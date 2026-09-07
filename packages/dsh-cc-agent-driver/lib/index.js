/**
 * Claude Code native session driver.
 *
 * This package deliberately owns Agent + Session publication instead of
 * registering a replacement AgentFactory. A shared UUID is the DSH SessionId
 * and Claude Code session id. The DSH event log is the UI replay source; the
 * Claude local session is used only for the next inference turn.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { importDshModule } from './dsh-runtime.js'

const { createAssistantMessage, createToolResultMessage } = await importDshModule('@deepseek-ai/dsh-llm')
const { emitAgentEvent } = await importDshModule('@deepseek-ai/dsh-agent')
const { createScope } = await importDshModule('@deepseek-ai/dsh-scope')
const { TypertRemoteService } = await importDshModule('@deepseek-ai/dsh-typert-protocol')

export const name = 'cc-agent-driver'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'llm']

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
export const DEFAULT_PERMISSION_MODE = 'plan'
const DRIVER = 'claude-code-native'
const DRIVER_VERSION = 2
// 会话列表（dsh-client-ui-workspace）只渲染 displayTitle，不暴露 agent 信息。
// 原生会话的自动标题落地后加此前缀，列表即可区分该会话由哪个 Agent 驱动。
// 用 source: 'user' 固定（pin），避免后续 first-prompt 自动标题覆盖掉前缀。
export const AGENT_TITLE_PREFIX = 'Claude Code · '

function lastTitleEvent(session) {
  return session.events.findLast((event) => event.type === 'session/title')
}

function prefixTitleEvent(session, data) {
  if (typeof data?.title !== 'string') return
  // 用户手动命名的标题（source 'user'）是明确意图：既不加前缀，也视为 pin，
  // 之后任何自动标题都不再被改写成带前缀的版本（含本驱动写入的固定标题）。
  if (data.source?.kind === 'user') return
  if (session.events.some((event) => event.type === 'session/title' && event.data.source?.kind === 'user')) return
  if (data.title.startsWith(AGENT_TITLE_PREFIX)) return
  session.append('session/title', {
    title: `${AGENT_TITLE_PREFIX}${data.title}`,
    messageSeqs: Array.isArray(data.messageSeqs) ? [...data.messageSeqs] : [],
    source: { kind: 'user' },
  })
}

function ensureNativeRequestHeader(session) {
  if (session.requestHeader() !== undefined) return
  const config = { provider: CLAUDE_PROVIDER, model: DEFAULT_MODEL }
  session.append('request/header', { header: { config }, reason: 'initial' })
  session.append('request/context', config)
}

function permissionModeOf(value) {
  return CLAUDE_PERMISSION_MODES.includes(value) ? value : DEFAULT_PERMISSION_MODE
}

function permissionStateOf(entry) {
  const permissionMode = permissionModeOf(entry?.permissionMode)
  const effectivePermissionMode = typeof entry?.effectivePermissionMode === 'string'
    ? entry.effectivePermissionMode
    : undefined
  return effectivePermissionMode === undefined ? { permissionMode } : { permissionMode, effectivePermissionMode }
}

function configOf(raw = {}) {
  const indexPath = raw.indexPath ?? join(homedir(), '.dsh', 'cc-agent-driver', 'sessions.json')
  const command = raw.command ?? 'claude'
  const tools = Array.isArray(raw.tools) ? raw.tools.map(String) : [...DEFAULT_TOOLS]
  const args = Array.isArray(raw.args) ? raw.args.map(String) : []
  if (args.some((arg) => arg === '--dangerously-skip-permissions' || arg === '--allow-dangerously-skip-permissions')) {
    throw new Error('cc-agent-driver: bypass-permissions flags are forbidden')
  }
  if (args.some((arg) => arg === '--permission-mode' || arg.startsWith('--permission-mode='))) {
    throw new Error('cc-agent-driver: --permission-mode is managed per native session; remove it from args')
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

function asJson(value) {
  try { return JSON.stringify(value ?? {}) } catch { return '{}' }
}

function textBlocks(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) return [{ type: 'text', text: String(value ?? '') }]
  return value.map((item) => typeof item === 'string' ? { type: 'text', text: item } : item)
}

class NativeSentinelAdapter {
  providerInfo(provider) { return { id: provider, name: 'Claude Code（原生会话）' } }
  providerRetryPolicy() { return undefined }
  async listModels(provider) {
    return [{ provider, id: DEFAULT_MODEL, name: 'Claude Code（由本机配置决定）', inputModalities: ['text'] }]
  }
  async resolveModel(provider, model) { return { provider, id: model, name: 'Claude Code（原生会话）', inputModalities: ['text'] } }
  async *stream() {
    throw new Error('claude-code-native is driven by its Agent, not through LlmRuntime.stream()')
  }
}

/** A small durable sidecar: it stores driver ownership, never credentials. */
export class DriverIndex {
  constructor(path) { this.path = path }
  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(parsed.sessions)) throw new Error('sessions must be an array')
      return parsed.sessions.filter((entry) => entry && entry.driver === DRIVER && typeof entry.sessionId === 'string')
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw new Error(`cc-agent-driver: cannot read driver index ${this.path}`, { cause: error })
    }
  }
  async write(entries) {
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify({ version: DRIVER_VERSION, sessions: entries }, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.path)
  }
  async upsert(entry) {
    const entries = await this.read()
    const next = [...entries.filter((item) => item.sessionId !== entry.sessionId), entry]
    await this.write(next)
  }
  async remove(sessionId) {
    const entries = await this.read()
    await this.write(entries.filter((entry) => entry.sessionId !== sessionId))
  }
}

