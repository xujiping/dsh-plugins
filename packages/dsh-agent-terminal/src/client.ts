/**
 * dsh-agent-terminal — browser half (bundled into lib/client.js by esbuild).
 *
 * Plain-DOM client (no React tree, so it can never disturb the shell's
 * reconciliation): a sidebar entry row toggles a center-column panel that
 * offers one card per configured agent CLI. Clicking a card opens a new
 * "conversation" — an xterm.js view over the host PTY running that agent's
 * real interactive TUI. Tabs keep their terminals mounted while switching
 * (host replays scrollback on re-attach), and a close kills the session.
 */

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import xtermCss from '@xterm/xterm/css/xterm.css'

/** Route paths (same values the host half spells). */
const API = {
  agents: '/api/dsh-agent-terminal/agents',
  sessions: '/api/dsh-agent-terminal/sessions',
  terminal: '/api/dsh-agent-terminal/terminal',
}

/** Stable data attributes / activation protocol keys. */
const VIEW_SELECTOR = '[data-dsh-agent-terminal-view]'
const ENTRY_SELECTOR = '[data-dsh-agent-terminal-entry]'
const ACTIVE_ATTR = 'data-dsh-agent-terminal-active'
/** Sibling panels' activation attributes, removed when this panel opens. */
const OTHER_ACTIVE_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active']
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'agent-terminal'
/** Sidebar rows that hand the center column back to the conversation. */
const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

const MONOSPACE = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)'

/** Inject the plugin stylesheet once per page load. */
let cssInjected = false
function ensureCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  if (document.querySelector('style[data-dsh-agent-terminal-css]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshAgentTerminalCss = ''
  style.textContent = xtermCss + '\n' + PANEL_CSS
  document.head.appendChild(style)
}

// ---------------------------------------------------------------------------
// panel open/close store (tiny external store, no React)
// ---------------------------------------------------------------------------

/** Minimal subscribe/getSnapshot store for the panel's open state. */
function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: (): T => value,
    set(next: T): void {
      value = next
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

// ---------------------------------------------------------------------------
// API client (fetch + WebSocket, same origin)
// ---------------------------------------------------------------------------

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const record = typeof body === 'object' && body !== null ? body as { error?: unknown } : null
    const message = typeof record?.error === 'string' ? record.error : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body as T
}

interface AgentInfo { id: string; label: string; command: string; available: boolean }
interface SessionInfo { id: string; agentId: string; label: string; startedAt: number; exited: boolean }

async function fetchAgents(): Promise<AgentInfo[]> {
  const response = await fetch(API.agents)
  const body = await readJson<{ agents: AgentInfo[] }>(response)
  return body.agents
}

async function createSession(agentId: string, cols: number, rows: number): Promise<SessionInfo> {
  const response = await fetch(API.sessions, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, cols, rows }),
  })
  const body = await readJson<{ session: SessionInfo }>(response)
  return body.session
}

async function killSession(id: string): Promise<void> {
  try {
    await fetch(`${API.sessions}?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch { /* server may already have removed it */ }
}

/** One live terminal connection (JSON frames over WebSocket). */
interface TermConnection {
  send(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  onReady: (() => void) | undefined
  onOutput: ((data: string) => void) | undefined
  onExit: ((code: number | null, error?: string) => void) | undefined
}

function openTerminalSocket(sessionId: string, cols: number, rows: number): TermConnection {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${scheme}://${window.location.host}${API.terminal}?session=${encodeURIComponent(sessionId)}&cols=${cols}&rows=${rows}`
  const socket = new WebSocket(url)
  const connection: TermConnection = {
    onReady: undefined,
    onOutput: undefined,
    onExit: undefined,
    send(data) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
    },
    resize(cols, rows) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }))
    },
    close() {
      try { socket.close() } catch { /* already closed */ }
    },
  }
  socket.onmessage = event => {
    let frame: { type: string; data?: string; code?: number | null; error?: string }
    try {
      frame = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (frame.type === 'ready') connection.onReady?.()
    else if (frame.type === 'output') connection.onOutput?.(frame.data ?? '')
    else if (frame.type === 'exit') connection.onExit?.(frame.code ?? null, frame.error)
  }
  socket.onclose = () => { connection.onExit?.(null, 'connection closed') }
  socket.onerror = () => { connection.onExit?.(null, 'connection error') }
  return connection
}

