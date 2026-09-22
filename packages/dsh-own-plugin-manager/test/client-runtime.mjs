/**
 * Client-half runtime smoke test for dsh-own-plugin-manager.
 *
 * 在 Node 里用 stub react + stub document 执行真实 client.js：
 *   1. __ModuleLoader__ 工厂执行成功，导出 { apply, inject: ['slots'] }；
 *   2. apply(ctx) 注册 settings.section（id/order/label）；
 *   3. 导航 label 渲染出「插件管家」+ data-settings-nav-label 标记；
 *   4. 样式注入 head（含默认图标隐藏规则 + 卡片网格体系）；
 *   5. 有状态渲染（useState 计数器 stub）：
 *      - 加载态 → 数据态：默认「自有插件」Tab 出自研卡片（自研徽标/源码已更新/已生效）；
 *      - 切「社区插件」Tab：出社区卡片（npm 徽标 + v1 → v2 版本行 + 更新日志链接）；
 *      - 状态分段筛选（已启用）与 profile 过滤生效；
 *      - 空态渲染无异常。
 *
 * 注意：组件 hooks 顺序为 [view, profile, tab, status, query, loading,
 * refreshing]（client.js 中有注释锚定），本测试按该顺序注入状态。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---- stubs ------------------------------------------------------------
const styleTags = []
globalThis.document = {
  readyState: 'complete',
  createElement: tag => ({ tagName: tag, className: '', textContent: '', dataset: {},
    setAttribute(k, v) { this[k] = v }, append() {}, style: {} }),
  getElementById: id => styleTags.find(t => t.id === id) || null,
  head: { append: t => styleTags.push(t) },
  body: { append: () => {} },
}

// 有状态 hooks stub：每次 render 重置计数器，setter 直接写状态槽。
// createElement 会对「函数组件」自动求值（类组件除外），模拟 React 渲染。
const hookStates = []
let hookIdx = 0
const react = {
  createElement: (type, props, ...children) => {
    const node = { type, props: props || {}, children: children.flat() }
    if (typeof type === 'function' && !(type.prototype instanceof react.Component)) {
      return type({ ...node.props, children: node.children })
    }
    return node
  },
  useState: initial => {
    const idx = hookIdx++
    if (hookStates[idx] === undefined) hookStates[idx] = typeof initial === 'function' ? initial() : initial
    const set = value => { hookStates[idx] = typeof value === 'function' ? value(hookStates[idx]) : value }
    return [hookStates[idx], set]
  },
  useEffect: () => {},
  Component: class { constructor(p) { this.props = p } },
}

const registrations = []
const ctx = {
  slots: {
    inject: (key, cb) => { registrations.push({ key, effect: cb() }) },
    register: (opts, comp) => { registrations.push({ opts, comp }); return () => {} },
  },
}

let capturedFactory = null
globalThis.window = { __ModuleLoader__: { load: reg => { capturedFactory = reg.factory } } }
new Function('window', src)(globalThis.window)

/** 渲染一轮：重置 hooks 计数器后调用分区组件（剥掉 ErrorBoundary 外壳）。 */
function render(boundary) {
  hookIdx = 0
  return boundary.children[0]
}
/** 深度遍历虚拟树，收集所有节点。 */
function flatten(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) flatten(child, out)
  return out
}
/** 收集节点子树下的所有文本。 */
function texts(node) {
  return flatten(node).map(n => n.children.filter(c => typeof c === 'string')).flat()
}
const byClass = (root, cls) => flatten(root).filter(n => n.props && n.props.className === cls)

// ---- 1. exports shape ---------------------------------------------------
const exports = capturedFactory(spec => {
  if (spec === 'react') return react
  throw new Error(`unexpected require: ${spec}`)
})
assert.equal(typeof exports.apply, 'function')
assert.deepEqual(exports.inject, ['slots'])

// ---- 2. settings.section registration -----------------------------------
exports.apply(ctx)
const reg = registrations.find(r => r.opts)
assert.ok(reg, 'registration captured')
assert.equal(reg.opts.name, 'settings.section')
assert.equal(reg.opts.id, 'own-plugin-manager')
assert.equal(reg.opts.order, 34)
assert.equal(typeof reg.comp, 'function')

