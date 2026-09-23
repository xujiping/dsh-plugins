/**
 * dsh-own-plugin-manager — core logic (pure, dependency-free, testable).
 *
 * 职责：
 *   - parseSource：把 profile package.json 的依赖声明归一为
 *     npm / github / link / tarball / other 五类来源
 *   - compareVersions：宽松 semver 比较（v 前缀、预发布、非 semver 回退）
 *   - listProfiles / readProfileState：扫描 ~/.dsh/profiles/<name>，聚合
 *     插件清单（版本、来源、启停、自研标记、cordis id、bundled）
 *   - parsePatchDisables / togglePluginInPatchYml：对 profile cordis.patch.yml
 *     做行级启停 patch（保留用户手写注释，绝不整体重写）
 *   - checkNpm / checkGithub / checkTarball / checkLink：四类来源的版本
 *     更新检测（fetch / git 可注入，便于测试与沙箱）；link 类为
 *     「远端最新版 + 本地漂移」双信号：远端优先 GitHub release 标签
 *     （<pkg>@vX.Y.Z），无匹配回退默认分支 <subpath>/package.json
 *   - readState / writeState：检测快照 + 缓存落盘（原子写）
 *   - refreshProfile / refreshAll：按缓存有效期增量刷新，link 类发现源码
 *     变化后保持基线直到 ack（表示「已重启生效」）
 *
 * 所有时间参数都可注入（now），所有网络访问都可注入（fetchFn），零依赖。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// ------------------------------------------------------------------ constants

export const NPM_REGISTRY_PRIMARY = 'https://registry.npmjs.org'
export const NPM_REGISTRY_FALLBACK = 'https://registry.npmmirror.com'
export const GITHUB_API = 'https://api.github.com'
export const FETCH_TIMEOUT_MS = 8000
/** 检测缓存有效期（分钟），可用 DSH_OPM_CHECK_MAX_AGE_MIN 覆盖。 */
export const CHECK_MAX_AGE_MIN = Number(process.env.DSH_OPM_CHECK_MAX_AGE_MIN || 360)

/** 默认状态文件：~/.dsh/plugin-versions.json（DSH_OPM_STATE 可覆盖）。 */
export function statePath() {
  return process.env.DSH_OPM_STATE || join(homedir(), '.dsh', 'plugin-versions.json')
}

/** 默认 DSH 根目录：~/.dsh（DSH_OPM_HOME 可覆盖，测试用）。 */
export function dshHome() {
  return process.env.DSH_OPM_HOME || join(homedir(), '.dsh')
}

/** 仓库源配置文件路径（DSH_OPM_REPOS 可覆盖，测试用）。 */
export function reposPath() {
  return process.env.DSH_OPM_REPOS || join(dshHome(), 'plugin-repos.json')
}

// ------------------------------------------------------------ source parsing

/**
 * 归一化依赖声明值为来源描述。
 *
 *   link:~/ai/pkgs/x      -> { type:'link', path:'/Users/me/ai/pkgs/x' }
 *   link:/abs/path        -> { type:'link', path:'/abs/path' }
 *   ^1.2.3 / ~1.0 / 1.2.3 -> { type:'npm', version:'1.2.3', range:'^1.2.3' }
 *   github:owner/repo#ref -> { type:'github', repo:'owner/repo', ref:'ref' }
 *   https://.../releases/download/<name>@v<ver>/<name>-<ver>.tgz
 *                        -> { type:'tarball', repo:'owner/repo', tag:'<name>@v<ver>', version:'<ver>' }
 *   其他（file:/git+https/...）-> { type:'other', spec }
 */
