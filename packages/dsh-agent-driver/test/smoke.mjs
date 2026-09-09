import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
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
  CLAUDE_PROFILE,
  ClaudeCodeDriverGateway,
  CLAUDE_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TOOLS,
  DriverIndex,
  HERMES_PERMISSION_MODES,
  HERMES_PROFILE,
  HERMES_PROVIDER,
  HermesDriverGateway,
} from '../lib/index.js'
import TYPERT from '../lib/typert.js'
import REMOTE from '../lib/remote.js'
import { CliDriverGateway } from '../lib/driver-core.js'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-agent-driver-'))
const indexPath = join(scratch, 'sessions.json')

// 插件加载器可能不传配置；直接覆盖 apply 使用的通用网关，避免兼容类的默认值掩盖错误。
{
  const startupCtx = new Context()
  const startupGateway = new CliDriverGateway(startupCtx, undefined, CLAUDE_PROFILE)
  assert.equal(startupGateway.config.indexPath, join(homedir(), '.dsh', 'agent-driver', 'sessions.json'))
  assert.equal(startupGateway.legacyPath, join(homedir(), '.dsh', 'cc-agent-driver', 'sessions.json'))
}

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
      inject: () => {},
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
  assert.deepEqual(mounted.descriptors.map((descriptor) => descriptor.method), ['createSession', 'getPermission', 'setPermission', 'createSession', 'getPermission', 'setPermission', 'getModels', 'setModel', 'getModels', 'setModel'])
  assert.deepEqual(mounted.descriptors.map((descriptor) => descriptor.namespace), ['nativeAgent', 'nativeAgent', 'nativeAgent', 'hermesAgent', 'hermesAgent', 'hermesAgent', 'nativeAgent', 'nativeAgent', 'hermesAgent', 'hermesAgent'])
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
assert.equal(gateway.legacyPath, undefined, '自定义索引路径不触发旧索引迁移')
assert.deepEqual(DEFAULT_TOOLS, ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'])
assert.deepEqual(CLAUDE_PERMISSION_MODES, ['plan', 'acceptEdits', 'auto'])
assert.equal(DEFAULT_PERMISSION_MODE, 'acceptEdits')
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
assert.deepEqual(TYPERT.invocations.map((invocation) => invocation.method), ['getModels', 'setModel', 'createSession', 'getPermission', 'setPermission', 'getModels', 'setModel', 'createSession', 'getPermission', 'setPermission'])
assert.deepEqual(TYPERT.invocations.map((invocation) => invocation.namespace), ['nativeAgent', 'nativeAgent', 'nativeAgent', 'nativeAgent', 'nativeAgent', 'hermesAgent', 'hermesAgent', 'hermesAgent', 'hermesAgent', 'hermesAgent'])
assert.deepEqual(REMOTE.descriptors.map((descriptor) => descriptor.method), ['getModels', 'setModel', 'createSession', 'getPermission', 'setPermission', 'getModels', 'setModel', 'createSession', 'getPermission', 'setPermission'])
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
assert.equal(startupArgs[startupArgs.indexOf('--permission-mode') + 1], 'acceptEdits', 'new native sessions default to Claude acceptEdits mode')

const initialPermission = await remoteGateway.invoke({
  namespace: 'nativeAgent',
  method: 'getPermission',
  args: { sessionId },
})
assert.deepEqual(initialPermission, { permissionMode: 'acceptEdits' })

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
assert.deepEqual(await gateway.getPermission(sessionId), { permissionMode: 'acceptEdits', effectivePermissionMode: 'acceptEdits', model: 'fake-claude' }, 'system/init reports the effective Claude permission mode and actual model')

const changedPermission = await remoteGateway.invoke({
  namespace: 'nativeAgent',
  method: 'setPermission',
  args: { sessionId, permissionMode: 'acceptEdits' },
})
assert.deepEqual(changedPermission, { permissionMode: 'acceptEdits', model: 'fake-claude' })
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
assert.deepEqual(finalPermission, { permissionMode: 'auto', model: 'fake-claude' })

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

// ---- Hermes driver ----
const hermesIndexPath = join(scratch, 'hermes-sessions.json')
const hermesGateway = new HermesDriverGateway(ctx, {
  command: process.execPath,
  args: [join(here, 'fake-hermes-acp.js')],
  indexPath: hermesIndexPath,
})
ctx.llm.registerAdapter([HERMES_PROVIDER], {
  providerInfo: (id) => ({ id, name: id }),
  providerRetryPolicy: () => undefined,
  listModels: async () => [],
  resolveModel: async (provider, id) => ({ provider, id }),
  stream: async function* () {},
})
assert.deepEqual(HERMES_PERMISSION_MODES, ['default', 'yolo'])
assert.equal(hermesGateway.config.securityProfile, 'workspace-tools')

const { sessionId: hermesSessionId } = await remoteGateway.invoke({
  namespace: 'hermesAgent',
  method: 'createSession',
  args: { workspaceId: 'workspace-1' },
})
const hermesAgentLive = ctx.agents.get(hermesSessionId)
assert.ok(hermesAgentLive, 'Hermes agent is live in the standard registry')
assert.equal(hermesAgentLive.options.provider, HERMES_PROVIDER)
const hermesQuery = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: randomUUID() } })
assert.deepEqual(hermesAgentLive.commandArgs(false, hermesQuery('anything')), [join(here, 'fake-hermes-acp.js'), 'acp'], 'ACP mode spawns hermes acp without per-turn CLI flags')

