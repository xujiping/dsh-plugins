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
import { ClaudeCodeDriverGateway, CLAUDE_PROVIDER, DEFAULT_MODEL, DriverIndex } from '../lib/index.js'
import TYPERT from '../lib/typert.js'
import REMOTE from '../lib/remote.js'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-cc-driver-'))
const indexPath = join(scratch, 'sessions.json')

// The browser half is a classic DSH ModuleLoader script. Verify it registers
// a mountable strict Remote contribution without requiring a browser runtime.
{
  const clientSource = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')
  assert.doesNotMatch(clientSource, /api\.sessions\.selectModel/, 'native creation must not mutate the global default model')
  assert.match(clientSource, /sessions'\)\.create\(\{ workspaceId: target \}\)/, 'default route creates a standard session instead of reusing a native blank one')
  assert.doesNotMatch(clientSource, /workspaces'\)\.startSession\(/, 'default route must not adopt an arbitrary blank session')
  let descriptor
  const windowShim = { __ModuleLoader__: { load: (value) => { descriptor = value } } }
  new Function('window', clientSource)(windowShim)
  const clientApi = descriptor.factory((specifier) => {
    throw new Error(`client must not require external module: ${specifier}`)
  })
  assert.deepEqual(clientApi.inject, ['connection', 'remote', 'sessions', 'workspaces'])
  let mounted
  const pendingEffects = []
  await clientApi.apply({
    remote: { $mount: async (value) => { mounted = value; return () => {} } },
    reflect: { get: (key) => key === 'remote.ccNative' ? {} : undefined },
    effect: (callback) => { pendingEffects.push(Promise.resolve(callback())); return () => {} },
  })
  await Promise.all(pendingEffects)
  assert.equal(mounted.package, 'dsh-cc-agent-driver')
  assert.equal(mounted.descriptors[0].namespace, 'ccNative')
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
  tools: [],
})
ctx.llm.registerAdapter([CLAUDE_PROVIDER], {
  providerInfo: (id) => ({ id, name: id }),
  providerRetryPolicy: () => undefined,
  listModels: async () => [],
  resolveModel: async (provider, id) => ({ provider, id }),
  stream: async function* () {},
})

// Host and Client contributions share one strict endpoint contract.
assert.equal(TYPERT.invocations[0].namespace, 'ccNative')
assert.equal(REMOTE.descriptors[0].method, 'createSession')
assert.equal(TYPERT.invocations[0].parameters[0].codec.mode, 'strict')
assert.ok('_zod' in TYPERT.invocations[0].parameters[0].codec.schema, 'Host descriptor is a zod v4 schema for typert-loader')
assert.equal(REMOTE.descriptors[0].result.codec ? 'unexpected' : REMOTE.descriptors[0].result.mode, 'strict')

ctx.typert.register(TYPERT)
const remoteGateway = new TypertGatewayService(ctx)
const { sessionId } = await remoteGateway.invoke({
  namespace: 'ccNative',
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

// A native Agent's Context must be scope-isolated. Otherwise API-proxy's
// agent/session-start setup installs its model-selection listener globally and
// routes unrelated default Harness agents to the native sentinel adapter.
let nativeScopeHits = 0
agent.ctx.on('cc-agent-driver/scope-probe', () => { nativeScopeHits += 1 })
const sibling = { id: randomUUID(), session: { id: randomUUID() } }
emitAgentEvent(ctx, sibling, 'cc-agent-driver/scope-probe', {})
assert.equal(nativeScopeHits, 0, 'native scoped listener does not observe a sibling Agent')
emitAgentEvent(ctx, agent, 'cc-agent-driver/scope-probe', {})
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

const stored = JSON.parse(await readFile(indexPath, 'utf8'))
assert.equal(stored.sessions[0].sessionId, sessionId)
assert.equal(stored.sessions[0].driver, 'claude-code-native')

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
console.log('PASS atomic lifecycle, strict Remote descriptor, JSONL event translation, sidecar index')
