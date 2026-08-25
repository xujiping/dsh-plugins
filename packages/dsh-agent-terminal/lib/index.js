/**
 * dsh-agent-terminal — host half.
 *
 * Runs external agent CLIs (claude code, hermes, …) interactively inside a
 * local PTY and streams them to the browser half over a WebSocket, where
 * xterm.js renders the agent's own TUI — the page IS the real agent UI, at
 * 100% fidelity.
 *
 * Design points:
 * - node-pty and ws are resolved from the host's / profile's node_modules at
 *   runtime (createRequire fallback chain): this package carries zero npm
 *   dependencies, and the native node-pty build already matches the running
 *   host ABI (Electron) — we never compile our own.
 * - Sessions outlive the browser tab: the PTY keeps running while detached,
 *   output is retained in a bounded scrollback, and a later attach replays it.
 * - Every route (and the WebSocket upgrade) carries the loopback trust fence
 *   — these endpoints spawn interactive processes as the local user.
 * - PATH augmentation matches dsh-llm-agent-bridge: the DSH host process has
 *   a narrow PATH, so common bin dirs (/opt/homebrew/bin, …) are probed and
 *   prepended before spawning.
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { isIPv4 } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable cordis plugin name. */
export const name = 'agent-terminal'

/** Services required before the surfaces can mount. */
export const inject = ['webServer']

/** Route family paths (the browser half spells the same values). */
export const AGENT_TERM_API = {
  agents: '/api/dsh-agent-terminal/agents',
  sessions: '/api/dsh-agent-terminal/sessions',
  terminal: '/api/dsh-agent-terminal/terminal',
}

/** Common extra bin dirs probed when the command is a bare name. */
const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/opt/local/bin']

/** Default agent roster (overridable via plugin config `agents`). */
export const DEFAULT_AGENTS = [
  { id: 'claude-code', label: 'Claude Code', command: 'claude', args: [] },
  { id: 'hermes', label: 'Hermes', command: 'hermes', args: [] },
]

/** Bound on retained scrollback per session (characters, ~512 KiB). */
const SCROLLBACK_CHARS = 512 * 1024

/** Concurrent session cap — a runaway guard, not a quota feature. */
const MAX_SESSIONS = 8

/** Pause the PTY when a client socket's send buffer exceeds this… */
const BACKPRESSURE_HIGH_WATER = 1024 * 1024
/** …and resume once every client drains below this. */
const BACKPRESSURE_LOW_WATER = 512 * 1024

// ---------------------------------------------------------------------------
// module resolution (ws / node-pty from host or profile node_modules)
// ---------------------------------------------------------------------------

/** Candidate package.json roots whose node_modules may carry ws / node-pty. */
function moduleSearchRoots() {
  const roots = []
  // 1. This package's own resolution chain (repo-local install wins).
  roots.push(dirname(fileURLToPath(import.meta.url)))
  // 2. Every dsh profile root (~/.dsh/profiles/<name>/node_modules).
  const profiles = join(homedir(), '.dsh', 'profiles')
  try {
    for (const entry of readdirSync(profiles)) {
      const root = join(profiles, entry)
      if (existsSync(join(root, 'package.json'))) roots.push(root)
    }
  } catch { /* no profiles dir */ }
  // 3. The Electron app root (process.execPath …/MacOS/DSH Desktop →
  //    …/Resources/app.asar/package.json; asar reads redirect to
  //    app.asar.unpacked for unpacked files such as native modules).
  try {
    const exe = process.execPath
    if (exe.includes('Resources')) {
      const resources = dirname(exe)
      for (const sub of ['app.asar', 'app.asar.unpacked', '.']) {
        const root = join(resources, sub)
        if (existsSync(join(root, 'package.json'))) roots.push(root)
      }
    }
  } catch { /* execPath unavailable */ }
  // 4. Current working directory (dsh CLI launched from a checkout).
  roots.push(process.cwd())
  return roots
}

/**
 * Resolve one runtime module (ws / node-pty) from any known root.
 * @param {string} moduleName - package name to require.
 * @returns {any} the module namespace / exports.
 */
export function resolveHostModule(moduleName) {
  const tried = []
  for (const root of moduleSearchRoots()) {
    tried.push(root)
    try {
      const require = createRequire(join(root, 'package.json'))
      return require(moduleName)
    } catch { /* not here — next root */ }
  }
  throw new Error(`dsh-agent-terminal: cannot resolve '${moduleName}' from any of: ${tried.join(', ')}`)
}

// ---------------------------------------------------------------------------
// command resolution + child env (shared approach with dsh-llm-agent-bridge)
// ---------------------------------------------------------------------------

