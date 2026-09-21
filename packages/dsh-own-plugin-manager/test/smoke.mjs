/**
 * Host-half smoke test for dsh-own-plugin-manager.
 *
 * 覆盖：
 *   1. parseSource —— link/npm/github/tarball/other 归一（~/ 展开、tag 解码）
 *   2. compareVersions —— semver 严格段比较、v 前缀、预发布、非 semver 回退
 *   3. parsePatchDisables / togglePluginInPatchYml —— 行级启停：改值/插入/
 *      追加/注释逐字保留/幂等
 *   4. readProfileState —— fixture profile：own 标记、bundled、disabled、
 *      cordis id 提取（bundle patch 优先、host 源码兜底）
 *   5. checkNpm / checkGithub / checkTarball —— 注入 fake fetch 的四类检测
 *   6. readState / writeState —— round-trip + 原子写（无 tmp 残留）
 *   7. refreshProfile —— link 基线对比、变化保持基线、ackLink 对齐
 *   8. buildView —— updateCount 汇总
 *   9. 路由 —— trusted 围栏（403/405）、state/refresh/toggle/ack handler
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import './client-smoke.mjs'

process.env.DSH_OPM_INTERVAL_MIN = '0' // 关闭后台定时器，测试进程干净退出

import {
  parseSource, compareVersions, isOwnSource,
  parsePatchDisables, togglePluginInPatchYml,
  listProfiles, readProfileState,
  readState, writeState, statePath,
  checkNpm, checkGithub, checkTarball, readLinkFingerprint,
  refreshProfile, ackLink, buildView,
} from '../lib/core.js'
import { apply, trusted } from '../lib/index.js'

// --------------------------------------------------------------- parseSource
{
  const link = parseSource('link:~/AiProjects/dsh-plugins/packages/dsh-web-sites')
  assert.equal(link.type, 'link')
  assert.equal(link.path, join(homedir(), 'AiProjects/dsh-plugins/packages/dsh-web-sites'))
  assert.equal(isOwnSource(link), true)

  const abs = parseSource('link:/tmp/somewhere-else/pkg')
  assert.equal(abs.type, 'link')
  assert.equal(abs.path, '/tmp/somewhere-else/pkg')
  assert.equal(isOwnSource(abs), false)

  const caret = parseSource('^0.18.0')
  assert.equal(caret.type, 'npm')
  assert.equal(caret.version, '0.18.0')

  const exact = parseSource('1.45.0')
  assert.equal(exact.type, 'npm')
  assert.equal(exact.version, '1.45.0')

  const star = parseSource('*')
  assert.equal(star.type, 'npm')

  const gh = parseSource('github:csyangwen/dsh-memory-evolve')
  assert.equal(gh.type, 'github')
  assert.equal(gh.repo, 'csyangwen/dsh-memory-evolve')

  const ghRef = parseSource('github:omdsh-dev/dsh-at-file#da602d1a8f1b')
  assert.equal(ghRef.type, 'github')
  assert.equal(ghRef.repo, 'omdsh-dev/dsh-at-file')
  assert.equal(ghRef.ref, 'da602d1a8f1b')

  const tgz = parseSource('https://github.com/veildawn/dsh-plugins/releases/download/dsh-plugin-manager%40v0.3.20/dsh-plugin-manager-0.3.20.tgz')
  assert.equal(tgz.type, 'tarball')
  assert.equal(tgz.repo, 'veildawn/dsh-plugins')
  assert.equal(tgz.tag, 'dsh-plugin-manager@v0.3.20')
  assert.equal(tgz.version, '0.3.20')

  const other = parseSource('file:../local-pkg')
  assert.equal(other.type, 'other')

  console.log('parseSource ok')
}

// ---------------------------------------------------------- compareVersions
{
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1)
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
  assert.equal(compareVersions('v1.0', '1.0.0'), 0)
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.2'), 1)
  assert.equal(compareVersions('abc', 'abd'), -1) // 非 semver 回退字符串比较
  console.log('compareVersions ok')
}

// ---------------------------------------------------------- patch yml toggle
const SAMPLE_PATCH = `# 手写注释：必须逐字保留。
- insert:
    - id: mcp-local-workbench
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        command: uv
- id: web-sites
  disabled: true
# 另一段注释
- id: agent-driver
  disabled: false
`
{
  const disables = parsePatchDisables(SAMPLE_PATCH)
  assert.equal(disables.has('web-sites'), true)
  assert.equal(disables.get('web-sites').disabled, true)
  assert.equal(disables.get('agent-driver').disabled, false)
  assert.equal(disables.get('mcp-local-workbench').disabled, false)
  assert.equal(disables.size, 3)

  // 改值：web-sites true -> false
  const off = togglePluginInPatchYml(SAMPLE_PATCH, 'web-sites', false)
  const offDisables = parsePatchDisables(off)
  assert.equal(offDisables.get('web-sites').disabled, false)
  assert.equal(offDisables.get('agent-driver').disabled, false)
  // 注释逐字保留
  assert.match(off, /# 手写注释：必须逐字保留。/)
  assert.match(off, /# 另一段注释/)
  assert.match(off, /command: uv/)

  // 幂等：同状态再调用不变
  assert.equal(togglePluginInPatchYml(off, 'web-sites', false), off)

  // 改回：agent-driver false -> true
  const on = togglePluginInPatchYml(off, 'agent-driver', true)
  assert.equal(parsePatchDisables(on).get('agent-driver').disabled, true)

  // 条目存在但没有 disabled 行 -> 插入
  const inserted = togglePluginInPatchYml('- id: desktop-pet\n  name: dsh-desktop-pet\n', 'desktop-pet', true)
  assert.match(inserted, /- id: desktop-pet\n  disabled: true/)
  assert.match(inserted, /name: dsh-desktop-pet/)

  // 条目不存在 -> 末尾追加（保留尾部注释结构）
  const appended = togglePluginInPatchYml('# only comments\n- id: other\n  disabled: true\n', 'own-plugin-manager', true)
  assert.match(appended, /- id: own-plugin-manager\n  disabled: true\n?$/)

  // 空文件追加
  const fromEmpty = togglePluginInPatchYml('', 'x-plugin', true)
  assert.match(fromEmpty, /^- id: x-plugin\n  disabled: true\n$/)
  console.log('patchYml toggle ok')
}

// --------------------------------------------------------------- fixture
/** 构造一个微型 DSH home：profile web 装两个插件（link 自研 + npm）。 */
function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-opm-home-'))
  const stateFile = join(home, 'plugin-versions.json')
  const profileDir = join(home, 'profiles', 'web')
  // 源目录刻意模拟 dsh-plugins monorepo 布局（触发自研标记）
  const srcDir = join(home, 'AiProjects', 'dsh-plugins', 'packages', 'dsh-foo')
  mkdirSync(join(profileDir, 'node_modules', 'dsh-foo'), { recursive: true })
  mkdirSync(join(profileDir, 'node_modules', 'dsh-bar'), { recursive: true })
  mkdirSync(srcDir, { recursive: true })

  // link 源目录（自研包 dsh-foo v0.1.0）
  writeFileSync(join(srcDir, 'package.json'), JSON.stringify({ name: 'dsh-foo', version: '0.1.0', description: '自研测试包' }))

  // node_modules 里的安装视图（link 场景下与源一致即可）
  const fooDir = join(profileDir, 'node_modules', 'dsh-foo')
  writeFileSync(join(fooDir, 'package.json'), JSON.stringify({ name: 'dsh-foo', version: '0.1.0', description: '自研测试包' }))
  writeFileSync(join(fooDir, 'cordis.patch.yml'), '- insert:\n    - id: foo\n      name: dsh-foo\n')

  const barDir = join(profileDir, 'node_modules', 'dsh-bar')
  writeFileSync(join(barDir, 'package.json'), JSON.stringify({ name: 'dsh-bar', version: '0.2.0', description: 'npm 包' }))
  mkdirSync(join(barDir, 'lib'), { recursive: true })
  writeFileSync(join(barDir, 'lib', 'index.js'), "export const name = 'bar'\n")

  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# fixture 注释\n- id: foo\n  disabled: true\n')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      'dsh-foo': `link:${srcDir}`,
      'dsh-bar': '^0.2.0',
      'not-a-plugin': '1.0.0',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-foo', 'dsh-bar'] } },
  }, null, 2))

  return { home, stateFile, profileDir, srcDir, fooDir, barDir }
}

