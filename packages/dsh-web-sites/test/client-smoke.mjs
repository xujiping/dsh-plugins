// 使用有界 DOM 变更队列复现真实浏览器的自愈监听，防止死循环挂住测试进程。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let observer
let pending = false
let writes = 0
let mount
let dispose
let plugin
let resize
const warnings = []
function changed(node) {
  if (observer?.active && body.contains(node)) pending = true
}
class Element {
  children = []
  parent = null
  style = {}
  dataset = {}
  _text = ''
  rect = { left: 12, top: 120, width: 268, height: 700 }
  get firstElementChild() { return this.children[0] }
  get textContent() { return this._text }
  set textContent(value) {
    this._text = value
    writes++
    changed(this) // 即使新旧文本相同，浏览器仍产生 childList 变更。
  }
  append(...nodes) {
    for (const node of nodes) { node.parent = this; this.children.push(node) }
    changed(this)
  }
  contains(node) { return this === node || this.children.some(child => child.contains(node)) }
  querySelector(selector) {
    for (const child of this.children) {
      if (selector === '.' + child.className || selector === '#' + child.id) return child
      const found = child.querySelector(selector)
      if (found) return found
    }
    return null
  }
  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  getBoundingClientRect() { return this.rect }
  remove() {
    if (!this.parent) return
    const parent = this.parent
    parent.children = parent.children.filter(child => child !== this)
    this.parent = null
    changed(parent)
  }
}
const body = new Element()
const head = new Element()
const tree = new Element()
const workspace = new Element()
const slot = new Element()
workspace.append(tree)
slot.append(workspace)
body.append(slot)
const document = {
  body, head,
  createElement: () => new Element(),
  querySelector: selector => selector === '[data-slot="sidebar.workspaces"]' ? slot : selector === '[role="tree"]' ? tree : body.querySelector(selector),
  getElementById: id => head.querySelector('#' + id),
  addEventListener() {}, removeEventListener() {},
}
vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: definition => { plugin = definition.factory() } } },
  document, HTMLElement: Element, Element,
  MutationObserver: class {
    constructor(callback) { this.callback = callback; observer = this }
    observe() { this.active = true }
    disconnect() { this.active = false }
  },
  ResizeObserver: class {
    constructor(callback) { resize = callback }
    observe() {} unobserve() {} disconnect() {}
  },
  localStorage: { getItem: () => null, removeItem() {} },
  fetch: async () => ({ ok: true, json: async () => ({ sites: [{ id: 'one' }] }) }),
  setTimeout: callback => { mount = callback; return 1 }, clearTimeout() {},
  console: { warn: (...args) => warnings.push(args) },
})
function settle() {
  let callbacks = 0
  while (pending && callbacks < 10) {
    pending = false
    observer.callback()
    callbacks++
  }
  assert.equal(pending, false, 'DOM 自愈必须收敛，不能无限重写站点数量')
}
plugin.apply({ effect: factory => { dispose = factory() } })
mount()
await new Promise(resolve => setImmediate(resolve))
settle()
assert.equal(body.querySelector('.dws-menu-count').textContent, '1')
const menu = body.querySelector('.dws-menu')
assert.equal(menu.parent, body, '菜单必须位于 React 树外')
assert.equal(menu.style.top, '120px', '菜单必须锚定整个工作区，不是会话列表')
assert.match(head.querySelector('#dsh-web-sites-styles').textContent,
  /\[data-slot="sidebar.workspaces"\] > :first-child\s*\{\s*padding-block-start: 36px;/,
  '工作区标题前必须为菜单预留独立空间')
workspace.rect.width = 64
resize()
assert.equal(menu.style.display, 'none', '侧边栏折叠时隐藏菜单')
workspace.rect.width = 320
resize()
assert.equal(menu.style.display, 'flex')
assert.equal(menu.style.width, '308px', '菜单宽度应跟随侧边栏调整')
const stableWrites = writes
body.append(new Element()) // 模拟宿主 UI 更新。
settle()
assert.equal(writes, stableWrites, '数量不变时不得重写文本节点')
body.querySelector('.dws-menu').remove()
settle()
assert.ok(body.querySelector('.dws-menu'), '菜单被移除后仍应能自愈')
assert.deepEqual(warnings, [])
dispose()
assert.equal(body.querySelector('.dws-menu'), null)
assert.equal(observer.active, false)
console.log('dsh-web-sites client smoke: passed')
