/**
 * Client-half runtime smoke test for dsh-own-plugin-manager.
 *
 * 在 Node 里用 stub react + stub document 执行真实 client.js：
 *   1. __ModuleLoader__ 工厂执行成功，导出 { apply, inject: ['slots'] }；
 *   2. apply(ctx) 注册 settings.section（id/order/label）；
 *   3. 导航 label 渲染出「插件管家」+ data-settings-nav-label 标记；
 *   4. 样式注入 head（含默认图标隐藏规则）；
 *   5. 分区组件对「有数据 / 空态」两种 view 均可无异常渲染。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---- stubs ------------------------------------------------------------
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  Component: class { constructor(p) { this.props = p } },
}
const styleTags = []
globalThis.document = {
  readyState: 'complete',
  createElement: tag => ({ tagName: tag, className: '', textContent: '', dataset: {},
    setAttribute(k, v) { this[k] = v }, append() {}, style: {} }),
  getElementById: id => styleTags.find(t => t.id === id) || null,
  head: { append: t => styleTags.push(t) },
  body: { append: () => {} },
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
assert.match(styleTags[0].textContent, /\.opm-page/)

// ---- 5. component render（有数据 / 空态）--------------------------------
const view = {
  profiles: [{ name: 'web', plugins: [
    { pkg: 'dsh-foo', version: '0.1.0', own: true, bundled: true, disabled: false, description: 'x',
      source: { type: 'link', path: '/p' }, check: { type: 'link', hasUpdate: true, base: { version: '0.1.0' }, current: '0.2.0' } },
    { pkg: 'dsh-bar', version: '1.0.0', bundled: true, disabled: true, source: { type: 'npm', spec: '^1.0.0' },
      check: { hasUpdate: true, latest: '1.1.0', url: 'https://example.com' } },
  ] }],
  updateCount: 2,
  checkedAt: new Date().toISOString(),
}
const stateStore = { view }
const setViewFn = v => { stateStore.view = typeof v === 'function' ? v(stateStore.view) : v }
react.useState = initial => (initial === null
  ? [stateStore.view, setViewFn]
  : [typeof initial === 'function' ? initial() : initial, () => {}])

let node = reg.comp()
assert.ok(node && node.type, 'render with data')
stateStore.view = { profiles: [], updateCount: 0, checkedAt: null, error: 'boom' }
node = reg.comp()
assert.ok(node && node.type, 'render empty')

console.log('client runtime smoke: all ok')