// ---- 3. nav label --------------------------------------------------------
const labelNode = reg.opts.label()
assert.equal(labelNode.props['data-settings-nav-label'], 'own-plugin-manager')
const labelText = labelNode.children[labelNode.children.length - 1].children[0]
assert.equal(labelText, '插件管家')

// ---- 4. styles -----------------------------------------------------------
assert.equal(styleTags.length, 1)
assert.match(styleTags[0].textContent, /svg:first-child/)
assert.match(styleTags[0].textContent, /\.opm-container/)
assert.match(styleTags[0].textContent, /\.opm-grid/)
assert.match(styleTags[0].textContent, /\.opm-card-icon/)
assert.match(styleTags[0].textContent, /\.opm-tab\b/)
assert.doesNotMatch(styleTags[0].textContent, /gradient/)

// ---- 5. renders ----------------------------------------------------------
// 5a. 加载态（view=null）
let tree = render(reg.comp())
assert.ok(tree && tree.type === 'div', 'render loading')
assert.match(texts(tree).join('|'), /正在加载插件状态/)

// 5b. 注入数据：hooks [view, profile, tab, status, query, loading, refreshing]
const view = {
  profiles: [
    { name: 'web', plugins: [
      { pkg: 'dsh-agent-driver', version: '0.1.0', own: true, bundled: true, disabled: false, description: '自研驱动',
        source: { type: 'link', path: '/x/dsh-plugins/packages/dsh-agent-driver' },
        check: { type: 'link', hasUpdate: true, latest: '0.2.0', latestSource: 'release', remoteHasUpdate: true, driftHasUpdate: true, base: { version: '0.1.0' }, current: '0.2.0' } },
      { pkg: 'dsh-bar', version: '1.0.0', bundled: true, disabled: true, description: '社区插件',
        source: { type: 'npm', spec: '^1.0.0' },
        check: { type: 'npm', hasUpdate: true, latest: '1.1.0', url: 'https://example.com/changelog' } },
    ] },
    { name: 'desktop', plugins: [
      { pkg: 'dsh-agent-driver', version: '0.1.0', own: true, bundled: true, disabled: true, description: '自研驱动',
        source: { type: 'link', path: '/x/dsh-plugins/packages/dsh-agent-driver' }, check: null },
    ] },
  ],
  updateCount: 2,
  checkedAt: new Date().toISOString(),
}
hookStates[0] = view
hookStates[5] = false // loading = false
tree = render(reg.comp())
assert.match(texts(tree).join('|'), /自有插件/)
assert.match(texts(tree).join('|'), /社区插件/)
assert.match(texts(tree).join('|'), /上次检测/)

// 默认 Tab = own：dsh-agent-driver 卡片（跨 profile 聚合为一张卡）
let cards = byClass(tree, 'opm-card')
assert.equal(cards.length, 1, 'own tab shows one aggregated card')
assert.match(texts(cards[0]).join('|'), /dsh-agent-driver/)
assert.match(texts(cards[0]).join('|'), /自研/)
assert.match(texts(cards[0]).join('|'), /源码已更新/)
assert.match(texts(cards[0]).join('|'), /已生效/)
assert.match(texts(cards[0]).join('|'), /web/)
assert.match(texts(cards[0]).join('|'), /desktop/)
assert.match(texts(cards[0]).join('|'), /v0\.1\.0/)
assert.match(texts(cards[0]).join('|'), /v0\.2\.0/) // 远端 release 标签新版
assert.match(texts(cards[0]).join('|'), /复制更新命令/)
assert.equal(byClass(cards[0], 'opm-sw').length, 2, 'per-profile switches')

// 5b2. 仅漂移（远端无新版）：源码已更新仍在，但无复制更新命令
const linkCheck = view.profiles[0].plugins[0].check
linkCheck.remoteHasUpdate = false
linkCheck.latest = null
tree = render(reg.comp())
cards = byClass(tree, 'opm-card')
assert.match(texts(cards[0]).join('|'), /源码已更新/)
assert.match(texts(cards[0]).join('|'), /已生效/)
assert.doesNotMatch(texts(cards[0]).join('|'), /复制更新命令/)
linkCheck.remoteHasUpdate = true // 还原，供后续用例
linkCheck.latest = '0.2.0'