// ---------------------------------------------------------------------------
// panel (center column takeover, dsh-ssh / task-board activation protocol)
// ---------------------------------------------------------------------------

type TermStatus = 'connecting' | 'attached' | 'detached' | 'exited' | 'error'

interface TerminalEntry {
  session: SessionInfo
  term: Terminal
  fit: FitAddon
  wrap: HTMLDivElement
  container: HTMLDivElement
  overlay: HTMLDivElement
  dataSub: { dispose(): void } | undefined
  conn: TermConnection | undefined
  status: TermStatus
  detail: string | undefined
}

class PanelController {
  readonly openStore = createStore(false)
  private view: HTMLDivElement | undefined
  private agents: AgentInfo[] = []
  private terminals: TerminalEntry[] = []
  private activeId: string | undefined

  toggle(): void {
    if (this.openStore.get()) this.close()
    else this.open()
  }

  open(): void {
    this.openStore.set(true)
    this.applyActive()
    void this.refreshAgents()
  }

  close(): void {
    // Sessions intentionally survive the panel closing: the host PTY keeps
    // running and the next open replays the scrollback. Only the view hides.
    this.openStore.set(false)
    this.applyActive()
  }

  private applyActive(): void {
    if (this.openStore.get()) {
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }

  /** (Re)build the agent card row. */
  async refreshAgents(): Promise<void> {
    try {
      this.agents = await fetchAgents()
    } catch (error) {
      this.agents = []
      this.renderAgentError(error instanceof Error ? error.message : String(error))
      return
    }
    this.renderAgents()
  }

  // ------------------------------------------------------------- rendering

  ensureView(): HTMLDivElement | undefined {
    if (this.view !== undefined && this.view.isConnected) return this.view
    const column = document.querySelector<HTMLElement>('[data-pane="conversation"], [class*="centerCol"]')
    if (column === null) return undefined
    const view = document.createElement('div')
    view.dataset.dshAgentTerminalView = ''
    view.dataset.dshPlugin = PANEL_NAME
    view.className = 'dat-view'
    view.innerHTML = `
      <div class="dat-head">
        <div class="dat-title">智能体终端</div>
        <div class="dat-agents" data-role="agents"><span class="dat-hint">加载智能体列表…</span></div>
        <button type="button" class="dat-close" aria-label="关闭面板">✕</button>
      </div>
      <div class="dat-tabs" data-role="tabs"></div>
      <div class="dat-stack" data-role="stack"></div>`
    view.querySelector('.dat-close')?.addEventListener('click', () => { this.close() })
    column.appendChild(view)
    this.view = view
    return view
  }

  private renderAgents(): void {
    const host = this.view?.querySelector<HTMLElement>('[data-role="agents"]')
    if (host === undefined || this.agents.length === 0) return
    host.replaceChildren()
    for (const agent of this.agents) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'dat-chip'
      chip.dataset.agentId = agent.id
      chip.textContent = `+ ${agent.label}`
      if (!agent.available) {
        chip.disabled = true
        chip.title = `未找到命令：${agent.command}`
        chip.dataset.unavailable = ''
      } else {
        chip.title = `新建 ${agent.label} 会话（${agent.command}）`
        chip.addEventListener('click', () => { void this.openSession(agent) })
      }
      host.appendChild(chip)
    }
  }

  private renderAgentError(message: string): void {
    const host = this.view?.querySelector<HTMLElement>('[data-role="agents"]')
    if (host === undefined) return
    host.innerHTML = `<span class="dat-hint dat-error">智能体列表加载失败：${escapeHtml(message)}</span>`
  }

