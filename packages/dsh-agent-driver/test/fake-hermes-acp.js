#!/usr/bin/env node
// Fake hermes CLI：模拟 `hermes acp` 的 JSON-RPC 服务器（换行分隔 JSON）。
// 支持 initialize / session/new / session/load（含历史 replay，驱动应丢弃）/
// session/prompt（思考流 + 工具调用 + 正文流 + usage）/
// session/request_permission（等待客户端应答，并回显所选 optionId）。
let buffer = ''
let currentSession = 'acp-fake-session'
let promptCount = 0
let resumed = false
let selectedModel

const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)
const respond = (id, result) => write({ jsonrpc: '2.0', id, result })
const notify = (update) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: currentSession, update } })

// 服务器 → 客户端请求（request_permission）的挂起应答。
const serverRequests = new Map()

async function handle(msg) {
  const { method, params = {} } = msg
  if (method === 'initialize') {
    respond(msg.id, { protocolVersion: 1, agentInfo: { name: 'hermes-agent', version: 'fake' }, agentCapabilities: {} })
  } else if (method === 'session/new') {
    currentSession = 'acp-fake-session'
    respond(msg.id, { sessionId: currentSession, models: { currentModelId: 'zai:fake-acp-model', availableModels: [{ modelId: 'zai:fake-acp-model', name: '测试 Hermes' }] } })
    notify({ sessionUpdate: 'available_commands_update', availableCommands: [
      { name: 'model', description: 'Hermes 模型', input: { hint: '[model]' } },
      { name: 'compact', description: 'Hermes 压缩' },
    ] })
  } else if (method === 'session/load') {
    resumed = true
    currentSession = typeof params.sessionId === 'string' ? params.sessionId : currentSession
    notify({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed history must be dropped' } })
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed reply must be dropped' } })
    respond(msg.id, { models: { currentModelId: 'zai:fake-acp-model', availableModels: [{ modelId: 'zai:fake-acp-model', name: '测试 Hermes' }] } })
  } else if (method === 'session/set_model') {
    if (!['zai:fake-acp-model', 'custom:qwen-coding-plan:shared-model'].includes(params.modelId)) throw new Error('invalid test model')
    selectedModel = params.modelId
    respond(msg.id, {})
  } else if (method === 'session/prompt') {
    const text = params.prompt?.[0]?.text
    if (text?.startsWith('/')) {
      notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `command:${text}${selectedModel ? `\nmodel:${selectedModel}` : ''}` } })
      respond(msg.id, { stopReason: 'end_turn' })
      return
    }
    promptCount += 1
    const permissionId = 9000 + promptCount
    const answer = await new Promise((resolve) => {
      serverRequests.set(permissionId, resolve)
      write({
        jsonrpc: '2.0', id: permissionId, method: 'session/request_permission',
        params: {
          sessionId: currentSession,
          options: [
            { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
          ],
          toolCall: { title: 'dangerous', kind: 'execute' },
        },
      })
    })
    const granted = answer?.outcome?.optionId === 'allow_once'
    notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about it ' } })
    notify({ sessionUpdate: 'tool_call', toolCallId: `toolu-${promptCount}`, title: `fake tool ${promptCount}`, kind: 'execute', status: 'pending' })
    notify({ sessionUpdate: 'tool_call', toolCallId: `toolu-${promptCount}`, title: `fake tool ${promptCount}`, kind: 'execute', status: 'completed', content: [{ type: 'text', text: granted ? 'tool ran' : 'tool denied' }] })
    notify({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `${resumed ? 'Second reply' : 'Hello'} from fake Hermes ACP. perm:${granted ? 'allow' : 'deny'}` },
    })
    notify({ sessionUpdate: 'usage_update', size: 200000, used: 1234 })
    respond(msg.id, { stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 2 } })
  } else {
    respond(msg.id, {})
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    // 客户端对服务器请求的响应：唤醒挂起的 request_permission。
    if (msg.method === undefined && msg.id !== undefined && msg.result !== undefined) {
      const waiter = serverRequests.get(msg.id)
      if (waiter !== undefined) {
        serverRequests.delete(msg.id)
        waiter(msg.result)
        continue
      }
    }
    if (msg.method !== undefined && msg.id !== undefined) void handle(msg).catch(() => {})
  }
})