/**
 * Minimal custom Agent. It is intentionally serial: each Claude process owns
 * exactly one DSH turn, and cancellation always targets that process group.
 */
export class ClaudeCodeAgent {
  constructor(rootCtx, id, session, config, permission, onEffectivePermissionMode) {
    this.rootCtx = rootCtx
    this.id = id
    this.session = session
    this.options = { provider: CLAUDE_PROVIDER, model: DEFAULT_MODEL }
    // Agent-scoped listeners (notably API model selection) must never be
    // registered on the root Context. A root listener installed while a native
    // agent is live would overwrite every normal Harness request with this
    // agent's sentinel route.
    this.scope = createScope(rootCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.config = config
    this.permission = permission
    this.onEffectivePermissionMode = onEffectivePermissionMode
    this.pending = []
    this.injected = []
    this.current = undefined
    this.status = 'idle'
    this.turn = session.events.findLast((event) => event.type === 'turn/start')?.data.turn ?? 0
    this.activity = Promise.resolve()
    // The normal API only observes these read-only fields; custom ownership
    // deliberately keeps its queue private rather than abusing dsh-agent Inbox.
    this.inbox = Object.freeze({ nextTurn: [], nextStep: [], hasPending: false, clear() {} })
  }
  emit(type, payload) {
    try { emitAgentEvent(this.rootCtx, this, type, payload) } catch { /* standalone tests may not mount agent events */ }
  }
  setStatus(status) {
    if (this.status === status) return
    this.status = status
    this.emit('agent/status', { status })
  }
  send(message, target, wakeup) {
    if (target === 'next-step' && !wakeup) { this.injected.push(message); return }
    this.pending.push(message)
    if (wakeup) this.pump()
  }
  followup(message) { this.send(message, 'next-turn', true) }
  steer(message) { this.send(message, 'next-step', true) }
  inject(message) { this.send(message, 'next-step', false) }
  async whenIdle() {
    while (this.current !== undefined || this.pending.length > 0) await this.activity
  }
  runMaintenance(task) {
    if (this.current !== undefined) throw new Error(`agent "${this.id}" is running`)
    const controller = new AbortController()
    this.activity = Promise.resolve(task(controller.signal))
    return this.activity
  }
  cancel(cause, options = {}) {
    if (!options.keepInbox) this.pending.length = 0
    const current = this.current
    if (current === undefined) return
    current.controller.abort(cause)
    terminateProcessGroup(current.child)
  }
  pump() {
    if (this.current !== undefined || this.pending.length === 0) return
    const message = this.pending.shift()
    const done = this.runTurn(message)
    this.activity = done.catch(() => undefined)
    void done.finally(() => this.pump())
  }
  commandArgs(firstTurn) {
    const sessionFlag = firstTurn ? ['--session-id', this.id] : ['--resume', this.id]
    const tools = this.config.tools.length === 0 ? [] : ['--tools', this.config.tools.join(',')]
    // Extra args precede Claude flags so the fake CLI used by M0 can be run by
    // `node fake-claude.js ...`; real configurations normally leave this empty.
    return [
      ...this.config.args,
      '-p',
      ...sessionFlag,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      // Claude CLI 的 --resume 不会可靠继承先前 -p 运行的权限模式，
      // 因此每轮都从 driver sidecar 显式传入当前会话选择。
      '--permission-mode', this.permission.permissionMode,
      ...(this.config.safeMode ? ['--safe-mode'] : []),
      // Claude's --tools limits only built-ins. The strict empty MCP config is
      // required as well, otherwise user-level MCP servers remain available.
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      ...tools,
    ]
  }
  observeEffectivePermissionMode(value) {
    if (typeof value !== 'string' || value.length === 0) return
    if (this.permission.effectivePermissionMode === value) return
    this.permission.effectivePermissionMode = value
    void this.onEffectivePermissionMode?.(value)
  }
  async runTurn(message) {
    const turn = ++this.turn
    const step = 1
    const controller = new AbortController()
    this.setStatus('running')
    this.session.append('turn/start', { turn })
    this.session.append('step/start', { turn, step })
    const injected = this.injected.splice(0)
    for (const item of injected) this.session.append('user/message', item, { surfaceOp: 'append' })
    this.session.append('user/message', message, { surfaceOp: 'append' })
    if (this.session.requestHeader() === undefined) {
      this.session.append('request/header', {
        header: { config: { provider: CLAUDE_PROVIDER, model: DEFAULT_MODEL } },
        reason: 'initial',
      })
      this.session.append('request/context', { provider: CLAUDE_PROVIDER, model: DEFAULT_MODEL })
    }

    let child
    try {
      child = spawn(this.config.command, this.commandArgs(turn === 1), {
        cwd: this.session.header.cwd,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.current = { child, controller }
      const exited = exitOf(child)
      const payload = {
        type: 'user',
        message: { role: 'user', content: [...injected.flatMap((item) => item.content), ...message.content] },
      }
      child.stdin.end(`${JSON.stringify(payload)}\n`)
      await consumeClaudeJsonl(this, child, turn, step, controller.signal)
      const exit = await exited
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('cancelled')
      if (exit.code !== 0) throw new Error(`Claude Code exited with code ${exit.code}: ${exit.stderr}`)
      this.session.append('step/end', { turn, step })
      this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    } catch (error) {
      const aborted = controller.signal.aborted
      this.session.append('step/end', { turn, step })
      this.session.append('turn/end', {
        turn,
        reason: aborted
          ? { kind: 'aborted', reason: controller.signal.reason ?? { kind: 'user' } }
          : { kind: 'error', error: { message: error instanceof Error ? error.message : String(error), code: 'CLAUDE_CLI' } },
      })
      if (!aborted) this.emit('agent/error', { turn, step, error })
    } finally {
      this.current = undefined
      this.setStatus('idle')
    }
  }
}

function terminateProcessGroup(child) {
  if (child === undefined || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') child.kill('SIGINT')
    else process.kill(-child.pid, 'SIGINT')
  } catch { /* process may already have exited */ }
  const deadline = setTimeout(() => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    } catch { /* process may already have exited */ }
  }, 2_000)
  child.once('exit', () => clearTimeout(deadline))
}

function exitOf(child) {
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-1_000) })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), stderr }))
  })
}

