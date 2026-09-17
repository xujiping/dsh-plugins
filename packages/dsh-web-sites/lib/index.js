/**
 * dsh-web-sites — host half (runs inside the dsh CLI process).
 *
 * Serves the site-launcher config over loopback-trusted routes:
 *
 *   GET  /api/dsh-sites/list   -> { sites: Site[] }
 *   POST /api/dsh-sites/save   -> body { sites: Site[] }   (full-list atomic write)
 *   POST /api/dsh-sites/add    -> body { name, url, icon?, tags?, id? }
 *   POST /api/dsh-sites/update -> body { id, name?, url?, icon?, tags? }
 *   POST /api/dsh-sites/remove -> body { id }
 *   POST /api/dsh-sites/reorder-> body { ids: string[] }    (list order by ids)
 *
 * Site 额外字段 embed: false —— 不走 iframe 内嵌（避开第三方 Cookie 拦截），
 * 点击站点直接新标签打开。
 *
 * 细粒度路由面向「对话式管理」：AI 会话可直接 curl 单条增删改，不必拉全量
 * 再写回，避免覆盖并发修改。
 *
 * The config file lives at ~/.dsh/sites.yaml:
 *
 *   sites:
 *     - id: contract
 *       name: 合同管理系统
 *       url: http://localhost:8080
 *       icon: 📄
 *       tags: [办公]
 *
 * Reads tolerate a missing / partially-corrupt file (falls back to empty list);
 * writes are atomic (tmp file + rename). The yaml library is resolved from the
 * DSH dependency tree (zero extra dependencies for this package itself).
 */
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'

export const name = 'web-sites'
export const inject = ['webServer']

const DSH_DIR = join(homedir(), '.dsh')

/** 配置路径：可用 DSH_WEB_SITES_CONFIG 覆盖（便于测试隔离与个性化定位）；调用时惰性解析。 */
function sitesPath() {
  return process.env.DSH_WEB_SITES_CONFIG || join(DSH_DIR, 'sites.yaml')
}

// ------------------------------------------------------------------ helpers

/** Loopback trust fence: only local, same-host requests may touch the config. */
export function trusted(req) {
  const address = (req.socket.remoteAddress || '').toLowerCase().replace(/^::ffff:/, '')
  if (address !== '::1' && !/^127\./.test(address)) return false
  try {
    const host = new URL(`http://${req.headers.host}`)
    if (!['localhost', '[::1]'].includes(host.hostname) && !/^127\./.test(host.hostname)) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    return !req.headers.origin || new URL(req.headers.origin).host === host.host
  } catch {
    return false
  }
}

function loadYamlLib() {
  // 零依赖优先：能从 dsh 依赖树解析到 yaml 就用它（插件自身零依赖）。
  const dshBins = ['/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js']
  if (process.argv[1]) dshBins.unshift(process.argv[1])
  for (const base of [import.meta.url, ...dshBins]) {
    try { return createRequire(base)('yaml') } catch { /* 换下一个 */ }
  }
  return null
}

/** Normalise a raw yaml doc into Site[]; silently drops malformed entries. */
function normaliseSites(raw) {
  const list = Array.isArray(raw?.sites) ? raw.sites : Array.isArray(raw) ? raw : []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name ?? '').trim()
    const url = String(item.url ?? '').trim()
    if (name === '' || url === '') continue
    out.push({
      id: String(item.id ?? '').trim() || slugify(name),
      name,
      url,
      icon: String(item.icon ?? '').trim() || '🌐',
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      // embed: false 表示该站点不走 iframe 内嵌，点击直接新标签打开
      embed: item.embed === false ? false : true,
    })
  }
  return out
}

function slugify(text) {
  const base = String(text).trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '')
  return base || `site-${Math.random().toString(36).slice(2, 8)}`
}

export function readSites(path = sitesPath()) {
  try {
    const yaml = loadYamlLib()
    if (!yaml) throw new Error('未找到 yaml 解析依赖')
    return normaliseSites(yaml.parse(readFileSync(path, 'utf8')))
  } catch {
    return [] // 文件不存在或损坏：回退空列表
  }
}

export function writeSites(sites, path = sitesPath()) {
  const yaml = loadYamlLib()
  if (!yaml) throw new Error('未找到 yaml 序列化依赖')
  const list = normaliseSites({ sites })
  const body = yaml.stringify({ sites: list }, { indent: 2 })
  // 原子写：先写临时文件再 rename，避免中途崩溃留下半截配置。
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, path)
  return list
}

/** 读盘 + 变更 + 原子写回的公共通道；mutate 抛错即整条拒绝，不落盘。 */
function mutateSites(mutate) {
  const sites = readSites()
  const next = mutate(sites)
  return writeSites(next)
}

/** 按 id 或 name 精确查找站点下标；找不到返回 -1。 */
function findIndex(sites, ref) {
  const key = String(ref ?? '').trim()
  if (!key) return -1
  return sites.findIndex(s => s.id === key || s.name === key)
}

