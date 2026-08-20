/**
 * dsh-memory — host half.
 *
 * Registers the /api/dsh-memory route family: list / read / write of the
 * DSH global-instruction file (~/.dsh/AGENTS.md) and the global memory
 * directory (~/.dsh/memory/*.md). Every route is fenced loopback-only (the
 * same trust fence the dsh-web-ui family uses); file keys are whitelisted
 * shapes so the API can never traverse outside the memory directory.
 * Writes are atomic (temp file + rename) and capped at 1 MiB.
 */

import { readFile, readdir, rename, stat, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Stable cordis plugin name. */
export const name = 'memory'

/** Services required before the routes can mount. */
export const inject = ['webServer']

/** Cap on file content accepted by the write route (1 MiB). */
const MAX_CONTENT_BYTES = 1024 * 1024

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024

const DSH_HOME = join(homedir(), '.dsh')
const GLOBAL_FILE = join(DSH_HOME, 'AGENTS.md')
const MEMORY_DIR = join(DSH_HOME, 'memory')

/** Key for the global instruction file (reserved). */
const GLOBAL_KEY = '__global__'

/** Legal memory-file key: plain filename, .md, no separators/traversal. */
const MEMORY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/

/** Resolve a file key to its absolute path, or undefined when illegal. */
function resolvePath(key) {
  if (key === GLOBAL_KEY) return GLOBAL_FILE
  if (typeof key === 'string' && MEMORY_KEY_RE.test(key)) return join(MEMORY_DIR, key)
  return undefined
}

/** IPv4 127/8 predicate. */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Loopback socket + Host header + same-origin fence (never trusts XFF). */
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  const addressOk = normalized === '::1'
    || (normalized.startsWith('::ffff:') && isIPv4Loopback(normalized.slice(7)))
    || isIPv4Loopback(normalized)
  if (!addressOk) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname
  const hostOk = hostname === 'localhost' || hostname === '[::1]' || isIPv4Loopback(hostname)
  if (!hostOk) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Stat one file, tolerating absence. */
async function statEntry(path) {
  try {
    const info = await stat(path)
    return { exists: true, bytes: info.size, mtimeMs: Math.round(info.mtimeMs) }
  } catch {
    return { exists: false, bytes: 0, mtimeMs: 0 }
  }
}

/** List the global file + every memory file. */
async function listFiles() {
  const files = []
  const globalInfo = await statEntry(GLOBAL_FILE)
  files.push({
    key: GLOBAL_KEY,
    title: 'AGENTS.md',
    subtitle: '全局指令（所有会话注入）',
    path: GLOBAL_FILE,
    ...globalInfo,
  })
  try {
    const names = (await readdir(MEMORY_DIR)).filter((name) => MEMORY_KEY_RE.test(name)).sort()
    for (const name of names) {
      const info = await statEntry(join(MEMORY_DIR, name))
      files.push({
        key: name,
        title: name,
        subtitle: '记忆 / ' + name.replace(/\.md$/, ''),
        path: join(MEMORY_DIR, name),
        ...info,
      })
    }
  } catch {
    // memory dir absent: only the global file is listed
  }
  return files
}

/** Build the /api/dsh-memory route family (one handler per path; method dispatch inside). */
export function makeRoutes() {
  return [
    {
      kind: 'exact',
      path: '/api/dsh-memory/files',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        writeJson(res, 200, { files: await listFiles() })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-memory/file',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost')
          const key = url.searchParams.get('key') ?? ''
          const path = resolvePath(key)
          if (path === undefined) return writeJson(res, 400, { error: 'bad key' })
          try {
            const content = await readFile(path, 'utf8')
            const info = await statEntry(path)
            writeJson(res, 200, { key, content, bytes: info.bytes, mtimeMs: info.mtimeMs })
          } catch {
            writeJson(res, 200, { key, content: '', bytes: 0, mtimeMs: 0, missing: true })
          }
          return
        }
        if (req.method === 'PUT') {
          const body = await readJsonBody(req)
          const key = body?.key
          const content = body?.content
          if (typeof key !== 'string' || typeof content !== 'string') {
            return writeJson(res, 400, { error: 'key and content required' })
          }
          if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
            return writeJson(res, 413, { error: 'content too large (max 1 MiB)' })
          }
          const path = resolvePath(key)
          if (path === undefined) return writeJson(res, 400, { error: 'bad key' })
          try {
            if (key !== GLOBAL_KEY) await mkdir(MEMORY_DIR, { recursive: true, mode: 0o700 })
            const tmp = path + '.tmp-' + randomBytes(4).toString('hex')
            await writeFile(tmp, content, { mode: 0o600 })
            await rename(tmp, path)
            const info = await statEntry(path)
            writeJson(res, 200, { ok: true, key, bytes: info.bytes, mtimeMs: info.mtimeMs })
          } catch (error) {
            writeJson(res, 500, { error: 'write failed: ' + (error instanceof Error ? error.message : String(error)) })
          }
          return
        }
        writeJson(res, 405, { error: 'method not allowed' })
      },
    },
  ]
}

/** Mount the /api/dsh-memory route family. */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = makeRoutes().map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-memory: routes')
}
