/**
 * Hermes (hermes-agent CLI) native session driver profile — ACP 模式。
 *
 * 每个 DSH turn 独立 spawn 一个 `hermes acp`（JSON-RPC over stdio，编辑器
 * 集成同款通道）：initialize → session/new（首轮）或 session/load（续接，
 * 历史 replay 通知直接丢弃，DSH 自己有可回放事件）→ session/prompt。
 * prompt 期间流式转发 agent_thought_chunk（思考）/ agent_message_chunk
 * （正文）/ tool_call（工具调用）为 DSH 事件；server → client 的
 * session/request_permission 按权限档位自动应答：default 拒绝（fail-closed），
 * yolo 选 allow_once。turn 结束后终止进程组；ACP 会话持久化在 Hermes
 * 自己的存储里，下一轮用 acpSessionId 续接。
 */
import { discoverHermesModels } from './hermes-models.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { importDshModule } from './dsh-runtime.js'
import { CliDriverAgent, CliDriverGateway, CliDriverIndex, terminateProcessGroup, textBlocks } from './driver-core.js'

const { createAssistantMessage, createToolResultMessage } = await importDshModule('@deepseek-ai/dsh-llm')

export const HERMES_PROVIDER = 'hermes-native'
export const DEFAULT_MODEL = 'default'
const DRIVER = 'hermes-native'
const DRIVER_VERSION = 2
export const HERMES_PERMISSION_MODES = Object.freeze(['default', 'yolo'])
export const DEFAULT_HERMES_PERMISSION_MODE = 'default'
export const AGENT_TITLE_PREFIX = 'Hermes · '

function messageText(message) {
  return textBlocks(message?.content).map((block) => String(block?.text ?? '')).join('\n').trim()
}

// 聊天界面按 Markdown 渲染：不带代码围栏的树/目录/多行文本会被折叠成一
// 个段落。此指令只附加到发送给 CLI 的提示词（不进 DSH 事件流），要求
// Hermes 把这类内容用围栏包起来。
const FORMAT_DIRECTIVE = [
  '',
  '[formatting request: always wrap directory trees, file listings, ASCII diagrams, and any preformatted multi-line content in fenced Markdown code blocks (```); never emit them as plain lines]',
].join('\n')

export function hermesConfigOf(raw = {}) {
  const indexPath = raw.indexPath ?? join(homedir(), '.dsh', 'hermes-agent-driver', 'sessions.json')
  const command = raw.command ?? 'hermes'
  const args = Array.isArray(raw.args) ? raw.args.map(String) : []
  return {
    indexPath,
    command,
    args,
    securityProfile: raw.securityProfile ?? 'workspace-tools',
  }
}

/** Hermes Agent：网关引用由通用核心注入（this.gateway）。 */
export class HermesAgent extends CliDriverAgent {
  /** ACP 会话 id 由 session/new 返回；写入 sidecar 供后续 session/load。 */
  async observeAcpSessionId(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (this.permission.acpSessionId === sessionId) return
    this.permission.acpSessionId = sessionId
    try {
      await this.gateway?.persistRecord(this.gateway.recordFor({ ...this.permission }))
    } catch { /* best-effort：下一轮成功后会再尝试持久化 */ }
  }
}

/** Hermes 网关：把自身引用注入 Agent 以便持久化 ACP 会话 id。 */
export class HermesDriverGateway extends CliDriverGateway {
  constructor(ctx, rawConfig = {}) { super(ctx, rawConfig, HERMES_PROFILE) }

  createAgentFor(session, record) {
    return new HermesAgent(
      this.ctx,
      session.id,
      session,
      this.config,
      record,
      (effectivePermissionMode) => this.observeEffectivePermission(session.id, record, effectivePermissionMode),
      HERMES_PROFILE,
      this,
    )
  }
}

