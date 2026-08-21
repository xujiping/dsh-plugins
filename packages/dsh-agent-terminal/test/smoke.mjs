/**
 * Host-half smoke tests for dsh-agent-terminal.
 *
 * Sections:
 *  1. normalizeAgents validation (defaults, dedupe, bad entries).
 *  2. AgentTerminal registry over a fake pty: create/attach/write/resize/
 *     scrollback replay/backpressure-free broadcast/kill/cap.
 *  3. isLoopbackRequest fence (socket + Host + origin markers).
 *  4. Route handlers over fake req/res (agents list, session create errors,
 *     loopback 403, method 405).
 *  5. Real node-pty end-to-end: resolve the module from the profile, spawn
 *     `cat` as an "agent", echo input, replay scrollback, kill.
 *  6. Client bundle format: lib/client.js must be a classic script that only
 *     REGISTERS a factory via window.__ModuleLoader__.load (dsh client-module
 *     protocol), whose materialization yields { apply, inject }. Guards the
 *     regression where an --format=esm build loaded without registering.
 *
 * Run: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentTerminal, isLoopbackRequest, makeRoutes, normalizeAgents } from './lib-under-test.js'

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`FAIL - ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

// --------------------------------------------------------------- fake pty

/** Fake node-pty module: spawn returns a scriptable fake terminal. */
function fakePtyModule() {
  const spawned = []
  const mod = {
    spawned,
    spawn(file, args, options) {
      const listeners = { data: [], exit: [] }
      const pty = {
        file,
        args,
        options,
        written: [],
        resized: [],
        killed: false,
        paused: false,
        onData(fn) { listeners.data.push(fn) },
        onExit(fn) { listeners.exit.push(fn) },
        write(data) { if (!this.killed) this.written.push(data) },
        resize(cols, rows) { this.resized.push([cols, rows]) },
        kill() { this.killed = true; for (const fn of listeners.exit) fn({ exitCode: 0 }) },
        pause() { this.paused = true },
        resume() { this.paused = false },
        emitData(data) { for (const fn of listeners.data) fn(data) },
        emitExit(code) { for (const fn of listeners.exit) fn({ exitCode: code }) },
      }
      spawned.push(pty)
      return pty
    },
  }
  return mod
}

/** Fake attached WebSocket client (records sent frames). */
function fakeWs() {
  const frames = []
  return {
    readyState: 1,
    bufferedAmount: 0,
    frames,
    send(text) { frames.push(JSON.parse(text)) },
    close() { this.readyState = 3 },
  }
}

// ---------------------------------------------------------------- tests

await test('normalizeAgents: defaults give claude-code + hermes', () => {
  const agents = normalizeAgents(undefined)
  assert.deepEqual(agents.map(a => a.id), ['claude-code', 'hermes'])
  assert.equal(agents[0].label, 'Claude Code')
})

await test('normalizeAgents: custom roster and duplicate rejection', () => {
  const agents = normalizeAgents([{ id: 'x', command: 'echo', args: ['hi'], label: 'X' }])
  assert.equal(agents[0].args[0], 'hi')
  assert.throws(() => normalizeAgents([{ id: 'x', command: 'a' }, { id: 'x', command: 'b' }]), /duplicate/)
  assert.throws(() => normalizeAgents([{ id: 'x' }]), /needs both id and command/)
})

await test('registry: unknown agent and missing command are rejected', () => {
  const registry = new AgentTerminal({ agents: normalizeAgents([{ id: 'gone', command: 'definitely-not-a-real-cmd-xyz' }]) })
  assert.throws(() => registry.create('nope'), /unknown agent/)
  assert.throws(() => registry.create('gone'), /command not found/)
  assert.equal(registry.listAgents()[0].available, false)
})

await test('registry: create → attach → output broadcast + input routing', () => {
  const pty = fakePtyModule()
  const registry = new AgentTerminal({ agents: normalizeAgents([{ id: 'fake', command: '/bin/cat' }]), ptyImpl: pty })
  const session = registry.create('fake', { cols: 100, rows: 30 })
  assert.equal(pty.spawned[0].options.cols, 100)
  assert.equal(pty.spawned[0].options.name, 'xterm-256color')

  const ws = fakeWs()
  const attached = registry.attach(ws, session.id)
  assert.equal(attached.id, session.id)
  // ready frame first, then (empty) scrollback did not add an output frame.
  assert.equal(ws.frames[0].type, 'ready')

  pty.spawned[0].emitData('hello world')
  assert.equal(ws.frames.at(-1).type, 'output')
  assert.equal(ws.frames.at(-1).data, 'hello world')

  registry.write(session.id, 'typed\n')
  assert.equal(pty.spawned[0].written.at(-1), 'typed\n')

  registry.resize(session.id, 200, 50)
  assert.deepEqual(pty.spawned[0].resized.at(-1), [200, 50])
})

