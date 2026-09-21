/**
 * dsh-own-plugin-manager — host half (runs inside the dsh CLI process).
 *
 * Loopback-trusted routes（对话式管理可直接 curl 这些端点）:
 *
 *   GET  /api/dsh-opm/state             ?profile=web[,desktop]  — 插件全景 + 检测缓存
 *   POST /api/dsh-opm/refresh           { profile?, force? }    — 触发版本检测（默认增量）
 *   POST /api/dsh-opm/toggle            { profile, plugin, disabled } — 启用/停用插件
 *   POST /api/dsh-opm/ack               { profile, plugin }     — link 插件基线对齐（已重启生效）
 *
 * 另有后台定时自动监测：每 DSH_OPM_INTERVAL_MIN（默认 360 分钟）刷新一轮
 * 版本检测并落盘 ~/.dsh/plugin-versions.json；启动时仅当缓存过期才补跑
 * （异步执行，不阻塞 GUI 启动）。所有定时器经 ctx.effect 注销。
 *
 * toggle 只做 cordis.patch.yml 行级 patch（保留用户注释），写回为原子写。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  dshHome, statePath, readState, writeState, buildView, refreshAll,
  readProfileState, togglePluginInPatchYml, ackLink,
} from './core.js'

export const name = 'own-plugin-manager'
export const inject = ['webServer']

/** 自动监测间隔（分钟），0 关闭；默认 6 小时。 */
function intervalMin() {
  const n = Number(process.env.DSH_OPM_INTERVAL_MIN ?? 360)
  return Number.isFinite(n) && n >= 0 ? n : 360
}

// ------------------------------------------------------------------ trust

/** Loopback trust fence: only local, same-host requests may manage plugins. */
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

// ------------------------------------------------------------------ helpers

/** 原子写文本文件。 */
function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
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

    /** POST 路由公共壳：围栏 + 方法 + JSON 解析；handler 异常统一 400。 */
    const post = handler => (req, res) => {
      if (!trusted(req)) return reply(res, 403, { error: '仅允许本机同源请求' })
      if (req.method !== 'POST') return reply(res, 405, { error: '不支持的请求方法' })
      readBody(req).then(body => {
        try {
          Promise.resolve(handler(JSON.parse(body || '{}')))
            .then(result => reply(res, 200, result))
            .catch(error => reply(res, 400, { ok: false, error: String(error?.message || error) }))
        } catch (error) {
          reply(res, 400, { ok: false, error: String(error?.message || error) })
        }
      }, () => reply(res, 400, { ok: false, error: '请求体读取失败' }))
    }

    const disposers = [
      // ------------------------------------------------ plugin panorama view
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-opm/state',
        handler(req, res) {
          if (!trusted(req)) return reply(res, 403, { error: '仅允许本机同源请求' })
          if (req.method !== 'GET') return reply(res, 405, { error: '不支持的请求方法' })
          try {
            const url = new URL(req.url, 'http://localhost')
            const profiles = url.searchParams.get('profile')?.split(',').map(s => s.trim()).filter(Boolean) || null
            reply(res, 200, buildView(dshHome(), { stateFile: statePath(), profiles }))
          } catch (error) {
            reply(res, 500, { error: String(error?.message || error) })
          }
        },
      }),

      // ----------------------------------------------------- refresh checks
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-opm/refresh',
        handler: post(async parsed => {
          const profiles = Array.isArray(parsed.profiles) ? parsed.profiles.map(String)
            : parsed.profile ? String(parsed.profile).split(',').map(s => s.trim()).filter(Boolean) : null
          const { state } = await refreshAll(dshHome(), { profiles, force: parsed.force === true })
          writeState(state, statePath())
          return { ok: true, view: buildView(dshHome(), { state, profiles }) }
        }),
      }),

      // ------------------------------------------------------- enable/disable
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-opm/toggle',
        handler: post(async parsed => {
          const profile = String(parsed.profile ?? '').trim()
          const plugin = String(parsed.plugin ?? '').trim()
          if (!profile || !plugin) throw new Error('profile 与 plugin 必填')
          if (typeof parsed.disabled !== 'boolean') throw new Error('disabled 必须为 boolean')

          const home = dshHome()
          const snapshot = readProfileState(home, profile)
          const info = snapshot.plugins.find(p => p.pkg === plugin || p.cordisId === plugin)
          if (!info) throw new Error(`profile ${profile} 中未找到插件：${plugin}`)
          if (!info.bundled) throw new Error(`${info.pkg} 不在 profile bundles 中，无法通过 patch 启停`)

          const patchPath = join(home, 'profiles', profile, 'cordis.patch.yml')
          let text = ''
          try { text = readFileSync(patchPath, 'utf8') } catch { /* 允许不存在，从空文件追加 */ }
          const next = togglePluginInPatchYml(text, info.cordisId, parsed.disabled)
          atomicWrite(patchPath, next)
          return { ok: true, plugin: { ...info, disabled: parsed.disabled }, note: '改动将在 profile 重载/重启后生效' }
        }),
      }),

      // -------------------------------------------------- ack link baseline
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-opm/ack',
        handler: post(parsed => {
          const profile = String(parsed.profile ?? '').trim()
          const plugin = String(parsed.plugin ?? '').trim()
          if (!profile || !plugin) throw new Error('profile 与 plugin 必填')
          const state = readState(statePath())
          if (!ackLink(state, profile, plugin)) throw new Error(`${profile}/${plugin} 不是 link 类插件或未检测过`)
          writeState(state, statePath())
          return { ok: true, profile, plugin }
        }),
      }),
    ]

    // ------------------------------------------------ background auto checks
    const minutes = intervalMin()
    let timer = null
    let bootTimer = null
    if (minutes > 0) {
      const runChecks = async force => {
        try {
          const { state } = await refreshAll(dshHome(), { force })
          writeState(state, statePath())
        } catch { /* 后台监测失败静默，等下一轮 */ }
      }
      timer = setInterval(() => { runChecks(false) }, minutes * 60_000)
      timer.unref?.()
      // 启动补跑：仅当缓存过期（避免每次 GUI 启动都打 registry/GitHub API）
      const st = readState(statePath())
      const fresh = st.checkedAt && Date.now() - Date.parse(st.checkedAt) < minutes * 60_000
      if (!fresh) {
        bootTimer = setTimeout(() => { runChecks(false); bootTimer = null }, 5_000)
        bootTimer.unref?.()
      }
    }

    return () => {
      for (const dispose of disposers) dispose()
      if (timer) clearInterval(timer)
      if (bootTimer) clearTimeout(bootTimer)
    }
  }, 'own-plugin-manager: routes + auto checks')
}
