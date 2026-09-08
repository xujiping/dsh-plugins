import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '/Users/xujiping/.dsh/profiles/node_modules/@deepseek-ai/cordis/lib/index.js'
import SessionStore from '/Users/xujiping/.dsh/profiles/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import AgentRegistry, { emitAgentEvent } from '/Users/xujiping/.dsh/profiles/node_modules/@deepseek-ai/dsh-agent/lib/index.js'
import LlmRuntime from '/Users/xujiping/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import { createUserMessage } from '/Users/xujiping/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import TypertRegistry from '/Users/xujiping/.dsh/profiles/node_modules/@deepseek-ai/dsh-typert-registry/lib/index.js'
import TypertGatewayService from '/Users/xujiping/.dsh/profiles/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js'
import {
  CLAUDE_PERMISSION_MODES,
  ClaudeCodeDriverGateway,
  CLAUDE_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TOOLS,
  DriverIndex,
} from '../lib/index.js'
import TYPERT from '../lib/typert.js'
import REMOTE from '../lib/remote.js'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-agent-driver-'))
const indexPath = join(scratch, 'sessions.json')

// The browser half is a classic DSH ModuleLoader script. Verify it registers
// a mountable strict Remote contribution without requiring a browser runtime.
{
  const clientSource = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')
  assert.doesNotMatch(clientSource, /api\.sessions\.selectModel/, 'native creation must not mutate the global default model')
  assert.match(clientSource, /sessions'\)\.create\(\{ workspaceId: target \}\)/, 'default route creates a standard session instead of reusing a native blank one')
  assert.doesNotMatch(clientSource, /workspaces'\)\.startSession\(/, 'default route must not adopt an arbitrary blank session')
  let descriptor
  const windowShim = {
    __ModuleLoader__: { load: (value) => { descriptor = value } },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  new Function('window', clientSource)(windowShim)
  const clientApi = descriptor.factory((specifier) => {
    if (specifier === 'react') {
      return {
        createElement: () => null,
        useState: () => [undefined, () => {}],
        useEffect: () => {},
      }
    }
    throw new Error(`unexpected client module: ${specifier}`)
  })
  assert.deepEqual(clientApi.inject, ['connection', 'remote', 'sessions', 'workspaces', 'slots'])
  let mounted
  const slotRegistrations = []
  const pendingEffects = []
  const savedDocument = globalThis.document
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ dataset: {}, style: {} }),
    head: { appendChild: () => {} },
    body: { dataset: {} },
  }
  try {
    await clientApi.apply({
      remote: { $mount: async (value) => { mounted = value; return () => {} } },
      reflect: { get: (key) => key === 'remote.nativeAgent' ? { getPermission: async () => ({ ok: false, error: {} }) } : undefined },
      get: (key) => key === 'sessions' ? { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } } : undefined,
      slots: {
        inject: (_name, callback) => callback(),
        register: (entry, component) => { slotRegistrations.push({ entry, component }); return () => {} },
      },
      effect: (callback) => { pendingEffects.push(Promise.resolve(callback())); return () => {} },
    })
    await Promise.all(pendingEffects)
  } finally {
    globalThis.document = savedDocument
  }
  assert.equal(mounted.package, 'dsh-agent-driver')
  assert.equal(mounted.descriptors[0].namespace, 'nativeAgent')
  assert.deepEqual(mounted.descriptors.map((descriptor) => descriptor.method), ['createSession', 'getPermission', 'setPermission'])
  assert.equal(slotRegistrations[0].entry.name, 'conversation.input.left')
  assert.equal(slotRegistrations[0].entry.id, 'claude-code-permission')
}

// Real dsh-session + dsh-agent registries prove that publication uses the
// public prepare/enter/announce transaction, not sessions.create/register.
const ctx = new Context()
ctx.sessions = new SessionStore(ctx)
ctx.agents = new AgentRegistry(ctx)
ctx.llm = new LlmRuntime(ctx)
ctx.typert = new TypertRegistry(ctx)
const attached = []
ctx.workspaceRegistry = {
  get: (id) => id === 'workspace-1' ? { path: scratch, attachSession: async (sessionId) => attached.push(sessionId) } : undefined,
}
ctx.sessionPersistence = { prepare: async () => { throw new Error('not used in fresh smoke') } }