await test('registry: scrollback replays for a later attach, bounded', () => {
  const pty = fakePtyModule()
  const registry = new AgentTerminal({
    agents: normalizeAgents([{ id: 'fake', command: '/bin/cat' }]),
    ptyImpl: pty,
    scrollbackChars: 40,
  })
  const session = registry.create('fake')
  pty.spawned[0].emitData('a'.repeat(30))
  pty.spawned[0].emitData('b'.repeat(30))
  const ws = fakeWs()
  registry.attach(ws, session.id)
  const output = ws.frames.filter(f => f.type === 'output').map(f => f.data).join('')
  assert.ok(output.length <= 60 + 40, `scrollback bounded, got ${output.length}`)
  assert.ok(output.endsWith('b'.repeat(30)), 'newest output retained')
})

await test('registry: exit closes clients and drops the session; kill works', () => {
  const pty = fakePtyModule()
  const registry = new AgentTerminal({ agents: normalizeAgents([{ id: 'fake', command: '/bin/cat' }]), ptyImpl: pty })
  const session = registry.create('fake')
  const ws = fakeWs()
  registry.attach(ws, session.id)
  pty.spawned[0].emitExit(3)
  const exitFrame = ws.frames.find(f => f.type === 'exit')
  assert.equal(exitFrame.code, 3)
  assert.equal(ws.readyState, 3)
  assert.equal(registry.listSessions().length, 0)

  const session2 = registry.create('fake')
  assert.equal(registry.kill(session2.id), true)
  assert.equal(pty.spawned[1].killed, true)
})

await test('registry: session cap enforced', () => {
  const pty = fakePtyModule()
  const registry = new AgentTerminal({ agents: normalizeAgents([{ id: 'fake', command: '/bin/cat' }]), ptyImpl: pty, maxSessions: 2 })
  registry.create('fake')
  registry.create('fake')
  assert.throws(() => registry.create('fake'), /session cap/)
})