// 5c. 切社区 Tab：dsh-bar 卡片（npm 徽标 + v1.0.0 → v1.1.0 + 更新日志）
hookStates[2] = 'community'
tree = render(reg.comp())
cards = byClass(tree, 'opm-card')
assert.equal(cards.length, 1, 'community tab shows dsh-bar')
assert.match(texts(cards[0]).join('|'), /dsh-bar/)
assert.match(texts(cards[0]).join('|'), /npm/)
assert.match(texts(cards[0]).join('|'), /v1\.0\.0/)
assert.match(texts(cards[0]).join('|'), /v1\.1\.0/)
assert.match(texts(cards[0]).join('|'), /更新日志/)
assert.match(texts(cards[0]).join('|'), /复制更新命令/) // npm 包 → dsh plugin add 命令
let sws = byClass(cards[0], 'opm-sw')
assert.equal(sws.length, 1)
assert.equal(sws[0].props['data-on'], 'false', 'dsh-bar switch reflects disabled')

// 5d. 社区 Tab + 状态筛选「已启用」→ 空（dsh-bar 是停用态）
hookStates[3] = 'on'
tree = render(reg.comp())
assert.equal(byClass(tree, 'opm-card').length, 0)
assert.match(texts(tree).join('|'), /没有匹配的插件/)

// 5d2. 社区 Tab + 关注仓库：仓库发现的未安装插件出现在列表（仓库源卡片 + 安装按钮）
const repoView = {
  profiles: view.profiles,
  updateCount: view.updateCount,
  checkedAt: view.checkedAt,
  repos: [{
    repo: 'veildawn/dsh-plugins',
    mode: 'monorepo',
    checkedAt: view.checkedAt,
    plugins: [
      { pkg: 'dsh-remote-plugin', version: '0.9.0', tgzUrl: 'https://github.com/veildawn/dsh-plugins/releases/download/dsh-remote-plugin%40v0.9.0/dsh-remote-plugin-0.9.0.tgz', repo: 'veildawn/dsh-plugins' },
    ],
    installed: { 'dsh-remote-plugin': [{ profile: 'desktop', version: '0.8.0' }] },
  }],
}
hookStates[0] = repoView
hookStates[1] = ''
hookStates[2] = 'community'
hookStates[3] = 'all'
tree = render(reg.comp())
assert.match(texts(tree).join('|'), /关注仓库源/)
assert.match(texts(tree).join('|'), /veildawn\/dsh-plugins/)
assert.match(texts(tree).join('|'), /dsh-remote-plugin/)
assert.match(texts(tree).join('|'), /v0\.9\.0/)
assert.match(texts(tree).join('|'), /复制安装命令/)
assert.match(texts(tree).join('|'), /安装/)
// 已安装的 dsh-bar 常规卡片仍展示（社区 Tab 合并）
cards = byClass(tree, 'opm-card')
assert.ok(cards.some(c => texts(c).join('|').includes('dsh-bar')), 'installed community card still shown')
const repoCards = byClass(tree, 'opm-card').concat(byClass(tree, 'opm-card repo'))
assert.ok(repoCards.some(c => texts(c).join('|').includes('dsh-remote-plugin')), 'repo-discovered card shown')
// 仓库源管理卡存在
assert.ok(byClass(tree, 'opm-repos').length >= 1, 'repo source card rendered')

// 5e. profile 过滤 web + 自有 Tab + 「已停用」→ 空（web 里自研包启用中）
hookStates[1] = 'web'
hookStates[2] = 'own'
hookStates[3] = 'off'
tree = render(reg.comp())
assert.equal(byClass(tree, 'opm-card').length, 0)

// 5f. profile 过滤 desktop：自研聚合只剩 desktop 实例（1 个开关、卡内无 web 标签）
hookStates[1] = 'desktop'
hookStates[3] = 'all'
tree = render(reg.comp())
cards = byClass(tree, 'opm-card')
assert.equal(cards.length, 1)
assert.equal(byClass(cards[0], 'opm-sw').length, 1)
assert.doesNotMatch(texts(cards[0]).join('|'), /web/)

// 5g. 空态
hookStates[0] = { profiles: [], updateCount: 0, checkedAt: null, error: 'boom' }
hookStates[1] = ''
hookStates[2] = 'own'
tree = render(reg.comp())
assert.match(texts(tree).join('|'), /加载失败：boom/)

console.log('client runtime smoke: all ok')
