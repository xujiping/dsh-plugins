/**
 * dsh-llm-agent-bridge — host half.
 *
 * Registers LLM adapter routes whose "model" is a local external agent CLI
 * (claude code, hermes, …). Each configured agent becomes one provider route
 * on ctx.llm; when the chat box selects that provider/model, this adapter
 * spawns the CLI, feeds it the flattened conversation, and maps the CLI's
 * streamed output back onto the harness StreamChunk protocol
 * (block-start / text-delta / reasoning-delta / block-end / usage / finish).
 *
 * The external agent keeps its own tools: tool activity from the CLI is
 * surfaced as ordinary text blocks, and every step finishes with a plain
 * `stop` so the harness loop never tries to dispatch the CLI's tools itself.
 *
 * No runtime dependencies: the adapter duck-types the LlmAdapter contract
 * (providerInfo / listModels / resolveModel / stream) which dsh-llm accepts.
 */

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

/** Stable cordis plugin name. */
export const name = 'llm-agent-bridge'

/** Requires the llm service (adapter registry). */
export const inject = ['llm']

/** Default agent routes registered when config provides none. */
const DEFAULT_AGENTS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    protocol: 'claude-code', // JSONL stream-json events on stdout
    command: 'claude',
    args: ['-p', '--output-format', 'stream-json', '--verbose'],
    promptVia: 'stdin',
    contextWindow: 200000,
  },
  {
    id: 'hermes',
    label: 'Hermes',
    protocol: 'plain', // raw stdout streamed as text
    command: 'hermes',
    args: ['-z'],
    promptVia: 'arg',
    contextWindow: 200000,
  },
]

/** Max chars of flattened history fed to the CLI prompt. */
const MAX_PROMPT_CHARS = 128000

/** Kill the CLI when it produces no output for this long. */
const DEFAULT_IDLE_TIMEOUT_MS = 600000

/** Cap for a single tool-result summary line. */
const TOOL_SUMMARY_LIMIT = 2000

/** Expand a leading `~` in configured paths. */
function expandHome(value) {
  if (typeof value === 'string' && value.startsWith('~/')) {
    return `${homedir()}${value.slice(1)}`
  }
  return value
}

/** Binary directories likely to hold agent CLIs, in probe order. */
const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/opt/local/bin']

/** Split a PATH string into existing directories. */
function pathDirs(pathValue) {
  if (typeof pathValue !== 'string' || pathValue.length === 0) return []
  return pathValue.split(':').filter((dir) => dir.length > 0)
}

