/**
 * Integration test: load the plugin's `apply` against a real cordis Context
 * with a real dsh-llm LlmRuntime, then verify provider registration and a
 * full stream call through the real LlmRuntime dispatch path.
 *
 * Resolves @deepseek-ai/cordis and @deepseek-ai/dsh-llm from the desktop
 * profile's shared node_modules so it exercises the exact runtime seam.
 */
import { Context } from '/Users/xujiping/.dsh/profiles/node_modules/@deepseek-ai/cordis/lib/index.js'
import LlmRuntime, { BlockAssembler } from '/Users/xujiping/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import { apply as applyBridge } from '/Users/xujiping/AiProjects/dsh-plugins/packages/dsh-llm-agent-bridge/lib/index.js'
import assert from 'node:assert/strict'

const ctx = new Context()
// Bind a real LlmRuntime as the `llm` service on this context. The bridge
// plugin reads ctx.llm and calls registerAdapter / prepareCall / stream,
// which is exactly the seam the real host wires up at boot.
const llm = new LlmRuntime(ctx)
ctx.llm = llm

// Apply the bridge plugin with default config (no agents -> defaults)
const fakeClaude = '/Users/xujiping/AiProjects/dsh-plugins/packages/dsh-llm-agent-bridge/test/fake-claude.js'
applyBridge(ctx, {
  agents: [
    {
      id: 'claude-code',
      label: 'Claude Code',
      protocol: 'claude-code',
      command: process.execPath,
      args: [fakeClaude],
      promptVia: 'stdin',
      contextWindow: 200000,
    },
  ],
})

// 1) provider registered?
const providers = llm.listProviders()
assert.ok(providers.some((p) => p.id === 'claude-code'), `provider registered: ${JSON.stringify(providers)}`)

// 2) listModels
const models = await llm.listModels('claude-code')
assert.equal(models.length, 1)
assert.equal(models[0].id, 'default')

// 3) full stream dispatch through the real LlmRuntime.prepareCall + stream
const prepared = await llm.prepareCall({ provider: 'claude-code', model: 'default' })
const chunks = []
for await (const chunk of prepared.stream({
  provider: 'claude-code',
  model: 'default',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
})) {
  chunks.push(chunk)
}

const types = chunks.map((c) => c.type)
assert.ok(types.includes('text-delta'), `got text-delta: ${types}`)
assert.ok(types.includes('reasoning-delta'), `got reasoning-delta: ${types}`)
assert.equal(chunks.filter((c) => c.type === 'finish').length, 1)
assert.equal(chunks.find((c) => c.type === 'finish').reason.kind, 'stop')

// 4) BlockAssembler: the emitted block sequence must assemble into a message
const assembler = new BlockAssembler()
for (const chunk of chunks) assembler.push(chunk)
const msg = assembler.message()
assert.ok(Array.isArray(msg.content) && msg.content.length > 0, 'assembler produced a message')
const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
assert.ok(text.includes('Hello from fake claude.'), `assembled text has content: ${JSON.stringify(text.slice(0, 120))}`)
console.log('assembled message role=%s blocks=%s', msg.role, JSON.stringify(msg.content.map((b) => b.type)))

console.log('\nINTEGRATION PASS: plugin loads, provider registered, stream dispatch + assembly OK')