/** Whether a path exists and carries any executable bit. */
function isExecutable(file) {
  try {
    return (statSync(file).mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * Resolve a bare command name to an absolute path (host PATH + common dirs).
 * @param {string} command - bare name or absolute path.
 * @param {string[]} [pathDirs] - PATH entries to probe first.
 * @returns {string | undefined} absolute path when found.
 */
export function resolveCommand(command, pathDirs = []) {
  if (command.includes('/')) return isExecutable(command) ? command : undefined
  const dirs = [...pathDirs, ...process.env.PATH.split(':').filter(Boolean), ...COMMON_BIN_DIRS]
  for (const dir of dirs) {
    const candidate = join(dir, command)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/** Child env: parent env with common bin dirs prepended to PATH. */
export function childEnv() {
  const inherited = { ...process.env }
  const seen = new Set()
  const parts = []
  for (const dir of [...COMMON_BIN_DIRS, ...(inherited.PATH ?? '').split(':')]) {
    if (dir === '' || seen.has(dir)) continue
    seen.add(dir)
    parts.push(dir)
  }
  return { ...inherited, PATH: parts.join(':') }
}

// ---------------------------------------------------------------------------
// loopback trust fence (same semantics as the dsh-ssh shared core)
// ---------------------------------------------------------------------------

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
  return isIPv4(v4) && v4.startsWith('127.')
}

/** Loopback socket address (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Loopback URL hostname (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: loopback socket address AND loopback Host
 * header, plus browser same-origin markers. X-Forwarded-For is never trusted.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// PTY session registry
// ---------------------------------------------------------------------------

/** Normalize one configured agent entry. */
function normalizeAgent(entry) {
  const id = typeof entry?.id === 'string' && entry.id !== '' ? entry.id : undefined
  const command = typeof entry?.command === 'string' && entry.command !== '' ? entry.command : undefined
  if (id === undefined || command === undefined) {
    throw new Error(`dsh-agent-terminal: agent entry needs both id and command (got ${JSON.stringify(entry)})`)
  }
  return {
    id,
    label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : id,
    command,
    args: Array.isArray(entry.args) ? entry.args.filter(arg => typeof arg === 'string') : [],
    cwd: typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : undefined,
    resolved: resolveCommand(command),
  }
}

/** Normalize the whole roster (config list or defaults). */
export function normalizeAgents(list) {
  const source = Array.isArray(list) && list.length > 0 ? list : DEFAULT_AGENTS
  const agents = source.map(normalizeAgent)
  const ids = new Set()
  for (const agent of agents) {
    if (ids.has(agent.id)) throw new Error(`dsh-agent-terminal: duplicate agent id '${agent.id}'`)
    ids.add(agent.id)
  }
  return agents
}

/**
 * Host-side PTY session registry: spawn, attach (WebSocket clients), bounded
 * scrollback retention, resize, kill. Sessions survive client detach.
 */
export class AgentTerminal {
  /**
   * @param {object} options
   * @param {Array} options.agents - normalized agent roster.
   * @param {any} [options.ptyImpl] - node-pty module (injectable for tests).
   * @param {number} [options.maxSessions] - concurrent session cap.
   * @param {number} [options.scrollbackChars] - retained output bound.
   */
  constructor(options = {}) {
    this.agents = options.agents ?? normalizeAgents(undefined)
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS
    this.scrollbackChars = options.scrollbackChars ?? SCROLLBACK_CHARS
    this.ptyImpl = options.ptyImpl
    this.sessions = new Map()
    this.nextId = 1
  }

  /** Resolve the node-pty module lazily (only needed when spawning). */
  pty() {
    this.ptyImpl ??= resolveHostModule('node-pty')
    return this.ptyImpl
  }

  /** Agent roster for the browser (availability = command resolvable). */
  listAgents() {
    return this.agents.map(agent => ({
      id: agent.id,
      label: agent.label,
      command: agent.command,
      resolved: agent.resolved,
      available: agent.resolved !== undefined,
    }))
  }

  /** Session summaries (order: creation). */
  listSessions() {
    return Array.from(this.sessions.values()).map(session => ({
      id: session.id,
      agentId: session.agentId,
      label: session.label,
      startedAt: session.startedAt,
      exited: session.exited,
      exitCode: session.exitCode,
      clients: session.clients.size,
    }))
  }

  /**
   * Spawn one agent session.
   * @param {string} agentId - roster id.
   * @param {{cols?: number, rows?: number, cwd?: string}} [options]
   * @returns {object} the session record.
   */
  create(agentId, options = {}) {
    const agent = this.agents.find(entry => entry.id === agentId)
    if (agent === undefined) throw new Error(`unknown agent '${agentId}'`)
    if (agent.resolved === undefined) {
      throw new Error(`command not found: ${agent.command} (probe dirs: ${COMMON_BIN_DIRS.join(', ')})`)
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`session cap reached (${this.maxSessions}) — close a terminal first`)
    }
    const cols = clampDim(options.cols, 80)
    const rows = clampDim(options.rows, 24)
    const cwd = options.cwd ?? agent.cwd ?? process.env.HOME ?? homedir()
    const pty = this.pty().spawn(agent.resolved, agent.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: existsSync(cwd) ? cwd : (process.env.HOME ?? homedir()),
      env: childEnv(),
    })
    const id = `s${this.nextId++}`
    const session = {
      id,
      agentId: agent.id,
      label: agent.label,
      command: agent.command,
      startedAt: Date.now(),
      exited: false,
      exitCode: null,
      exitError: undefined,
      pty,
      clients: new Set(),
      buffer: [],
      bufferedChars: 0,
      paused: false,
      onOutput: null,
      onExit: null,
    }
    this.sessions.set(id, session)
    pty.onData(data => {
      appendScrollback(this, session, data)
      broadcast(this, session, { type: 'output', data })
      manageBackpressure(this, session)
    })
    pty.onExit(({ exitCode }) => {
      session.exited = true
      session.exitCode = exitCode
      broadcast(this, session, { type: 'exit', code: exitCode })
      // Close every attached client socket; the record is dropped now so the
      // session list stops advertising it (the tab keeps its final frame).
      for (const ws of Array.from(session.clients)) {
        session.clients.delete(ws)
        try { ws.close(1000) } catch { /* already closed */ }
      }
      this.sessions.delete(id)
    })
    return sessionSummary(session)
  }

  /** Attach one WebSocket client to a live session (replays scrollback). */
  attach(ws, sessionId) {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return undefined
    session.clients.add(ws)
    sendFrame(ws, { type: 'ready', session: session.id, label: session.label })
    const retained = session.buffer.join('')
    if (retained !== '') sendFrame(ws, { type: 'output', data: retained })
    manageBackpressure(this, session)
    return session
  }

  /** Write user input into the session's PTY. */
  write(sessionId, data) {
    const session = this.sessions.get(sessionId)
    if (session !== undefined && !session.exited) {
      try { session.pty.write(data) } catch { /* pty gone */ }
    }
  }

  /** Resize the session's PTY. */
  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId)
    if (session !== undefined && !session.exited) {
      try { session.pty.resize(clampDim(cols, 80), clampDim(rows, 24)) } catch { /* pty gone */ }
    }
  }

  /** Kill one session (SIGTERM to the process group leader). */
  kill(sessionId) {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return false
    try { session.pty.kill() } catch { /* already dead */ }
    return true
  }

  /** Kill everything (plugin dispose). */
  dispose() {
    for (const session of Array.from(this.sessions.values())) {
      try { session.pty.kill() } catch { /* already dead */ }
    }
    this.sessions.clear()
  }
}

