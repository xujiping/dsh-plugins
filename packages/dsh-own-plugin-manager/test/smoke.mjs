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
 *  10. resolveGitRepo / repoSubpath / checkLink —— link 网络检测：
 *      release 标签优先、分支回退、远端落后不误报、漂移不被网络失败掩盖
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import './client-smoke.mjs'

process.env.DSH_OPM_INTERVAL_MIN = '0' // 关闭后台定时器，测试进程干净退出
delete process.env.DSH_OPM_OWN_REPO // repo 覆盖在对应用例内单独设置

import {
  parseSource, compareVersions, isOwnSource,
  parsePatchDisables, togglePluginInPatchYml,
  listProfiles, readProfileState,
  readState, writeState, statePath,
  reposPath, readRepos, writeRepos, addRepo, removeRepo, parseRepoUrl,
  discoverRepoPlugins, refreshRepos, resolveDshBin, runInstall,
  checkNpm, checkGithub, checkTarball, readLinkFingerprint,
  resolveGitRepo, repoSubpath, checkLink,
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

// ------------------------------------------------------------ repo sources
{
  // parseRepoUrl：三种输入归一
  assert.deepEqual(parseRepoUrl('owner/repo'), { owner: 'owner', name: 'repo', key: 'owner/repo' })
  assert.deepEqual(parseRepoUrl('https://github.com/veildawn/dsh-plugins'), { owner: 'veildawn', name: 'dsh-plugins', key: 'veildawn/dsh-plugins' })
  assert.deepEqual(parseRepoUrl('github:csyangwen/dsh-memory-evolve'), { owner: 'csyangwen', name: 'dsh-memory-evolve', key: 'csyangwen/dsh-memory-evolve' })
  assert.equal(parseRepoUrl('https://gitlab.com/x/y'), null)
  assert.equal(parseRepoUrl('not-a-repo'), null)

  // addRepo / removeRepo：round-trip + 幂等 + 落盘
  const dir = mkdtempSync(join(tmpdir(), 'opm-repos-'))
  const repoFile = join(dir, 'repos.json')
  let repos = addRepo('veildawn/dsh-plugins', [], repoFile)
  assert.equal(repos.length, 1)
  assert.equal(repos[0].repo, 'veildawn/dsh-plugins')
  assert.equal(addRepo('https://github.com/veildawn/dsh-plugins', repos, repoFile).length, 1, '重复添加幂等')
  assert.equal(readRepos(repoFile).length, 1)
  assert.equal(removeRepo('veildawn/dsh-plugins', readRepos(repoFile), repoFile), true)
  assert.equal(readRepos(repoFile).length, 0)
  assert.equal(removeRepo('nope/nope', readRepos(repoFile), repoFile), false)
  rmSync(dir, { recursive: true, force: true })
  console.log('repo sources ok')
}

// ------------------------------------------------------ repo plugin discovery
{
  // 主模式（monorepo）：releases tags 解析 `<pkg>@vX.Y.Z`
  const fetchFn = async url => {
    if (url.includes('/releases?per_page=100')) {
      return {
        ok: true,
        json: async () => [
          { tag_name: 'dsh-plugin-manager@v0.3.20', draft: false },
          { tag_name: 'dsh-ai-proxy@v0.3.4', draft: false },
          { tag_name: 'dsh-ai-proxy@v0.2.9', draft: false },
          { tag_name: 'not-a-plugin-tag', draft: false },
          { tag_name: 'dsh-foo@v1.0.0', draft: true }, // draft 忽略
        ],
      }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  const mono = await discoverRepoPlugins('veildawn/dsh-plugins', { fetchFn })
  assert.equal(mono.mode, 'monorepo')
  assert.equal(mono.plugins.length, 2)
  const byName = Object.fromEntries(mono.plugins.map(p => [p.pkg, p]))
  assert.equal(byName['dsh-ai-proxy'].version, '0.3.4') // 取最高版本
  assert.equal(byName['dsh-ai-proxy'].tgzUrl, 'https://github.com/veildawn/dsh-plugins/releases/download/dsh-ai-proxy%40v0.3.4/dsh-ai-proxy-0.3.4.tgz')
  assert.equal(byName['dsh-plugin-manager'].version, '0.3.20')

  // 回退模式（单插件仓库）：无 `<pkg>@` tag → 读默认分支根 package.json
  const fetchSingle = async url => {
    if (url.includes('/repos/solo/repo')) {
      return { ok: true, json: async () => ({ default_branch: 'main' }) }
    }
    if (url.includes('raw.githubusercontent.com/solo/repo/main/package.json')) {
      return { ok: true, json: async () => ({ name: 'dsh-solo', version: '0.5.0' }) }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  const single = await discoverRepoPlugins('solo/repo', { fetchFn: fetchSingle })
  assert.equal(single.mode, 'single')
  assert.equal(single.plugins.length, 1)
  assert.equal(single.plugins[0].pkg, 'dsh-solo')
  assert.equal(single.plugins[0].spec, 'github:solo/repo')

  // 网络失败：plugins 空、error 记录、不抛
  const fail = await discoverRepoPlugins('x/y', { fetchFn: async () => { throw new Error('boom') } })
  assert.equal(fail.plugins.length, 0)
  assert.match(fail.error, /boom/)

  // refreshRepos：快照并入状态 + 缓存生效（force 控制）
  const st = { profiles: {}, repos: {} }
  const { state: st2 } = await refreshRepos(st, [{ repo: 'veildawn/dsh-plugins' }], { fetchFn, now: 1000 })
  assert.equal(st2.repos['veildawn/dsh-plugins'].plugins.length, 2)
  assert.equal(st2.repos['veildawn/dsh-plugins'].checkedAt, new Date(1000).toISOString())
  // 未过期则走缓存（不触发网络）
  let called = false
  const { state: st3 } = await refreshRepos(st2, [{ repo: 'veildawn/dsh-plugins' }], { fetchFn: async () => { called = true; throw new Error('should not hit') }, now: 1000 + 60_000 })
  assert.equal(called, false)
  assert.equal(st3.repos['veildawn/dsh-plugins'].plugins.length, 2)

  // buildView 附带 repos（关联已安装）
  const home2 = mkdtempSync(join(tmpdir(), 'opm-home-'))
  const repoFile2 = join(home2, 'repos.json')
  mkdirSync(join(home2, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home2, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: {
      'dsh-ai-proxy': 'https://github.com/veildawn/dsh-plugins/releases/download/dsh-ai-proxy%40v0.3.4/dsh-ai-proxy-0.3.4.tgz',
    },
    dsh: { profile: { bundles: ['dsh-ai-proxy'] } },
  }), 'utf8')
  writeFileSync(repoFile2, JSON.stringify({ version: 1, repos: [{ repo: 'veildawn/dsh-plugins', addedAt: 'x' }] }), 'utf8')
  process.env.DSH_OPM_REPOS = repoFile2
  const view = buildView(home2, { state: st3, profiles: ['web'] })
  const repoView = view.repos[0]
  assert.equal(repoView.repo, 'veildawn/dsh-plugins')
  assert.equal(repoView.plugins.length, 2)
  assert.deepEqual(repoView.installed['dsh-ai-proxy'], [{ profile: 'web', version: '0.3.4' }])
  assert.equal('dsh-plugin-manager' in repoView.installed, false)
  delete process.env.DSH_OPM_REPOS
  rmSync(home2, { recursive: true, force: true })
  console.log('repo discovery ok')
}

// ----------------------------------------------------------------- install
{
  // resolveDshBin：注入 PATH 探测
  const bin = resolveDshBin({ PATH: '' })
  // 真实机器上可能在 /opt/homebrew/bin 命中，无法断言非空；只断言函数可调用
  assert.equal(typeof bin, 'string' || 'null')

  // runInstall：注入 fake spawn，验证参数与成功/失败分支
  let spawned = null
  const fakeSpawn = (cmd, args, opts) => {
    spawned = { cmd, args, opts }
    return { status: 0, stdout: 'installed ok', stderr: '', error: undefined }
  }
  const ok = runInstall('web', 'dsh-ai-proxy@0.3.4', { spawn: fakeSpawn })
  assert.equal(ok.ok, true)
  assert.ok(spawned.args.includes('plugin'))
  assert.ok(spawned.args.includes('web'))
  assert.ok(spawned.args.includes('add'))
  assert.ok(spawned.args.includes('dsh-ai-proxy@0.3.4'))

  // 失败分支：非零 exit → stderrTail
  const fakeFail = (cmd, args, opts) => ({ status: 1, stdout: '', stderr: 'pnpm failed: allowBuilds\n', error: undefined })
  const fail = runInstall('web', 'x', { spawn: fakeFail })
  assert.equal(fail.ok, false)
  assert.match(fail.error, /allowBuilds/)
  assert.match(fail.stderrTail, /allowBuilds/)
  console.log('install ok')
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

// --------------------------------------------- link 网络检测（release/branch）
/** 构造带 origin remote 的微型 git monorepo（packages/dsh-foo v0.1.0）。 */
function makeGitFixture(remote = 'git@github.com:aa/bb.git') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opm-git-'))
  const src = join(dir, 'packages', 'dsh-foo')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'dsh-foo', version: '0.1.0' }))
  execSync('git init -q', { cwd: dir, stdio: 'ignore' })
  execSync(`git remote add origin ${remote}`, { cwd: dir, stdio: 'ignore' })
  return { dir, src }
}

/** 按 URL 正则表路由的 fake fetch。 */
function routeFetch(routes) {
  return async url => {
    for (const [re, payload] of routes) if (re.test(url)) return jsonRes(payload)
    throw new Error(`unexpected fetch ${url}`)
  }
}

{
  // repo 解析：env 覆盖 > git remote；https/git@ 两种形态
  assert.equal(resolveGitRepo('/anywhere', { env: { DSH_OPM_OWN_REPO: 'x/y' } }), 'x/y')
  const gf = makeGitFixture()
  assert.equal(resolveGitRepo(gf.src), 'aa/bb')
  assert.equal(repoSubpath(gf.src), 'packages/dsh-foo')
  assert.equal(repoSubpath(join(gf.dir, 'not-git')), '')
  const gh = makeGitFixture('https://github.com/cc/dd.git')
  assert.equal(resolveGitRepo(gh.src), 'cc/dd')
  rmSync(gf.dir, { recursive: true, force: true })
  rmSync(gh.dir, { recursive: true, force: true })
  console.log('resolveGitRepo ok')
}

{
  const { dir, src } = makeGitFixture()
  const info = { pkg: 'dsh-foo', source: { type: 'link', path: src } }
  const now = Date.parse('2026-09-22T00:00:00Z')

  // ① release 标签命中（列表里混着别的包的 tag，按前缀过滤）
  const relFetch = routeFetch([
    [/\/releases\?per_page=100$/, [
      { tag_name: 'dsh-other@v9.9.9', draft: false },
      { tag_name: 'dsh-foo@v0.2.0', draft: false, html_url: 'https://github.com/aa/bb/releases/tag/dsh-foo%40v0.2.0' },
    ]],
  ])
  let out = await checkLink(info, null, { fetchFn: relFetch, repo: 'aa/bb', now })
  assert.equal(out.latest, '0.2.0')
  assert.equal(out.latestSource, 'release')
  assert.equal(out.remoteHasUpdate, true)
  assert.equal(out.driftHasUpdate, false)
  assert.equal(out.hasUpdate, true)
  assert.ok(out.url.includes('releases/tag'))

  // ② 无匹配标签 → 回退默认分支 packages/<pkg>/package.json
  const branchFetch = routeFetch([
    [/\/releases\?per_page=100$/, []],
    [/\/repos\/aa\/bb$/, { default_branch: 'main' }],
    [/raw\.githubusercontent\.com\/aa\/bb\/main\/packages\/dsh-foo\/package\.json$/, { version: '0.2.0' }],
  ])
  out = await checkLink(info, null, { fetchFn: branchFetch, repo: 'aa/bb', now })
  assert.equal(out.latest, '0.2.0')
  assert.equal(out.latestSource, 'branch')
  assert.equal(out.branch, 'main')
  assert.equal(out.remoteHasUpdate, true)

  // ③ 远端落后于本地（本地开发中未 push）→ 不误报
  const behindFetch = routeFetch([
    [/\/releases\?per_page=100$/, []],
    [/\/repos\/aa\/bb$/, { default_branch: 'main' }],
    [/raw\.githubusercontent\.com/, { version: '0.0.9' }],
  ])
  out = await checkLink(info, null, { fetchFn: behindFetch, repo: 'aa/bb', now })
  assert.equal(out.remoteHasUpdate, false)
  assert.equal(out.hasUpdate, false)

  // ④ 仅漂移（本地已 bump 到 0.2.0，远端同版本，基线 0.1.0）→ 漂移信号
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'dsh-foo', version: '0.2.0' }))
  const prev = { base: { version: '0.1.0', commit: '' } }
  const driftFetch = routeFetch([
    [/\/releases\?per_page=100$/, []],
    [/\/repos\/aa\/bb$/, { default_branch: 'main' }],
    [/raw\.githubusercontent\.com/, { version: '0.2.0' }],
  ])
  out = await checkLink(info, prev, { fetchFn: driftFetch, repo: 'aa/bb', now })
  assert.equal(out.remoteHasUpdate, false)
  assert.equal(out.driftHasUpdate, true)
  assert.equal(out.hasUpdate, true)
  // ack 只清漂移，不清远端信号
  assert.equal(ackLink({ profiles: { p: { plugins: { 'dsh-foo': out } } } }, 'p', 'dsh-foo'), true)
  assert.equal(out.driftHasUpdate, false)
  assert.equal(out.hasUpdate, false)

  // ⑤ 网络失败：不掩盖漂移；remoteError 记录、status 保持 ok
  const failFetch = async () => { throw new Error('offline') }
  out = await checkLink(info, prev, { fetchFn: failFetch, repo: 'aa/bb', now })
  assert.equal(out.remoteHasUpdate, false)
  assert.equal(out.driftHasUpdate, true)
  assert.equal(out.hasUpdate, true)
  assert.equal(out.status, 'ok')
  assert.match(out.remoteError, /offline/)

  // ⑥ repo 解析失败（非 git 目录且无 env）→ 纯本地指纹，零网络请求
  const plainSrc = mkdtempSync(join(tmpdir(), 'dsh-opm-plain-'))
  writeFileSync(join(plainSrc, 'package.json'), JSON.stringify({ version: '0.1.0' }))
  const noFetch = async url => { throw new Error(`unexpected fetch ${url}`) }
  out = await checkLink({ pkg: 'dsh-foo', source: { type: 'link', path: plainSrc } }, null, { fetchFn: noFetch, now })
  assert.equal(out.latest, null)
  assert.equal(out.remoteHasUpdate, false)
  assert.equal(out.hasUpdate, false) // 首次：基线即当前指纹
  assert.equal(out.status, 'ok')
  rmSync(plainSrc, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
  console.log('checkLink ok')
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
  assert.equal(routes.size, 9)

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

  // repos 路由：GET 空列表
  const reposEmpty = await callHandler(routes.get('/api/dsh-opm/repos'))
  assert.equal(reposEmpty.status, 200)
  assert.equal(reposEmpty.payload.repos.length, 0)

  // repos/add：非法 URL -> 400
  const reposBad = await callHandler(routes.get('/api/dsh-opm/repos/add'), { method: 'POST', body: { url: 'not-a-repo' } })
  assert.equal(reposBad.status, 400)

  // repos/remove：不存在 -> 400
  const reposRmBad = await callHandler(routes.get('/api/dsh-opm/repos/remove'), { method: 'POST', body: { repo: 'nope/nope' } })
  assert.equal(reposRmBad.status, 400)

  // install 路由：desktop 之外的 profile 若 spawn 失败（无 dsh bin / 测试环境）也应回 200 且 ok:false
  const installRes = await callHandler(routes.get('/api/dsh-opm/install'), { method: 'POST', body: { profile: 'web', spec: 'dsh-ai-proxy@0.3.4' } })
  assert.equal(installRes.status, 200)
  assert.equal(typeof installRes.payload.ok, 'boolean')
  // install 参数缺失 -> 400
  const installBad = await callHandler(routes.get('/api/dsh-opm/install'), { method: 'POST', body: { profile: 'web' } })
  assert.equal(installBad.status, 400)

  rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_OPM_HOME
  delete process.env.DSH_OPM_STATE
  console.log('routes ok')
}

console.log('smoke: all ok')
