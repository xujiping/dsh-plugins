/**
 * Generic CLI agent-driver core.
 *
 * 多智能体抽象层：本文件承载与具体 CLI 无关的通用机制（Agent 生命周期、
 * 会话发布/恢复、持久化 sidecar、权限状态、标题前缀、子进程终止），由
 * `profile` 描述对象参数化。接入新智能体时只需在各自入口文件提供 profile
 * （provider、权限枚举、命令行构造、事件翻译），再组合此核心。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute } from 'node:path'
import { importDshModule } from './dsh-runtime.js'
import { discoverModels, discoverCommands, installNativeCommands } from './commands.js'

const { createAssistantMessage } = await importDshModule('@deepseek-ai/dsh-llm')
const { emitAgentEvent } = await importDshModule('@deepseek-ai/dsh-agent')
const { createScope } = await importDshModule('@deepseek-ai/dsh-scope')
const { TypertRemoteService } = await importDshModule('@deepseek-ai/dsh-typert-protocol')

export function asJson(value) {
  try { return JSON.stringify(value ?? {}) } catch { return '{}' }
}

export function textBlocks(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) return [{ type: 'text', text: String(value ?? '') }]
  return value.map((item) => typeof item === 'string' ? { type: 'text', text: item } : item)
}

export function normalizeUsage(usage) {
  if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return undefined
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(Number.isFinite(usage.cache_read_input_tokens) ? { cacheReadInputTokens: usage.cache_read_input_tokens } : {}),
    ...(Number.isFinite(usage.cache_creation_input_tokens) ? { cacheCreationInputTokens: usage.cache_creation_input_tokens } : {}),
  }
}

function approvalReason(toolName, input) {
  const detail = toolName === 'Bash' && typeof input?.command === 'string'
    ? input.command
    : typeof input?.file_path === 'string'
      ? input.file_path
      : ''
  return detail === '' ? `Claude Code 请求执行 ${toolName}` : `Claude Code 请求执行 ${toolName}：${detail.slice(0, 600)}`
}

/**
 * 将 Claude Code 的 permission-prompt MCP 回调桥接到 DSH 的一次性审批面板。
 * 只监听随机端口且要求每轮新令牌，MCP 子进程无法请求其他会话的授权。
 */
export async function createMcpApprovalBridge(agent, signal) {
  const approval = agent.rootCtx.get('approval')
  if (typeof approval?.request !== 'function') return undefined
  const token = randomUUID()
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let authorized = false
    const send = (payload) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`)
    }
    const handle = async (message) => {
      if (!authorized) {
        if (message?.type !== 'hello' || message.token !== token) return socket.destroy()
        authorized = true
        send({ type: 'ready' })
        return
      }
      if (message?.type !== 'permission' || typeof message.id !== 'string' || typeof message.tool_name !== 'string' || message.tool_name.length === 0 || message.input === null || typeof message.input !== 'object' || Array.isArray(message.input)) {
        return socket.destroy()
      }
      let outcome = 'unavailable'
      try {
        outcome = await approval.request({
          agent,
          toolName: message.tool_name,
          reason: approvalReason(message.tool_name, message.input),
          signal,
        })
      } catch { /* 审批审计失败也必须 fail-closed。 */ }
      send({ type: 'permission-result', id: message.id, outcome })
    }
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message
        try { message = JSON.parse(line) } catch { socket.destroy(); return }
        void handle(message)
      }
    })
    socket.once('close', () => sockets.delete(socket))
  })
  const address = await new Promise((resolve, reject) => {
    const fail = (error) => reject(error)
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail)
      resolve(server.address())
    })
  })
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('agent-driver: cannot allocate the local Claude approval bridge')
  }
  return {
    port: address.port,
    token,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

export function terminateProcessGroup(child) {
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

/**
 * 哨兵 LLM adapter：原生会话不经过 LlmRuntime.stream()，仅向模型列表暴露
 * 一个由本机配置决定的占位模型。
 */
export class SentinelAdapter {
  constructor(profile) { this.profile = profile }
  providerInfo(provider) { return { id: provider, name: this.profile.providerName } }
  providerRetryPolicy() { return undefined }
  async listModels(provider) {
    return [{ provider, id: this.profile.defaultModel, name: this.profile.modelName, inputModalities: ['text'] }]
  }
  async resolveModel(provider, model) { return { provider, id: model, name: this.profile.providerName, inputModalities: ['text'] } }
  async *stream() {
    throw new Error(`${this.profile.provider} is driven by its Agent, not through LlmRuntime.stream()`)
  }
}

/** A small durable sidecar: it stores driver ownership, never credentials. */
export class CliDriverIndex {
  constructor(path, driver, driverVersion) {
    this.path = path
    this.driver = driver
    this.driverVersion = driverVersion
  }
  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(parsed.sessions)) throw new Error('sessions must be an array')
      return parsed.sessions.filter((entry) => entry && entry.driver === this.driver && typeof entry.sessionId === 'string')
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw new Error(`agent-driver: cannot read driver index ${this.path}`, { cause: error })
    }
  }
  async write(entries) {
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify({ version: this.driverVersion, sessions: entries }, null, 2)}\n`, { mode: 0o600 })
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