/** Dimension clamp for cols/rows. */
function clampDim(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : fallback
}

/** Append output to the bounded scrollback (front-trim on overflow). */
function appendScrollback(registry, session, data) {
  session.buffer.push(data)
  session.bufferedChars += data.length
  while (session.bufferedChars > registry.scrollbackChars && session.buffer.length > 1) {
    session.bufferedChars -= session.buffer[0].length
    session.buffer.shift()
  }
}

/** Broadcast one server frame to every attached client. */
function broadcast(registry, session, frame) {
  for (const ws of session.clients) sendFrame(ws, frame)
}

/** Send one JSON frame (silently ignores dead sockets). */
function sendFrame(ws, frame) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(frame))
  } catch { /* client gone */ }
}

/**
 * Transport backpressure: pause the PTY while ANY client's send buffer is
 * above the high-water mark; resume once every client drains below low-water.
 */
function manageBackpressure(registry, session) {
  if (session.exited) return
  const congested = Array.from(session.clients).some(ws => ws.readyState === 1 && ws.bufferedAmount > BACKPRESSURE_HIGH_WATER)
  if (congested && !session.paused) {
    session.paused = true
    try { session.pty.pause() } catch { /* unsupported */ }
  } else if (!congested && session.paused) {
    const drained = Array.from(session.clients).every(ws => ws.readyState !== 1 || ws.bufferedAmount < BACKPRESSURE_LOW_WATER)
    if (drained) {
      session.paused = false
      try { session.pty.resume() } catch { /* unsupported */ }
    }
  }
}

/** Public summary shape of one session. */
function sessionSummary(session) {
  return {
    id: session.id,
    agentId: session.agentId,
    label: session.label,
    startedAt: session.startedAt,
    exited: session.exited,
    exitCode: session.exitCode,
  }
}

// ---------------------------------------------------------------------------
// routes + WebSocket upgrade
// ---------------------------------------------------------------------------

