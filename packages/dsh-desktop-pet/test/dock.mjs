/**
 * dsh-desktop-pet 停靠行为回归测试（零依赖，自带最小 DOM stub）。
 *
 * 断言「像 workbuddy 一样趴在输入框上方、位置随输入框而动」这条链路：
 *   1. 启动即停靠在 composer 右上方（右缘 -10 / 上方 -6）
 *   2. composer 位移（侧栏开合、窗口缩放）→ 下一帧跟上
 *   3. composer 顶到视口上沿放不下 → 保持原位，不乱跳
 *   4. 拖动中停靠同步让位给鼠标（不被每帧拽回），松手解除停靠
 *   5. 原地点击（无位移）保持停靠，不把宠物踢下输入框
 *
 * 运行：node test/dock.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const SRC = readFileSync(CLIENT, 'utf8')

// ---------------------------------------------------------------- DOM stub
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.style = {}
    this.dataset = {}
    this.attrs = {}
    this._listeners = {}
    this.textContent = ''
    this.className = ''
    this.offsetParent = {}          // 非 null = 可见
    this.offsetWidth = 120
    this.offsetHeight = 80
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false }
  }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] ?? null }
  removeAttribute(k) { delete this.attrs[k] }
  append(...n) { this.children.push(...n) }
  appendChild(n) { this.children.push(n); return n }
  remove() {}
  addEventListener(t, f) { (this._listeners[t] ||= []).push(f) }
  removeEventListener() {}
  dispatch(t, ev) { for (const f of this._listeners[t] || []) f(ev) }
  setPointerCapture() {}
  releasePointerCapture() {}
  querySelector() { return null }
  querySelectorAll() { return [] }
  contains() { return false }
  closest() { return null }
  focus() {}
  getBoundingClientRect() {
    const r = this._rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    return { ...r }
  }
}

const composer = new El('div')
composer._rect = { left: 300, top: 600, right: 900, bottom: 700, width: 600, height: 100 }

const body = new El('body')
const document = {
  readyState: 'complete',
  body,
  head: new El('head'),
  createElement: tag => new El(tag),
  querySelector: sel => (sel === '[data-composer-seat]' && composer.offsetParent ? composer : null),
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
}

let rafCb = null
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Promise, Number, String, Object, Array, Symbol, Error,
  document,
  HTMLElement: El,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  requestAnimationFrame: cb => { rafCb = cb; return 1 },
  cancelAnimationFrame() {},
  EventSource: class { constructor() { this.onmessage = null; this.onerror = null } close() {} },
  MutationObserver: class { observe() {} disconnect() {} },
  fetch: async () => ({ ok: false, status: 503, json: async () => null }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.innerWidth = 1400
sandbox.innerHeight = 900
sandbox.addEventListener = () => {}
sandbox.__ModuleLoader__ = {
  load: ({ factory }) => {
    sandbox.__exports = factory(() => { throw new Error('client half must not require() anything') })
  },
}

// ---------------------------------------------------------------- run
vm.runInNewContext(SRC, sandbox)
sandbox.__exports.apply({})

const root = body.children.find(c => c.id === 'dsh-desktop-pet-root')
assert.ok(root, 'pet root mounted')
const pet = sandbox.window.__dshDesktopPet
assert.equal(pet.settings.dock, true, 'dock on by default')

let frame = 0
const tick = () => {
  const cb = rafCb
  rafCb = null
  assert.ok(cb, 'raf loop alive')
  cb(frame += 16)
}
const left = () => Number.parseFloat(root.style.left)
const top = () => Number.parseFloat(root.style.top)

// 1) 初始停靠
assert.equal(left(), 900 - 72 - 10, 'docked x = composer right - pet width - margin')
assert.equal(top(), 600 - 84 - 6, 'docked y = composer top - pet height - margin')

// 2) composer 位移 → 下一帧跟上
composer._rect = { left: 200, top: 500, right: 800, bottom: 600, width: 600, height: 100 }
tick()
assert.equal(left(), 800 - 72 - 10, 'follows composer x')
assert.equal(top(), 500 - 84 - 6, 'follows composer y')

// 3) composer 贴到视口顶端 → 保持原位
const kept = { l: root.style.left, t: root.style.top }
composer._rect = { left: 200, top: 40, right: 800, bottom: 140, width: 600, height: 100 }
tick()
assert.equal(root.style.left, kept.l, 'no jump when composer has no room above')
assert.equal(root.style.top, kept.t)

// 4) 拖动：拖拽中不被停靠拽回，松手解除停靠
composer._rect = { left: 200, top: 500, right: 800, bottom: 600, width: 600, height: 100 }
tick()
root.dispatch('pointerdown', { button: 0, clientX: left() + 10, clientY: top() + 10, pointerId: 1, preventDefault() {} })
root.dispatch('pointermove', { clientX: 400, clientY: 120, pointerId: 1, preventDefault() {} })
const dragged = { l: left(), t: top() }
tick()
assert.equal(left(), dragged.l, 'drag position survives dock sync')
assert.equal(top(), dragged.t)
assert.notEqual(dragged.l, 800 - 72 - 10, 'pet actually left the dock')
root.dispatch('pointerup', { pointerId: 1 })
assert.equal(pet.settings.dock, false, 'drag releases dock')

// 5) 原地点击不解除停靠
pet.settings.dock = true
tick()
root.dispatch('pointerdown', { button: 0, clientX: left() + 20, clientY: top() + 20, pointerId: 2, preventDefault() {} })
root.dispatch('pointerup', { pointerId: 2 })
assert.equal(pet.settings.dock, true, 'a plain click keeps docking')
assert.equal(left(), 800 - 72 - 10, 'click snaps back to dock')
assert.equal(top(), 500 - 84 - 6)

pet.dispose()
console.log('desktop-pet dock: passed')
process.exit(0)
