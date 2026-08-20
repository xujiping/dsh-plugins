/**
 * Host-half smoke test: registers the /api/dsh-memory routes on a stub
 * webServer, then drives the handlers with fake req/res pairs against the
 * REAL ~/.dsh files (read-only paths) plus a sandboxed write of a temp key.
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const registered = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    registered.push(dispose)
    return dispose
  },
}
const webServer = {
  register(route) {
    registered.push(route)
    return () => {}
  },
}
ctx.webServer = webServer

const mod = await import('../lib/index.js')
assert.equal(mod.name, 'memory')
assert.deepEqual(mod.inject, ['webServer'])
mod.apply(ctx)
const routes = registered.filter((r) => r.kind === 'exact')
assert.equal(routes.length, 2, 'two exact routes')

const filesRoute = routes.find((r) => r.path === '/api/dsh-memory/files')
const fileRoute = routes.find((r) => r.path === '/api/dsh-memory/file')

/** Fake loopback request. */
function req(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:65096' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Response recorder. */
function res() {
  const out = {
    status: 0,
    body: '',
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(payload) {
      if (payload !== undefined) out.body += payload
    },
  }
  return out
}

// --- loopback fence: non-loopback socket is rejected
{
  const bad = { ...req('GET', '/api/dsh-memory/files'), socket: { remoteAddress: '192.168.1.5' } }
  const r = res()
  await filesRoute.handler(bad, r)
  assert.equal(r.status, 403)
}

// --- list
{
  const r = res()
  await filesRoute.handler(req('GET', '/api/dsh-memory/files'), r)
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.ok(Array.isArray(body.files) && body.files.length >= 1)
  assert.ok(body.files.some((f) => f.key === '__global__' && f.title === 'AGENTS.md'))
  assert.ok(body.files.some((f) => f.key === 'prefs.md'))
  console.log('list ok:', body.files.map((f) => f.key).join(', '))
}

// --- read global
{
  const r = res()
  await fileRoute.handler(req('GET', '/api/dsh-memory/file?key=__global__'), r)
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.ok(body.content.includes('全局用户指令'))
}

// --- traversal rejected
for (const key of ['../AGENTS.md', 'a/b.md', '.hidden.md', 'no-extension', '__global__x']) {
  const r = res()
  await fileRoute.handler(req('GET', '/api/dsh-memory/file?key=' + encodeURIComponent(key)), r)
  assert.equal(r.status, 400, 'key should be rejected: ' + key)
}

// --- write roundtrip on a temp key, then restore
const TEMP_KEY = 'smoke-test.md'
const TEMP_PATH = join(homedir(), '.dsh', 'memory', TEMP_KEY)
try {
  const marker = '# smoke ' + Date.now() + '\n'
  const r = res()
  await fileRoute.handler(req('PUT', '/api/dsh-memory/file', { key: TEMP_KEY, content: marker }), r)
  assert.equal(r.status, 200, r.body)
  assert.equal(await readFile(TEMP_PATH, 'utf8'), marker)
  const r2 = res()
  await fileRoute.handler(req('GET', '/api/dsh-memory/file?key=' + TEMP_KEY), r2)
  assert.equal(JSON.parse(r2.body).content, marker)
  console.log('write roundtrip ok')
} finally {
  await rm(TEMP_PATH, { force: true })
}

// --- bad bodies rejected
{
  const r = res()
  await fileRoute.handler(req('PUT', '/api/dsh-memory/file', { content: 'x' }), r)
  assert.equal(r.status, 400)
  const r2 = res()
  await fileRoute.handler(req('PUT', '/api/dsh-memory/file', { key: 'a.md', content: 42 }), r2)
  assert.equal(r2.status, 400)
}

console.log('ALL SMOKE TESTS PASSED')