// ------------------------------------------------------------ profile scan
{
  const { home } = makeFixture()
  assert.deepEqual(listProfiles(home), ['web'])
  assert.deepEqual(listProfiles(join(home, 'nope')), [])

  const state = readProfileState(home, 'web')
  assert.equal(state.plugins.length, 2) // not-a-plugin 被排除

  const foo = state.plugins.find(p => p.pkg === 'dsh-foo')
  assert.equal(foo.version, '0.1.0')
  assert.equal(foo.own, true)
  assert.equal(foo.bundled, true)
  assert.equal(foo.cordisId, 'foo')       // 取自包内 cordis.patch.yml
  assert.equal(foo.disabled, true)        // 取自 profile patch
  assert.equal(foo.source.type, 'link')

  const bar = state.plugins.find(p => p.pkg === 'dsh-bar')
  assert.equal(bar.cordisId, 'bar')       // 兜底取自 host 源码 export name
  assert.equal(bar.own, false)
  assert.equal(bar.disabled, false)
  assert.equal(bar.source.type, 'npm')
  console.log('readProfileState ok')
}

// -------------------------------------------------------------- checkers
function jsonRes(payload) {
  return { ok: true, status: 200, json: async () => payload }
}
{
  // npm：官方源拿到 latest
  const npm = await checkNpm('dsh-bar', '0.2.0', {
    fetchFn: async url => jsonRes({ 'dist-tags': { latest: '0.3.0' } }),
  })
  assert.equal(npm.latest, '0.3.0')
  assert.equal(npm.hasUpdate, true)
  assert.equal(npm.status, 'ok')

  // npm：已是最新
  const npmSame = await checkNpm('dsh-bar', '0.3.0', {
    fetchFn: async url => jsonRes({ 'dist-tags': { latest: '0.3.0' } }),
  })
  assert.equal(npmSame.hasUpdate, false)

  // npm：官方源 500 -> 回退镜像
  let calls = 0
  const npmFallback = await checkNpm('dsh-bar', '0.2.0', {
    fetchFn: async url => {
      calls += 1
      if (url.includes('registry.npmjs.org')) return { ok: false, status: 500, json: async () => ({}) }
      return jsonRes({ 'dist-tags': { latest: '0.4.0' } })
    },
  })
  assert.equal(calls, 2)
  assert.equal(npmFallback.latest, '0.4.0')
  assert.equal(npmFallback.hasUpdate, true)

  // github：default_branch + raw package.json
  const gh = await checkGithub('csyangwen/dsh-memory-evolve', '0.1.0', {
    fetchFn: async url => {
      if (url.includes('/repos/')) return jsonRes({ default_branch: 'main' })
      if (url.includes('raw.githubusercontent.com')) return jsonRes({ version: '0.2.0' })
      throw new Error(`unexpected url ${url}`)
    },
  })
  assert.equal(gh.branch, 'main')
  assert.equal(gh.latest, '0.2.0')
  assert.equal(gh.hasUpdate, true)

  // tarball：monorepo releases 列表按 <pkg>@ 前缀匹配目标包 tag
  const tgz = await checkTarball('veildawn/dsh-plugins', '0.3.20', {
    pkg: 'dsh-plugin-manager',
    fetchFn: async url => {
      if (url.includes('/releases?')) {
        return jsonRes([
          { tag_name: 'dsh-other-plugin@v9.9.9', draft: false },            // 别的包，须忽略
          { tag_name: 'dsh-plugin-manager@v0.4.0', draft: false },           // 目标包最新
          { tag_name: 'dsh-plugin-manager@v0.3.20', draft: false },          // 目标包次新
        ])
      }
      throw new Error(`unexpected url ${url}`)
    },
  })
  assert.equal(tgz.latest, '0.4.0')
  assert.equal(tgz.hasUpdate, true)

  // tarball：列表无匹配 -> 退回 releases/latest
  const tgzFallback = await checkTarball('a/b', '1.0.0', {
    pkg: 'dsh-x',
    fetchFn: async url => {
      if (url.includes('/releases?')) return jsonRes([{ tag_name: 'unrelated@v2.0.0' }])
      if (url.includes('/releases/latest')) return jsonRes({ tag_name: 'dsh-x@v1.5.0' })
      throw new Error(`unexpected url ${url}`)
    },
  })
  assert.equal(tgzFallback.latest, '1.5.0')
  assert.equal(tgzFallback.hasUpdate, true)
  console.log('net checkers ok')
}