/** Does this path exist and look like an executable file? */
function isExecutable(candidate) {
  try {
    const st = statSync(candidate)
    return st.isFile() && (st.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * Resolve `command` to an absolute path. Honours explicit paths (with `~`),
 * then probes the parent PATH, then common install dirs. Returns the original
 * command string when nothing matches — the caller's error path then reports
 * it with actionable guidance.
 */
function resolveCommand(command, env) {
  const candidate = expandHome(command)
  if (candidate.includes('/')) return candidate
  const dirs = [...pathDirs(env.PATH), ...COMMON_BIN_DIRS]
  for (const dir of dirs) {
    const full = `${dir}/${candidate}`
    if (isExecutable(full)) return full
  }
  return command
}

/** Child env with a PATH that can actually find common agent CLIs. */
function childEnv(agent) {
  const base = { ...process.env }
  const merged = agent.env ? { ...base, ...agent.env } : base
  const current = merged.PATH ?? ''
  const augmented = [...new Set([...COMMON_BIN_DIRS, ...pathDirs(current)])].join(':')
  return { ...merged, PATH: augmented }
}

/** Validate and normalize one configured agent entry. */
function resolveAgent(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('llm-agent-bridge: each agent must be an object')
  const id = entry.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('llm-agent-bridge: agent.id must be a non-empty string')
  const protocol = entry.protocol ?? 'plain'
  if (protocol !== 'claude-code' && protocol !== 'plain') {
    throw new Error(`llm-agent-bridge: agent "${id}" has unsupported protocol "${protocol}"`)
  }
  const command = entry.command
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error(`llm-agent-bridge: agent "${id}" must set command`)
  }
  const args = Array.isArray(entry.args) ? entry.args.map(String) : []
  const promptVia = entry.promptVia ?? (protocol === 'claude-code' ? 'stdin' : 'arg')
  if (promptVia !== 'stdin' && promptVia !== 'arg') {
    throw new Error(`llm-agent-bridge: agent "${id}" promptVia must be "stdin" or "arg"`)
  }
  return {
    id,
    label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : id,
    protocol,
    command,
    args,
    extraArgs: Array.isArray(entry.extraArgs) ? entry.extraArgs.map(String) : [],
    promptVia,
    cwd: expandHome(entry.cwd),
    modelId: typeof entry.modelId === 'string' && entry.modelId.length > 0 ? entry.modelId : 'default',
    contextWindow: Number.isInteger(entry.contextWindow) && entry.contextWindow > 0 ? entry.contextWindow : 200000,
    idleTimeoutMs:
      Number.isFinite(entry.idleTimeoutMs) && entry.idleTimeoutMs > 0 ? entry.idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS,
    showTools: entry.showTools === true,
    env: entry.env && typeof entry.env === 'object' ? entry.env : undefined,
  }
}

/** Extract plain text out of one content block array. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** One-line summary of a tool call / tool result block for the transcript. */
function toolSummary(detail) {
  const line = String(detail)
  return line.length > TOOL_SUMMARY_LIMIT ? `${line.slice(0, TOOL_SUMMARY_LIMIT)}…` : line
}

/** Collapse whitespace/newlines and truncate to a short one-line summary. */
function compactText(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Compact JSON: single line, no pretty-printing, truncated. */
function compactJson(value) {
  try {
    return compactText(JSON.stringify(value), 200)
  } catch {
    return compactText(String(value), 200)
  }
}

/** Flatten harness message history into a text transcript for the CLI. */
function flattenHistory(messages) {
  const lines = []
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue
    if (message.role === 'system') continue
    const parts = []
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        parts.push(block.text)
      } else if (block.type === 'tool-call') {
        parts.push(`[assistant called tool ${block.name}] ${toolSummary(block.arguments)}`)
      } else if (block.type === 'tool-result') {
        parts.push(`[tool result] ${toolSummary(textOf(block.content))}`)
      }
    }
    if (parts.length === 0) continue
    const who = message.role === 'assistant' ? 'Assistant' : 'User'
    lines.push(`${who}: ${parts.join('\n')}`)
  }
  let transcript = lines.join('\n\n')
  if (transcript.length > MAX_PROMPT_CHARS) {
    transcript = `${transcript.slice(0, 2000)}\n\n…(earlier history truncated)…\n\n${transcript.slice(
      MAX_PROMPT_CHARS - 2000,
    )}`
  }
  return transcript
}

/** Shorten a stderr tail for an error message. */
function stderrTail(buffer) {
  const text = buffer.trim()
  return text.length > 600 ? `${text.slice(0, 600)}…` : text
}

/** Terminal error chunk. */
function errorFinish(message, code) {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}

/**
 * The bridge adapter. One instance owns every configured provider route; the
 * provider id selects which CLI to spawn.
 */
class AgentBridgeAdapter {
  constructor(agents) {
    this.agents = agents.map(resolveAgent)
    this.byId = new Map(this.agents.map((agent) => [agent.id, agent]))
  }

  agentOf(provider) {
    const agent = this.byId.get(provider)
    if (agent === undefined) throw new Error(`llm-agent-bridge: unknown provider "${provider}"`)
    return agent
  }

  /** Use the harness's normal retry defaults for this provider. */
  providerRetryPolicy() {
    return undefined
  }

  providerInfo(provider) {
    return { id: provider, name: this.agentOf(provider).label }
  }

  listModels(provider) {
    const agent = this.agentOf(provider)
    return Promise.resolve([{ provider, id: agent.modelId, name: `${agent.label} (CLI)`, inputModalities: ['text'] }])
  }

  resolveModel(provider, model) {
    const agent = this.agentOf(provider)
    return Promise.resolve({
      provider,
      id: model,
      name: `${agent.label} (CLI)`,
      inputModalities: ['text'],
      context: { contextWindow: agent.contextWindow },
    })
  }