async function consumeClaudeJsonl(agent, child, turn, step, signal) {
  child.stdout.setEncoding('utf8')
  const lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity })
  let initModel = DEFAULT_MODEL
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
          source: { provider: CLAUDE_PROVIDER, model: pendingAssistant.event.message.model ?? initModel },
        })
        const finalUsage = usage === undefined ? undefined : normalizeUsage(usage)
        agent.session.append('assistant/message', {
          turn,
          step,
          message,
          ...(finalUsage === undefined ? {} : { usage: finalUsage }),
        }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
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
    if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
      initModel = event.model
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
        const source = agent.session.events.findLast((item) => item.type === 'tool/call' && item.data.callId === callId)
        agent.session.append('tool/result', { turn, step, message }, { surfaceOp: 'append', sourceEventSeqs: source ? [source.seq] : undefined })
      }
    }
    if (event.type === 'result') flushPending(event.usage)
  }
  flushPending()
}

function normalizeUsage(usage) {
  if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return undefined
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(Number.isFinite(usage.cache_read_input_tokens) ? { cacheReadInputTokens: usage.cache_read_input_tokens } : {}),
    ...(Number.isFinite(usage.cache_creation_input_tokens) ? { cacheCreationInputTokens: usage.cache_creation_input_tokens } : {}),
  }
}