function permissionModeOf(profile, value) {
  return profile.permissionModes.includes(value) ? value : profile.defaultPermissionMode
}

function permissionStateOf(profile, entry) {
  const permissionMode = permissionModeOf(profile, entry?.permissionMode)
  const effectivePermissionMode = typeof entry?.effectivePermissionMode === 'string'
    ? entry.effectivePermissionMode
    : undefined
  const base = effectivePermissionMode === undefined ? { permissionMode } : { permissionMode, effectivePermissionMode }
  // CLI 实际使用的模型（Claude 来自 init 事件，Hermes 来自 status 探测），
  // 只作展示，不参与路由。
  return typeof entry?.model === 'string' && entry.model.length > 0 ? { ...base, model: entry.model } : base
}

function lastTitleEvent(session) {
  return session.events.findLast((event) => event.type === 'session/title')
}

/**
 * Minimal custom Agent. It is intentionally serial: each CLI process owns
 * exactly one DSH turn, and cancellation always targets that process group.
 */
export class CliDriverAgent {
  constructor(rootCtx, id, session, config, permission, onEffectivePermissionMode, profile, gateway) {
    this.rootCtx = rootCtx
    this.id = id
    this.session = session
    this.profile = profile
    this.gateway = gateway
    this.options = { provider: profile.provider, model: profile.defaultModel }
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
    this.discoveryController = new AbortController()
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
  /** 由 profile 决定实际 CLI 参数；通用核心不感知具体 CLI。 */
  commandArgs(firstTurn, message) {
    return this.profile.commandArgs(this, firstTurn, message, this.approvalBridge)
  }
  async observeEffectivePermissionMode(value) {
    if (typeof value !== 'string' || value.length === 0) return
    if (this.permission.effectivePermissionMode === value) return
    if (this.onEffectivePermissionMode !== undefined) {
      await this.onEffectivePermissionMode(value)
    } else {
      this.permission.effectivePermissionMode = value
    }
  }
  /** 记录 CLI 实际使用的模型并持久化到 sidecar（仅展示用）。 */
  async observeModel(value) {
    if (typeof value !== 'string' || value.length === 0) return
    if (this.permission.model === value) return
    this.permission.model = value
    try {
      await this.gateway?.persistRecord(this.gateway.recordFor({ ...this.permission }))
    } catch { /* best-effort：展示性数据，失败不影响会话 */ }
  }
  listCommands() {
    if (this.commandCatalog !== undefined) return Promise.resolve(this.commandCatalog)
    if (this.commandDiscovery === undefined) {
      this.commandDiscovery = discoverCommands(this, this.discoveryController.signal).then((commands) => {
        this.commandCatalog = commands
        return commands
      }).finally(() => { this.commandDiscovery = undefined })
    }
    return this.commandDiscovery
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
        header: { config: this.options },
        reason: 'initial',
      })
      this.session.append('request/context', { ...this.options })
    }

    let child
    let approvalBridge
    try {
      // 建立本地审批桥需要一次异步 listen。先占住 current，避免 whenIdle()
      // 或取消逻辑把这段启动窗口误判成已完成的 turn。
      this.current = { controller, child: undefined }
      if (this.profile.createApprovalBridge !== undefined) {
        approvalBridge = await this.profile.createApprovalBridge(this, controller.signal)
        this.approvalBridge = approvalBridge
      }
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('cancelled')
      child = spawn(this.config.command, this.commandArgs(turn === 1, message), {
        cwd: this.session.header.cwd,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.current.child = child
      const exited = exitOf(child)
      const payload = {
        type: 'user',
        message: { role: 'user', content: [...injected.flatMap((item) => item.content), ...message.content] },
      }
      // 默认把整轮用户输入作为 JSONL 写入 stdin 并关闭；profile 可用
      // promptInput 覆盖（返回 null 表示提示词由 translate 经其他通道传递，
      // stdin 的生命周期也交给 translate 管理）。
      const input = this.profile.promptInput === undefined
        ? `${JSON.stringify(payload)}\n`
        : this.profile.promptInput(payload)
      if (input !== null) child.stdin.end(input)
      await this.profile.translate(this, child, turn, step, controller.signal, message)
      const exit = await exited
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('cancelled')
      // 事件翻译已成功完成的 turn，允许 CLI 以非零码退出（例如 JSON-RPC
      // 服务器被驱动主动终止）；内容正确性由 translate 自己保证。
      if (exit.code !== 0 && this.profile.tolerateUncleanExit !== true) {
        throw new Error(`${this.profile.label} exited with code ${exit.code}: ${exit.stderr}`)
      }
      this.session.append('step/end', { turn, step })
      this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    } catch (error) {
      const aborted = controller.signal.aborted
      this.session.append('step/end', { turn, step })
      this.session.append('turn/end', {
        turn,
        reason: aborted
          ? { kind: 'aborted', reason: controller.signal.reason ?? { kind: 'user' } }
          : { kind: 'error', error: { message: error instanceof Error ? error.message : String(error), code: this.profile.errorCode } },
      })
      if (!aborted) this.emit('agent/error', { turn, step, error })
    } finally {
      this.approvalBridge = undefined
      await approvalBridge?.close()
      this.current = undefined
      this.setStatus('idle')
    }
  }
}

