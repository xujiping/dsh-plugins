import { spawn } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'desktop-pet'
export const inject = ['webServer']
const instance = randomUUID()
const helper = fileURLToPath(new URL('./restart.js', import.meta.url))
const ipv4 = value => isIPv4(value) && value.startsWith('127.')

// 同时校验连接地址、Host 和同源请求，避免跨站触发重启。
export function trusted(req) {
  const address = (req.socket.remoteAddress || '').toLowerCase().replace(/^::ffff:/, '')
  if (address !== '::1' && !ipv4(address)) return false
  try {
    const host = new URL(`http://${req.headers.host}`)
    if (!['localhost', '[::1]'].includes(host.hostname) && !ipv4(host.hostname)) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    return !req.headers.origin || new URL(req.headers.origin).host === host.host
  } catch { return false }
}

// 只重启标准 CLI 入口；Electron 等托管进程不能按 Node 参数重新启动。
// argv[1] 可能是 symlink（如 /opt/homebrew/bin/dsh），先 realpath 再匹配。
export function restartSupported(argv = process.argv) {
  let bin = argv[1] || ''
  try { bin = realpathSync(bin) } catch { /* 保留原路径参与匹配 */ }
  return /[/\\]@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js$/.test(bin)
    && !argv.some((arg, i) => arg === '--port=0' || (arg === '--port' && argv[i + 1] === '0'))
}

// ---------------------------------------------------------------- 提醒机制
// 简单 semver 比较：只比较主.次.修订三元组；带预发布后缀的视为低于同三元组正式版。
export function compareVersions(a, b) {
  const parse = v => String(v || '').trim().replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  const [pa, pb] = [parse(a), parse(b)]
  const preA = /-/.test(String(a || '')), preB = /-/.test(String(b || ''))
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  if (preA !== preB) return preA ? -1 : 1
  return 0
}

// 当前 DSH 版本：优先从插件依赖树解析 @deepseek-ai/dsh，回退到 bin.js 旁的 package.json。
export function currentDshVersion() {
  try {
    const require = createRequire(import.meta.url)
    return JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version
  } catch { /* 走回退路径 */ }
  try {
    // dsh 的 bin.js 位于 <pkg>/lib/bin.js，package.json 在上一级（<pkg>/package.json）。
    const pkg = new URL('../package.json', `file://${process.argv[1] || ''}`)
    return JSON.parse(readFileSync(fileURLToPath(pkg), 'utf8')).version
  } catch { return null }
}

// npm registry 候选（可用 DSH_PET_NPM_REGISTRY 覆盖），逐个尝试直到拿到 dist-tags。
const registries = () => {
  const custom = process.env.DSH_PET_NPM_REGISTRY
  if (custom) return [custom]
  return ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
}

export async function latestDshVersion(signal) {
  for (const base of registries()) {
    try {
      const res = await fetch(`${base}/@deepseek-ai/dsh`, { signal, headers: { accept: 'application/vnd.npm.install-v1+json' } })
      if (!res.ok) continue
      const tags = (await res.json())['dist-tags'] || {}
      // rc 阶段 latest 可能落后于 next，取两者较新者。
      const candidates = [tags.latest, tags.next].filter(Boolean)
      if (!candidates.length) continue
      return candidates.reduce((max, v) => (compareVersions(v, max) > 0 ? v : max))
    } catch { /* 换下一个 registry */ }
  }
  return null
}

// 提醒中心：环形缓冲 + SSE 广播；同一 id 只提醒一次（进程生命周期内）。
function createNotifier({ limit = 20 } = {}) {
  const clients = new Set()
  const history = []
  const sent = new Set()
  const encode = notice => `id: ${notice.id}\ndata: ${JSON.stringify(notice)}\n\n`
  return {
    publish(notice) {
      if (sent.has(notice.id)) return false
      sent.add(notice.id)
      history.push(notice)
      if (history.length > limit) history.shift()
      const frame = encode(notice)
      for (const res of clients) res.write(frame)
      return true
    },
    attach(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write('retry: 5000\n\n')
      for (const notice of history) res.write(encode(notice))
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000)
      clients.add(res)
      req.once('close', () => { clearInterval(heartbeat); clients.delete(res) })
    },
    get size() { return clients.size },
    close() { for (const res of clients) res.end(); clients.clear() },
  }
}

