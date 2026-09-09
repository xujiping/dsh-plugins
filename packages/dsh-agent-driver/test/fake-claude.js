#!/usr/bin/env node
// Fake stream-json Claude process. It ignores flags and one JSONL user input.
process.stdin.resume()
process.stdin.once('data', () => {
  const events = [
    { type: 'system', subtype: 'init', session_id: process.argv.includes('--resume') ? 'resumed' : 'new', model: 'fake-claude', permissionMode: 'acceptEdits' },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'checking' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello from fake Claude.' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
    { type: 'assistant', message: { id: 'fake-message-1', content: [
      { type: 'thinking', thinking: 'checking' },
    ] } },
    { type: 'assistant', message: { id: 'fake-message-1', content: [
      { type: 'text', text: 'Hello from fake Claude.' },
      { type: 'tool_use', id: 'toolu_fake', name: 'Read', input: { file_path: '/tmp/example.txt' } },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fake', content: 'example', is_error: false }] } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } } },
    { type: 'assistant', message: { id: 'fake-message-2', model: 'fake-runtime-model', content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'result', subtype: 'success', session_id: 'ignored-by-driver', usage: { input_tokens: 10, output_tokens: 3 } },
  ]
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`)
})