function toolCallText(update) {
  const content = Array.isArray(update.content) ? update.content : []
  return content
    .filter((item) => item && typeof item === 'object' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
}

/**
 * Hermes ACP 翻译器：把 `hermes acp` 的 JSON-RPC 通知流翻译成 DSH 事件。
 * stdin 生命周期由本函数管理（promptInput 返回 null）。
 */
export async function consumeHermesAcp(agent, child, turn, step, signal, message) {
  const query = messageText(message)
  if (query === '') throw new Error('agent-driver: Hermes sessions require a text prompt')

  child.stdout.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', () => { /* 日志通道，忽略 */ })

  let buffer = ''
  let nextId = 1
  const pending = new Map()
  const write = (payload) => {
    try { child.stdin.write(`${JSON.stringify(payload)}\n`) } catch { /* closing */ }
  }
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId
    nextId += 1
    pending.set(id, { resolve, reject })
    write({ jsonrpc: '2.0', id, method, params })
  })

  // 流式块：reasoning 在前 text 在后（出现顺序无关，按类型各一个块）。
  const blocks = []
  const chunkSeqs = []
  const ensureBlock = (type) => {
    let index = blocks.findIndex((block) => block.type === type)
    if (index < 0) {
      blocks.push({ type, text: '' })
      index = blocks.length - 1
      chunkSeqs.push(agent.session.append('assistant/chunk', { turn, step, chunk: { type: 'block-start', index, blockType: type } }).seq)
    }
    return index
  }
  const appendDelta = (type, text) => {
    if (text === undefined || text === '') return
    const index = ensureBlock(type)
    blocks[index].text += text
    chunkSeqs.push(agent.session.append('assistant/chunk', { turn, step, chunk: { type: `${type}-delta`, index, text } }).seq)
  }

  const toolCalls = new Map()
  const handleToolUpdate = (update) => {
    const id = String(update.toolCallId ?? update.rawToolCallId ?? '')
    if (id === '') return
    if (!toolCalls.has(id)) {
      toolCalls.set(id, true)
      agent.session.append('tool/call', { turn, step, callId: id, name: String(update.title ?? 'hermes-tool'), arguments: '{}' })
    }
    if (update.status === 'completed' || update.status === 'failed') {
      const text = toolCallText(update)
      const resultMessage = createToolResultMessage({ callId: id, content: textBlocks(text), isError: update.status === 'failed' })
      const source = agent.session.events.findLast((event) => event.type === 'tool/call' && event.data.callId === id)
      agent.session.append('tool/result', { turn, step, message: resultMessage }, { surfaceOp: 'append', sourceEventSeqs: source ? [source.seq] : undefined })
    }
  }

  // session/load 会先 replay 历史通知；DSH 已有这些事件，全部丢弃。
  let replaying = false
  let accepting = true

  const handleMessage = async (msg) => {
    if (signal.aborted) return
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = pending.get(msg.id)
      if (waiter === undefined) return
      pending.delete(msg.id)
      if (msg.error !== undefined) waiter.reject(new Error(`${String(msg.error.message ?? 'ACP request failed')} (${msg.id})`))
      else waiter.resolve(msg.result)
      return
    }
    if (msg.method === 'session/update') {
      if (!accepting || replaying) return
      const update = msg.params?.update ?? {}
      if (update.sessionUpdate === 'agent_message_chunk') appendDelta('text', update.content?.text)
      else if (update.sessionUpdate === 'agent_thought_chunk') appendDelta('reasoning', update.content?.text)
      else if (update.sessionUpdate === 'tool_call') handleToolUpdate(update)
      return
    }
    if (msg.method === 'session/request_permission') {
      // 权限档位自动应答：yolo → allow_once；default → deny（fail-closed）。
      const wanted = agent.permission.permissionMode === 'yolo' ? 'allow_once' : 'deny'
      const options = Array.isArray(msg.params?.options) ? msg.params.options : []
      const option = options.some((item) => item?.optionId === wanted) ? wanted : 'deny'
      write({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: option } } })
      return
    }
    if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, result: {} })
  }

  const ended = new Promise((resolve, reject) => {
    child.stdout.once('error', reject)
    child.stdout.once('end', resolve)
  })
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      try { void handleMessage(JSON.parse(line)) } catch { /* 非 JSON 行忽略 */ }
    }
  })

  const cwd = agent.session.header.cwd
  const baseParams = { cwd, mcpServers: [] }
  try {
    await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { read: true, write: true } },
      clientInfo: { name: 'dsh-agent-driver', version: '0.1.0' },
    })
  } catch (error) {
    throw new Error(`agent-driver: hermes acp initialize failed: ${String(error)}`)
  }

  let session = undefined
  if (!signal.aborted && typeof agent.permission.acpSessionId === 'string') {
    replaying = true
    try {
      session = await request('session/load', { ...baseParams, sessionId: agent.permission.acpSessionId })
    } catch { session = undefined }
    replaying = false
  }
  if (session === undefined) session = await request('session/new', baseParams)
  await agent.observeAcpSessionId(String(session?.sessionId ?? ''))

  if (agent.permission.selectedModel) {
    await request('session/set_model', { sessionId: agent.permission.acpSessionId, modelId: agent.permission.selectedModel })
  }
  const currentModel = agent.permission.selectedModel ?? session?.models?.currentModelId
  if (typeof currentModel === 'string' && currentModel !== '') {
    // modelId 形如 "zai:glm-5.3-flash"；展示去掉 provider 前缀。
    await agent.observeModel(currentModel.includes(':') ? currentModel.split(':').pop() : currentModel)
  }
  await agent.observeEffectivePermissionMode(agent.permission.permissionMode)

  let response
  try {
    response = await request('session/prompt', {
      sessionId: agent.permission.acpSessionId,
      prompt: [{ type: 'text', text: query.startsWith('/') ? query : `${query}\n${FORMAT_DIRECTIVE}` }],
    })
  } finally {
    accepting = false
  }

  for (let index = 0; index < blocks.length; index += 1) {
    chunkSeqs.push(agent.session.append('assistant/chunk', { turn, step, chunk: { type: 'block-end', index, block: { type: blocks[index].type, text: blocks[index].text } } }).seq)
  }
  if (blocks.length > 0) {
    const usage = response?.usage
    agent.session.append('assistant/message', {
      turn,
      step,
      message: createAssistantMessage({
        content: blocks.map((block) => ({ type: block.type, text: block.text })),
        source: { provider: agent.options.provider, model: agent.options.model },
      }),
      ...(usage !== undefined && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)
        ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }
        : {}),
    }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
  }

  // turn 已完成；终止 ACP 服务器进程（profile 声明 tolerateUncleanExit）。
  try { child.stdin.end() } catch { /* already closed */ }
  terminateProcessGroup(child)
  await Promise.race([ended, new Promise((resolve) => child.once('close', resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))])
}

