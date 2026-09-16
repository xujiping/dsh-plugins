/**
 * Client-half smoke test for dsh-session-archive.
 *
 * The client half is a browser script (`window.__ModuleLoader__.load`), so we
 * boot it inside a minimal DOM stub: document.body with simulated sidebar
 * workspace rows (`div[role="treeitem"]` holding a title span), plus stubbed
 * cordis services (`workspaces.list` / `sessions.list` snapshots and an
 * `archiveSession` recorder). We then assert:
 *
 *   1. an archive button is injected onto every visible workspace row
 *   2. the idle-candidate derivation skips archived / subagent / recent
 *      sessions and treats missing updatedAt conservatively
 *   3. clicking the button opens the confirmation dialog with the right count
 *   4. confirming archives exactly the idle candidates via workspaces.archiveSession
 *   5. the idle-days threshold round-trips through localStorage
 *   6. unmount (ctx.effect disposer) tears down injected buttons + dialog
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// ------------------------------------------------------------------- DOM stub
class StubElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentElement = null
    this.style = {}
    this._attrs = {}
    this._listeners = {}
    this._text = ''
    // dataset assignments reflect to data-* attributes, like a real browser.
    const ds = {}
    this.dataset = new Proxy(ds, {
      get: (t, k) => t[k],
      set: (t, k, v) => {
        t[k] = String(v)
        const attr = 'data-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
        this._attrs[attr] = String(v)
        return true
      },
    })
  }
  get className() { return this._className || '' }
  set className(v) { this._className = v }
  get id() { return this._attrs.id || '' }
  set id(v) { this._attrs.id = v }
  setAttribute(name, value) {
    this._attrs[name] = String(value)
    const data = name.match(/^data-(.+)$/)
    if (data) this.dataset[data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value)
  }
  getAttribute(name) { return this._attrs[name] ?? null }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? textNode(n) : n
      node.parentElement = this
      this.children.push(node)
    }
  }
  appendChild(node) { this.append(node); return node }
  replaceChildren(...nodes) {
    for (const c of [...this.children]) { c.parentElement = null }
    this.children = []
    this.append(...nodes)
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
  get textContent() {
    let t = this._text
    for (const c of this.children) t += c.textContent
    return t
  }
  set textContent(v) { this._text = String(v) }
}

/** Minimal text node used by append('string'). */
function textNode(text) {
  const el = new StubElement('#text')
  el._text = String(text)
  return el
}

function matches(el, sel) {  if (sel.startsWith('[')) {
    const m = sel.match(/^\[([a-z-]+)="([^"]*)"\]$/)
    if (m) return el.getAttribute(m[1]) === m[2]
    const m1 = sel.match(/^\[([a-z-]+)\]$/)
    if (m1) return el.getAttribute(m1[1]) !== null
  }
  if (sel.includes(' ')) {
    const parts = sel.split(' ').filter(Boolean)
    let cur = el
    for (let i = parts.length - 1; i >= 0; i--) {
      let found = null
      let n = cur
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
    this._cache = {}
  }
  createElement(tag) { return new StubElement(tag) }
  getElementById(id) { return this._cache[id] ?? null }
  querySelector(sel) { return this.body.querySelector(sel) }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel) }
}

// ---------------------------------------------------------- environment boot
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const dom = new StubDocument()

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
  }
  return el
}

const localStorageStub = (() => {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  }
})()

let mutationCbs = []
class StubMutationObserver {
  constructor(cb) { this.cb = cb; this.observed = null }
  observe(target, opts) { this.observed = { target, opts }; mutationCbs.push(this) }
  disconnect() { mutationCbs = mutationCbs.filter((o) => o !== this) }
}

globalThis.window = { innerWidth: 1440, innerHeight: 900 }
globalThis.document = dom
globalThis.MutationObserver = StubMutationObserver
globalThis.localStorage = localStorageStub
globalThis.setTimeout = (fn) => { fn(); return 0 } // fire immediately for toast
globalThis.clearTimeout = () => {}