/** Host Remote plus lifecycle owner, generic over profile. */
export class CliDriverGateway extends TypertRemoteService {
  constructor(ctx, rawConfig = {}, profile) {
    super(ctx, profile.remoteNamespace)
    this.profile = profile
    this.config = profile.configOf(rawConfig)
    this.index = profile.createIndex(this.config.indexPath)
    this.legacyPath = profile.legacyIndexPath?.(rawConfig)
    this.handles = new Map()
    this.indexWrite = Promise.resolve()
    // A gateway is a long-lived host service. On plugin unload, immediately
    // cancel every child process and let each handle finish its detach path.
    ctx.effect(() => () => {
      for (const handle of [...this.handles.values()]) void handle.dispose()
    }, `${profile.pluginName}: dispose published sessions`)
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
        this.prefixTitleEvent(session, data)
      })
    })
  }
  prefixTitleEvent(session, data) {
    const prefix = this.profile.titlePrefix
    if (typeof data?.title !== 'string') return
    // 用户手动命名的标题（source 'user'）是明确意图：既不加前缀，也视为 pin，
    // 之后任何自动标题都不再被改写成带前缀的版本（含本驱动写入的固定标题）。
    if (data.source?.kind === 'user') return
    if (session.events.some((event) => event.type === 'session/title' && event.data.source?.kind === 'user')) return
    if (data.title.startsWith(prefix)) return
    session.append('session/title', {
      title: `${prefix}${data.title}`,
      messageSeqs: Array.isArray(data.messageSeqs) ? [...data.messageSeqs] : [],
      source: { kind: 'user' },
    })
  }
  ensureRequestHeader(session) {
    if (session.requestHeader() !== undefined) return
    const config = { provider: this.profile.provider, model: this.profile.defaultModel }
    session.append('request/header', { header: { config }, reason: 'initial' })
    session.append('request/context', config)
  }
  permissionStateOf(entry) {
    return permissionStateOf(this.profile, entry)
  }
  async migrateLegacyIndex() {
    if (this.legacyPath === undefined) return
    try {
      const legacy = await this.profile.createIndex(this.legacyPath).read()
      if (legacy.length === 0) return
      const current = await this.index.read()
      if (current.length > 0) return
      await this.index.write(legacy)
      this.ctx.logger?.info?.(`${this.profile.pluginName}: migrated ${legacy.length} legacy session(s) from ${this.legacyPath}`)
    } catch (error) {
      this.ctx.logger?.warn?.(`${this.profile.pluginName}: legacy index migration skipped: ${String(error)}`)
    }
  }
  /** 默认委托 profile.createAgent；子类可覆盖以注入网关自身的引用。 */
  createAgentFor(session, record) {
    return this.profile.createAgent(
      this.ctx,
      session.id,
      session,
      this.config,
      record,
      (effectivePermissionMode) => this.observeEffectivePermission(session.id, record, effectivePermissionMode),
      this,
    )
  }
  async createSession(workspaceId) {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new Error(`${this.profile.pluginName}: workspace "${workspaceId}" was not found`)
    return this.createForWorkspace(workspace)
  }
  enqueueIndexWrite(task) {
    const write = this.indexWrite.then(task)
    // 后续写入不能被一次磁盘错误永久短路；调用方仍会收到当前这次失败。
    this.indexWrite = write.catch(() => undefined)
    return write
  }
  persistRecord(record) {
    return this.enqueueIndexWrite(() => this.index.upsert(record))
  }
  recordFor(entry) {
    return {
      ...entry,
      driver: this.profile.driver,
      driverVersion: this.profile.driverVersion,
      ...this.permissionStateOf(entry),
    }
  }
  getPermission(sessionId) {
    const handle = this.handles.get(sessionId)
    if (handle === undefined) throw new Error(`${this.profile.pluginName}: session "${sessionId}" is not a live native ${this.profile.label} session`)
    return this.permissionStateOf(handle.record)
  }
  async getModels(sessionId) {
    const handle = this.handles.get(sessionId)
    if (!handle) throw new Error('会话不属于当前原生驱动')
    return discoverModels(handle.agent, handle.agent.discoveryController.signal)
  }
  async setModel(sessionId, modelId) {
    const handle = this.handles.get(sessionId)
    if (!handle) throw new Error('会话不属于当前原生驱动')
    if (handle.agent.status !== 'idle') throw new Error('请等待当前 agent 完成后再切换模型')
    const models = await this.getModels(sessionId)
    if (!models.some((model) => model.id === modelId)) throw new Error('该模型不在当前 agent 的可选列表中')
    if (handle.agent.status !== 'idle') throw new Error('请等待当前 agent 完成后再切换模型')
    const next = { ...handle.record, selectedModel: modelId, model: modelId }
    await this.persistRecord(next)
    Object.assign(handle.record, next)
    return this.permissionStateOf(handle.record)
  }
  async setPermission(sessionId, permissionMode) {
    if (!this.profile.permissionModes.includes(permissionMode)) {
      throw new Error(`${this.profile.pluginName}: unsupported ${this.profile.label} permission mode "${String(permissionMode)}"`)
    }
    const handle = this.handles.get(sessionId)
    if (handle === undefined) throw new Error(`${this.profile.pluginName}: session "${sessionId}" is not a live native ${this.profile.label} session`)
    // 权限模式仅在下一轮 spawn CLI 时读取。运行中的子进程已经拿到了
    // 自己的 --permission-mode，保存新选择只会作用于随后的一轮，不会改变
    // 当前 CLI 的行为，因此无需阻止用户预先切换。保留已观测的实际模式，
    // 让界面能在本轮结束前提示其仍与新选择不同。
    const wasRunning = handle.agent.status !== 'idle'
    const next = { ...handle.record, permissionMode }
    if (!wasRunning) delete next.effectivePermissionMode
    await this.persistRecord(next)
    Object.assign(handle.record, next)
    if (!wasRunning) delete handle.record.effectivePermissionMode
    return this.permissionStateOf(handle.record)
  }
  async observeEffectivePermission(sessionId, record, effectivePermissionMode) {
    if (typeof effectivePermissionMode !== 'string' || effectivePermissionMode.length === 0) return
    const handle = this.handles.get(sessionId)
    if (handle === undefined || handle.record !== record || record.effectivePermissionMode === effectivePermissionMode) return
    const next = { ...record, effectivePermissionMode }
    try {
      await this.persistRecord(next)
      Object.assign(record, next)
    } catch (error) {
      this.ctx.logger?.warn?.(`${this.profile.pluginName}: cannot persist effective permission mode for ${sessionId}: ${String(error)}`)
    }
  }
  async createForWorkspace(workspace) {
    const cwd = workspace.path
    if (!isAbsolute(cwd)) throw new Error(`${this.profile.pluginName}: workspace path must be absolute`)
    const id = randomUUID()
    const session = this.ctx.sessions.prepare(id, { meta: { cwd } })
    // Do not call the generic `sessions.selectModel` API for a native Agent.
    // That API persists a global default model selection, so a later default
    // Harness session would inherit this sentinel provider.
    this.ensureRequestHeader(session)
    const record = this.recordFor({
      sessionId: id,
      securityProfile: this.config.securityProfile,
      createdAt: Date.now(),
    })
    const handle = this.publish(session, 'startup', record)
    try {
      await this.persistRecord(record)
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
        const record = this.recordFor(entry)
        this.publish(preparation.session, 'resume', record)
        if (entry.driverVersion !== this.profile.driverVersion || entry.permissionMode !== record.permissionMode || entry.effectivePermissionMode !== record.effectivePermissionMode) {
          await this.persistRecord(record)
        }
      } catch (error) {
        this.ctx.logger?.warn?.(`${this.profile.pluginName}: cannot restore ${entry.sessionId}: ${String(error)}`)
      } finally {
        preparation?.[Symbol.dispose]?.()
      }
    }
  }
  publish(session, source, record = this.recordFor({ sessionId: session.id, securityProfile: this.config.securityProfile })) {
    // Upgrade blank sessions created by earlier M0 builds during cold restore.
    this.ensureRequestHeader(session)
    const agent = this.createAgentFor(session, record)
    let detachSession
    let detachAgent
    const dispose = async () => {
      agent.discoveryController.abort()
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
      if (stored !== undefined) this.prefixTitleEvent(session, stored.data)
      emitAgentEvent(this.ctx, agent, 'agent/session-start', { source })
      const handle = { agent, record, dispose }
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

/** 组装 CLI 智能体驱动的插件 apply 函数（注册哨兵 adapter + 启动网关）。
 * profiles 可传单个 profile 或数组；数组时同一插件内注册多个智能体。 */
export function createDriverApply(profiles) {
  const list = Array.isArray(profiles) ? profiles : [profiles]
  return async (ctx, config) => {
    installNativeCommands(ctx, (agent) => agent instanceof CliDriverAgent)
    for (const profile of list) {
      ctx.llm.registerAdapter([profile.provider], new SentinelAdapter(profile))
      const gateway = new (profile.Gateway ?? CliDriverGateway)(ctx, config, profile)
      await gateway.migrateLegacyIndex()
      await gateway.restore()
    }
  }
}
