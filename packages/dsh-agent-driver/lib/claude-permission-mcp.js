/**
 * Claude Code --permission-prompt-tool 的极小 MCP stdio 服务。
 *
 * 它不自行决定权限：每个请求经本机回环 socket 交给同一 DSH turn 的 Host，
 * 再由 DSH 的 ApprovalPanel 向用户展示一次性「允许／拒绝」。
 */
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'

const [portText, token] = process.argv.slice(2)
const port = Number(portText)
if (!Number.isInteger(port) || port <= 0 || typeof token !== 'string' || token.length === 0) process.exit(64)

const socket = createConnection({ host: '127.0.0.1', port })
socket.setEncoding('utf8')
const pending = new Map()
let bridgeReady
let settleBridge
let failBridge
// socket 故障绝不能让本进程崩溃：未处理的 rejection 会在 claude 的 MCP
// 握手窗口内杀死本服务，claude 侧随即报 "Available MCP tools: none"。
// 这里保持进程存活，由 requestDecision 把失败降级为 fail-closed 的 deny。
bridgeReady = new Promise((resolve, reject) => {
  settleBridge = resolve
  failBridge = (error) => { reject(error); bridgeReady.catch(() => {}) }
})
let buffer = ''

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function permissionResult(outcome, input) {
  if (outcome === 'allowed-once') return { behavior: 'allow', updatedInput: input }
  return {
    behavior: 'deny',
    message: outcome === 'rejected' ? 'User rejected this action.' : 'The approval request was unavailable or cancelled.',
  }
}

socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'hello', token })}\n`))
socket.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    let message
    try { message = JSON.parse(line) } catch { socket.destroy(); return }
    if (message?.type === 'ready') {
      settleBridge()
      continue
    }
    if (message?.type === 'permission-result' && typeof message.id === 'string') {
      const resolve = pending.get(message.id)
      pending.delete(message.id)
      resolve?.(message.outcome)
    }
  }
})
socket.once('error', (error) => failBridge(error))
socket.once('close', () => {
  failBridge(new Error('DSH approval bridge closed'))
  for (const resolve of pending.values()) resolve('unavailable')
  pending.clear()
})

async function requestDecision(toolName, input) {
  try {
    await bridgeReady
    const id = randomUUID()
    const answer = new Promise((resolve) => pending.set(id, resolve))
    socket.write(`${JSON.stringify({ type: 'permission', id, tool_name: toolName, input })}\n`)
    return await answer
  } catch {
    return 'unavailable'
  }
}

async function dispatch(request) {
  if (request?.method === 'initialize') {
    return write({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-claude-approval', version: '1.0.0' },
      },
    })
  }
  if (request?.method === 'tools/list') {
    return write({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [{
          name: 'request_permission',
          description: 'Ask the DSH user to approve a Claude Code tool call.',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string' },
              input: { type: 'object' },
            },
            required: ['tool_name', 'input'],
            additionalProperties: false,
          },
        }],
      },
    })
  }
  if (request?.method === 'tools/call') {
    const params = request.params ?? {}
    const input = params.arguments?.input
    if (params.name !== 'request_permission' || typeof params.arguments?.tool_name !== 'string' || input === null || typeof input !== 'object' || Array.isArray(input)) {
      return write({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(permissionResult('unavailable', {})) }], isError: true } })
    }
    const outcome = await requestDecision(params.arguments.tool_name, input)
    return write({
      jsonrpc: '2.0',
      id: request.id,
      result: { content: [{ type: 'text', text: JSON.stringify(permissionResult(outcome, input)) }] },
    })
  }
  if (Object.hasOwn(request ?? {}, 'id')) {
    write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
  }
}

process.stdin.setEncoding('utf8')
let stdinBuffer = ''
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  let newline
  while ((newline = stdinBuffer.indexOf('\n')) >= 0) {
    const line = stdinBuffer.slice(0, newline)
    stdinBuffer = stdinBuffer.slice(newline + 1)
    let request
    try { request = JSON.parse(line) } catch { continue }
    void dispatch(request)
  }
})