await test('isLoopbackRequest: fence semantics', () => {
  const base = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:57928' } }
  assert.equal(isLoopbackRequest(base), true)
  assert.equal(isLoopbackRequest({ ...base, headers: { host: '127.0.0.1:57928', origin: 'http://127.0.0.1:57928' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.5' }, headers: { host: '127.0.0.1:1' } }), false)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'example.com' } }), false)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { host: 'localhost:80' } }), true)
})

await test('routes: agents list, create validation, fences', async () => {
  const pty = fakePtyModule()
  const registry = new AgentTerminal({ agents: normalizeAgents([{ id: 'fake', command: '/bin/cat' }]), ptyImpl: pty })
  const wsModule = { WebSocketServer: class { constructor() {} close() {} } }
  const { routes } = makeRoutes({ registry, wsModule })
  const byPath = Object.fromEntries(routes.map(r => [r.path, r]))

  const res = () => {
    const state = { status: 0, body: '', headers: {} }
    return {
      state,
      writeHead(status, headers) { state.status = status; state.headers = headers },
      end(payload) { state.body = payload ?? '' },
    }
  }
  const loopback = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:1' }, method: 'GET', url: '/api/dsh-agent-terminal/agents' }
  const remote = { ...loopback, socket: { remoteAddress: '10.0.0.2' } }

  const ok = res()
  await byPath['/api/dsh-agent-terminal/agents'].handler(loopback, ok)
  assert.equal(ok.state.status, 200)
  assert.deepEqual(JSON.parse(ok.state.body).agents.map(a => a.id), ['fake'])

  const forbidden = res()
  await byPath['/api/dsh-agent-terminal/agents'].handler(remote, forbidden)
  assert.equal(forbidden.state.status, 403)

  const bad = res()
  const badReq = {
    socket: { remoteAddress: '127.0.0.1' },
    method: 'POST',
    url: '/api/dsh-agent-terminal/sessions',
    headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
    async * [Symbol.asyncIterator]() { yield Buffer.from('{}') },
  }
  await byPath['/api/dsh-agent-terminal/sessions'].handler(badReq, bad)
  // {} -> missing agentId
  assert.equal(bad.state.status, 400)
  assert.ok(JSON.parse(bad.state.body).error.includes('agentId'))

  const wrongMethod = res()
  await byPath['/api/dsh-agent-terminal/agents'].handler({ ...loopback, method: 'PUT' }, wrongMethod)
  assert.equal(wrongMethod.state.status, 405)
})

await test('real node-pty: resolve module, spawn cat, echo, replay, kill', async () => {
  const { AgentTerminal: RealAgentTerminal, resolveHostModule } = await import('./lib-under-test.js')
  const ptyImpl = resolveHostModule('node-pty')
  assert.equal(typeof ptyImpl.spawn, 'function')
  const registry = new RealAgentTerminal({
    agents: normalizeAgents([{ id: 'cat', label: 'cat', command: 'cat', args: [] }]),
    ptyImpl,
  })
  const session = registry.create('cat', { cols: 90, rows: 28 })
  const ws = fakeWs()
  registry.attach(ws, session.id)
  registry.write(session.id, 'ping-echo\n')
  let echoed = false
  for (let i = 0; i < 40 && !echoed; i++) {
    await delay(25)
    echoed = ws.frames.some(f => f.type === 'output' && f.data.includes('ping-echo'))
  }
  assert.ok(echoed, 'cat echoed the input back through the WebSocket frames')

  // Detach, produce more output, re-attach: scrollback replay must contain it.
  ws.close()
  registry.write(session.id, 'after-detach\n')
  await delay(150)
  const ws2 = fakeWs()
  registry.attach(ws2, session.id)
  const replay = ws2.frames.filter(f => f.type === 'output').map(f => f.data).join('')
  assert.ok(replay.includes('after-detach'), 'reattach replays post-detach output')

  registry.kill(session.id)
  await delay(200)
  assert.equal(registry.listSessions().length, 0, 'session dropped after kill')
})

await test('apply(): wires registry + routes through a fake cordis ctx', async () => {
  const mod = await import('./lib-under-test.js')
  const registered = []
  const upgrades = []
  const effects = []
  const ctx = {
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    webServer: {
      register: route => { registered.push(route); return () => {} },
      registerUpgrade: route => { upgrades.push(route); return () => {} },
    },
    logger: { info() {}, warn() {} },
  }
  mod.apply(ctx, { agents: [{ id: 'cat', command: 'cat' }] })
  assert.equal(registered.length, 2, 'two exact routes registered')
  assert.equal(upgrades.length, 1, 'terminal upgrade registered')
  assert.deepEqual(registered.map(r => r.path).sort(), [
    '/api/dsh-agent-terminal/agents',
    '/api/dsh-agent-terminal/sessions',
  ])
  assert.equal(upgrades[0].path, '/api/dsh-agent-terminal/terminal')
  // Disposing the effects must not throw (registry.dispose with no sessions).
  for (const dispose of effects) dispose()
})

// ------------------------------------------- client bundle format (dsh loader)

await test('client bundle: registers via window.__ModuleLoader__.load, materializes apply/inject', () => {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  let record = null
  const registered = new Map()
  const sandboxWindow = { __ModuleLoader__: { load(entry) { registered.set(entry.id, entry); record = entry } } }

  // Script execution = registration only (no DOM access, no side effects).
  const run = new Function('window', code)
  run(sandboxWindow)

  assert.equal(record?.id, 'dsh-agent-terminal', 'registered under the package name')
  assert.equal(typeof record.factory, 'function', 'factory registered')
  assert.equal(registered.size, 1, 'exactly one load() call')

  // Materialization: factory(require) -> exports with apply + inject.
  const exports_ = record.factory(() => { throw new Error('unexpected require') })
  assert.equal(typeof exports_.apply, 'function', 'exports.apply is a function')
  assert.deepEqual(exports_.inject, [], 'exports.inject is []')

  // apply() in a DOM-less host only warns — never throws (failure policy).
  exports_.apply({
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    logger: { info() {}, warn() {} },
  })
})

console.log(`\n${passed} passed`)
