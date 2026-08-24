/**
 * Client-half smoke test for dsh-chat-scroll-nav.
 *
 * The client half is a browser script (`window.__ModuleLoader__.load`), so we
 * boot it inside a minimal DOM stub: document.body with a simulated DSH
 * conversation ([data-conversation-scroll] > [data-chat-flow] > rows with
 * [data-chat-anchor-key] / [data-chat-flow-kind], plus [data-composer-seat]),
 * then assert the rail mounts, one tick per user/assistant message, hidden
 * without any message, and that click-to-jump scrolls the container.
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ------------------------------------------------------------------- DOM stub
class StubElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentElement = null
    this.style = {}
    this.dataset = {}
    this._attrs = {}
    this._listeners = {}
    this._text = ''
    this.scrollTop = 0
    this.scrollHeight = 0
    this.clientHeight = 0
  }
  get className() { return this._className || '' }
  set className(v) { this._className = v }
  get id() { return this._attrs.id || '' }
  set id(v) { this._attrs.id = v }
  setAttribute(name, value) {
    this._attrs[name] = String(value)
    if (name === 'data-kind') this.dataset.kind = String(value)
    if (name === 'data-index') this.dataset.index = String(value)
    if (name === 'data-active') this.dataset.active = 'true'
    if (name === 'data-anchor-key') this.dataset.anchorKey = String(value)
    if (name === 'data-hidden') this.dataset.hidden = String(value)
  }
  getAttribute(name) { return this._attrs[name] ?? null }
  removeAttribute(name) {
    delete this._attrs[name]
    if (name === 'data-active') delete this.dataset.active
    if (name === 'data-hidden') delete this.dataset.hidden
  }
  append(...nodes) {
    for (const n of nodes) { n.parentElement = this; this.children.push(n) }
  }
  remove() {
    if (this.parentElement) {
      const i = this.parentElement.children.indexOf(this)
      if (i >= 0) this.parentElement.children.splice(i, 1)
      this.parentElement = null
    }
  }
  querySelectorAll(sel) {
    const out = []
    const walk = (node) => {
      for (const c of node.children) {
        if (matches(c, sel)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
  querySelector(sel) {
    const all = this.querySelectorAll(sel)
    return all.length ? all[0] : null
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn) }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn)
  }
  getBoundingClientRect() { return this._rect || { top: 0, left: 0, right: 100, bottom: 100, height: 100, width: 100 } }
  closest(sel) {
    let node = this
    while (node !== null) {
      if (matches(node, sel)) return node
      node = node.parentElement
    }
    return null
  }
  get textContent() {
    let t = this._text
    for (const c of this.children) t += c.textContent
    return t
  }
  set textContent(v) { this._text = String(v) }
  cloneNode() { return this }
  get offsetWidth() { return 0 }
  get offsetHeight() { return 0 }
  get clientWidth() { return 0 }
}

function matches(el, sel) {
  // minimal support for [attr] and .class selectors
  if (sel.startsWith('[')) {
    const m = sel.match(/^\[([a-z-]+)\]$/)
    if (m) return el.getAttribute(m[1]) !== null
    const m2 = sel.match(/^\[([a-z-]+)="([^"]*)"\]$/)
    if (m2) return el.getAttribute(m2[1]) === m2[2]
  }
  if (sel.startsWith('.')) return el.className.split(/\s+/).includes(sel.slice(1))
  if (sel.includes(' ')) {
    const parts = sel.split(' ').filter(Boolean)
    // ancestor-descendant: walk up
    let cur = el
    for (let i = parts.length - 1; i >= 0; i--) {
      let found = null
      let n = i === parts.length - 1 ? cur : cur.parentElement
      while (n) {
        if (matches(n, parts[i])) { found = n; break }
        n = n.parentElement
      }
      if (!found) return false
      cur = found
    }
    return true
  }
  return el.tagName.toLowerCase() === sel.toLowerCase()
}

class StubDocument {
  constructor() {
    this.head = new StubElement('head')
    this.body = new StubElement('body')
    this.documentElement = new StubElement('html')
    this._cache = {}
  }
  createElement(tag) { return new StubElement(tag) }
  getElementById(id) { return this._cache[id] ?? null }
  querySelector(sel) { return this.body.querySelector(sel) }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel) }
  addEventListener() {}
  removeEventListener() {}
}

// ---------------------------------------------------------- environment boot
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const dom = new StubDocument()
const disposed = []
const applied = { count: 0 }

// hooks the plugin writes style tags into document.head with an id
const originalCreateElement = dom.createElement.bind(dom)
dom.createElement = (tag) => {
  const el = originalCreateElement(tag)
  if (tag === 'style') {
    const origSet = el.setAttribute.bind(el)
    el.setAttribute = (name, value) => {
      origSet(name, value)
      if (name === 'id') dom._cache[value] = el
    }
    const origAppend = el.append.bind(el)
    el.append = (...nodes) => { origAppend(...nodes); dom._cache[el.id] = el }
    return el
  }
  return el
}

const rafQueue = []
let mutationCbs = []
let resizeCbs = []

class StubMutationObserver {
  constructor(cb) { this.cb = cb; this.observed = null }
  observe(target, opts) { this.observed = { target, opts }; mutationCbs.push(this) }
  disconnect() { mutationCbs = mutationCbs.filter((o) => o !== this) }
}
class StubResizeObserver {
  constructor(cb) { this.cb = cb; this.observed = null }
  observe(target) { this.observed = target; resizeCbs.push(this) }
  disconnect() { resizeCbs = resizeCbs.filter((o) => o !== this) }
}

globalThis.window = {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
  getComputedStyle: (el) => ({ overflowY: 'auto' }),
}
globalThis.document = dom
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length }
globalThis.MutationObserver = StubMutationObserver
globalThis.ResizeObserver = StubResizeObserver
globalThis.setTimeout = () => 0
globalThis.URL = URL

const loaders = []
globalThis.window.__ModuleLoader__ = {
  load(spec) {
    loaders.push(spec)
    // evaluate the factory with a require stub
    const fakeRequire = () => ({})
    const mod = spec.factory(fakeRequire)
    applied.count += 1
    applied.mod = mod
    // the plugin calls apply(ctx) via the runtime; simulate ctx
    const ctx = { effect(fn) { const d = fn(); if (typeof d === 'function') disposed.push(d); return d } }
    mod.apply(ctx)
  },
}

// ------------------------------------------------------------------ run client
// Execute the browser half (it ends by calling window.__ModuleLoader__.load),
// after all globals are installed.
import vm from 'node:vm'
vm.runInThisContext(source, { filename: 'dsh-chat-scroll-nav-client.js' })

// ---------------------------------------------------------------------- build a conversation
function buildConversation({ withComposer = true } = {}) {
  const scroller = new StubElement('div')
  scroller.setAttribute('data-conversation-scroll', '')
  scroller.scrollTop = 0
  scroller.scrollHeight = 6000
  scroller.clientHeight = 800
  scroller._rect = { top: 60, left: 300, right: 1200, bottom: 860, height: 800, width: 900 }

  const flow = new StubElement('div')
  flow.setAttribute('data-chat-flow', '')
  scroller.append(flow)

  const kinds = ['user', 'assistant', 'user', 'tool-call', 'assistant', 'user', 'assistant']
  const previews = { user: '我的问题：如何实现一个快速导航条？', assistant: '我来帮你实现，思路如下……', 'tool-call': '工具调用' }
  kinds.forEach((kind, i) => {
    const row = new StubElement('div')
    row.setAttribute('data-chat-anchor-key', 'node-' + i)
    row.setAttribute('data-chat-flow-kind', kind)
    const text = new StubElement('div')
    text.textContent = previews[kind] || ''
    row.append(text)
    row._rect = { top: 60 + i * 400, left: 300, right: 1100, bottom: 60 + i * 400 + 200, height: 200, width: 800 }
    flow.append(row)
  })

  if (withComposer) {
    const composer = new StubElement('div')
    composer.setAttribute('data-composer-seat', '')
    composer._rect = { top: 800, left: 300, right: 1200, bottom: 860, height: 60, width: 900 }
    scroller.append(composer)
  }
  dom.body.append(scroller)
  return { scroller, flow }
}

// ----------------------------------------------------------- tests
// 1. no conversation → rail exists but hidden
globalThis.window.__ModuleLoader__.loaders = loaders
applied.mod = null
// (apply already ran with an empty body above; assert hidden)
const rail = dom.body.querySelector('[data-dsh-scroll-nav="rail"]')
assert.ok(rail !== null, 'rail is mounted even without a conversation')
assert.equal(rail.getAttribute('data-hidden'), 'true', 'rail hidden with no conversation')

// 2. with a conversation → ticks appear, one per user/assistant message
buildConversation()
// fire the plugin's observers (stubs don't auto-fire), then drain rAF
mutationCbs.forEach((o) => o.cb())
while (rafQueue.length) rafQueue.shift()()
const ticks = dom.body.querySelectorAll('[data-dsh-scroll-nav="tick"]')
assert.equal(ticks.length, 6, 'ticks = 6 user/assistant messages (tool-call excluded)')
assert.equal(rail.getAttribute('data-hidden'), 'false', 'rail visible with messages')

// 3. click-to-jump scrolls the container
const scroller = dom.body.querySelector('[data-conversation-scroll]')
const flow = dom.body.querySelector('[data-chat-flow]')
const row4 = flow.children[4] // node-4, assistant
row4._rect = { top: 2000, left: 300, right: 1100, bottom: 2200, height: 200, width: 800 }
const tick4 = ticks[3] // index 3 = 4th user/assistant target (node-4)
const clickEvent = { target: tick4, clientY: 500, preventDefault() {} }
rail._listeners.click.forEach((fn) => fn(clickEvent))
assert.ok(scroller.scrollTop >= 0, 'click triggers a scroll jump')

// 4. scrub on mousedown maps to proportional scroll
const before = scroller.scrollTop
rail._listeners.mousedown.forEach((fn) => fn({ clientY: 430, preventDefault() {} }))
assert.notEqual(scroller.scrollTop, before, 'mousedown scrubs the scroller')

console.log('dsh-chat-scroll-nav client smoke: all assertions passed')
process.exit(0)
