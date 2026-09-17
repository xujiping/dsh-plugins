/**
 * Host-half smoke test for dsh-web-sites.
 *
 * Covers the pure-Node logic:
 *
 *   1. `trusted` loopback fence — local/same-host passes, remote host /
 *      cross-site origin / spoofed host reject
 *   2. `readSites` — valid yaml parses + normalises; missing file returns [];
 *      malformed entries dropped
 *   3. `writeSites` — normalises + round-trips through readSites; invalid
 *      entries dropped; empty name/url dropped; chinese names slugified
 *   4. route registration — apply registers /api/dsh-sites/list + /save
 *   5. route guards — non-loopback 403, wrong method 405
 *   6. /save handler — persists a posted full list and returns {ok, sites}
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { apply, trusted, readSites, writeSites } from '../lib/index.js'

// -------------------------------------------------------- client isolation
// 菜单必须留在 React 侧边栏树外，否则新版 DSH 的重绘会与自愈监听形成循环。
{
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /document\.body\.append\(menuEl\)/)
  assert.doesNotMatch(client, /insertBefore\(menuEl, tree\)/)
  assert.match(client, /const timer = setTimeout\(\(\) =>/)
}

// ------------------------------------------------------------------ helpers
let n = 0
function tmpFile(name = 'sites.yaml') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-sites-'))
  const file = join(dir, name)
  return { dir, file }
}

function request(address = '127.0.0.1', headers = {}) {
  return { socket: { remoteAddress: address }, headers: { host: 'localhost:3000', ...headers } }
}

/** Run a route handler with a stubbed req/res; collects status + JSON body. */
async function callHandler(handler, { method = 'GET', body = null, rawBody = null, address = '127.0.0.1', headers = {} } = {}) {
  let status = 0
  let payload = null
  const req = request(address, headers)
  req.method = method
  if (body !== null || rawBody !== null) {
    const data = rawBody !== null ? rawBody : JSON.stringify(body)
    let i = 0
    req.on = (event, cb) => {
      if (event === 'data') {
        // simulate a chunked stream (split halfway to exercise accumulation)
        const mid = Math.ceil(data.length / 2)
        cb(data.slice(0, mid))
        cb(data.slice(mid))
      }
      if (event === 'end') cb()
    }
  } else {
    req.on = () => {}
  }
  const res = {
    writeHead(code) { status = code },
    end(value) {
      if (value) payload = JSON.parse(value)
    },
  }
  await handler(req, res)
  return { status, payload }
}

// --------------------------------------------------------------- trust fence
assert.equal(trusted(request()), true)
assert.equal(trusted(request('::ffff:127.0.0.1')), true)
assert.equal(trusted(request('::1')), true)
assert.equal(trusted(request('192.168.1.2')), false)
assert.equal(trusted(request('10.0.0.1')), false)
assert.equal(trusted(request('127.0.0.1', { origin: 'https://evil.example' })), false)
assert.equal(trusted(request('127.0.0.1', { host: 'evil.example' })), false)
assert.equal(trusted(request('127.0.0.1', { 'sec-fetch-site': 'cross-site' })), false)
assert.equal(trusted(request('127.0.0.1', { origin: 'http://localhost:3000' })), true)