export function parseSource(value) {
  const spec = String(value ?? '').trim()
  if (spec === '') return { type: 'other', spec }

  if (spec.startsWith('link:')) {
    let p = spec.slice(5)
    if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
    return { type: 'link', path: resolve(p), spec }
  }

  const tarball = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/releases\/download\/([^/\s]+)\/[^/\s]+\.tgz$/i.exec(spec)
  if (tarball) {
    const tag = decodeURIComponent(tarball[3])
    const v = /\.?v?(\d[^\s-]*)/i.exec(tag)?.[1] || ''
    return { type: 'tarball', repo: `${tarball[1]}/${tarball[2]}`, tag, version: v, spec }
  }

  const gh = /^github:([^#\s]+)(?:#(.+))?$/.exec(spec)
  if (gh) return { type: 'github', repo: gh[1].replace(/\.git$/, ''), ref: gh[2] || '', spec }

  if (/^[\^~><=]*\s*\d/.test(spec) || spec === '*' || spec === 'latest') {
    const version = /^[\^~><=\s]*v?(\d+(?:\.\d+){0,2})/.exec(spec)?.[1] || ''
    return { type: 'npm', version, range: spec, spec }
  }

  return { type: 'other', spec }
}

/** link 源路径指向 dsh-plugins monorepo 的包视为自研插件。 */
export function isOwnSource(source) {
  return source?.type === 'link' && /\/dsh-plugins\/packages\/[^/]+\/?$/.test(source.path)
}

// ------------------------------------------------------------- version compare

/** 宽松 semver 解析：v 前缀、1-3 段数字；返回 [major,minor,patch,pre] 或 null。 */
export function parseSemver(text) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(String(text ?? '').trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0), m[4] || '']
}

/** 比较 a/b：a>b 返回 1，a<b 返回 -1，相等 0；非 semver 时按字符串比较。 */
export function compareVersions(a, b) {
  const sa = String(a ?? ''), sb = String(b ?? '')
  const pa = parseSemver(sa), pb = parseSemver(sb)
  if (!pa || !pb) return sa === sb ? 0 : sa > sb ? 1 : -1
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  const preA = pa[3], preB = pb[3]
  if (preA === preB) return 0
  // 无预发布 > 有预发布；两个预发布按字典序（简化 semver 规则）
  if (preA === '') return 1
  if (preB === '') return -1
  return preA > preB ? 1 : -1
}

// --------------------------------------------------------------- profile scan

