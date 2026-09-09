import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importDshModule } from '../lib/dsh-runtime.js'
import { ClaudeCodeDriverGateway, HermesDriverGateway } from '../lib/index.js'
import { TYPERT as NATIVE_TYPERT } from '../lib/typert.js'
import { discoverHermesModels } from '../lib/hermes-models.js'
import { CliDriverAgent } from '../lib/driver-core.js'
import { discoverCommands, installNativeCommands, normalizeCommands } from '../lib/commands.js'
const { Context } = await importDshModule('@deepseek-ai/cordis')
const { default: Sessions } = await importDshModule('@deepseek-ai/dsh-session')
const { default: Agents } = await importDshModule('@deepseek-ai/dsh-agent')
const { default: Commands } = await importDshModule('@deepseek-ai/dsh-commands')
const { default: Registry } = await importDshModule('@deepseek-ai/dsh-typert-registry')
const { default: Remote } = await importDshModule('@deepseek-ai/dsh-api-gateway')
const { TYPERT } = await importDshModule('@deepseek-ai/dsh-commands/typert')
const here = dirname(fileURLToPath(import.meta.url))
const cwd = await mkdtemp(join(tmpdir(), 'native-commands-'))
const ctx = new Context()
ctx.sessions = new Sessions(ctx)
ctx.agents = new Agents(ctx)
ctx.commands = new Commands(ctx)
ctx.typert = new Registry(ctx)
ctx.typert.register(TYPERT)
ctx.typert.register(NATIVE_TYPERT)
const remote = new Remote(ctx)
let harnessCalls = 0
ctx.commands.register({ name: 'compact', description: 'Harness 压缩', handler: () => { harnessCalls++; return { kind: 'success' } } })
const originalList = ctx.commands.list
const originalExecute = ctx.commands.execute
let disposeCommands
installNativeCommands({ commands: ctx.commands, effect: (fn) => { disposeCommands = fn() } }, (agent) => agent instanceof CliDriverAgent)
const gateways = [
  new ClaudeCodeDriverGateway(ctx, { command: process.execPath, args: [join(here, 'fake-claude.js')], indexPath: join(cwd, 'claude.json') }),
  new HermesDriverGateway(ctx, { command: process.execPath, args: [join(here, 'fake-hermes-acp.js')], indexPath: join(cwd, 'hermes.json') }),
]
const agents = []
for (const gateway of gateways) {
  const { sessionId } = await gateway.createForWorkspace({ path: cwd, attachSession: async () => {} })
  agents.push(ctx.agents.get(sessionId))
}
const [claude, hermes] = agents
const modelConfig = { command: join(here, 'fake-hermes/hermes'), args: ['--profile', 'test'] }
hermes.profile = { ...hermes.profile, discoverModels: (agent, signal) => discoverHermesModels({ ...agent, config: modelConfig }, signal) }
const hermesModels = await gateways[1].getModels(hermes.id)
assert.equal(hermesModels.length, 4, '目录包含当前 provider 之外的模型')
assert.equal(hermesModels[3].id, 'custom:qwen-coding-plan:shared-model', '自定义提供商使用可路由的 ACP 标识')
assert.equal(JSON.stringify(hermesModels).includes('must-not-leak'), false, '目录不泄露凭据')
const modelAbort = new AbortController()
modelAbort.abort()
await assert.rejects(discoverHermesModels({ ...hermes, config: modelConfig }, modelAbort.signal), /取消/)
await assert.rejects(discoverHermesModels(hermes), /Python/, '不支持的 launcher 明确报错而非回退不完整目录')
const invoke = (agent, method, extra = {}) => remote.invoke({ namespace: 'commands', method, args: { agentId: agent.id, ...extra } })
const [claudeCommands, hermesCommands] = await Promise.all(agents.map((agent) => invoke(agent, 'list')))
assert.equal(claude.turn, 0, '发现命令不启动推理 turn')
assert.equal(hermes.turn, 0, '发现命令不启动推理 turn')
assert.deepEqual(claudeCommands.map((c) => c.name), ['compact', 'model', 'plugin:review'])
assert.deepEqual(hermesCommands.map((c) => c.name), ['compact', 'model'])
assert.match(claudeCommands[0].description, /^Claude Code/)
assert.match(hermesCommands[0].description, /^Hermes/)
assert.equal((await claude.listCommands()), claude.commandCatalog, '重复打开菜单复用同会话目录')
claude.commandCatalog = undefined
const firstPull = claude.listCommands()
assert.equal(firstPull, claude.listCommands(), '同会话并发查询共享一个探测进程')
await firstPull
assert.deepEqual(normalizeCommands([{ name: 'review', aliases: ['inspect'], description: 'review' }, { name: 'bad name' }], 'CLI').map((c) => c.name), ['inspect', 'review'])