/** Host Remote plus lifecycle owner. */
export class ClaudeCodeDriverGateway extends TypertRemoteService {
  constructor(ctx, rawConfig = {}) {
    super(ctx, 'ccNative')
    this.config = configOf(rawConfig)
    this.index = new DriverIndex(this.config.indexPath)
    this.handles = new Map()
    // A gateway is a long-lived host service. On plugin unload, immediately
    // cancel every child process and let each handle finish its detach path.
    ctx.effect(() => () => {
      for (const handle of [...this.handles.values()]) void handle.dispose()
    }, 'cc-agent-driver: dispose published sessions')
    // Native sessions have no LLM route the title provider can stream, so they
    // only ever receive the deterministic first-prompt fallback title. Prefix
    // that title (pinned as a user title) so the workspace session list shows
    // which agent drives the conversation.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'session/title' || !this.handles.has(session.id)) return
      const data = event.data
      // Session.append 不可重入（观察者分发期间 entry.appending 置位），补写
      // 固定标题必须推迟到当前 append 发布完成之后。
      queueMicrotask(() => {
        if (!this.handles.has(session.id)) return
        if (this.ctx.sessions.get(session.id) !== session) return
        prefixTitleEvent(session, data)
      })
    })
  }
  async createSession(workspaceId) {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new Error(`cc-agent-driver: workspace "${workspaceId}" was not found`)
    return this.createForWorkspace(workspace)
  }
  async createForWorkspace(workspace) {
    const cwd = workspace.path
    if (!isAbsolute(cwd)) throw new Error('cc-agent-driver: workspace path must be absolute')
    const id = randomUUID()
    const session = this.ctx.sessions.prepare(id, { meta: { cwd } })
    // Do not call the generic `sessions.selectModel` API for a native Agent.
    // That API persists a global default model selection, so a later default
    // Harness session would inherit this sentinel provider.
    ensureNativeRequestHeader(session)
    const handle = this.publish(session, 'startup')
    try {
      await this.index.upsert({ sessionId: id, driver: DRIVER, driverVersion: DRIVER_VERSION, securityProfile: this.config.securityProfile, createdAt: Date.now() })
      await workspace.attachSession(id)
      return { sessionId: id }
    } catch (error) {
      await handle.dispose()
      await this.index.remove(id).catch(() => undefined)
      throw error
    }
  }
  async restore() {
    const entries = await this.index.read()
    for (const entry of entries) {
      if (this.ctx.agents.get(entry.sessionId) !== undefined) continue
      let preparation
      try {
        preparation = await this.ctx.sessionPersistence.prepare(entry.sessionId)
        this.publish(preparation.session, 'resume')
      } catch (error) {
        this.ctx.logger?.warn?.(`cc-agent-driver: cannot restore ${entry.sessionId}: ${String(error)}`)
      } finally {
        preparation?.[Symbol.dispose]?.()
      }
    }
  }
  publish(session, source) {
    // Upgrade blank sessions created by earlier M0 builds during cold restore.
    ensureNativeRequestHeader(session)
    const agent = new ClaudeCodeAgent(this.ctx, session.id, session, this.config)
    let detachSession
    let detachAgent
    const dispose = async () => {
      agent.cancel({ kind: 'disposed' }, { keepInbox: false })
      await agent.whenIdle()
      detachAgent?.()
      detachSession?.()
      await agent.scope.dispose()
      this.handles.delete(session.id)
    }
    try {
      detachSession = agent.ctx.sessions.enter(session)
      detachAgent = this.ctx.agents.enter(agent, this.ctx.agent)
      agent.ctx.sessions.announce(session)
      this.ctx.agents.announce(agent)
      // Backfill sessions restored from older builds: their stored title (if
      // any) predates the prefix listener, so re-pin it with the prefix.
      const stored = lastTitleEvent(session)
      if (stored !== undefined) prefixTitleEvent(session, stored.data)
      emitAgentEvent(this.ctx, agent, 'agent/session-start', { source })
      const handle = { agent, dispose }
      this.handles.set(session.id, handle)
      return handle
    } catch (error) {
      detachAgent?.()
      detachSession?.()
      void agent.scope.dispose()
      throw error
    }
  }
}

export async function apply(ctx, config) {
  ctx.llm.registerAdapter([CLAUDE_PROVIDER], new NativeSentinelAdapter())
  const gateway = new ClaudeCodeDriverGateway(ctx, config)
  await gateway.restore()
}

export { NativeSentinelAdapter, consumeClaudeJsonl, terminateProcessGroup }