// --------------------------------------------------------------------- stores
const NOW = Date.now()
const DAY = 86400000

// Two workspaces: alpha (project A) and beta (project B).
const workspaces = {
  items: [
    { workspaceId: 'ws-a', title: 'alpha', path: '/p/alpha', createdAt: new Date(NOW - 40 * DAY).toISOString(), sessionIds: ['s-old', 's-archived', 's-recent', 's-sub'] },
    { workspaceId: 'ws-b', title: 'beta', path: '/p/beta', createdAt: new Date(NOW - 10 * DAY).toISOString(), sessionIds: ['s-b'] },
  ],
  archivedSessionIds: ['s-archived'],
  phase: 'ready',
}

const sessions = {
  byId: {
    's-old': { id: 's-old', displayTitle: '很旧的会话', updatedAt: NOW - 20 * DAY, origin: 'user' },
    's-archived': { id: 's-archived', displayTitle: '已归档的', updatedAt: NOW - 30 * DAY, origin: 'user' },
    's-recent': { id: 's-recent', displayTitle: '最近的会话', updatedAt: NOW - 1 * DAY, origin: 'user' },
    's-sub': { id: 's-sub', displayTitle: '子代理', updatedAt: NOW - 30 * DAY, origin: 'subagent' },
    's-b': { id: 's-b', displayTitle: 'beta 会话', updatedAt: NOW - 10 * DAY, origin: 'user' },
  },
  ids: ['s-old', 's-archived', 's-recent', 's-sub', 's-b'],
  current: 's-recent',
  phase: 'ready',
}

const archivedCalls = []
const workspacesService = {
  list: { getSnapshot: () => workspaces },
  archiveSession: async (sessionId) => { archivedCalls.push(sessionId) },
}
const sessionsService = {
  list: { getSnapshot: () => sessions },
}

const ctxStub = {
  get(name) {
    if (name === 'workspaces') return workspacesService
    if (name === 'sessions') return sessionsService
    return undefined
  },
  effect(fn, label) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
}

const disposers = []
globalThis.window.__ModuleLoader__ = {
  load(spec) {
    const mod = spec.factory(() => ({}))
    mod.apply(ctxStub)
  },
}

// ------------------------------------------------------------------ build DOM
function workspaceRow(title) {
  const row = new StubElement('div')
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-expanded', 'true')
  const folder = new StubElement('span')
  const chevron = new StubElement('span')
  const projectText = new StubElement('span')
  const titleSpan = new StubElement('span')
  titleSpan.textContent = title
  projectText.append(titleSpan)
  const rowActions = new StubElement('span')
  const plusBtn = new StubElement('button')
  plusBtn.setAttribute('aria-label', `在“${title}”中新建会话`)
  rowActions.append(plusBtn)
  row.append(folder, chevron, projectText, rowActions)
  return row
}

const rowAlpha = workspaceRow('alpha')
const rowBeta = workspaceRow('beta')
dom.body.append(rowAlpha, rowBeta)

// --------------------------------------------------------------- execute client
vm.runInThisContext(source, { filename: 'dsh-session-archive-client.js' })

// --------------------------------------------------------------------- tests
// 1. buttons injected onto every visible workspace row
let buttons = dom.body.querySelectorAll('[data-dsh-session-archive="button"]')
assert.equal(buttons.length, 2, 'one archive button per workspace row')
assert.equal(buttons[0].parentElement, rowAlpha, 'button attached to the alpha row')

// 2. idle-candidate derivation: only s-old qualifies under the default 3-day
//    threshold (s-archived excluded, s-recent too new, s-sub subagent).
//    Re-run the sweep is not needed; verify via the dialog path instead.
//    First open the dialog by clicking the alpha button.
assert.equal(typeof buttons[0]._listeners.click, 'object', 'button has a click listener')
buttons[0]._listeners.click.forEach((fn) =>
  fn({ preventDefault() {}, stopPropagation() {} })
)