await invoke(hermes, 'execute', { line: '/compact exact-model  two-spaces' })
await hermes.whenIdle()
const response = hermes.session.events.findLast((event) => event.type === 'assistant/message').data.message.content
assert.equal(response[0].text, 'command:/compact exact-model  two-spaces', '斜杠命令不追加格式指令且保留内部空格')
await invoke(claude, 'execute', { line: '/plugin:review src/index.js' })
await claude.whenIdle()
assert.equal(claude.session.events.findLast((event) => event.type === 'user/message').data.content[0].text, '/plugin:review src/index.js')
assert.equal(harnessCalls, 0, '原生命令不进入同名 Harness handler')
assert.equal(await invoke(hermes, 'execute', { line: '/plugin:review' }), undefined, 'Hermes 不能执行 Claude 专属命令')
const count = hermes.session.events.length
hermes.status = 'running'
await assert.rejects(invoke(hermes, 'execute', { line: '/compact' }), /等待/)
hermes.status = 'idle'
assert.equal(hermes.session.events.length, count)
const abort = new AbortController()
abort.abort()
await assert.rejects(ctx.commands.execute(hermes, '/compact', abort.signal), /取消/)
await assert.rejects(discoverCommands(hermes, abort.signal), /取消/)
await assert.rejects(discoverCommands({ ...hermes, config: { command: '/nonexistent-dsh-test' }, commandArgs: () => [] }), /ENOENT/)
const pendingAbort = new AbortController()
const waiting = discoverCommands({ ...hermes, config: { command: process.execPath }, commandArgs: () => ['-e', 'process.stdin.resume()'] }, pendingAbort.signal)
pendingAbort.abort()
await assert.rejects(waiting, /取消/, '取消进行中的探测')
const savedConfig = claude.config
claude.commandCatalog = undefined
claude.config = { ...savedConfig, command: '/nonexistent-dsh-test' }
await assert.rejects(claude.listCommands(), /ENOENT/)
assert.equal(claude.commandDiscovery, undefined)
claude.config = savedConfig
assert.equal((await claude.listCommands()).length, 3, '失败后可重新发现命令')
const normal = { session: ctx.sessions.prepare(crypto.randomUUID(), { meta: { cwd } }) }
assert.deepEqual(ctx.commands.list(normal).map((c) => c.description), ['Harness 压缩'])
await ctx.commands.execute(normal, '/compact', new AbortController().signal)
assert.equal(harnessCalls, 1, '默认会话保留原命令通道')