// ------------------------------------------------------------- state io
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opm-state-'))
  const file = join(dir, 'plugin-versions.json')
  assert.deepEqual(readState(file), { version: 1, checkedAt: null, profiles: {} })
  writeState({ version: 1, checkedAt: 'now', profiles: { web: { checkedAt: 'now', plugins: { 'dsh-foo': { type: 'link', hasUpdate: true } } } } }, file)
  const back = readState(file)
  assert.equal(back.profiles.web.plugins['dsh-foo'].hasUpdate, true)
  // 原子写：无 tmp 残留
  assert.equal(readdirSync(dir).filter(f => f.includes('.tmp-')).length, 0)
  rmSync(dir, { recursive: true, force: true })
  console.log('state io ok')
}

// --------------------------------------------------- link refresh baseline
{
  const { home, stateFile, srcDir } = makeFixture()
  const st = { version: 1, checkedAt: null, profiles: {} }
  // 离线 fake registry：dsh-bar 最新 0.3.0
  const fakeFetch = async url => {
    if (/registry\.(npmjs\.org|npmmirror\.com)\/dsh-bar$/.test(url)) {
      return jsonRes({ 'dist-tags': { latest: '0.3.0' } })
    }
    throw new Error(`unexpected fetch ${url}`)
  }

  // 第一轮：基线对齐，无更新
  await refreshProfile(home, 'web', st, { now: Date.now(), fetchFn: fakeFetch })
  assert.equal(st.profiles.web.plugins['dsh-foo'].hasUpdate, false)
  assert.equal(st.profiles.web.plugins['dsh-bar'].latest, '0.3.0')

  // 源码升级 v0.2.0：hasUpdate=true 且基线保持 v0.1.0
  // （同一时刻的第二轮须 force 跳过缓存有效期）
  writeFileSync(join(srcDir, 'package.json'), JSON.stringify({ name: 'dsh-foo', version: '0.2.0' }))
  await refreshProfile(home, 'web', st, { now: Date.now(), fetchFn: fakeFetch, force: true })
  const fooCheck = st.profiles.web.plugins['dsh-foo']
  assert.equal(fooCheck.hasUpdate, true)
  assert.equal(fooCheck.current, '0.2.0')
  assert.equal(fooCheck.base.version, '0.1.0')

  // ack 后基线对齐、徽标清除
  assert.equal(ackLink(st, 'web', 'dsh-foo'), true)
  assert.equal(st.profiles.web.plugins['dsh-foo'].hasUpdate, false)
  assert.equal(st.profiles.web.plugins['dsh-foo'].base.version, '0.2.0')
  assert.equal(ackLink(st, 'web', 'dsh-bar'), false) // 非 link 拒绝

  // buildView 汇总
  const view = buildView(home, { state: st })
  assert.equal(view.profiles.length, 1)
  assert.equal(view.updateCount, 1) // dsh-bar 0.2.0 -> 0.3.0
  const fooView = view.profiles[0].plugins.find(p => p.pkg === 'dsh-foo')
  assert.equal(fooView.own, true)
  assert.equal(fooView.check.current, '0.2.0')
  rmSync(home, { recursive: true, force: true })
  console.log('link baseline + view ok')
}

