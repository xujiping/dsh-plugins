import assert from 'node:assert/strict'
import { apply, trusted, restartSupported, compareVersions, currentDshVersion, latestDshVersion, readCredential, collectBalances } from '../lib/index.js'
const request = (address = '127.0.0.1', headers = {}) => ({ socket: { remoteAddress: address }, headers: { host: 'localhost:3000', ...headers } })
assert.equal(trusted(request()), true)
assert.equal(trusted(request('::ffff:127.0.0.1')), true)
assert.equal(trusted(request('192.168.1.2')), false)
assert.equal(trusted(request('127.0.0.1', { origin: 'https://evil.example' })), false)
assert.equal(trusted(request('127.0.0.1', { host: 'evil.example' })), false)
assert.equal(trusted(request('127.0.0.1', { 'sec-fetch-site': 'cross-site' })), false)
const cli = ['node', '/opt/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web']
assert.equal(restartSupported(cli), true)
assert.equal(restartSupported([...cli, '--port', '0']), false)
assert.equal(restartSupported(['electron', 'app.js']), false)

// --- semver 比较 ---
assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
assert.equal(compareVersions('0.1.0', '0.2.0'), -1)
assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
assert.equal(compareVersions('v0.1.1', '0.1.0'), 1)
assert.equal(compareVersions('0.1.0-rc.6', '0.1.0'), -1)      // 预发布低于正式版
assert.equal(compareVersions('0.1.0-rc.6', '0.1.0-rc.10'), 0) // 同三元组同预发布状态视为相等

// --- 当前版本探测（本机装了 dsh，应能拿到）---
const current = currentDshVersion()
assert.ok(!current || /^\d+\.\d+\.\d+/.test(current), `unexpected version: ${current}`)

// --- registry 查询（联网时应有结果；离线时允许为 null）---
const latest = await latestDshVersion(AbortSignal.timeout(20000)).catch(() => null)
if (latest != null) assert.ok(/^\d+\.\d+\.\d+/.test(latest), `unexpected latest: ${latest}`)

// --- 路由注册：restart + SSE events ---
const routes = {}
const cleanups = []
apply({ effect(fn) { cleanups.push(fn()) }, webServer: { register(value) { routes[value.path] = value; return () => {} } } })
const restartRoute = routes['/api/dsh-desktop-pet/restart']
const eventsRoute = routes['/api/dsh-desktop-pet/events']
assert.ok(restartRoute && eventsRoute, 'both routes registered')

async function callRestart(method, headers = {}, address) {
  let status, body
  await restartRoute.handler({ ...request(address, headers), method }, { writeHead(code) { status = code }, end(value) { body = JSON.parse(value) } })
  return { status, body }
}
assert.equal((await callRestart('GET')).status, 200)
assert.equal((await callRestart('POST')).status, 403)
assert.equal((await callRestart('POST', { 'x-dsh-pet-action': 'restart' })).status, 409)
assert.equal((await callRestart('DELETE')).status, 405)
assert.equal((await callRestart('GET', {}, '10.0.0.1')).status, 403)

// SSE：非本机 403、非 GET 405；GET 建立 event-stream。
let sseStatus, sseHeaders = {}, sseChunks = []
const sseRes = { writeHead(code, h) { sseStatus = code; sseHeaders = h }, write(c) { sseChunks.push(c) }, end() {} }
await eventsRoute.handler({ ...request('10.0.0.1'), method: 'GET' }, sseRes)
assert.equal(sseStatus, 403)
await eventsRoute.handler({ ...request(), method: 'POST' }, { writeHead(c) { sseStatus = c }, end() {} })
assert.equal(sseStatus, 405)
let closeFn = () => {}
await eventsRoute.handler({ ...request(), method: 'GET', once(ev, fn) { if (ev === 'close') closeFn = fn } }, sseRes)
assert.equal(sseStatus, 200)
assert.equal(sseHeaders['content-type'], 'text/event-stream')
assert.ok(sseChunks.some(c => String(c).includes('retry: 5000')))
closeFn() // 模拟断开，验证清理路径不报错
// --- 余额查询：凭证回退解析 + 路由注册 + 围栏 ---
assert.equal(readCredential('NOPE_MISSING_ENV', '/nonexistent/path'), '')
const balanceRoute = routes['/api/dsh-desktop-pet/balance']
assert.ok(balanceRoute, 'balance route registered')
{
  let status, body
  const res = { writeHead(code) { status = code }, end(v) { body = JSON.parse(v) } }
  await balanceRoute.handler({ ...request('10.0.0.1'), method: 'GET' }, res)
  assert.equal(status, 403)
  await balanceRoute.handler({ ...request(), method: 'POST' }, res)
  assert.equal(status, 405)
  await balanceRoute.handler({ ...request(), method: 'GET' }, res)
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.providers), 'providers list returned')
  for (const p of body.providers) {
    assert.ok(p.id && typeof p.text === 'string', 'provider row shape')
    assert.ok(!('apiKey' in p) && !('key' in p), 'no credential leak')
  }
}
// 本机存在真实配置时验证结构（离线/无 yaml 时 collectBalances 可能抛错，允许失败）。
try {
  const live = await collectBalances()
  assert.ok(live.at > 0)
} catch { /* 依赖缺失环境下跳过 */ }

for (const fn of cleanups) await fn()
console.log('desktop-pet smoke: passed')