hermesAgentLive.followup(hermesQuery('first question'))
await hermesAgentLive.whenIdle()
const hermesAssistant = hermesAgentLive.session.events.findLast((event) => event.type === 'assistant/message')?.data
assert.ok(hermesAssistant, 'ACP turn produced an assistant message')
const hermesText = hermesAssistant.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
const hermesThought = hermesAssistant.message.content.filter((block) => block.type === 'reasoning').map((block) => block.text).join('')
assert.equal(hermesText, 'Hello from fake Hermes ACP. perm:deny', 'streamed reply lands; default permission mode denies')
assert.equal(hermesThought, 'thinking about it ', 'thought chunks stream into a reasoning block')
assert.deepEqual(hermesAssistant.usage, { inputTokens: 7, outputTokens: 2 })
assert.equal(hermesAgentLive.session.events.at(-1).data.reason.kind, 'completed')
assert.ok(hermesAgentLive.session.events.some((event) => event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta'), 'partial text deltas stream in real time')
const hermesToolCall = hermesAgentLive.session.events.find((event) => event.type === 'tool/call')
const hermesToolResult = hermesAgentLive.session.events.find((event) => event.type === 'tool/result')
assert.ok(hermesToolCall && hermesToolResult, 'ACP tool_call updates map to tool/call + tool/result')
assert.equal(hermesToolResult.data.message.content[0].content[0].text, 'tool denied')
assert.ok(!hermesText.includes('replayed'), 'session/load replay history is dropped, not re-appended')
const hermesStored = JSON.parse(await readFile(hermesIndexPath, 'utf8'))
assert.equal(hermesStored.sessions[0].driver, 'hermes-native')
assert.equal(hermesStored.version, 2)
assert.equal(hermesStored.sessions[0].acpSessionId, 'acp-fake-session', 'ACP session id is durable for later session/load')
assert.equal(hermesStored.sessions[0].model, 'fake-acp-model', 'currentModelId is persisted for display')
assert.deepEqual(await hermesGateway.getPermission(hermesSessionId), { permissionMode: 'default', effectivePermissionMode: 'default', model: 'fake-acp-model' })

// 第二轮：应走 session/load 续接同一 ACP 会话（fake 在 load 时 replay 旧消息，
// 驱动必须丢弃，且第二轮正文仍是新回复）。
hermesAgentLive.followup(hermesQuery('second question'))
await hermesAgentLive.whenIdle()
const secondAssistant = hermesAgentLive.session.events.filter((event) => event.type === 'assistant/message').at(-1).data
const secondText = secondAssistant.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
assert.equal(secondText, 'Second reply from fake Hermes ACP. perm:deny')

const hermesYolo = await remoteGateway.invoke({
  namespace: 'hermesAgent',
  method: 'setPermission',
  args: { sessionId: hermesSessionId, permissionMode: 'yolo' },
})
assert.deepEqual(hermesYolo, { permissionMode: 'yolo', model: 'fake-acp-model' })
hermesAgentLive.followup(hermesQuery('third question'))
await hermesAgentLive.whenIdle()
const yoloText = hermesAgentLive.session.events.filter((event) => event.type === 'assistant/message').at(-1).data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
assert.ok(yoloText.endsWith('perm:allow'), 'yolo permission round-trip selects allow_once')
await assert.rejects(
  () => remoteGateway.invoke({ namespace: 'hermesAgent', method: 'setPermission', args: { sessionId: hermesSessionId, permissionMode: 'acceptEdits' } }),
  /unsupported Hermes permission mode/,
  'Hermes sessions only accept their own permission modes',
)
hermesAgentLive.session.append('session/title', { title: '查一下配置', messageSeqs: [2], source: { kind: 'fallback' } })
await new Promise((resolve) => queueMicrotask(resolve))
const hermesTitles = hermesAgentLive.session.events.filter((event) => event.type === 'session/title')
assert.equal(hermesTitles.at(-1).data.title, 'Hermes · 查一下配置', 'Hermes fallback titles are prefixed too')
assert.equal(HERMES_PROFILE.remoteNamespace, 'hermesAgent')
assert.equal(CLAUDE_PROFILE.remoteNamespace, 'nativeAgent')
console.log('PASS lifecycle, Remote permissions, JSONL translation, durable permission mode, sidecar index, agent-name title prefix, Hermes ACP streaming driver')
