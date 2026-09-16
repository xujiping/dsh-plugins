/**
 * dsh-web-sites — host half (runs inside the dsh CLI process).
 *
 * Serves the site-launcher config over two loopback-trusted routes:
 *
 *   GET  /api/dsh-sites/list  -> { sites: Site[] }
 *   POST /api/dsh-sites/save  -> body { sites: Site[] }  (full-list atomic write)
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

// -------------------------------------------------------------------- apply

export function apply(ctx) {
  ctx.effect(() => {
    const reply = (res, code, data) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(data))
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
          let body = ''
          req.on('data', chunk => { body += chunk })
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body || '{}')
              const sites = writeSites(parsed.sites ?? [])
              reply(res, 200, { ok: true, sites })
            } catch (error) {
              reply(res, 400, { ok: false, error: error.message })
            }
          })
        },
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'web-sites: config routes')
}