// 版本检查器：延迟启动，之后每 12 小时复查；发现新版本发一条提醒。
function scheduleVersionChecks(ctx, notifier) {
  const notified = new Set()
  let timer = 0
  const check = async () => {
    const current = currentDshVersion()
    if (!current) return
    const latest = await latestDshVersion(AbortSignal.timeout(15000)).catch(() => null)
    if (!latest || compareVersions(latest, current) <= 0) return
    if (notified.has(latest)) return
    notified.add(latest)
    notifier.publish({
      id: `dsh-update:${latest}`,
      kind: 'update',
      icon: '🆙',
      title: 'DSH 有新版本',
      body: `当前 ${current} → 最新 ${latest}，可在合适的时机重启升级。`,
    })
  }
  const arm = delay => { timer = setTimeout(async () => { await check().catch(() => {}); arm(12 * 3600 * 1000) }, delay) }
  arm(15000)
  return () => clearTimeout(timer)
}

export function apply(ctx) {
  ctx.effect(() => {
    let pending = false
    let timer
    const dispose = ctx.webServer.register({
      kind: 'exact', path: '/api/dsh-desktop-pet/restart',
      async handler(req, res) {
        const reply = (code, data) => {
          res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(data))
        }
        if (!trusted(req)) return reply(403, { error: '仅允许本机同源请求' })
        if (req.method === 'GET') return reply(200, { instance, pending, supported: restartSupported() })
        if (req.method !== 'POST') return reply(405, { error: '不支持的请求方法' })
        if (req.headers['x-dsh-pet-action'] !== 'restart') return reply(403, { error: '缺少操作标识' })
        if (!restartSupported()) return reply(409, { error: '当前启动方式不支持重启，请通过固定端口的 dsh CLI 启动' })
        if (pending) return reply(409, { error: '正在重启，请稍候' })
        pending = true
        try {
          const child = spawn(process.execPath, [helper, String(process.pid), process.cwd(), ...process.execArgv, ...process.argv.slice(1)], {
            detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env,
          })
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { child.kill(); reject(new Error('重启助手启动超时')) }, 5000)
            const finish = (error) => { clearTimeout(timeout); error ? reject(error) : resolve() }
            child.once('error', finish)
            child.once('exit', () => finish(new Error('重启助手提前退出')))
            child.once('message', () => finish())
          })
          // 助手先启动成功，再响应浏览器并通过 CLI 的 SIGTERM 清理流程退出。
          res.once('finish', () => {
            child.send('restart', error => {
              if (error) { pending = false; return }
              child.disconnect()
              child.unref()
              timer = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250)
            })
          })
          reply(202, { instance })
        } catch (error) {
          pending = false
          reply(500, { error: error.message })
        }
      },
    })
    return () => { clearTimeout(timer); dispose() }
  }, 'desktop-pet: restart route')

  // -------------------------------------------------------------- 提醒通道
  ctx.effect(() => {
    const notifier = createNotifier()
    const stopChecks = scheduleVersionChecks(ctx, notifier)
    const dispose = ctx.webServer.register({
      kind: 'exact', path: '/api/dsh-desktop-pet/events',
      handler(req, res) {
        if (!trusted(req)) {
          res.writeHead(403, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: '仅允许本机同源请求' }))
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: '不支持的请求方法' }))
        }
        notifier.attach(req, res)
      },
    })
    return () => { stopChecks(); dispose(); notifier.close() }
  }, 'desktop-pet: notification SSE')
}
