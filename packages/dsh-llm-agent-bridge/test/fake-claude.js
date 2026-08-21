#!/usr/bin/env node
/**
 * Fake claude-code CLI for smoke tests: reads the prompt on stdin, emits a
 * canned stream-json event sequence (thinking + text + tool_use + result).
 * Usage: fake-claude.js <--verbose> ...  (argv is ignored)
 */
const events = [
  { type: 'system', subtype: 'init', model: 'fake' },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'let me think about this' },
        { type: 'text', text: 'Hello from fake claude.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Bash',
          input: { command: 'ls /some/dir && echo "line1"\nline2\nline3', description: 'inspect files' },
        },
      ],
    },
  },
  {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'file-a.txt\nfile-b.txt\nfile-c.txt\n(very long output continues...)',
          is_error: false,
        },
      ],
    },
  },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
  { type: 'result', subtype: 'success', result: 'Done.', session_id: 'sess_1', usage: { input_tokens: 10, output_tokens: 3 } },
]
for (const event of events) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}