  private renderTabs(): void {
    const host = this.view?.querySelector<HTMLElement>('[data-role="tabs"]')
    if (host === undefined) return
    host.replaceChildren()
    for (const entry of this.terminals) {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'dat-tab'
      if (entry.session.id === this.activeId) tab.dataset.active = ''
      if (entry.status === 'exited') tab.dataset.exited = ''
      const dot = document.createElement('span')
      dot.className = 'dat-dot'
      dot.dataset.status = entry.status
      const label = document.createElement('span')
      label.className = 'dat-tabLabel'
      label.textContent = entry.session.label
      const close = document.createElement('span')
      close.className = 'dat-tabClose'
      close.textContent = '✕'
      close.title = '结束会话'
      close.addEventListener('click', event => {
        event.stopPropagation()
        this.closeSession(entry.session.id)
      })
      tab.append(dot, label, close)
      tab.addEventListener('click', () => { this.activate(entry.session.id) })
      host.appendChild(tab)
    }
  }

  // ------------------------------------------------------------ terminals

  async openSession(agent: AgentInfo): Promise<void> {
    const view = this.ensureView()
    const stack = view?.querySelector<HTMLElement>('[data-role="stack"]')
    if (view === undefined || stack === null) return
    if (this.terminals.length >= 8) return

    // Create + fit the terminal first so the session spawns at the size the
    // user actually sees (the agent TUI redraws anyway, but the first paint
    // then matches).
    const wrap = document.createElement('div')
    wrap.className = 'dat-termWrap'
    const container = document.createElement('div')
    container.className = 'dat-term'
    const overlay = document.createElement('div')
    overlay.className = 'dat-overlay'
    overlay.textContent = '正在启动…'
    wrap.append(container, overlay)
    stack.appendChild(wrap)

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: MONOSPACE,
      theme: { background: '#0b0e14', foreground: '#d8dee9', cursor: '#a3b8d0' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    try { fit.fit() } catch { /* zero-size container before layout */ }

    const entry: TerminalEntry = {
      session: { id: '', agentId: agent.id, label: agent.label, startedAt: Date.now(), exited: false },
      term,
      fit,
      wrap,
      container,
      overlay,
      dataSub: undefined,
      conn: undefined,
      status: 'connecting',
      detail: undefined,
    }
    // Show the new terminal immediately (nothing else selected yet).
    this.activeId = undefined
    for (const item of this.terminals) item.wrap.style.display = 'none'
    this.terminals.push(entry)

    try {
      entry.session = await createSession(agent.id, term.cols, term.rows)
    } catch (error) {
      entry.status = 'error'
      entry.detail = error instanceof Error ? error.message : String(error)
      this.showOverlay(entry, `启动失败：${entry.detail}`)
      this.renderTabs()
      return
    }
    this.activeId = entry.session.id
    this.renderTabs()
    this.attach(entry)
    this.observeSize(entry)
  }

  /** Open (or re-open) the WebSocket for one terminal entry. */
  private attach(entry: TerminalEntry): void {
    this.detach(entry)
    entry.status = 'connecting'
    entry.detail = undefined
    this.showOverlay(entry, '正在连接…')
    const connection = openTerminalSocket(entry.session.id, entry.term.cols, entry.term.rows)
    entry.conn = connection
    entry.term.options.disableStdin = false
    entry.dataSub = entry.term.onData(data => { connection.send(data) })
    connection.onReady = () => {
      entry.status = 'attached'
      this.hideOverlay(entry)
      this.renderTabs()
    }
    connection.onOutput = data => { entry.term.write(data) }
    connection.onExit = (code, error) => {
      if (entry.status === 'attached' || entry.status === 'connecting') {
        if (code !== null && error === undefined) {
          entry.status = 'exited'
          entry.term.options.disableStdin = true
          this.showOverlay(entry, `会话已结束（退出码 ${code}）— 关闭标签页清理`)
        } else if (error === 'connection closed' || error === 'connection error') {
          // Transport dropped while the PTY likely still runs: offer re-attach.
          entry.status = 'detached'
          this.showOverlay(entry, '连接已断开', '重新连接')
        } else {
          entry.status = 'error'
          entry.detail = error
          this.showOverlay(entry, `连接出错：${error ?? '未知错误'}`)
        }
      }
      entry.dataSub?.dispose()
      entry.dataSub = undefined
      entry.conn = undefined
      this.renderTabs()
    }
  }

  /** Drop the current connection without touching the terminal. */
  private detach(entry: TerminalEntry): void {
    const connection = entry.conn
    entry.conn = undefined
    if (connection !== undefined) {
      connection.onReady = undefined
      connection.onOutput = undefined
      connection.onExit = undefined
      connection.close()
    }
    entry.dataSub?.dispose()
    entry.dataSub = undefined
  }

  /** Show one terminal (tab switch); re-attach when detached. */
  activate(sessionId: string): void {
    const entry = this.terminals.find(item => item.session.id === sessionId)
    if (entry === undefined) return
    this.activeId = sessionId
    for (const item of this.terminals) {
      item.wrap.style.display = item === entry ? '' : 'none'
    }
    requestAnimationFrame(() => {
      try { entry.fit.fit() } catch { /* container hidden */ }
      entry.conn?.resize(entry.term.cols, entry.term.rows)
      entry.term.focus()
    })
    if (entry.status === 'detached') this.attach(entry)
    this.renderTabs()
  }

  /** Kill the PTY and dispose the local terminal. */
  closeSession(sessionId: string): void {
    const index = this.terminals.findIndex(item => item.session.id === sessionId)
    if (index === -1) return
    const [entry] = this.terminals.splice(index, 1)
    if (!entry.session.exited && entry.session.id !== '') void killSession(entry.session.id)
    this.detach(entry)
    entry.term.dispose()
    entry.wrap.remove()
    if (this.activeId === sessionId) {
      const fallback = this.terminals[this.terminals.length - 1]
      if (fallback !== undefined) this.activate(fallback.session.id)
      else this.activeId = undefined
    }
    this.renderTabs()
  }

  /** Keep the PTY size in sync with the rendered terminal. */
  private observeSize(entry: TerminalEntry): void {
    let lastCols = -1
    let lastRows = -1
    const sync = (): void => {
      if (!this.openStore.get() || entry.wrap.style.display === 'none') return
      try { entry.fit.fit() } catch { return }
      if (entry.term.cols !== lastCols || entry.term.rows !== lastRows) {
        lastCols = entry.term.cols
        lastRows = entry.term.rows
        entry.conn?.resize(lastCols, lastRows)
      }
    }
    window.addEventListener('resize', sync)
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => { sync() })
      observer.observe(entry.container)
    }
  }

  private showOverlay(entry: TerminalEntry, text: string, actionLabel?: string): void {
    entry.overlay.replaceChildren()
    entry.overlay.appendChild(document.createTextNode(text))
    if (actionLabel !== undefined) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dat-reconnect'
      button.textContent = actionLabel
      button.addEventListener('click', () => { this.attach(entry) })
      entry.overlay.appendChild(button)
    }
    entry.overlay.dataset.visible = ''
  }

  private hideOverlay(entry: TerminalEntry): void {
    delete entry.overlay.dataset.visible
  }
}