  /**
   * Spawn the CLI and translate its output into harness StreamChunks. Always
   * ends with exactly one terminal `finish` chunk; spawn/parse failures become
   * `finish { kind: 'error' }` rather than throws, matching the stream
   * protocol's adapter boundary.
   */
  stream(options) {
    const agent = this.agentOf(options.provider)
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        yield* self.run(agent, options)
      },
    }
  }

  async *run(agent, options) {
    const prompt = flattenHistory(options.messages)
    const signal = options.signal
    const finalArgs = [...agent.args, ...agent.extraArgs, ...(agent.promptVia === 'arg' ? [prompt] : [])]
    const env = childEnv(agent)
    const command = resolveCommand(agent.command, env)

    let child
    try {
      child = spawn(command, finalArgs, {
        cwd: agent.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      yield errorFinish(
        `llm-agent-bridge: failed to spawn "${agent.command}" (resolved "${command}"): ${error.message}`,
        'SPAWN_FAILED',
      )
      return
    }

    // spawn() failures (e.g. ENOENT) arrive asynchronously on the child's
    // `error` event, not as a throw. If left unhandled they become an
    // uncaught exception that crashes the host, so surface them as a
    // graceful error finish instead. A failed spawn also never emits `exit`,
    // so the exit promise below must resolve from the error path too.
    let spawnError = null
    child.on('error', (error) => {
      spawnError = error
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    })

    if (agent.promptVia === 'stdin') {
      child.stdin.on('error', () => {}) // EPIPE when the CLI exits early
      try {
        child.stdin.write(prompt)
        child.stdin.end()
      } catch {
        /* stdin already closed; spawn error path reports it */
      }
    }

    let stderrText = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderrText.length < 8000) stderrText += chunk
    })

    // Resolves when the child either exits normally or fails to spawn. A
    // failed spawn emits `error` but never `exit`, so both paths resolve it.
    let resolveExit
    const exit = new Promise((resolve) => {
      resolveExit = resolve
    })
    child.on('exit', (code, signalName) => resolveExit({ code, signalName }))
    child.on('error', () => resolveExit({ code: null, signalName: null }))

    // Idle watchdog: a hung CLI must not hang the harness turn forever.
    let idleTimer = null
    let timedOut = false
    const armIdle = () => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, agent.idleTimeoutMs)
    }

    // Caller abort: terminate the CLI promptly; iteration unwinds via finally.
    const onAbort = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', onAbort, { once: true })

    const terminated = { finished: false }
    try {
      armIdle()
      if (agent.protocol === 'claude-code') {
        yield* this.pumpClaudeCode(agent, child, terminated, () => armIdle())
      } else {
        yield* this.pumpPlain(child, terminated, () => armIdle())
      }
      // Wait for the process to exit so a nonzero status still surfaces.
      const { code } = await exit
      if (spawnError) {
        yield errorFinish(
          `llm-agent-bridge: failed to spawn "${agent.command}" (resolved "${command}"): ${spawnError.message}` +
            ` — is it installed and on PATH? (searched ${env.PATH})`,
          'SPAWN_FAILED',
        )
        return
      }
      if (timedOut) {
        yield errorFinish(
          `llm-agent-bridge: "${agent.command}" produced no output for ${agent.idleTimeoutMs}ms and was terminated`,
          'IDLE_TIMEOUT',
        )
        return
      }
      if (signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'agent CLI aborted by caller', code: 'ABORTED' } } }
        return
      }
      if (code !== 0 && !terminated.finished) {
        yield errorFinish(
          `llm-agent-bridge: "${agent.command}" exited with code ${code}${
            stderrText.length > 0 ? `: ${stderrTail(stderrText)}` : ''
          }`,
          'CLI_EXIT',
        )
        return
      }
      if (!terminated.finished) yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      if (!terminated.finished) {
        yield errorFinish(`llm-agent-bridge: ${error.message}`, 'BRIDGE_ERROR')
      }
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer)
      signal?.removeEventListener('abort', onAbort)
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* spawn failed or already gone */
        }
      }
    }
  }

  /** claude-code stream-json: JSONL events on stdout. */
  async *pumpClaudeCode(agent, child, terminated, keepAlive) {
    let sawText = false
    let nextIndex = 0
    const text = (t) => this.textBlock(t, nextIndex++)
    const reasoning = (t) => this.reasoningBlock(t, nextIndex++)
    for await (const line of lineIterator(child.stdout)) {
      keepAlive()
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let event
      try {
        event = JSON.parse(trimmed)
      } catch {
        // Non-JSON noise on stdout: surface it so the user sees the CLI's words.
        yield* text(`[stdout] ${trimmed}`)
        continue
      }
      if (!event || typeof event !== 'object') continue
      if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
          if (!block || typeof block !== 'object') continue
          if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
            sawText = true
            yield* text(block.text)
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
            yield* reasoning(block.thinking)
          } else if (block.type === 'tool_use' && agent.showTools) {
            // Claude Code executes its own tools; by default we stay quiet so
            // the chat reads like a normal conversation. Opt-in showTools
            // surfaces a one-line summary instead of the raw JSON dump.
            const label = `${block.name ?? 'tool'}${
              typeof block.input === 'object' && block.input !== null
                ? ` ${compactJson(block.input)}`
                : ''
            }`
            yield* text(`⚙ ${compactText(label, 120)}`)
          }
        }
      } else if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
        if (!agent.showTools) continue
        for (const block of event.message.content) {
          if (block && block.type === 'tool_result') {
            const body = typeof block.content === 'string' ? block.content : textOf(block.content)
            yield* text(`↳ ${compactText(body || '(no output)', 240)}`)
          }
        }
      } else if (event.type === 'result') {
        if (event.is_error === true || (event.subtype && event.subtype !== 'success')) {
          terminated.finished = true
          yield errorFinish(
            String(event.result ?? 'claude code reported an error'),
            'CLI_RESULT',
          )
          return
        }
        if (!sawText && typeof event.result === 'string' && event.result.length > 0) {
          yield* text(event.result)
        }
        const usage = event.usage
        if (usage && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)) {
          yield { type: 'usage', usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }
        }
        terminated.finished = true
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // `system` init lines and unknown event types are dropped.
    }
    // stdout ended without a result event; run() turns the exit code into the
    // terminal chunk (or a plain stop when the CLI exited cleanly).
  }

  /** plain protocol: everything on stdout is answer text. */
  async *pumpPlain(child, terminated, keepAlive) {
    child.stdout.setEncoding('utf8')
    let nextIndex = 0
    for await (const line of lineIterator(child.stdout)) {
      keepAlive()
      if (line.length === 0) continue
      yield* this.textBlock(line.endsWith('\n') ? line.slice(0, -1) : line, nextIndex++)
    }
  }

  /** One complete text block: block-start, one delta, block-end. */
  async *textBlock(text, index) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text }
    yield { type: 'block-end', index, block: { type: 'text', text } }
  }

  /** One complete reasoning block. */
  async *reasoningBlock(text, index) {
    yield { type: 'block-start', index, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index, text }
    yield { type: 'block-end', index, block: { type: 'reasoning', text } }
  }
}

/** Async iterator over complete lines of a readable stream. */
async function* lineIterator(stream) {
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) yield line
  rl.close()
}

/** Cordis plugin entry. */
export function apply(ctx, config) {
  const rawAgents = Array.isArray(config?.agents) && config.agents.length > 0 ? config.agents : DEFAULT_AGENTS
  const adapter = new AgentBridgeAdapter(rawAgents)
  const agents = adapter.agents
  const seen = new Set()
  for (const agent of agents) {
    if (seen.has(agent.id)) throw new Error(`llm-agent-bridge: duplicate agent id "${agent.id}"`)
    seen.add(agent.id)
  }
  ctx.llm.registerAdapter(
    agents.map((agent) => agent.id),
    adapter,
  )
  ctx.logger.info(
    `llm-agent-bridge: registered provider routes ${agents.map((agent) => `${agent.id} -> ${agent.command}`).join(', ')}`,
  )
}

export { AgentBridgeAdapter, DEFAULT_AGENTS, childEnv, flattenHistory, resolveCommand }