// ------------------------------------------------------------------ readSites
{
  const { dir, file } = tmpFile()
  try {
    // missing file -> []
    assert.deepEqual(readSites(file), [])

    // valid file -> normalised list
    writeFileSync(file, [
      'sites:',
      '  - id: contract',
      '    name: 合同管理系统',
      '    url: http://localhost:8080',
      '    icon: 📄',
      '    tags: [办公]',
      '  - name: 知识平台',
      '    url: http://192.168.1.20:3000',
      '  - name: ""',       // empty name -> dropped
      '    url: http://x',
      '  - name: no-url',   // empty url -> dropped
      '    url: ""',
      '  - 42',             // non-object -> dropped
    ].join('\n'), 'utf8')
    const sites = readSites(file)
    assert.equal(sites.length, 2)
    assert.deepEqual(sites[0], {
      id: 'contract', name: '合同管理系统', url: 'http://localhost:8080', icon: '📄', tags: ['办公'],
    })
    // 无 id 时由 name 生成 slug（中文保留）
    assert.equal(sites[1].id, '知识平台')
    assert.equal(sites[1].icon, '🌐')
    assert.deepEqual(sites[1].tags, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ writeSites
{
  const { dir, file } = tmpFile()
  try {
    const written = writeSites([
      { id: 'a', name: '站点A', url: 'http://a.local', icon: '🅰', tags: ['x'] },
      { name: '', url: 'http://bad' },               // dropped
      { name: '无地址', url: '' },                    // dropped
      'garbage',                                     // dropped
    ], file)
    assert.equal(written.length, 1)
    assert.deepEqual(written[0], { id: 'a', name: '站点A', url: 'http://a.local', icon: '🅰', tags: ['x'] })

    // round-trip: 写回后再读应一致
    assert.deepEqual(readSites(file), written)

    // 文件是合法 yaml，且保留了 sites: 顶层键
    const raw = readFileSync(file, 'utf8')
    assert.match(raw, /^sites:/m)
    assert.match(raw, /name: 站点A/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ route registration
{
  const routes = {}
  const cleanups = []
  apply({
    effect(fn) { cleanups.push(fn()) },
    webServer: {
      register(route) {
        routes[route.path] = route
        return () => {}
      },
    },
  })
  assert.ok(routes['/api/dsh-sites/list'], 'list route registered')
  assert.ok(routes['/api/dsh-sites/save'], 'save route registered')
  assert.equal(cleanups.length, 1)
  // disposer must be a function (route cleanup)
  assert.equal(typeof cleanups[0], 'function')
}

// ---------------------------------------------------------------- route guards
{
  // 路由处理函数走默认配置路径；用环境变量把它隔离到临时文件，避免污染真实 ~/.dsh/sites.yaml。
  const { dir, file } = tmpFile()
  const prev = process.env.DSH_WEB_SITES_CONFIG
  process.env.DSH_WEB_SITES_CONFIG = file
  try {
    const routes = {}
    apply({
      effect(fn) { fn() },
      webServer: {
        register(route) { routes[route.path] = route; return () => {} },
      },
    })

    const list = routes['/api/dsh-sites/list']
    assert.equal((await callHandler(list.handler, { method: 'POST' })).status, 405)
    assert.equal((await callHandler(list.handler, { address: '10.0.0.1' })).status, 403)
    const listOk = await callHandler(list.handler, { method: 'GET' })
    assert.equal(listOk.status, 200)
    assert.deepEqual(listOk.payload, { sites: [] })

    const save = routes['/api/dsh-sites/save']
    assert.equal((await callHandler(save.handler, { method: 'GET' })).status, 405)
    assert.equal((await callHandler(save.handler, { method: 'POST', address: '10.0.0.1' })).status, 403)

    // 合法保存：全量写回临时配置，返回 ok + 归一化后的列表
    const saveOk = await callHandler(save.handler, {
      method: 'POST',
      body: { sites: [{ id: 'a', name: '站点A', url: 'http://a.local' }, { name: '', url: 'http://bad' }] },
    })
    assert.equal(saveOk.status, 200)
    assert.equal(saveOk.payload.ok, true)
    assert.equal(saveOk.payload.sites.length, 1)
    assert.equal(saveOk.payload.sites[0].id, 'a')

    // 落盘可被 list 再次读到
    const listAgain = await callHandler(list.handler, { method: 'GET' })
    assert.equal(listAgain.payload.sites.length, 1)

    // 非法 body：400
    const bad = await callHandler(save.handler, { method: 'POST', rawBody: '{not-json!!' })
    assert.equal(bad.status, 400)
  } finally {
    if (prev === undefined) delete process.env.DSH_WEB_SITES_CONFIG
    else process.env.DSH_WEB_SITES_CONFIG = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('dsh-web-sites host smoke: OK')