/** Escape one plain-text run for innerHTML contexts. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// panel + sidebar mounts
// ---------------------------------------------------------------------------

/**
 * Mount the panel view into the center column and bind its visibility to the
 * controller's open state (waits for the shell frame, self-heals on teardown).
 */
function mountPanel(controller: PanelController): () => void {
  const ensure = (): void => { controller.ensureView() }
  const waitObserver = new MutationObserver(ensure)
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if ((detail === 'taskboard' || detail === 'ssh') && controller.openStore.get()) controller.close()
  }
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.openStore.get()) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.openStore.subscribe(() => { controller.ensureView() })
  controller.ensureView()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
  }
}

/**
 * Mount the sidebar entry row (plain DOM, idempotent, self-healing on React
 * re-renders — same approach as the dsh-ssh / task-board rows).
 */
function mountSidebarEntry(controller: PanelController): () => void {
  if (document.querySelector(ENTRY_SELECTOR) !== null) return () => {}

  const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M4.5 5.5l2.5 2.5-2.5 2.5"/><path d="M8.5 10.5h3"/></svg>'
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute('data-dsh-agent-terminal-entry', '')
  entry.setAttribute('data-dsh-plugin', PANEL_NAME)
  entry.setAttribute('data-dsh-part', 'sidebar-entry')
  entry.className = 'dat-entry'
  entry.setAttribute('aria-label', '智能体终端')
  entry.setAttribute('title', '在真实终端中运行 claude code / hermes 等智能体')
  entry.innerHTML = `<span class="dat-entryIcon">${ICON}</span><span class="dat-entryLabel">智能体</span>`
  entry.addEventListener('click', () => { controller.toggle() })

  const sidebarRoot = (): HTMLElement | undefined => {
    const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
    if (column === null) return undefined
    const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
    return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
  }
  const newSessionButton = (root: HTMLElement): HTMLButtonElement | undefined =>
    root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
      ?? (Array.from(root.children).find(child => child.tagName === 'BUTTON') as HTMLButtonElement | undefined)

  let root: HTMLElement | undefined
  let placed = false
  const placeEntry = (): boolean => {
    if (root === undefined) return false
    const button = newSessionButton(root)
    if (button === undefined) return false
    if (entry.parentElement !== root) {
      const row = button.closest('[class*="logoRow"]')
      const base = row !== null && row.parentElement === root ? row : button
      const family = Array.from(root.children).filter(
        el => el instanceof HTMLElement
          && el.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-agent-terminal-entry]'),
      )
      const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling
      root.insertBefore(entry, anchor)
    }
    return true
  }
  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry()
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }
  const waitObserver = new MutationObserver(tryPlace)
  waitObserver.observe(document.body, { childList: true, subtree: true })
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = placeEntry()
  })

  const syncActive = (): void => {
    if (controller.openStore.get()) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribe = controller.openStore.subscribe(syncActive)
  syncActive()
  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribe()
    entry.remove()
  }
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