// 执行真实 Client factory：在两个会话交错查目录时仍按入参会话隔离客户端贡献。
const source = await readFile(join(here, '../lib/client.js'), 'utf8')
let descriptor
new Function('window', source)({ __ModuleLoader__: { load: (value) => { descriptor = value } } })
const api = descriptor.factory(() => ({ createElement: () => null }))
const effects = []
const disposers = []
const uiCtx = new Context()
const sessionScopes = new Map(agents.map((agent) => [agent.id, new Context()]))
uiCtx.provide('sessions', { subagentAddress: () => undefined, scope: (id) => sessionScopes.get(id), scopeOf: (scope) => [...sessionScopes].find(([, value]) => value === scope)?.[0] })
const commandRemote = {
  $on: () => () => {},
  commands: {
    list: async (id) => ({ ok: true, value: await ctx.commands.list(agents.find((agent) => agent.id === id) ?? normal) }),
    execute: async (id, line) => ({ ok: true, value: await ctx.commands.execute(agents.find((agent) => agent.id === id), line, new AbortController().signal) }),
  },
}
uiCtx.provide('remote.commands', commandRemote.commands)
uiCtx.provide('remote', commandRemote)
uiCtx.provide('inputTriggers', { registerSource: () => () => {} })
let officialDescriptor
const officialSource = await readFile('/Users/xujiping/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-commands/lib/client.js', 'utf8')
new Function('window', officialSource)({ __ModuleLoader__: { load: (value) => { officialDescriptor = value } } })
const cordis = await importDshModule('@deepseek-ai/cordis')
const { CommandUiRuntime } = officialDescriptor.factory((name) => name === '@deepseek-ai/cordis' ? cordis : { createSnapshotStore: (initial) => { let value = initial; return { getSnapshot: () => value, set: (next) => { value = next }, subscribe: () => () => {} } } })
new CommandUiRuntime(uiCtx)
const ui = uiCtx.commandUi
const popup = { kind: 'popupSelect', options: async () => { throw new Error('不应打开 DSH 原生弹窗') } }
ui.register({ name: 'model', description: 'Harness 模型', available: () => true, ui: popup })
ui.decorate({ name: 'compact', available: () => true, ui: popup })
const normalId = crypto.randomUUID()
await api.apply({
  inject: (keys, callback) => {
    assert.ok(keys.includes('remote.commands'), '命令提交作用域必须注入 Remote 命令服务')
    const fiber = uiCtx.inject(keys, callback)
    disposers.push(() => fiber.dispose())
  },
  remote: { $mount: async () => () => {} },
  reflect: { get: (key) => ({
    getModels: (id) => remote.invoke({ namespace: key.slice(7), method: 'getModels', args: { sessionId: id } }),
    setModel: (id, model) => remote.invoke({ namespace: key.slice(7), method: 'setModel', args: { sessionId: id, modelId: model } }),
    getPermission: async (id) => {
    const wanted = key === 'remote.nativeAgent' ? claude.id : hermes.id
    return id === wanted ? { ok: true, value: { permissionMode: 'default' } } : { ok: false, error: { message: 'session is not a live native session' } }
  } }) },
  effect: (fn) => effects.push(Promise.resolve(fn())),
})
await Promise.all(effects)
await new Promise((resolve) => setTimeout(resolve, 20))
const request = { query: '', position: 'leading', signal: new AbortController().signal }
const [c, n, h] = await Promise.all([claude.id, normalId, hermes.id].map((sessionId) => ui.candidates({ sessionId }, request)))
assert.deepEqual(c.map((row) => row.name), ['compact', 'model', 'plugin:review'])
assert.deepEqual(h.map((row) => row.name), ['compact', 'model'])
assert.deepEqual(n.map((row) => row.name), ['compact', 'model'])
assert.match(n.find((row) => row.name === 'model').description, /Harness/)
assert.match(h.find((row) => row.name === 'model').description, /Hermes/)
for (const agent of agents) {
  const session = { sessionId: agent.id }
  assert.equal(ui.dispatch({ session, candidate: { name: 'compact' }, via: 'menu' }).claim.token, '/compact ')
  assert.equal(ui.matchSpace(session, '/compact').claim.token, '/compact ')
  assert.equal((await ui.matchEnter(session, '/compact details', request.signal)).claim.token, '/compact ')
}
for (const [index, agent] of agents.entries()) {
  const session = { sessionId: agent.id }
  assert.equal(await ui.matchEnter(session, '/model', request.signal), 'handled')
  const controller = ui.live.popups.get(agent.id)
  assert.ok(controller, '回车打开官方模型选择面板')
  for (let attempt = 0; controller.state.getSnapshot().status !== 'ready' && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  let options = controller.state.getSnapshot().options
  if (index === 1) {
    assert.equal(options.length, 4, '先展示三个提供商及取消项')
    assert.match(options[1].label, /MiniMax（2 个模型）/)
    await controller.select(1)
    await Promise.resolve()
    assert.equal(controller.state.getSnapshot().open, true, '选择提供商不会关闭面板')
    assert.equal(controller.state.getSnapshot().options.length, 4, '组内模型加返回和取消')
    assert.equal(agent.permission.selectedModel, undefined, '浏览提供商不会切换模型')
    await controller.select(2)
    await Promise.resolve()
    assert.match(controller.state.getSnapshot().options[0].label, /测试 Hermes/)
    await controller.select(0)
    await Promise.resolve()
    options = controller.state.getSnapshot().options
    assert.equal(options.length, 3)
  } else assert.equal(options.length, 1)
  assert.match(options[0].label, index === 0 ? /Sonnet/ : /fake-acp-model/)
  await controller.select(0)
  assert.equal(controller.state.getSnapshot().open, false, '选中后关闭面板')
  assert.equal(agent.permission.selectedModel, options[0].id)
  assert.equal((await gateways[index].index.read()).find((row) => row.sessionId === agent.id).selectedModel, options[0].id, '模型选择持久化至当前会话')
  assert.equal(ui.dispatch({ session, candidate: { name: 'model' }, via: 'menu' }), 'handled')
  controller.dismiss()
  await ui.matchSpace(session, '/model').claim.submit('')
  assert.equal(controller.state.getSnapshot().open, true, '空参数提交打开选择面板')
  controller.dismiss()
  await assert.rejects(gateways[index].setModel(agent.id, 'invalid-model'), /不在/)
}
await invoke(claude, 'execute', { line: '/model sonnet' })
assert.equal(claude.permission.selectedModel, 'sonnet')
await assert.rejects(gateways[0].getModels(hermes.id), /不属于/)
claude.status = 'running'
await assert.rejects(gateways[0].setModel(claude.id, 'sonnet'), /等待/)
claude.status = 'idle'
assert.ok(claude.commandArgs(false).includes('--model'))
assert.ok(claude.commandArgs(false).includes('sonnet'))
const hermesSession = { sessionId: hermes.id }
await ui.matchEnter(hermesSession, '/model', request.signal)
const grouped = ui.live.popups.get(hermes.id)
for (let i = 0; grouped.state.getSnapshot().status !== 'ready' && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10))
await grouped.select(2)
await Promise.resolve()
assert.equal(grouped.state.getSnapshot().options[0].label, 'shared-model')
await grouped.select(0)
assert.equal(hermes.permission.selectedModel, 'custom:qwen-coding-plan:shared-model', '同名模型保留提供商身份')
assert.equal(claude.permission.selectedModel, 'sonnet', '跨 provider 选择不影响其他会话')
await ui.matchEnter(hermesSession, '/model', request.signal)
for (let i = 0; grouped.state.getSnapshot().status !== 'ready' && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10))
await grouped.select(3)
assert.equal(grouped.state.getSnapshot().open, false, '取消关闭分组面板')
assert.equal(hermes.permission.selectedModel, 'custom:qwen-coding-plan:shared-model', '取消不改变模型')
await invoke(hermes, 'execute', { line: '/compact after-model' })
await hermes.whenIdle()
assert.match(hermes.session.events.findLast((event) => event.type === 'assistant/message').data.message.content[0].text, /model:custom:qwen-coding-plan:shared-model/, '下一轮 ACP 收到正确的跨 provider 模型标识')
for (const dispose of disposers) await dispose()
assert.equal(Object.hasOwn(ui, 'candidates'), false, '卸载恢复官方命令 UI')
for (const pending of effects) (await pending)?.()
for (const gateway of gateways) for (const handle of [...gateway.handles.values()]) await handle.dispose()
disposeCommands()
assert.equal(Object.hasOwn(ctx.commands, 'list'), false)
assert.equal(Object.hasOwn(ctx.commands, 'execute'), false)
assert.deepEqual(ctx.commands.list(normal), originalList.call(ctx.commands, normal))
console.log('PASS native command discovery, Remote routing, argument preservation, session isolation, client collisions, cancellation and cleanup')