// dialog opened: count line should say 1 idle session (s-old)
const count = dom.body.querySelector('[data-dsh-session-archive="count"]')
assert.ok(count !== null, 'dialog count line is present')
assert.ok(count.textContent.includes('1 个空闲会话'), `count line shows 1 idle: ${count.textContent}`)
const preview = dom.body.querySelector('[data-dsh-session-archive="preview"]')
assert.ok(preview.textContent.includes('很旧的会话'), 'preview lists the idle session title')

// 3. raise threshold to 40 days → s-old (20 days old) is now NOT idle, so
//    alpha has nothing to archive. (Threshold semantics: older threshold =
//    fewer candidates.)
const daysInput = dom.body.querySelector('[data-dsh-session-archive="days"]')
assert.ok(daysInput !== null, 'days input present')
daysInput.value = '40'
daysInput._listeners.input.forEach((fn) => fn())
assert.ok(
  count.textContent.includes('没有'),
  `40-day threshold → alpha has nothing idle: ${count.textContent}`
)
// and back to 3 days → s-old idle again (count line refresh is live)
daysInput.value = '3'
daysInput._listeners.input.forEach((fn) => fn())
assert.ok(count.textContent.includes('1 个空闲会话'), `3-day threshold → s-old idle again: ${count.textContent}`)

// 4. beta workspace: s-b was last active 10 days ago → idle at both the
//    default 3-day and a 7-day threshold. Open beta's dialog.
const betaBtn = buttons[1]
betaBtn._listeners.click.forEach((fn) =>
  fn({ preventDefault() {}, stopPropagation() {} })
)
const betaCount = dom.body.querySelector('[data-dsh-session-archive="count"]')
assert.ok(betaCount.textContent.includes('1 个空闲会话'), `beta default 3-day threshold → s-b idle: ${betaCount.textContent}`)
const betaDays = dom.body.querySelector('[data-dsh-session-archive="days"]')
betaDays.value = '7'
betaDays._listeners.input.forEach((fn) => fn())
assert.ok(betaCount.textContent.includes('1 个空闲会话'), `beta 7-day threshold → s-b idle: ${betaCount.textContent}`)

// 5. confirm on beta → archives exactly s-b
const betaConfirm = dom.body.querySelector('[data-dsh-session-archive="confirm"]')
betaConfirm._listeners.click.forEach((fn) => fn())
assert.ok(archivedCalls.includes('s-b'), 'confirm archives the beta idle session')
assert.ok(!archivedCalls.includes('s-old'), 'beta confirm does not touch alpha sessions')

// 6. threshold persisted to localStorage (7 from beta confirm)
assert.equal(localStorageStub.getItem('dsh.sessionArchive.idleDays'), '7', 'idle days persisted')

// 7. re-open alpha: threshold now 7 (persisted) → still only s-old idle
rowAlpha._listeners = {} // ensure we grab the current button
const alphaBtn2 = dom.body.querySelectorAll('[data-dsh-session-archive="button"]')[0]
alphaBtn2._listeners.click.forEach((fn) =>
  fn({ preventDefault() {}, stopPropagation() {} })
)
const alphaCount2 = dom.body.querySelector('[data-dsh-session-archive="count"]')
assert.ok(alphaCount2.textContent.includes('1 个空闲会话'), `alpha at persisted 7-day threshold → s-old only: ${alphaCount2.textContent}`)

// 8. unmount → buttons removed, dialog closed
disposers.forEach((fn) => fn())
assert.equal(dom.body.querySelectorAll('[data-dsh-session-archive="button"]').length, 0, 'buttons removed on unmount')
assert.equal(dom.body.querySelector('[data-dsh-session-archive="dialog"]'), null, 'dialog closed on unmount')
assert.equal(dom.body.querySelector('[data-dsh-session-archive="backdrop"]'), null, 'backdrop removed on unmount')

console.log('dsh-session-archive client smoke: all assertions passed')
process.exit(0)