/** No ctx services are required — the client is pure DOM. */
export const inject: string[] = []

/**
 * Mount the sidebar entry and the center panel. DOM problems are logged,
 * never thrown: an external plugin must not take the GUI down.
 * @param ctx - client root context (unused beyond lifetime).
 */
export function apply(ctx: unknown): void {
  if (typeof document === 'undefined') return
  ensureCss()
  const controller = new PanelController()
  const disposers: Array<() => void> = []
  try {
    disposers.push(mountSidebarEntry(controller))
    disposers.push(mountPanel(controller))
  } catch (error) {
    console.warn('[dsh-agent-terminal] mount failed:', error)
  }
  const teardown = (): void => {
    for (const dispose of disposers.splice(0)) dispose()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
  }
  // cordis ctx.effect runs immediately and treats the return as disposer.
  const maybeCtx = ctx as { effect?: (fn: () => unknown) => unknown } | null
  if (typeof maybeCtx?.effect === 'function') {
    maybeCtx.effect(() => teardown)
  }
}

// ---------------------------------------------------------------------------
// stylesheet
// ---------------------------------------------------------------------------

const PANEL_CSS = `
[data-pane='conversation'], [class*='centerCol'] { position: relative; }
.dat-view {
  display: none;
  position: absolute;
  inset: 0;
  z-index: 8;
  flex-direction: column;
  background: var(--ds-color-bg-canvas, #10141b);
  color: var(--ds-color-text-primary, #d8dee9);
  font-family: var(--ds-font-family-sans, system-ui, -apple-system, sans-serif);
  overflow: hidden;
}
html[${ACTIVE_ATTR}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) ${VIEW_SELECTOR} { display: flex; }
html[${ACTIVE_ATTR}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-pane='conversation'] > :not(${VIEW_SELECTOR}),
html[${ACTIVE_ATTR}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [class*='centerCol'] > :not(${VIEW_SELECTOR}) {
  visibility: hidden;
}
.dat-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ds-color-border-subtle, #232a35);
  flex: none;
  flex-wrap: wrap;
}
.dat-title { font-weight: 600; font-size: 14px; }
.dat-agents { display: flex; gap: 8px; flex-wrap: wrap; flex: 1; }
.dat-hint { font-size: 12px; opacity: 0.65; }
.dat-hint.dat-error { color: #e06c75; opacity: 1; }
.dat-chip {
  border: 1px solid var(--ds-color-border-subtle, #2c3542);
  background: var(--ds-color-bg-sunken, #171c26);
  color: inherit;
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
}
.dat-chip:hover:not(:disabled) { border-color: var(--ds-color-accent, #4f83cc); }
.dat-chip:disabled { opacity: 0.4; cursor: not-allowed; }
.dat-close {
  margin-left: auto;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 13px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
}
.dat-close:hover { background: var(--ds-color-bg-sunken, #1c222d); }
.dat-tabs {
  display: flex;
  gap: 6px;
  padding: 6px 14px 0;
  flex: none;
  overflow-x: auto;
  border-bottom: 1px solid var(--ds-color-border-subtle, #232a35);
}
.dat-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--ds-color-border-subtle, #2c3542);
  border-bottom: none;
  background: transparent;
  color: inherit;
  border-radius: 8px 8px 0 0;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.dat-tab[data-active] { background: var(--ds-color-bg-sunken, #171c26); border-color: var(--ds-color-accent, #4f83cc); }
.dat-tab[data-exited] { opacity: 0.55; }
.dat-dot { width: 7px; height: 7px; border-radius: 50%; background: #6b7686; flex: none; }
.dat-dot[data-status='attached'] { background: #46c07a; }
.dat-dot[data-status='connecting'] { background: #d9a53f; }
.dat-dot[data-status='detached'], .dat-dot[data-status='error'] { background: #e06c75; }
.dat-dot[data-status='exited'] { background: #555f6e; }
.dat-tabLabel { max-width: 12em; overflow: hidden; text-overflow: ellipsis; }
.dat-tabClose { opacity: 0.55; padding: 0 2px; }
.dat-tabClose:hover { opacity: 1; color: #e06c75; }
.dat-stack { position: relative; flex: 1; min-height: 0; }
.dat-termWrap { position: absolute; inset: 0; padding: 6px 10px 10px; }
.dat-term { width: 100%; height: 100%; }
.dat-term .xterm { height: 100%; }
.dat-overlay {
  display: none;
  position: absolute;
  inset: 0;
  z-index: 2;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(11, 14, 20, 0.82);
  font-size: 13px;
}
.dat-overlay[data-visible] { display: flex; }
.dat-reconnect {
  border: 1px solid var(--ds-color-accent, #4f83cc);
  background: transparent;
  color: inherit;
  border-radius: 6px;
  padding: 4px 14px;
  font-size: 12px;
  cursor: pointer;
}
.dat-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 13px;
  text-align: left;
  padding: 6px 12px;
  cursor: pointer;
  border-radius: 8px;
}
.dat-entry:hover { background: var(--ds-color-bg-sunken, rgba(127, 127, 127, 0.12)); }
.dat-entry[data-active] { background: var(--ds-color-bg-sunken, rgba(127, 127, 127, 0.18)); }
.dat-entryIcon { display: inline-flex; opacity: 0.8; }
.dat-entryLabel { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`