/** Hermes profile：唯一包含 CLI 专属知识的对象。 */
export const HERMES_PROFILE = Object.freeze({
  pluginName: 'agent-driver',
  driver: DRIVER,
  driverVersion: DRIVER_VERSION,
  remoteNamespace: 'hermesAgent',
  provider: HERMES_PROVIDER,
  providerName: 'Hermes（原生会话）',
  modelName: 'Hermes（由本机配置决定）',
  defaultModel: DEFAULT_MODEL,
  label: 'Hermes',
  titlePrefix: AGENT_TITLE_PREFIX,
  permissionModes: HERMES_PERMISSION_MODES,
  defaultPermissionMode: DEFAULT_HERMES_PERMISSION_MODE,
  errorCode: 'HERMES_CLI',
  configOf: hermesConfigOf,
  discoverModels: discoverHermesModels,
  createIndex: (path) => new CliDriverIndex(path, DRIVER, DRIVER_VERSION),
  Gateway: HermesDriverGateway,
  // 提示词经 session/prompt JSON-RPC 传递，stdin 归 translate 管理。
  promptInput: () => null,
  // 翻译器在收集完一轮后主动终止 ACP 服务器，退出码不作数。
  tolerateUncleanExit: true,
  commandArgs(agent) {
    return [...agent.config.args, 'acp']
  },
  translate: consumeHermesAcp,
})
