/**
 * Claude Code native session driver.
 *
 * 本文件是 Claude Code 的 profile 定义 + 兼容出口：通用机制（Agent 生命周期、
 * 持久化、恢复、权限、标题前缀）都在 `./driver-core.js`，接入其他 CLI 智能
 * 体时复用该核心并另写一份 profile 即可。
 *
 * This package deliberately owns Agent + Session publication instead of
 * registering a replacement AgentFactory. A shared UUID is the DSH SessionId
 * and Claude Code session id. The DSH event log is the UI replay source; the
 * Claude local session is used only for the next inference turn.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { importDshModule } from './dsh-runtime.js'
import { HERMES_PROFILE } from './hermes.js'
import {
  CliDriverAgent,
  CliDriverGateway,
  CliDriverIndex,
  SentinelAdapter,
  asJson,
  createMcpApprovalBridge,
  createDriverApply,
  normalizeUsage,
  sessionEvents,
  terminateProcessGroup,
  textBlocks,
} from './driver-core.js'

const { createAssistantMessage, createToolResultMessage } = await importDshModule('@deepseek-ai/dsh-llm')

export const name = 'agent-driver'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'llm', 'commands', 'approval']

export const CLAUDE_PROVIDER = 'claude-code-native'
export const DEFAULT_MODEL = 'default'
// Claude Code 会话需要完成实际的工程任务，而不只是浏览文件。不要使用
// `default`（它会随 Claude Code 的内置工具集变化），改为明确列出所需的
// 工作区工具；MCP 仍由下方的严格空配置隔离。
export const DEFAULT_TOOLS = Object.freeze(['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'])
// DSH 的沙箱权限不会约束作为外部进程运行的 `claude`。原生会话只允许
// 这三个由 Claude Code CLI 自己执行的模式；不要把 Manual、dontAsk 或
// bypassPermissions 伪装成可以在 DSH 内交互审批的选择。
export const CLAUDE_PERMISSION_MODES = Object.freeze(['plan', 'acceptEdits', 'auto'])
export const DEFAULT_PERMISSION_MODE = 'acceptEdits'
const DRIVER = 'claude-code-native'
const DRIVER_VERSION = 2
const PERMISSION_MCP_PATH = fileURLToPath(new URL('./claude-permission-mcp.js', import.meta.url))
// 会话列表（dsh-client-ui-workspace）只渲染 displayTitle，不暴露 agent 信息。
// 原生会话的自动标题落地后加此前缀，列表即可区分该会话由哪个 Agent 驱动。
// 用 source: 'user' 固定（pin），避免后续 first-prompt 自动标题覆盖掉前缀。
export const AGENT_TITLE_PREFIX = 'Claude Code · '

function configOf(raw = {}) {
  const indexPath = raw.indexPath ?? join(homedir(), '.dsh', 'agent-driver', 'sessions.json')
  const command = raw.command ?? 'claude'
  const tools = Array.isArray(raw.tools) ? raw.tools.map(String) : [...DEFAULT_TOOLS]
  const args = Array.isArray(raw.args) ? raw.args.map(String) : []
  if (args.some((arg) => arg === '--dangerously-skip-permissions' || arg === '--allow-dangerously-skip-permissions')) {
    throw new Error('agent-driver: bypass-permissions flags are forbidden')
  }
  if (args.some((arg) => arg === '--permission-mode' || arg.startsWith('--permission-mode='))) {
    throw new Error('agent-driver: --permission-mode is managed per native session; remove it from args')
  }
  return {
    indexPath,
    command,
    args,
    tools,
    securityProfile: raw.securityProfile ?? 'workspace-tools',
    safeMode: raw.safeMode !== false,
  }
}

/** 兼容出口：默认按 Claude 驱动标签过滤索引。 */
export class DriverIndex extends CliDriverIndex {
  constructor(path) { super(path, DRIVER, DRIVER_VERSION) }
}

/** 兼容出口：Claude profile 的哨兵 adapter。 */
export const NativeSentinelAdapter = class extends SentinelAdapter {
  constructor() { super(CLAUDE_PROFILE) }
}

/** 兼容出口：Claude profile 的 Agent。 */
export class ClaudeCodeAgent extends CliDriverAgent {}

/** 兼容出口：Claude profile 的网关。 */
export class ClaudeCodeDriverGateway extends CliDriverGateway {
  constructor(ctx, rawConfig = {}) { super(ctx, rawConfig, CLAUDE_PROFILE) }
}

/**
 * Claude Code 的 stream-json 事件翻译器：把 CLI 的 JSONL 输出翻译成 DSH
 * 事件流（assistant chunk / message / tool call / result）。模型与 provider
 * 取自 agent.options，因此可被其他 CLI profile 复用。
 */