const gateway = new ClaudeCodeDriverGateway(ctx, {
  command: process.execPath,
  args: [join(here, 'fake-claude.js')],
  indexPath,
})
assert.deepEqual(DEFAULT_TOOLS, ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'])
assert.deepEqual(CLAUDE_PERMISSION_MODES, ['plan', 'acceptEdits', 'auto'])
assert.equal(DEFAULT_PERMISSION_MODE, 'plan')
assert.deepEqual(gateway.config.tools, DEFAULT_TOOLS, 'native Claude sessions enable the standard workspace tool set by default')
assert.equal(gateway.config.securityProfile, 'workspace-tools')
ctx.llm.registerAdapter([CLAUDE_PROVIDER], {
  providerInfo: (id) => ({ id, name: id }),
  providerRetryPolicy: () => undefined,
  listModels: async () => [],
  resolveModel: async (provider, id) => ({ provider, id }),
  stream: async function* () {},
})

// Host and Client contributions share one strict endpoint contract.
assert.equal(TYPERT.invocations[0].namespace, 'nativeAgent')
assert.deepEqual(TYPERT.invocations.map((invocation) => invocation.method), ['createSession', 'getPermission', 'setPermission'])
assert.deepEqual(REMOTE.descriptors.map((descriptor) => descriptor.method), ['createSession', 'getPermission', 'setPermission'])
assert.equal(TYPERT.invocations[0].parameters[0].codec.mode, 'strict')
assert.ok('_zod' in TYPERT.invocations[0].parameters[0].codec.schema, 'Host descriptor is a zod v4 schema for typert-loader')
assert.equal(REMOTE.descriptors[0].result.codec ? 'unexpected' : REMOTE.descriptors[0].result.mode, 'strict')

ctx.typert.register(TYPERT)
const remoteGateway = new TypertGatewayService(ctx)
const { sessionId } = await remoteGateway.invoke({
  namespace: 'nativeAgent',
  method: 'createSession',
  args: { workspaceId: 'workspace-1' },
})
assert.match(sessionId, /^[0-9a-f-]{36}$/)
assert.deepEqual(attached, [sessionId])
const agent = ctx.agents.get(sessionId)
assert.ok(agent, 'custom agent is live in the standard registry')
assert.equal(ctx.sessions.get(sessionId), agent.session, 'same session is live in the standard store')
assert.equal(agent.options.provider, CLAUDE_PROVIDER)
assert.deepEqual(agent.session.requestHeader()?.config, {
  provider: CLAUDE_PROVIDER,
  model: DEFAULT_MODEL,
}, 'native route is session-local from creation; no global model selection RPC is needed')
const startupArgs = agent.commandArgs(true)
assert.equal(startupArgs[startupArgs.indexOf('--tools') + 1], DEFAULT_TOOLS.join(','), 'Claude CLI receives the enabled workspace tools')
assert.ok(startupArgs.includes('--safe-mode'), 'safe mode remains enabled with the workspace tools')
assert.ok(startupArgs.includes('--strict-mcp-config'), 'MCP isolation remains enabled with the workspace tools')
assert.equal(startupArgs[startupArgs.indexOf('--permission-mode') + 1], 'plan', 'new native sessions default to Claude plan mode')

const initialPermission = await remoteGateway.invoke({
  namespace: 'nativeAgent',
  method: 'getPermission',
  args: { sessionId },
})
assert.deepEqual(initialPermission, { permissionMode: 'plan' })

// A native Agent's Context must be scope-isolated. Otherwise API-proxy's
// agent/session-start setup installs its model-selection listener globally and
// routes unrelated default Harness agents to the native sentinel adapter.
let nativeScopeHits = 0
agent.ctx.on('agent-driver/scope-probe', () => { nativeScopeHits += 1 })
const sibling = { id: randomUUID(), session: { id: randomUUID() } }
emitAgentEvent(ctx, sibling, 'agent-driver/scope-probe', {})
assert.equal(nativeScopeHits, 0, 'native scoped listener does not observe a sibling Agent')
emitAgentEvent(ctx, agent, 'agent-driver/scope-probe', {})
assert.equal(nativeScopeHits, 1, 'native scoped listener observes its own Agent')

agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user', rpcId: randomUUID() } }))
await agent.whenIdle()
const types = agent.session.events.map((event) => event.type)
for (const type of ['turn/start', 'user/message', 'request/header', 'step/start', 'assistant/chunk', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end']) {
  assert.ok(types.includes(type), `event present: ${type}; got ${JSON.stringify(types)}`)
}
assert.equal(agent.session.events.find((event) => event.type === 'request/header').data.header.config.provider, CLAUDE_PROVIDER)
const call = agent.session.events.find((event) => event.type === 'tool/call')
const result = agent.session.events.find((event) => event.type === 'tool/result')
assert.equal(result.sourceEventSeqs[0], call.seq, 'tool result cites its call')
assert.equal(agent.session.events.at(-1).data.reason.kind, 'completed')
assert.ok(agent.session.events.some((event) => event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta'), 'partial text delta retained')
const assistantMessages = agent.session.events.filter((event) => event.type === 'assistant/message')
assert.equal(assistantMessages.at(-1).data.message.source.model, 'fake-runtime-model')
assert.deepEqual(assistantMessages.at(-1).data.usage, { inputTokens: 10, outputTokens: 3 })
assert.deepEqual(await gateway.getPermission(sessionId), { permissionMode: 'plan', effectivePermissionMode: 'plan' }, 'system/init reports the effective Claude permission mode')

const changedPermission = await remoteGateway.invoke({
  namespace: 'nativeAgent',
  method: 'setPermission',
  args: { sessionId, permissionMode: 'acceptEdits' },
})
assert.deepEqual(changedPermission, { permissionMode: 'acceptEdits' })
const resumedArgs = agent.commandArgs(false)
assert.equal(resumedArgs[resumedArgs.indexOf('--permission-mode') + 1], 'acceptEdits', '--resume carries the persisted permission mode too')
await assert.rejects(
  () => remoteGateway.invoke({ namespace: 'nativeAgent', method: 'setPermission', args: { sessionId, permissionMode: 'bypassPermissions' } }),
  /permissionMode|bypassPermissions/,
  'the Remote contract never accepts bypass permissions',
)
const finalPermission = await remoteGateway.invoke({
  namespace: 'nativeAgent',
  method: 'setPermission',
  args: { sessionId, permissionMode: 'auto' },
})
assert.deepEqual(finalPermission, { permissionMode: 'auto' })

// Automatic titles (first-prompt fallback) of native sessions must be pinned
// with the agent prefix so the workspace session list shows the agent name.
agent.session.append('session/title', { title: '帮我修一个 bug', messageSeqs: [3], source: { kind: 'fallback' } })
await new Promise((resolve) => queueMicrotask(resolve))
const titleEvents = agent.session.events.filter((event) => event.type === 'session/title')
assert.equal(titleEvents.at(-1).data.title, 'Claude Code · 帮我修一个 bug', 'fallback title is prefixed for the session list')
assert.equal(titleEvents.at(-1).data.source.kind, 'user', 'prefixed title is pinned so later auto titles cannot strip the agent name')
agent.session.append('session/title', { title: 'user rename', messageSeqs: [], source: { kind: 'user' } })
const titlesAfterUserRename = agent.session.events.filter((event) => event.type === 'session/title').map((event) => event.data.title)
agent.session.append('session/title', { title: 'later fallback', messageSeqs: [9], source: { kind: 'fallback' } })
await new Promise((resolve) => queueMicrotask(resolve))
const finalTitles = agent.session.events.filter((event) => event.type === 'session/title').map((event) => event.data.title)
assert.deepEqual(finalTitles, [...titlesAfterUserRename, 'later fallback'], 'user renames are respected verbatim; later auto titles are not re-prefixed')

const stored = JSON.parse(await readFile(indexPath, 'utf8'))
assert.equal(stored.sessions[0].sessionId, sessionId)
assert.equal(stored.sessions[0].driver, 'claude-code-native')
assert.equal(stored.version, 2)
assert.equal(stored.sessions[0].permissionMode, 'auto', 'permission choice is durable driver state')

// The sidecar never stores a second Claude ID or any secret.
const index = new DriverIndex(indexPath)
assert.deepEqual((await index.read()).map((entry) => entry.sessionId), [sessionId])

// Cold recovery reuses the durable DSH SessionId and publishes the custom
// Agent before any resolver gets a chance to create a default loop.
const restoreCtx = new Context()
restoreCtx.sessions = new SessionStore(restoreCtx)
restoreCtx.agents = new AgentRegistry(restoreCtx)
restoreCtx.llm = new LlmRuntime(restoreCtx)
restoreCtx.workspaceRegistry = { get: () => undefined }
restoreCtx.sessionPersistence = {
  prepare: async (id) => ({
    session: restoreCtx.sessions.prepare(id, { meta: { cwd: scratch } }),
    [Symbol.dispose]() {},
  }),
}
const restoringGateway = new ClaudeCodeDriverGateway(restoreCtx, { indexPath, tools: [] })
await restoringGateway.restore()
const restored = restoreCtx.agents.get(sessionId)
assert.ok(restored, 'sidecar entry restores a live custom agent')
assert.equal(restored.options.provider, CLAUDE_PROVIDER)
const restoredArgs = restored.commandArgs(false)
assert.equal(restoredArgs[restoredArgs.indexOf('--permission-mode') + 1], 'auto', 'cold recovery restores the selected Claude permission mode')
// Restored native sessions also pin prefixed titles for new automatic titles.
restored.session.append('session/title', { title: 'restored topic', messageSeqs: [1], source: { kind: 'provider' } })
await new Promise((resolve) => queueMicrotask(resolve))
const restoredTitles = restored.session.events.filter((event) => event.type === 'session/title').map((event) => event.data.title)
assert.deepEqual(restoredTitles, ['restored topic', 'Claude Code · restored topic'], 'restored agent pins the agent-name prefix')
assert.throws(
  () => new ClaudeCodeDriverGateway(new Context(), { args: ['--permission-mode', 'auto'] }),
  /managed per native session/,
  'static config cannot override the per-session permission mode',
)
console.log('PASS lifecycle, Remote permissions, JSONL translation, durable permission mode, sidecar index, agent-name title prefix')