// ------------------------------------------------------------------ routes
function request(address = '127.0.0.1', headers = {}) {
  return { socket: { remoteAddress: address }, headers: { host: 'localhost:3000', ...headers }, url: '/api/x' }
}

/** Run a registered route handler with a stubbed req/res. */
async function callHandler(handler, { method = 'GET', body = null, address = '127.0.0.1', headers = {} } = {}) {
  let status = 0
  let payload = null
  const req = request(address, headers)
  req.method = method
  if (body !== null) {
    const data = JSON.stringify(body)
    req.on = (event, cb) => {
      if (event === 'data') { const mid = Math.ceil(data.length / 2); cb(data.slice(0, mid)); cb(data.slice(mid)) }
      if (event === 'end') cb()
    }
  } else {
    req.on = () => {}
  }
  const res = {
    writeHead(code) { status = code },
    end(value) { if (value) { try { payload = JSON.parse(value) } catch { payload = value } } },
  }
  await handler(req, res)
  // async handler（含网络请求）回包晚于当前 tick：轮询等 writeHead 落地。
  const deadline = Date.now() + 20000
  while (status === 0 && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve))
  }
  return { status, payload }
}

{
  const { home, stateFile } = makeFixture()
  process.env.DSH_OPM_HOME = home
  process.env.DSH_OPM_STATE = stateFile
  assert.equal(statePath(), stateFile)

  const routes = new Map()
  const fakeCtx = {
    webServer: { register: def => { routes.set(def.path, def.handler); return () => routes.delete(def.path) } },
    effect: fn => { const dispose = fn(); return dispose },
  }
  apply(fakeCtx)
  assert.equal(routes.size, 4)

  // trust fence
  assert.equal(trusted(request()), true)
  assert.equal(trusted(request('::ffff:127.0.0.1')), true)
  assert.equal(trusted(request('192.168.1.2')), false)
  assert.equal(trusted(request('127.0.0.1', { origin: 'https://evil.example' })), false)
  assert.equal(trusted(request('127.0.0.1', { host: 'evil.example' })), false)
  assert.equal(trusted(request('127.0.0.1', { 'sec-fetch-site': 'cross-site' })), false)

  // guards
  assert.equal((await callHandler(routes.get('/api/dsh-opm/state'), { address: '10.0.0.5' })).status, 403)
  assert.equal((await callHandler(routes.get('/api/dsh-opm/state'), { method: 'POST' })).status, 405)

  // state 路由：返回全景（空缓存时 check=null）
  const stateRes = await callHandler(routes.get('/api/dsh-opm/state'))
  assert.equal(stateRes.status, 200)
  assert.equal(stateRes.payload.profiles[0].plugins.length, 2)
  assert.equal(stateRes.payload.updateCount, 0)

  // refresh 路由：注入不了 fetchFn（走全局），这里验证 handler 壳与错误路径
  // —— fixture 的 npm 源在无网络测试环境会标 error，但 handler 必须回 200。
  const refreshRes = await callHandler(routes.get('/api/dsh-opm/refresh'), { method: 'POST', body: { profile: 'web' } })
  assert.equal(refreshRes.status, 200)
  assert.equal(refreshRes.payload.ok, true)
  assert.equal(existsSync(stateFile), true) // 落盘生效

  // toggle 路由：停用 dsh-bar（npm 包、bundled）
  const toggleRes = await callHandler(routes.get('/api/dsh-opm/toggle'), {
    method: 'POST', body: { profile: 'web', plugin: 'dsh-bar', disabled: true },
  })
  assert.equal(toggleRes.status, 200)
  assert.equal(toggleRes.payload.ok, true)
  const patchAfter = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(patchAfter, /# fixture 注释/)                    // 注释保留
  assert.match(patchAfter, /- id: foo\n  disabled: true/)       // 原条目未动
  assert.match(patchAfter, /- id: bar\n  disabled: true\n?$/)     // 新条目追加

  // toggle 未知插件 -> 400
  const unknown = await callHandler(routes.get('/api/dsh-opm/toggle'), {
    method: 'POST', body: { profile: 'web', plugin: 'nope', disabled: true },
  })
  assert.equal(unknown.status, 400)

  // toggle 参数缺失 -> 400
  const missing = await callHandler(routes.get('/api/dsh-opm/toggle'), { method: 'POST', body: {} })
  assert.equal(missing.status, 400)

  // ack 路由：未知插件 -> 400；refresh 已为 dsh-foo 落盘 link 检测条目，直接 ack
  const badAck = await callHandler(routes.get('/api/dsh-opm/ack'), { method: 'POST', body: { profile: 'web', plugin: 'dsh-nope' } })
  assert.equal(badAck.status, 400)
  const st = readState(stateFile)
  assert.equal(st.profiles.web.plugins['dsh-foo'].type, 'link') // refresh 已写入 link 检测
  st.profiles.web.plugins['dsh-foo'].hasUpdate = true
  st.profiles.web.plugins['dsh-foo'].base = { version: '0.1.0', commit: '' }
  writeState(st, stateFile)
  const goodAck = await callHandler(routes.get('/api/dsh-opm/ack'), { method: 'POST', body: { profile: 'web', plugin: 'dsh-foo' } })
  assert.equal(goodAck.status, 200)
  assert.equal(readState(stateFile).profiles.web.plugins['dsh-foo'].hasUpdate, false)

  rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_OPM_HOME
  delete process.env.DSH_OPM_STATE
  console.log('routes ok')
}

console.log('smoke: all ok')