/** One JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a small JSON request body (undefined when oversized/unparseable). */
async function readJsonBody(req) {
  if (typeof req?.[Symbol.asyncIterator] !== 'function') return undefined
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16 * 1024) return undefined
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Query helper (first value, decoded). */
function queryParam(url, name) {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/**
 * Build the /api/dsh-agent-terminal route family + terminal upgrade.
 * @param {object} deps
 * @param {AgentTerminal} deps.registry - the PTY session registry.
 * @param {any} [deps.wsModule] - ws module (injectable for tests).
 * @returns {{routes: Array, upgrade: object}} webserver registrations.
 */
export function makeRoutes(deps) {
  const registry = deps.registry
  const wsModule = deps.wsModule ?? resolveHostModule('ws')
  const { WebSocketServer } = wsModule
  const terminalWss = new WebSocketServer({ noServer: true })

  const routes = [
    {
      kind: 'exact',
      path: AGENT_TERM_API.agents,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if (req.method !== 'GET') return writeJson(res, 405, { error: `method not allowed: ${req.method}` })
        writeJson(res, 200, { agents: registry.listAgents() })
      },
    },
    {
      kind: 'exact',
      path: AGENT_TERM_API.sessions,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          writeJson(res, 200, { sessions: registry.listSessions() })
          return
        }
        if (method === 'DELETE') {
          const id = queryParam(url, 'id')
          if (id === undefined || id === '') return writeJson(res, 400, { error: 'id query parameter is required' })
          writeJson(res, 200, { ok: registry.kill(id) })
          return
        }
        if (method !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${method}` })
        const body = await readJsonBody(req)
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
        const agentId = typeof body.agentId === 'string' ? body.agentId : ''
        if (agentId === '') return writeJson(res, 400, { error: 'agentId is required' })
        try {
          const session = registry.create(agentId, {
            cols: typeof body.cols === 'number' ? body.cols : undefined,
            rows: typeof body.rows === 'number' ? body.rows : undefined,
            cwd: typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : undefined,
          })
          writeJson(res, 201, { session })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]

  const upgrade = {
    path: AGENT_TERM_API.terminal,
    handler: (req, socket, head) => {
      if (!isLoopbackRequest(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = queryParam(url, 'session')
      if (sessionId === undefined || sessionId === '') {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const cols = Number.parseInt(queryParam(url, 'cols') ?? '80', 10)
      const rows = Number.parseInt(queryParam(url, 'rows') ?? '24', 10)
      const existing = registry.sessions.get(sessionId)
      if (existing === undefined) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      terminalWss.handleUpgrade(req, socket, head, ws => {
        const session = registry.attach(ws, sessionId)
        if (session === undefined) {
          try { ws.close(1000) } catch { /* closed */ }
          return
        }
        if (Number.isFinite(cols) || Number.isFinite(rows)) {
          registry.resize(sessionId, cols, rows)
        }
        ws.on('message', data => {
          let frame
          try {
            frame = JSON.parse(String(data))
          } catch {
            return
          }
          if (frame?.type === 'input' && typeof frame.data === 'string') {
            registry.write(sessionId, frame.data)
          } else if (frame?.type === 'resize') {
            registry.resize(sessionId, frame.cols, frame.rows)
          }
        })
        const detach = () => {
          session.clients.delete(ws)
          manageBackpressure(registry, session)
        }
        ws.on('close', detach)
        ws.on('error', detach)
      })
    },
  }

  return { routes, upgrade, terminalWss }
}

// ---------------------------------------------------------------------------
// plugin apply
// ---------------------------------------------------------------------------

/**
 * Mount the PTY registry, REST routes, and the terminal WebSocket upgrade.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {{agents?: Array, maxSessions?: number}} [config] - plugin config.
 */
export function apply(ctx, config = {}) {
  let agents
  try {
    agents = normalizeAgents(config.agents)
  } catch (error) {
    ctx.logger('warning')?.(`dsh-agent-terminal: ${error instanceof Error ? error.message : String(error)}`)
    agents = normalizeAgents(undefined)
  }
  const registry = new AgentTerminal({ agents, maxSessions: config.maxSessions })
  ctx.effect(() => () => { registry.dispose() }, 'dsh-agent-terminal: registry')

  ctx.effect(() => {
    const { routes, upgrade, terminalWss } = makeRoutes({ registry })
    const disposers = routes.map(route => ctx.webServer.register(route))
    disposers.push(ctx.webServer.registerUpgrade(upgrade))
    return () => {
      for (const dispose of disposers) dispose()
      try { terminalWss.close() } catch { /* already closed */ }
    }
  }, 'dsh-agent-terminal: routes')

  const missing = registry.listAgents().filter(agent => !agent.available)
  ctx.logger.info?.(
    `dsh-agent-terminal: ${agents.length} agent(s) registered`
    + (missing.length > 0 ? `; unresolved commands: ${missing.map(agent => agent.command).join(', ')}` : ''),
  )
}