/** 列出 DSH 根目录下所有 profile 名（跳过 node_modules 等非目录）。 */
export function listProfiles(home = dshHome()) {
  try {
    return readdirSync(join(home, 'profiles'), { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'node_modules')
      .map(e => e.name)
      .sort()
  } catch {
    return []
  }
}

/** 读取 JSON 文件；缺失/损坏返回 null。 */
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** 从插件包自身的 cordis.patch.yml 里提取 cordis id（insert 条目的 id）。 */
function cordisIdFromBundlePatch(pkgDir) {
  try {
    const text = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8')
    const m = /-?\s*id:\s*['"]?([A-Za-z0-9_-]+)['"]?/.exec(text)
    return m ? m[1] : null
  } catch { return null }
}

/** 兜底：从插件 host 半边源码提取 `export const name = '...'`。 */
function cordisIdFromHostSource(pkgDir) {
  try {
    const text = readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8')
    const m = /export\s+const\s+name\s*=\s*['"]([^'"]+)['"]/.exec(text)
    return m ? m[1] : null
  } catch { return null }
}

/**
 * 解析 profile cordis.patch.yml 文本中的启停条目。
 * 返回 Map<cordisId, { disabled, line }>（line 为 `- id:` 所在行号，0 起）。
 */
export function parsePatchDisables(text) {
  const out = new Map()
  const lines = String(text ?? '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-\s*id:\s*['"]?([A-Za-z0-9_@/.-]+)['"]?\s*$/.exec(lines[i])
    if (!m) continue
    const entry = { disabled: false, line: i }
    // 条目作用域：紧随其后的同级或更深缩进行，直到下一个 `- ` 顶层列表项
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (/^\s*-\s+/.test(line)) break
      if (/^\s*#/.test(line) || line.trim() === '') continue
      const d = /^(\s*)disabled:\s*(\S+).*$/i.exec(line)
      if (d && /^\s+/.test(line)) { entry.disabled = d[2].toLowerCase() !== 'false'; entry.disabledLine = j; entry.disabledIndent = d[1] }
    }
    out.set(m[1], entry)
  }
  return out
}

/**
 * 行级 patch：把 cordis.patch.yml 中某插件条目置为 disabled=true/false。
 * - 已有条目：改写 / 插入 `  disabled:` 行（缩进对齐条目现有属性）
 * - 没有条目：文件末尾追加 `- id: <id>` + `  disabled: <v>`
 * - 其余行与注释原样保留；幂等（重复调用同一状态不产生 diff）
 */
export function togglePluginInPatchYml(text, id, disabled) {
  const lines = String(text ?? '').split('\n')
  const disables = parsePatchDisables(text)
  const entry = disables.get(id)
  const want = `disabled: ${disabled ? 'true' : 'false'}`

  if (entry) {
    if (entry.disabledLine !== undefined) {
      if ((entry.disabled === true) === (disabled === true) && /disabled:\s*(true|false)/i.test(lines[entry.disabledLine])) {
        return lines.join('\n') // already in desired state
      }
      lines[entry.disabledLine] = `${entry.disabledIndent || '  '}${want}`
    } else {
      lines.splice(entry.line + 1, 0, `  ${want}`)
    }
    return lines.join('\n')
  }

  // append a fresh entry at the end of the file
  let body = lines
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  const suffix = body.length > 0 ? '\n' : ''
  return `${body.join('\n')}${suffix}- id: ${id}\n  ${want}\n`
}

/**
 * 读取单个 profile 的插件全景。
 *
 * 返回 { name, plugins: PluginInfo[] }，PluginInfo：
 *   { pkg, version, description, source, own, bundled, cordisId, disabled }
 */
export function readProfileState(home, profile) {
  const dir = join(home, 'profiles', profile)
  const manifest = readJson(join(dir, 'package.json')) || {}
  const deps = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []

  let patchText = ''
  try { patchText = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8') } catch { /* 可选文件 */ }
  const disables = parsePatchDisables(patchText)

  const plugins = []
  for (const [pkg, depValue] of Object.entries(deps)) {
    const source = parseSource(depValue)
    // dsh- 插件包才纳入管理（profile 自身 key 形如 dsh-profile-web）
    if (!/^dsh[-_@]/.test(pkg) && !/^(dshmarket)$/.test(pkg)) continue
    const pkgDir = join(dir, 'node_modules', ...pkg.split('/'))
    const pj = readJson(join(pkgDir, 'package.json')) || {}
    const cordisId = cordisIdFromBundlePatch(pkgDir) || cordisIdFromHostSource(pkgDir) || pkg.replace(/^dsh-/, '')
    const patchEntry = disables.get(cordisId) || disables.get(pkg)
    plugins.push({
      pkg,
      version: String(pj.version || source.version || ''),
      description: String(pj.description || ''),
      source,
      own: isOwnSource(source),
      bundled: bundles.includes(pkg),
      cordisId,
      disabled: patchEntry ? patchEntry.disabled : false,
    })
  }
  plugins.sort((a, b) => (b.own - a.own) || a.pkg.localeCompare(b.pkg))
  return { name: profile, plugins }
}

// ------------------------------------------------------------------ state io

/** 读状态文件；缺失/损坏返回空骨架。 */
export function readState(path = statePath()) {
  const data = readJson(path)
  if (!data || typeof data !== 'object' || typeof data.profiles !== 'object') {
    return { version: 1, checkedAt: null, profiles: {} }
  }
  return data
}

/** 原子写状态文件（tmp + rename），目录不存在则创建。 */
export function writeState(state, path = statePath()) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, path)
  return state
}

// ------------------------------------------------------------ repo sources

/** 仓库源配置：`[{ repo: 'owner/name', addedAt }]`。缺失/损坏返回空列表。 */
export function readRepos(path = reposPath()) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(data)) return data
    if (Array.isArray(data?.repos)) return data.repos
  } catch { /* 缺失/损坏 */ }
  return []
}

/** 原子写仓库源配置。 */
export function writeRepos(repos, path = reposPath()) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ version: 1, repos }, null, 2), 'utf8')
  renameSync(tmp, path)
  return repos
}

/** 归一化仓库输入：`owner/name`、`https://github.com/owner/name`、`github:owner/name`
 *  → `{ owner, name, key: 'owner/name' }`；非 GitHub 仓库返回 null。 */
