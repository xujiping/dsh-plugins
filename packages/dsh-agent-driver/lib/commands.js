/** 原生命令发现与 DSH 命令通道适配；不执行 shell，不发送模型提示词。 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { importDshModule } from './dsh-runtime.js'
const { createUserMessage } = await importDshModule('@deepseek-ai/dsh-llm')

export function normalizeCommands(items, label) {
  if (!Array.isArray(items)) throw new Error(`${label} 未返回命令目录`)
  const commands = new Map()
  for (const item of items) {
    if (!item || typeof item.name !== 'string' || !/^[\w:.-]+$/u.test(item.name)) continue
    const hint = item.input?.hint ?? item.argumentHint
    for (const name of [item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])]) {
      if (typeof name !== 'string' || !/^[\w:.-]+$/u.test(name)) continue
      commands.set(name, {
        name,
        description: `${label} · ${item.description || item.name}`,
        // 统一保留参数输入阶段，菜单选择不会立即触发命令。
        input: { hint: typeof hint === 'string' && hint.trim() ? hint : '可选参数，按 Enter 执行' },
      })
    }
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function discoverModels(agent, signal) {
  return agent.profile.discoverModels
    ? agent.profile.discoverModels(agent, signal)
    : discoverCommands(agent, signal, 'models')
}

export function discoverCommands(agent, signal, kind = 'commands') {
  const hermes = agent.profile.remoteNamespace === 'hermesAgent'
  const args = hermes ? agent.commandArgs(true) : agent.commandArgs(true).filter((arg, index, all) =>
    arg !== '--session-id' && all[index - 1] !== '--session-id')
  if (!hermes) args.push('--no-session-persistence')
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('命令发现已取消')); return }
    const child = spawn(agent.config.command, args, {
      cwd: agent.session.header.cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    let settled = false
    const finish = (error, items) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch { /* 子进程已经退出 */ }
      if (error) reject(error)
      else {
        try { resolve(kind === 'commands' ? normalizeCommands(items, agent.profile.label) : normalizeModels(items)) } catch (cause) { reject(cause) }
      }
    }
    const abort = () => finish(new Error('命令发现已取消'))
    const timer = setTimeout(() => finish(new Error(`${agent.profile.label} 命令发现超时`)), 15000)
    signal?.addEventListener('abort', abort, { once: true })
    const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stdin.on('error', (error) => finish(error))
    child.on('error', (error) => finish(error))
    child.on('close', () => finish(new Error(`${agent.profile.label} 在返回命令目录前退出`)))
    child.stderr.resume()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > 2_000_000) { finish(new Error('命令目录响应过大')); return }
      let index
      while (!settled && (index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (!hermes && message.type === 'control_response' && message.response?.request_id === 'commands') {
          if (message.response.subtype === 'error') finish(new Error('Claude Code 命令初始化失败'))
          else finish(null, message.response.response?.[kind])
        } else if (hermes) {
          if (message.error) { finish(new Error(message.error.message || 'ACP 命令初始化失败')); continue }
          if (message.id === 1 && message.result) write({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: agent.session.header.cwd, mcpServers: [] } })
          const update = message.params?.update
          if (kind === 'models' && message.id === 2 && message.result) finish(null, message.result.models?.availableModels)
          if (kind === 'commands' && update?.sessionUpdate === 'available_commands_update') finish(null, update.availableCommands)
        }
      }
    })
    write(hermes
      ? { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-agent-driver', version: '0.1.0' } } }
      : { type: 'control_request', request_id: 'commands', request: { subtype: 'initialize' } })
  })
}

/** rc.6 命令服务没有 provider 分发钩子：仅覆盖自有 agent 的公开 list/execute。 */
export function installNativeCommands(ctx, owns) {
  const commands = ctx.commands
  const originalList = commands.list
  const originalExecute = commands.execute
  const listDescriptor = Object.getOwnPropertyDescriptor(commands, 'list')
  const executeDescriptor = Object.getOwnPropertyDescriptor(commands, 'execute')
  const list = function (agent) {
    return owns(agent) ? agent.listCommands() : originalList.call(this, agent)
  }
  const execute = async function (agent, line, submittedAttachments, signal) {
    // DSH 的命令接口在 line 与 signal 之间加入了附件列表。普通 Harness
    // 会话必须逐项透传，否则官方命令会收到 undefined 的 signal 并在读取
    // signal.aborted 时崩溃。
    if (!owns(agent)) return originalExecute.call(this, agent, line, submittedAttachments, signal)
    const name = /^\/([^\s]+)(?:\s|$)/u.exec(line)?.[1]
    if (!name || !(await agent.listCommands()).some((item) => item.name === name)) return undefined
    if (signal.aborted) throw new Error('命令已取消')
    if (agent.status !== 'idle') throw new Error('请等待当前 agent 完成后再执行命令')
    const modelId = name === 'model' ? line.slice(name.length + 1).trim() : undefined
    if (name === 'model' && !modelId) throw new Error('请从模型选择面板选择模型')
    if (modelId) await agent.gateway.setModel(agent.id, modelId)
    const commandId = `native-${randomUUID()}`
    agent.session.append('command/run', { commandId, name, args: line.slice(name.length + 1), source: { kind: 'user' } })
    // 命令通过原有串行 turn 通道执行，响应和失败均进入会话事件流。
    if (!modelId) agent.followup(createUserMessage({ content: [{ type: 'text', text: line }] }))
    const result = { kind: 'success' }
    agent.session.append('command/done', { commandId, ...result })
    return { commandId, result }
  }
  commands.list = list
  commands.execute = execute
  ctx.effect(() => () => {
    // Cordis 每次读取服务方法都会生成代理，必须比较底层属性而非读取值。
    for (const [name, installed, descriptor] of [['list', list, listDescriptor], ['execute', execute, executeDescriptor]]) {
      if (Object.getOwnPropertyDescriptor(commands, name)?.value !== installed) continue
      if (descriptor) Object.defineProperty(commands, name, descriptor)
      else delete commands[name]
    }
  }, 'agent-driver: native commands')
}

function normalizeModels(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('当前 agent 未提供可选模型列表')
  return items.map((item) => {
    const id = item.value ?? item.modelId
    if (typeof id !== 'string' || !id.trim()) throw new Error('agent 返回了无效的模型标识')
    return { id, label: item.displayName ?? item.name ?? id, description: item.description ?? '' }
  })
}
