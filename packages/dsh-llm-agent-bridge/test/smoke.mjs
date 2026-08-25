/**
 * Smoke test for dsh-llm-agent-bridge.
 *
 * Drives the real adapter pipeline (spawn -> stdin prompt -> line parsing ->
 * chunk mapping) against a fake claude-code CLI and a fake plain CLI, and
 * asserts the harness StreamChunk sequences are well-formed.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AgentBridgeAdapter, flattenHistory } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fakeClaude = join(here, 'fake-claude.js')

/** Collect all chunks from an adapter stream call. */
async function collect(adapter, options) {
  const stream = adapter.stream({ provider: options.provider ?? 'claude-code', model: 'default', messages: options.messages ?? [] })
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

// ---- flattenHistory ----
{
  const flat = flattenHistory([
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ])
  assert.ok(flat.includes('User: hello'), 'user text flattened')
  assert.ok(flat.includes('Assistant: hi'), 'assistant text flattened')
  assert.ok(!flat.includes('be brief'), 'system message skipped')
  console.log('PASS flattenHistory')
}

// ---- claude-code protocol end-to-end ----
{
  const adapter = new AgentBridgeAdapter([
    {
      id: 'claude-code',
      label: 'Claude Code',
      protocol: 'claude-code',
      command: process.execPath,
      args: [fakeClaude],
      promptVia: 'stdin',
      contextWindow: 200000,
    },
  ])
  const chunks = await collect(adapter, {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
  })

  const types = chunks.map((c) => c.type)
  assert.ok(types.includes('block-start'), `block-start present: ${types}`)
  assert.ok(types.includes('text-delta'), `text-delta present: ${types}`)
  assert.ok(types.includes('reasoning-delta'), `reasoning-delta present: ${types}`)
  assert.ok(types.includes('usage'), `usage present: ${types}`)

  const finish = chunks.filter((c) => c.type === 'finish')
  assert.equal(finish.length, 1, 'exactly one finish chunk')
  assert.equal(finish[0].reason.kind, 'stop', 'finish kind is stop')

  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(' | ')
  assert.ok(text.includes('Hello from fake claude.'), `assistant text surfaced: ${text}`)
  assert.ok(!text.includes('⚙'), `tool_use hidden by default: ${text}`)
  assert.ok(!text.includes('↳'), `tool_result hidden by default: ${text}`)
  assert.ok(!text.includes('line1'), `raw command not dumped: ${text}`)
  assert.ok(!text.includes('file-a.txt'), `raw output not dumped: ${text}`)
  assert.ok(text.includes('Done.'), `result text present: ${text}`)
  console.log('PASS claude-code protocol (tools hidden by default)', JSON.stringify(types))
}

// ---- claude-code protocol with showTools: true (compact summaries) ----
{
  const adapter = new AgentBridgeAdapter([
    {
      id: 'claude-code',
      label: 'Claude Code',
      protocol: 'claude-code',
      command: process.execPath,
      args: [fakeClaude],
      promptVia: 'stdin',
      contextWindow: 200000,
      showTools: true,
    },
  ])
  const chunks = await collect(adapter, {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
  })
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(' | ')
  assert.ok(text.includes('⚙ Bash'), `tool_use summary shown: ${text}`)
  assert.ok(text.includes('↳'), `tool_result summary shown: ${text}`)
  // summaries must be compact: single line, no raw newlines inside
  const toolLine = text.split('|').find((t) => t.includes('⚙')) ?? ''
  assert.ok(!toolLine.includes('\n'), `tool summary is one line: ${JSON.stringify(toolLine)}`)
  console.log('PASS claude-code protocol (showTools compact)')
}

// ---- plain protocol (hermes-style) ----
{
  const adapter = new AgentBridgeAdapter([
    {
      id: 'hermes',
      label: 'Hermes',
      protocol: 'plain',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("line one\\nline two\\n")'],
      promptVia: 'arg',
    },
  ])
  const chunks = await collect(adapter, {
    provider: 'hermes',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
  })
  const finish = chunks.filter((c) => c.type === 'finish')
  assert.equal(finish.length, 1, 'plain: exactly one finish')
  assert.equal(finish[0].reason.kind, 'stop', 'plain: stop')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('\n')
  assert.ok(text.includes('line one'), `plain text streamed: ${JSON.stringify(text)}`)
  assert.ok(text.includes('line two'), `plain second line: ${JSON.stringify(text)}`)
  console.log('PASS plain protocol')
}

// ---- nonzero exit becomes an error finish ----
{
  const adapter = new AgentBridgeAdapter([
    {
      id: 'boom',
      label: 'Boom',
      protocol: 'plain',
      command: process.execPath,
      args: ['-e', 'process.stderr.write("kaput"); process.exit(3)'],
      promptVia: 'arg',
    },
  ])
  const chunks = await collect(adapter, {
    provider: 'boom',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  })
  const finish = chunks.filter((c) => c.type === 'finish')
  assert.equal(finish.length, 1, 'boom: one finish')
  assert.equal(finish[0].reason.kind, 'error', 'boom: error finish')
  assert.equal(finish[0].reason.failure.code, 'CLI_EXIT', 'boom: CLI_EXIT code')
  assert.ok(finish[0].reason.failure.message.includes('kaput'), `stderr surfaced: ${finish[0].reason.failure.message}`)
  console.log('PASS nonzero-exit error finish')
}

// ---- missing command becomes a graceful SPAWN_FAILED finish (not a throw) ----
{
  const adapter = new AgentBridgeAdapter([
    {
      id: 'missing',
      label: 'Missing',
      protocol: 'plain',
      command: 'definitely-not-a-real-binary-xyz',
      promptVia: 'arg',
    },
  ])
  const chunks = await collect(adapter, {
    provider: 'missing',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  })
  const finish = chunks.filter((c) => c.type === 'finish')
  assert.equal(finish.length, 1, 'missing: one finish')
  assert.equal(finish[0].reason.kind, 'error', 'missing: error finish')
  assert.equal(finish[0].reason.failure.code, 'SPAWN_FAILED', 'missing: SPAWN_FAILED code')
  console.log('PASS missing-command SPAWN_FAILED finish')
}

console.log('\nAll smoke tests passed.')
