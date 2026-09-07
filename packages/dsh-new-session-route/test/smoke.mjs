/**
 * Smoke test for dsh-new-session-route (client half).
 *
 * Loads lib/client.js inside a minimal DOM/ModuleLoader shim, applies the
 * plugin with a fake client context, then verifies:
 *   1. the module shape (apply / inject);
 *   2. the sidebar「新会话」button gets hooked;
 *   3. clicking the button opens the route menu instead of starting a session;
 *   4. clicking "Claude Code" runs connectWorkspace + selectModel against the
 *      claude-code provider (local claude CLI) and opens the session.
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

// ------------------------------------------------------------------ shims
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = {}
    this.dataset = {}
    this.style = {}
    this.listeners = {}
    this.offsetWidth = 220
    this.offsetHeight = 120
    this.textContent = ''
  }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return this.attributes[name] ?? null }
  getBoundingClientRect() { return { left: 20, top: 40, right: 120, bottom: 78, width: 100, height: 38 } }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this)
      if (i >= 0) this.parentNode.children.splice(i, 1)
      this.parentNode = null
    }
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  removeEventListener() {}
  dispatchClick() {
    for (const fn of this.listeners['click'] ?? []) {
      fn({ preventDefault() {}, stopPropagation() {}, currentTarget: this })
    }
  }
  querySelector() { return null }
}

const documentShim = {
  body: new FakeElement('body'),
  head: new FakeElement('head'),
  createElement(tag) { return new FakeElement(tag) },
  getElementById() { return null },
  querySelectorAll() {
    const matches = []
    const walk = (el) => {
      for (const child of el.children) {
        if (child.tagName === 'BUTTON') {
          const label = child.getAttribute('aria-label') || ''
          const text = (child.textContent || '').trim()
          if (label.includes('新会话') || text.includes('新会话')) matches.push(child)
        }
        walk(child)
      }
    }
    walk(this.body)
    return matches
  },
}

const windowShim = { innerWidth: 1280, innerHeight: 800 }

class FakeHTMLElement extends FakeElement {}
globalThis.HTMLElement = FakeHTMLElement
globalThis.window = windowShim
globalThis.document = documentShim
globalThis.MutationObserver = class { constructor() {} observe() {} disconnect() {} }

// Seed a「新会话」button in the body (must be an HTMLElement instance).
const seedButton = () => {
  const b = new FakeHTMLElement('button')
  b.setAttribute('aria-label', '新建会话')
  b.textContent = '新会话'
  documentShim.body.appendChild(b)
  return b
}

// ------------------------------------------------------------------ load
// Seed a「新会话」button in the body.
const button = seedButton()

// Capture the descriptor the client module registers, then run its factory and
// take the returned module.exports.
let descriptor
windowShim.__ModuleLoader__ = { load: (d) => { descriptor = d } }
new Function('window', clientSrc + '\nreturn null')(windowShim)
assert.ok(descriptor !== undefined, 'client module called __ModuleLoader__.load')
assert.equal(descriptor.id, 'dsh-new-session-route', 'module id is stable')
const api = descriptor.factory(() => { throw new Error('no require expected') })

// ------------------------------------------------------------------ asserts
// 1. module shape
assert.equal(typeof api.apply, 'function', 'apply is a function')
assert.deepEqual(api.inject, ['connection', 'sessions', 'workspaces', 'locale'], 'inject matches package.json')

// 2. apply() with a fake ctx mounts and hooks the button
const calls = []
const fakeCtx = {
  get: (name) => {
    if (name === 'workspaces') {
      return {
        startSession: () => { calls.push(['startSession']) },
        connectWorkspace: async (wsId) => { calls.push(['connectWorkspace', wsId]); return 'session-1' },
        list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', sessionIds: ['session-1'] }], recentWorkspaceId: 'ws-1' }) },
      }
    }
    if (name === 'sessions') {
      return {
        list: { getSnapshot: () => ({ current: 'session-1' }) },
        open: (id) => { calls.push(['open', id]) },
        clear: () => { calls.push(['clear']) },
      }
    }
    if (name === 'connection') {
      return {
        api: {
          sessions: {
            models: async () => ({ result: { ok: true, value: { groups: [{ id: 'claude-code', models: [{ id: 'default' }] }] } } }),
            selectModel: async (payload) => { calls.push(['selectModel', payload]); return { result: { ok: true } } },
          },
        },
      }
    }
    throw new Error('unexpected service: ' + name)
  },
  effect: (fn) => { calls.push(['effect']); return () => {} },
}
api.apply(fakeCtx)
assert.ok(button.listeners['click'] !== undefined, 'new-session button hooked')

// clicking the button must NOT start a session directly; menu opens instead
button.dispatchClick()
assert.ok(!calls.some((c) => c[0] === 'startSession'), 'click did not start a session (menu intercepts)')
const menu = documentShim.body.children.find((el) => el.dataset && el.dataset.dshNewSessionRoute === 'menu')
assert.ok(menu, 'route menu opened')
assert.equal(menu.children.length, 2, 'two route options')

// 3. click the "Claude Code" item
const claudeItem = menu.children.find((it) => {
  const nameEl = it.children.find((c) => c.dataset && c.dataset.dshNewSessionRoute === 'name')
  return nameEl && nameEl.textContent.includes('Claude Code')
})
assert.ok(claudeItem, 'Claude Code item present')
claudeItem.dispatchClick()
await new Promise((r) => setTimeout(r, 0)) // flush async flow
assert.ok(calls.some((c) => c[0] === 'connectWorkspace' && c[1] === 'ws-1'), 'connectWorkspace called with target workspace')
const selectModel = calls.find((c) => c[0] === 'selectModel')
assert.ok(selectModel, 'selectModel called')
assert.equal(selectModel[1].sessionId, 'session-1', 'selectModel targets the connected session')
assert.equal(selectModel[1].provider, 'claude-code', 'selectModel uses claude-code provider')
assert.equal(selectModel[1].model, 'default', 'selectModel uses discovered model')
assert.ok(calls.some((c) => c[0] === 'open' && c[1] === 'session-1'), 'session opened')

console.log('PASS: all dsh-new-session-route smoke checks')