// -------------------------------------------------------------------- apply

export function apply(ctx) {
  ctx.effect(() => {
    const reply = (res, code, data) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(data))
    }

    const readBody = req => new Promise((resolve, reject) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })

    /** POST 路由公共壳：围栏 + 方法 + JSON 解析。handler 返回 {status, data}
     *  或直接返回业务对象（视为 200 + {ok:true, ...result}）。 */
    const post = (handler) => (req, res) => {
      if (!trusted(req)) return reply(res, 403, { error: '仅允许本机同源请求' })
      if (req.method !== 'POST') return reply(res, 405, { error: '不支持的请求方法' })
      readBody(req).then(body => {
        try {
          const parsed = JSON.parse(body || '{}')
          const result = handler(parsed)
          if (result && typeof result === 'object' && 'status' in result) {
            return reply(res, result.status, result.data)
          }
          // 业务 handler 直接返回 Site[]（writeSites 的产物）→ {ok, sites}
          const data = Array.isArray(result) ? { sites: result } : result
          reply(res, 200, { ok: true, ...data })
        } catch (error) {
          reply(res, 400, { ok: false, error: error.message })
        }
      }, () => reply(res, 400, { ok: false, error: '请求体读取失败' }))
    }

    const disposers = [
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-sites/list',
        handler(req, res) {
          if (!trusted(req)) return reply(res, 403, { error: '仅允许本机同源请求' })
          if (req.method !== 'GET') return reply(res, 405, { error: '不支持的请求方法' })
          reply(res, 200, { sites: readSites() })
        },
      }),
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-sites/save',
        handler(req, res) {
          if (!trusted(req)) return reply(res, 403, { error: '仅允许本机同源请求' })
          if (req.method !== 'POST') return reply(res, 405, { error: '不支持的请求方法' })
          readBody(req).then(body => {
            try {
              const parsed = JSON.parse(body || '{}')
              const sites = writeSites(parsed.sites ?? [])
              reply(res, 200, { ok: true, sites })
            } catch (error) {
              reply(res, 400, { ok: false, error: error.message })
            }
          }, () => reply(res, 400, { ok: false, error: '请求体读取失败' }))
        },
      }),
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-sites/add',
        handler: post(parsed => {
          const name = String(parsed.name ?? '').trim()
          const url = String(parsed.url ?? '').trim()
          if (!name || !url) throw new Error('name 与 url 必填')
          return mutateSites(sites => {
            // 幂等：同 id 或同 url 已存在则视为更新（对话重试安全）。
            const idx = sites.findIndex(s => s.id === (String(parsed.id ?? '').trim() || slugify(name)) || s.url === url)
            const entry = {
              id: String(parsed.id ?? '').trim() || (idx >= 0 ? sites[idx].id : slugify(name)),
              name, url,
              icon: String(parsed.icon ?? '').trim() || (idx >= 0 ? sites[idx].icon : '🌐'),
              tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : (idx >= 0 ? sites[idx].tags : []),
              embed: parsed.embed !== undefined ? parsed.embed !== false : (idx >= 0 ? sites[idx].embed : true),
            }
            if (idx >= 0) { sites[idx] = entry; return sites }
            return [...sites, entry]
          })
        }),
      }),
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-sites/update',
        handler: post(parsed => {
          const ref = parsed.id ?? parsed.name
          return mutateSites(sites => {
            const idx = findIndex(sites, ref)
            if (idx < 0) throw new Error(`未找到站点：${ref}`)
            const cur = sites[idx]
            const next = {
              ...cur,
              name: String(parsed.name ?? cur.name).trim() || cur.name,
              url: String(parsed.url ?? cur.url).trim() || cur.url,
              icon: parsed.icon !== undefined ? (String(parsed.icon).trim() || cur.icon) : cur.icon,
              tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : cur.tags,
              embed: parsed.embed !== undefined ? parsed.embed !== false : cur.embed,
            }
            // name 变了且 id 是自动生成的，跟随更新；显式 id 不动。
            if (parsed.name && parsed.id === undefined && cur.id === slugify(cur.name)) next.id = slugify(next.name)
            const out = [...sites]; out[idx] = next
            return out
          })
        }),
      }),
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-sites/remove',
        handler: post(parsed => {
          const ref = parsed.id ?? parsed.name
          return mutateSites(sites => {
            const idx = findIndex(sites, ref)
            if (idx < 0) throw new Error(`未找到站点：${ref}`)
            const out = [...sites]; out.splice(idx, 1)
            return out
          })
        }),
      }),
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-sites/reorder',
        handler: post(parsed => {
          const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String) : null
          if (!ids || ids.length === 0) throw new Error('ids 必须为非空数组')
          return mutateSites(sites => {
            const byId = new Map(sites.map(s => [s.id, s]))
            const ordered = ids.map(id => byId.get(id)).filter(Boolean)
            const rest = sites.filter(s => !ids.includes(s.id))
            return [...ordered, ...rest]
          })
        }),
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'web-sites: config routes')
}