export async function consumeClaudeJsonl(agent, child, turn, step, signal) {
  child.stdout.setEncoding('utf8')
  const lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const provider = agent.options.provider
  let initModel = agent.options.model
  let stream = { chunks: [], blocks: new Map(), stopped: new Set() }
  const pending = []

  const appendChunk = (chunk) => {
    stream.chunks.push(agent.session.append('assistant/chunk', { turn, step, chunk }).seq)
  }
  const blockType = (block) => block?.type === 'thinking' ? 'reasoning' : block?.type === 'tool_use' ? 'tool-call' : 'text'
  const endBlock = (index, block) => {
    const type = blockType(block)
    if (type === 'tool-call') {
      return { type: 'block-end', index, block: { type, id: String(block.id), name: String(block.name ?? 'unknown'), arguments: asJson(block.input) } }
    }
    return { type: 'block-end', index, block: { type, text: String(block.text ?? block.thinking ?? '') } }
  }
  const flushPending = (usage) => {
    while (pending.length > 0) {
      const pendingAssistant = pending.shift()
      const content = pendingAssistant.event.message.content
      const blocks = []
      const toolCalls = []
      const chunkSeqs = [...pendingAssistant.stream.chunks]
      const streamBlocks = pendingAssistant.stream.blocks
      for (let index = 0; index < content.length; index += 1) {
        const block = content[index]
        if (block.type === 'text' || block.type === 'thinking') {
          const type = block.type === 'thinking' ? 'reasoning' : 'text'
          const text = String(block.text ?? block.thinking ?? '')
          blocks.push({ type, text })
          if (!streamBlocks.has(index)) {
            for (const chunk of [
              { type: 'block-start', index, blockType: type },
              { type: `${type}-delta`, index, text },
              { type: 'block-end', index, block: { type, text } },
            ]) chunkSeqs.push(agent.session.append('assistant/chunk', { turn, step, chunk }).seq)
          } else if (pendingAssistant.stream.stopped.has(index)) {
            chunkSeqs.push(agent.session.append('assistant/chunk', { turn, step, chunk: endBlock(index, block) }).seq)
          }
        } else if (block.type === 'tool_use') {
          const call = { type: 'tool-call', id: String(block.id), name: String(block.name ?? 'unknown'), arguments: asJson(block.input) }
          blocks.push(call)
          toolCalls.push(call)
          if (!streamBlocks.has(index)) {
            for (const chunk of [
              { type: 'block-start', index, blockType: 'tool-call' },
              { type: 'block-end', index, block: call },
            ]) chunkSeqs.push(agent.session.append('assistant/chunk', { turn, step, chunk }).seq)
          } else if (pendingAssistant.stream.stopped.has(index)) {
            chunkSeqs.push(agent.session.append('assistant/chunk', { turn, step, chunk: endBlock(index, block) }).seq)
          }
        }
      }
      if (blocks.length > 0) {
        const message = createAssistantMessage({
          content: blocks,
          source: { provider, model: pendingAssistant.event.message.model ?? initModel },
        })
        const finalUsage = usage === undefined ? undefined : normalizeUsage(usage)
        agent.session.append('assistant/message', {
          turn,
          step,
          message,
          ...(finalUsage === undefined ? {} : { usage: finalUsage }),
        }, { surfaceOp: 'append' })
        // DSH 0.1.5 起 assistant/message 自动内嵌其来源流，禁止携带
        // sourceEventSeqs（携带会抛 "embeds its source stream"）。
      }
      for (const call of toolCalls) {
        agent.session.append('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments })
      }
    }
    stream = { chunks: [], blocks: new Map(), stopped: new Set() }
  }
  for await (const line of lineReader) {
    if (signal.aborted) break
    if (line.trim() === '') continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.model === 'string') initModel = event.model
      await agent.observeModel(event.model)
      await agent.observeEffectivePermissionMode(event.permissionMode)
      continue
    }
    if (event.type === 'stream_event' && event.event && typeof event.event === 'object') {
      const streamed = event.event
      if (streamed.type === 'content_block_start') {
        const index = streamed.index
        const block = streamed.content_block
        stream.blocks.set(index, block)
        appendChunk({ type: 'block-start', index, blockType: blockType(block) })
      } else if (streamed.type === 'content_block_delta') {
        const index = streamed.index
        const delta = streamed.delta ?? {}
        if (delta.type === 'text_delta') appendChunk({ type: 'text-delta', index, text: String(delta.text ?? '') })
        else if (delta.type === 'thinking_delta') appendChunk({ type: 'reasoning-delta', index, text: String(delta.thinking ?? '') })
        else if (delta.type === 'input_json_delta') appendChunk({ type: 'tool-call-delta', index, argumentsDelta: String(delta.partial_json ?? '') })
      } else if (streamed.type === 'content_block_stop') {
        stream.stopped.add(streamed.index)
      }
      continue
    }
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      const messageId = typeof event.message.id === 'string' ? event.message.id : undefined
      const current = messageId === undefined ? undefined : pending.find((item) => item.messageId === messageId)
      if (current !== undefined) {
        current.event = {
          ...event,
          message: {
            ...event.message,
            content: [...current.event.message.content, ...event.message.content],
          },
        }
      } else {
        pending.push({ event, stream, messageId })
      }
      continue
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      flushPending()
      for (const result of event.message.content.filter((item) => item.type === 'tool_result')) {
        const callId = String(result.tool_use_id)
        const message = createToolResultMessage({ callId, content: textBlocks(result.content), isError: result.is_error === true })
        const source = sessionEvents(agent.session).findLast((item) => item.type === 'tool/call' && item.data.callId === callId)
        agent.session.append('tool/result', { turn, step, message }, { surfaceOp: 'append', sourceEventSeqs: source ? [source.seq] : undefined })
      }
    }
    if (event.type === 'result') flushPending(event.usage)
  }
  flushPending()
}

