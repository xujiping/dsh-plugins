import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMcpApprovalBridge } from '../lib/driver-core.js'

const here = dirname(fileURLToPath(import.meta.url))
const seen = []
const agent = {
  rootCtx: {
    get: (name) => name === 'approval' ? {
      request: async (request) => {
        seen.push(request)
        return 'allowed-once'
      },
    } : undefined,
  },
}
const bridge = await createMcpApprovalBridge(agent, new AbortController().signal)
assert.ok(bridge, '有 DSH approval 服务时建立回环桥接')

const child = spawn(process.execPath, [join(here, '..', 'lib', 'claude-permission-mcp.js'), String(bridge.port), bridge.token], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.setEncoding('utf8')
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk })
child.stdout.setEncoding('utf8')
let output = ''
const replies = []
const waiters = []
child.stdout.on('data', (chunk) => {
  output += chunk
  let newline
  while ((newline = output.indexOf('\n')) >= 0) {
    const line = output.slice(0, newline)
    output = output.slice(newline + 1)
    if (line === '') continue
    const reply = JSON.parse(line)
    const resolve = waiters.shift()
    if (resolve) resolve(reply)
    else replies.push(reply)
  }
})
const nextReply = () => replies.shift() ?? new Promise((resolve) => waiters.push(resolve))

try {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`)
  const initialized = await nextReply()
  assert.equal(initialized.result.serverInfo.name, 'dsh-claude-approval')
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
  const tools = await nextReply()
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ['request_permission'])
  const input = { command: 'git commit -m test' }
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'request_permission', arguments: { tool_name: 'Bash', input } } })}\n`)
  const result = await nextReply()
  assert.deepEqual(JSON.parse(result.result.content[0].text), { behavior: 'allow', updatedInput: input })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].agent, agent)
  assert.equal(seen[0].toolName, 'Bash')
  assert.match(seen[0].reason, /git commit -m test/)
} finally {
  child.stdin.end()
  await bridge.close()
  if (child.exitCode === null) child.kill('SIGTERM')
  await once(child, 'close')
}

assert.equal(stderr, '')
console.log('PASS Claude permission-prompt MCP bridge')