export function parseRepoUrl(input) {
  const spec = String(input ?? '').trim()
  const m = /^(?:https?:\/\/github\.com\/|github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(spec)
  if (!m) return null
  return { owner: m[1], name: m[2], key: `${m[1]}/${m[2]}` }
}

/** 添加仓库源（已存在返回 false）；返回更新后的列表。 */
export function addRepo(input, repos = readRepos(), path = reposPath()) {
  const parsed = parseRepoUrl(input)
  if (!parsed) throw new Error(`无法识别的 GitHub 仓库地址：${input}`)
  if (repos.some(r => r.repo === parsed.key)) return repos
  const next = [...repos, { repo: parsed.key, addedAt: new Date().toISOString() }]
  writeRepos(next, path)
  return next
}

/** 移除仓库源；不存在返回 false。 */
export function removeRepo(key, repos = readRepos(), path = reposPath()) {
  const next = repos.filter(r => r.repo !== key)
  if (next.length === repos.length) return false
  writeRepos(next, path)
  return true
}

// ------------------------------------------------------ repo plugin discovery

/**
 * 发现一个 GitHub 仓库发布的 DSH 插件。
 *
 * 主模式（monorepo）：拉 releases 列表，解析 `<pkg>@vX.Y.Z` 形式的 tag →
 * `{ pkg, version, tag, tgzUrl, repo }`（tgz 附件 URL 按 DSH release 惯例拼装，
 * 不逐个请求 release 资产）。
 * 回退模式（单插件仓库）：releases 无 `<pkg>@` tag 时，读默认分支根
 * `package.json`，取 name/version → `{ pkg, version, spec: 'github:owner/name', repo }`。
 *
 * 返回 { plugins, mode, error }；网络失败 plugins 为空、error 记录原因。
 */
export async function discoverRepoPlugins(repo, { fetchFn, now = Date.now() } = {}) {
  const out = { plugins: [], mode: 'none', error: null, checkedAt: new Date(now).toISOString() }
  try {
    const list = await fetchJson(`${GITHUB_API}/repos/${repo}/releases?per_page=100`, { fetchFn, headers: { accept: 'application/vnd.github+json' } })
    const tags = (Array.isArray(list) ? list : [])
      .filter(rel => !rel.draft)
      .map(rel => String(rel.tag_name || ''))
      .filter(Boolean)

    const seen = new Map() // pkg -> 最高版本条目
    for (const tag of tags) {
      const m = /^([A-Za-z0-9_.-]+)@v?(\d[^\s]*)\.tgz$/.exec(tag)
      const m2 = m ? null : /^([A-Za-z0-9_.-]+)@v?(\d[^\s]*)$/.exec(tag)
      const hit = m || m2
      if (!hit) continue
      const pkg = hit[1]
      const version = String(hit[2])
      const prev = seen.get(pkg)
      if (!prev || compareVersions(version, prev.version) > 0) {
        seen.set(pkg, {
          pkg,
          version,
          tag,
          tgzUrl: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${pkg}-${version}.tgz`,
          repo,
        })
      }
    }

    if (seen.size > 0) {
      out.plugins = [...seen.values()].sort((a, b) => a.pkg.localeCompare(b.pkg))
      out.mode = 'monorepo'
      return out
    }

    // 回退：单插件仓库 —— 默认分支根 package.json
    const meta = await fetchJson(`${GITHUB_API}/repos/${repo}`, { fetchFn, headers: { accept: 'application/vnd.github+json' } })
    const branch = meta?.default_branch || 'main'
    const pj = await fetchJson(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/package.json`, { fetchFn, headers: { accept: 'application/vnd.github.raw' } })
    const pkg = String(pj?.name || '')
    const version = String(pj?.version || '')
    if (pkg && version) {
      out.plugins = [{ pkg, version, spec: `github:${repo}`, repo, branch }]
      out.mode = 'single'
    }
    return out
  } catch (error) {
    out.error = String(error?.message || error)
    return out
  }
}

/**
 * 刷新关注仓库的插件快照，并入状态文件（state.repos）。
 * 传 only 时只刷指定仓库（单仓库刷新），其余仓库快照原样保留。
 * 返回 { state, results }；单仓库失败不拖垮整体。
 */
export async function refreshRepos(state = readState(), repos = readRepos(), { fetchFn, force = false, now = Date.now(), only = null } = {}) {
  if (!state.repos) state.repos = {}
  const results = {}
  for (const entry of repos) {
    const key = entry.repo
    if (only && key !== only) continue
    const prev = state.repos[key]
    if (!force && prev?.checkedAt && now - Date.parse(prev.checkedAt) < CHECK_MAX_AGE_MIN * 60_000) {
      results[key] = { cached: true }
      continue
    }
    try {
      const found = await discoverRepoPlugins(key, { fetchFn, now })
      state.repos[key] = { ...found, repo: key }
      results[key] = { ok: true, plugins: found.plugins.length, mode: found.mode }
    } catch (error) {
      results[key] = { error: String(error?.message || error) }
    }
  }
  return { state, results }
}

// ------------------------------------------------------------------ install

/** 探测 dsh 可执行文件：PATH 优先，回退常见安装目录（Electron 窄 PATH 兜底）。 */
export function resolveDshBin(env = process.env) {
  const dirs = (env.PATH || '').split(':').filter(Boolean)
  for (const dir of [...dirs, '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']) {
    try {
      const candidate = join(dir, 'dsh')
      if (existsSync(candidate)) return candidate
    } catch { /* 目录不存在 */ }
  }
  return null
}

/**
 * 一键安装/更新插件：spawn `dsh plugin --profile <p> add <spec>`。
 *
 * 注入 spawnFn 便于测试；失败（dsh 不在 PATH / pnpm 报错）返回
 * `{ ok:false, code, error, stderrTail }`，不抛异常。
 */
export function runInstall(profile, spec, { env = process.env, spawn = spawnSync } = {}) {
  const bin = resolveDshBin(env)
  if (!bin) return { ok: false, code: -1, error: '未找到 dsh 可执行文件（PATH 与常见目录均无）' }
  try {
    const result = spawn(bin, ['plugin', '--profile', profile, 'add', spec], {
      encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = String(result.stdout || '')
    const stderr = String(result.stderr || '')
    const code = result.status ?? (result.error ? -1 : 0)
    const tail = (stderr + stdout).trim().split('\n').slice(-6).join('\n')
    if (code !== 0) {
      return { ok: false, code, error: stderr.trim() || stdout.trim() || `安装失败（exit ${code}）`, stderrTail: tail }
    }
    return { ok: true, code, stdout: tail }
  } catch (error) {
    return { ok: false, code: -1, error: String(error?.message || error) }
  }
}

// --------------------------------------------------------------- net helpers

function makeFetch(fetchFn) {
  const f = fetchFn || globalThis.fetch
  if (!f) throw new Error('当前环境无 fetch 可用')
  return f
}

async function fetchJson(url, { fetchFn, headers = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await makeFetch(fetchFn)(url, { headers, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// ------------------------------------------------------------- checkers (net)

/** npm 源检测：registry dist-tags.latest 与当前版本比较。 */
export async function checkNpm(pkg, current, { fetchFn } = {}) {
  const result = { type: 'npm', current: current || '', latest: null, hasUpdate: false, status: 'ok', url: `https://www.npmjs.com/package/${pkg}?tab=versions` }
  const bases = [NPM_REGISTRY_PRIMARY, NPM_REGISTRY_FALLBACK]
  let lastError = null
  for (const base of bases) {
    try {
      const data = await fetchJson(`${base}/${encodeURIComponent(pkg)}`, { fetchFn, headers: { accept: 'application/vnd.npm.install-v1+json' } })
      const latest = data?.['dist-tags']?.latest || null
      if (!latest) throw new Error('响应缺少 dist-tags.latest')
      result.latest = latest
      result.hasUpdate = latest !== current && compareVersions(latest, current) > 0
      return result
    } catch (error) { lastError = error }
  }
  result.status = `error: ${lastError?.message || '网络异常'}`
  return result
}

/** github: 源检测：仓库默认分支 package.json 的 version。 */
export async function checkGithub(repo, current, { fetchFn } = {}) {
  const result = { type: 'github', current: current || '', latest: null, hasUpdate: false, status: 'ok', url: `https://github.com/${repo}/releases` }
  try {
    const meta = await fetchJson(`${GITHUB_API}/repos/${repo}`, { fetchFn, headers: { accept: 'application/vnd.github+json' } })
    const branch = meta?.default_branch || 'main'
    const headers = { accept: 'application/vnd.github.raw' }
    const pj = await fetchJson(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/package.json`, { fetchFn, headers })
    const latest = String(pj?.version || '')
    result.latest = latest
    result.branch = branch
    result.hasUpdate = latest !== '' && latest !== current && compareVersions(latest, current) > 0
  } catch (error) {
    result.status = `error: ${error.message}`
  }
  return result
}

/**
 * GitHub release tarball 检测：tag 与已装版本比较。
 *
 * monorepo（一个 repo 发多个插件包）的 releases 列表混着多个包的 tag
 * （形如 `<pkg>@v0.3.20`），`releases/latest` 可能是别的包 —— 所以按
 * `<pkg>@` 前缀过滤 releases 列表取目标包最新 tag；无匹配再退回 latest。
 */
export async function checkTarball(repo, current, { fetchFn, pkg = '' } = {}) {
  const result = { type: 'tarball', current: current || '', latest: null, hasUpdate: false, status: 'ok', url: `https://github.com/${repo}/releases` }
  try {
    let tag = ''
    if (pkg !== '') {
      const list = await fetchJson(`${GITHUB_API}/repos/${repo}/releases?per_page=100`, { fetchFn, headers: { accept: 'application/vnd.github+json' } })
      const prefix = `${pkg}@`
      const hit = (Array.isArray(list) ? list : [])
        .find(rel => String(rel?.tag_name || '').startsWith(prefix) && !rel.draft)
      if (hit) tag = String(hit.tag_name)
    }
    if (tag === '') {
      const rel = await fetchJson(`${GITHUB_API}/repos/${repo}/releases/latest`, { fetchFn, headers: { accept: 'application/vnd.github+json' } })
      tag = String(rel?.tag_name || '')
    }
    const latest = /\.?v?(\d[^\s-]*)/i.exec(tag)?.[1] || tag
    result.latest = latest
    result.hasUpdate = latest !== '' && latest !== current && compareVersions(latest, current) > 0
  } catch (error) {
    result.status = `error: ${error.message}`
  }
  return result
}

// ---------------------------------------------------------- checker (local)

/** 读取 link 源目录的 { version, commit }（git 不可用时 commit 为空）。 */
export function readLinkFingerprint(sourcePath) {
  const out = { version: '', commit: '' }
  try {
    const pj = readJson(join(sourcePath, 'package.json'))
    out.version = String(pj?.version || '')
  } catch { /* 源目录缺失 */ }
  try {
    out.commit = execFileSync('git', ['-C', sourcePath, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch { /* 非 git 仓库 / 无 git */ }
  return out
}

/** 解析 link 目录对应的 GitHub 仓库（owner/repo）；DSH_OPM_OWN_REPO 可覆盖，结果缓存。 */
const gitRepoCache = new Map()
export function resolveGitRepo(sourcePath, { env = process.env } = {}) {
  const override = env.DSH_OPM_OWN_REPO
  if (override) return override
  if (gitRepoCache.has(sourcePath)) return gitRepoCache.get(sourcePath)
  let repo = ''
  try {
    const url = execFileSync('git', ['-C', sourcePath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const hit = /github\.com[/:]([^\s/]+)\/([^\s/]+?)(?:\.git)?$/i.exec(url)
    if (hit) repo = `${hit[1]}/${hit[2]}`
  } catch { /* 非 git 仓库 / 无 origin remote */ }
  gitRepoCache.set(sourcePath, repo)
  return repo
}

/** link 目录在仓库内的相对路径（如 packages/dsh-foo）；非 git 目录返回 ''。 */
export function repoSubpath(sourcePath) {
  try {
    // --show-prefix 由 git 内部计算（避免 macOS /var 与 /private/var 符号链接差异）
    const prefix = execFileSync('git', ['-C', sourcePath, 'rev-parse', '--show-prefix'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return prefix.replace(/\/+$/, '')
  } catch { return '' }
}

/**
 * monorepo release 标签：按 `<pkg>@` 前缀取最新非 draft tag。
 * 刻意不做 releases/latest 兜底 —— monorepo 的 latest 可能是别的包的 tag。
 */
async function latestReleaseTag(repo, pkg, { fetchFn } = {}) {
  const list = await fetchJson(`${GITHUB_API}/repos/${repo}/releases?per_page=100`, { fetchFn, headers: { accept: 'application/vnd.github+json' } })
  const hit = (Array.isArray(list) ? list : [])
    .find(rel => String(rel?.tag_name || '').startsWith(`${pkg}@`) && !rel.draft)
  if (!hit) return null
  return { tag: String(hit.tag_name), url: hit.html_url || `https://github.com/${repo}/releases` }
}

/**
 * link 源检测（网络版）：「远端最新版 + 本地漂移」双信号。
 *
 *   - 远端：优先 GitHub release 标签（<pkg>@vX.Y.Z），无匹配回退默认分支
 *     <subpath>/package.json 的 version；repo 从 link 目录 git remote 推导
 *     （DSH_OPM_OWN_REPO 覆盖），推导失败退化为纯本地指纹。
 *   - 漂移：本地指纹（version+commit）vs 基线，变化保持基线直到 ack。
 *
 * hasUpdate = remoteHasUpdate || driftHasUpdate；远端网络失败不掩盖漂移信号
 * （错误记入 remoteError，status 保持 ok）。
 */
export async function checkLink(info, prev, { fetchFn, repo, now = Date.now() } = {}) {
  const fp = readLinkFingerprint(info.source.path)
  const base = prev?.base || { version: fp.version, commit: fp.commit }
  const driftHasUpdate = fp.version !== base.version || fp.commit !== base.commit
  const out = {
    type: 'link', status: 'ok', checkedAt: new Date(now).toISOString(),
    current: fp.version, currentCommit: fp.commit, base,
    latest: null, latestSource: null, branch: null,
    url: `file://${info.source.path}`,
    remoteHasUpdate: false, driftHasUpdate, hasUpdate: driftHasUpdate,
  }
  const ownerRepo = repo !== undefined ? repo : resolveGitRepo(info.source.path)
  if (!ownerRepo) return out
  try {
    const rel = await latestReleaseTag(ownerRepo, info.pkg, { fetchFn })
    if (rel) {
      out.latest = /\.?v?(\d[^\s-]*)/i.exec(rel.tag)?.[1] || rel.tag
      out.latestSource = 'release'
      out.url = rel.url
    } else {
      const meta = await fetchJson(`${GITHUB_API}/repos/${ownerRepo}`, { fetchFn, headers: { accept: 'application/vnd.github+json' } })
      const branch = meta?.default_branch || 'main'
      const sub = repoSubpath(info.source.path)
      const file = sub === '' ? 'package.json' : `${sub}/package.json`
      const pj = await fetchJson(`https://raw.githubusercontent.com/${ownerRepo}/${encodeURIComponent(branch)}/${file}`, { fetchFn, headers: { accept: 'application/vnd.github.raw' } })
      out.latest = String(pj?.version || '') || null
      out.latestSource = 'branch'
      out.branch = branch
      out.url = `https://github.com/${ownerRepo}/blob/${branch}/${file}`
    }
    out.remoteHasUpdate = !!out.latest && out.latest !== out.current && compareVersions(out.latest, out.current) > 0
    out.hasUpdate = out.remoteHasUpdate || driftHasUpdate
  } catch (error) {
    out.remoteError = String(error?.message || error)
  }
  return out
}

// ------------------------------------------------------------------- refresh

function isFresh(entry, now, maxAgeMin = CHECK_MAX_AGE_MIN) {
  if (!entry?.checkedAt) return false
  return now - Date.parse(entry.checkedAt) < maxAgeMin * 60_000
}

/**
 * 刷新单个 profile 的检测缓存。
 *
 * link 类走 checkLink（远端最新版 + 本地漂移双信号）；远端有新版提示
 * git pull，本地漂移（已 pull 未重启）保持基线直到 ackLink「已生效」。
 */
export async function refreshProfile(home, profile, state, { fetchFn, force = false, now = Date.now() } = {}) {
  const snapshot = readProfileState(home, profile)
  const bucket = state.profiles[profile] || (state.profiles[profile] = { checkedAt: null, plugins: {} })
  const cache = bucket.plugins

  for (const info of snapshot.plugins) {
    const key = info.pkg
    const prev = cache[key]
    if (!force && isFresh(prev, now) && prev?.type === info.source.type) continue

    if (info.source.type === 'npm') {
      cache[key] = { ...(await checkNpm(info.pkg, info.version, { fetchFn })), checkedAt: new Date(now).toISOString() }
    } else if (info.source.type === 'github') {
      cache[key] = { ...(await checkGithub(info.source.repo, info.version, { fetchFn })), checkedAt: new Date(now).toISOString() }
    } else if (info.source.type === 'tarball') {
      cache[key] = { ...(await checkTarball(info.source.repo, info.version || info.source.version, { fetchFn, pkg: info.pkg })), checkedAt: new Date(now).toISOString() }
    } else if (info.source.type === 'link') {
      cache[key] = await checkLink(info, prev, { fetchFn, now })
    } else {
      cache[key] = { type: 'other', status: 'unsupported', checkedAt: new Date(now).toISOString(), hasUpdate: false }
    }
  }
  bucket.checkedAt = new Date(now).toISOString()
  state.checkedAt = bucket.checkedAt
  return { snapshot, cache }
}

/** 刷新全部（或指定）profile；任何单 profile 失败不拖垮整体。 */
export async function refreshAll(home, { profiles = null, fetchFn, force = false, now = Date.now(), state = null, stateFile = statePath() } = {}) {
  const st = state || readState(stateFile)
  const targets = profiles && profiles.length > 0 ? profiles : listProfiles(home)
  const out = {}
  for (const profile of targets) {
    try {
      out[profile] = await refreshProfile(home, profile, st, { fetchFn, force, now })
    } catch (error) {
      out[profile] = { error: String(error?.message || error) }
    }
  }
  return { state: st, results: out }
}

/** link 插件基线对齐（用户确认已重启生效后调用）：只清漂移，不清远端更新。 */
export function ackLink(state, profile, pkg, { now = Date.now() } = {}) {
  const entry = state?.profiles?.[profile]?.plugins?.[pkg]
  if (!entry || entry.type !== 'link') return false
  entry.base = { version: entry.current, commit: entry.currentCommit }
  entry.driftHasUpdate = false
  entry.hasUpdate = !!entry.remoteHasUpdate
  entry.ackedAt = new Date(now).toISOString()
  return true
}

// --------------------------------------------------------------------- view

/**
 * 组装对外全景视图：profile 插件清单 + 检测缓存合并。
 * 每插件：PluginInfo ∪ { check: 缓存条目 | null }。
 */
export function buildView(home, { state = null, stateFile = statePath(), profiles = null } = {}) {
  const st = state || readState(stateFile)
  const targets = profiles && profiles.length > 0 ? profiles : listProfiles(home)
  const out = { checkedAt: st.checkedAt, profiles: [] }
  for (const profile of targets) {
    const snapshot = readProfileState(home, profile)
    const cache = st.profiles[profile]?.plugins || {}
    out.profiles.push({
      name: profile,
      checkedAt: st.profiles[profile]?.checkedAt || null,
      plugins: snapshot.plugins.map(info => ({ ...info, check: cache[info.pkg] || null })),
    })
  }
  /** 可用更新总数（跨 profile 去重计数）。 */
  out.updateCount = out.profiles.reduce((sum, p) => sum + p.plugins.filter(x => x.check?.hasUpdate).length, 0)

  // 关注仓库源 + 插件快照（关联已安装状态）
  out.repos = (readRepos()).map(entry => {
    const snap = st.repos?.[entry.repo] || { plugins: [], mode: 'none', checkedAt: null, error: null }
    const byPkg = {}
    for (const p of snap.plugins || []) byPkg[p.pkg] = p
    const installed = {}
    for (const profile of out.profiles) {
      for (const info of profile.plugins) {
        if (!(info.pkg in byPkg)) continue
        if (!installed[info.pkg]) installed[info.pkg] = []
        installed[info.pkg].push({ profile: profile.name, version: info.version })
      }
    }
    return { ...entry, ...snap, installed }
  })
  return out
}