/** Claude Code profile：唯一包含 CLI 专属知识的对象。 */
export const CLAUDE_PROFILE = Object.freeze({
  pluginName: 'agent-driver',
  driver: DRIVER,
  driverVersion: DRIVER_VERSION,
  remoteNamespace: 'nativeAgent',
  provider: CLAUDE_PROVIDER,
  providerName: 'Claude Code（原生会话）',
  modelName: 'Claude Code（由本机配置决定）',
  defaultModel: DEFAULT_MODEL,
  label: 'Claude Code',
  titlePrefix: AGENT_TITLE_PREFIX,
  permissionModes: CLAUDE_PERMISSION_MODES,
  defaultPermissionMode: DEFAULT_PERMISSION_MODE,
  errorCode: 'CLAUDE_CLI',
  configOf,
  createIndex: (path) => new DriverIndex(path),
  createAgent: (ctx, id, session, config, record, onEffectivePermissionMode, gateway) =>
    new ClaudeCodeAgent(ctx, id, session, config, record, onEffectivePermissionMode, CLAUDE_PROFILE, gateway),
  // 仅当使用默认索引路径时，才从旧包名（dsh-cc-agent-driver）时代的
  // ~/.dsh/cc-agent-driver/sessions.json 迁移存量会话；旧文件保留不删。
  legacyIndexPath: (rawConfig) => rawConfig.indexPath === undefined
    ? join(homedir(), '.dsh', 'cc-agent-driver', 'sessions.json')
    : undefined,
  createApprovalBridge: createMcpApprovalBridge,
  commandArgs(agent, firstTurn, _message, approvalBridge) {
    const sessionFlag = firstTurn ? ['--session-id', agent.id] : ['--resume', agent.id]
    const tools = agent.config.tools.length === 0 ? [] : ['--tools', agent.config.tools.join(',')]
    // Extra args precede Claude flags so the fake CLI used by M0 can be run by
    // `node fake-claude.js ...`; real configurations normally leave this empty.
    return [
      ...agent.config.args,
      '-p',
      ...sessionFlag,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      // Claude CLI 的 --resume 不会可靠继承先前 -p 运行的权限模式，
      // 因此每轮都从 driver sidecar 显式传入当前会话选择。
      '--permission-mode', agent.permission.permissionMode,
      ...(agent.permission.selectedModel ? ['--model', agent.permission.selectedModel] : []),
      // --safe-mode 会让 Claude CLI 完全不加载 MCP 服务（2.1.237 实测），
      // 与依赖 MCP 桥的 --permission-prompt-tool 互斥；走审批桥的回合必须省略。
      ...(agent.config.safeMode && approvalBridge === undefined ? ['--safe-mode'] : []),
      // Claude's --tools limits only built-ins. The strict MCP config blocks
      // user-level MCP servers; the sole exception is our per-turn local
      // permission bridge, which relays prompts to DSH's ApprovalPanel.
      '--strict-mcp-config',
      '--mcp-config', approvalBridge === undefined
        ? '{"mcpServers":{}}'
        : JSON.stringify({ mcpServers: {
          dsh_approval: {
            command: process.execPath,
            args: [PERMISSION_MCP_PATH, String(approvalBridge.port), approvalBridge.token],
          },
        } }),
      ...(approvalBridge === undefined ? [] : ['--permission-prompt-tool', 'mcp__dsh_approval__request_permission']),
      ...tools,
    ]
  },
  translate: consumeClaudeJsonl,
})

// 同一插件内同时注册 Claude Code 与 Hermes 两个原生会话驱动。
export const apply = createDriverApply([CLAUDE_PROFILE, HERMES_PROFILE])
export { terminateProcessGroup }
export { HERMES_PROFILE, HermesAgent, HermesDriverGateway, consumeHermesAcp, HERMES_PERMISSION_MODES, HERMES_PROVIDER } from './hermes.js'
