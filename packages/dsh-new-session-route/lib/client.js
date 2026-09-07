/**
 * dsh-new-session-route — browser half (runs inside the dsh web GUI).
 *
 * Hooks the sidebar「新会话」(New Session) button. Instead of immediately
 * starting a session with the deployment default backend, it opens a small
 * dropdown offering the route for the NEXT session:
 *
 *   - 默认 DeepSeek Harness —— the original behaviour (ctx.workspaces.startSession)
 *   - Claude Code —— starts a blank session on the same workspace, then selects
 *     the `claude-code` provider (dsh-llm-agent-bridge spawns the local `claude`
 *     CLI, whose models are configured via ccswitch) as that session's model.
 *
 * Implementation notes
 * --------------------
 * - Cordis client plugin: `inject` pulls the services we need, `apply(ctx)`
 *   receives the client root context. We use `ctx.get("connection").api` for
 *   the wire API (`sessions.models` / `sessions.selectModel`) and
 *   `ctx.get("workspaces")` / `ctx.get("sessions")` for the runtime flow.
 * - The sidebar「新会话」button is rendered inside React (SidebarRoot) and has
 *   no slot we can inject into, so we hook it with plain DOM: a capture-phase
 *   listener on the button that stops propagation (blocking React's own
 *   `startSession`) and opens our dropdown instead. A MutationObserver
 *   re-arms the hook whenever the sidebar re-renders.
 * - The dropdown lives OUTSIDE the React tree (appended to document.body,
 *   position fixed), so it can never disturb the shell's reconciliation.
 *   Mount failures are logged, never thrown.
 *
 * Stable DOM hooks this relies on (from @deepseek-ai/dsh-client-ui-sidebar):
 *   button.hHd-Xa_newSession — the sidebar New Session button (hashed css class);
 *   its `aria-label` is the localized "新建会话" / "New session".
 */

window.__ModuleLoader__.load({
  id: 'dsh-new-session-route',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ------------------------------------------------------------------ config
    // The Claude Code route: dsh-llm-agent-bridge registers a `claude-code`
    // provider that spawns the local `claude` CLI (models via ccswitch).
    const CLAUDE_PROVIDER = 'claude-code'
    const CLAUDE_MODEL_FALLBACK = 'default'

    // ---------------------------------------------------------------- selectors
    // Match the sidebar New Session button by its stable attributes: the
    // localized aria-label AND the visible label text ("新会话" / "New Session").
    const NEW_SESSION_LABELS = ['新会话', 'New Session', '新建会话', 'New session']

    // ------------------------------------------------------------------- state
    let ctx = null
    let menuEl = null
    let backdropEl = null
    let hookedButtons = new WeakSet()

    // ---------------------------------------------------------------- helpers
    function isNewSessionButton(el) {
      if (!(el instanceof HTMLElement) || el.tagName !== 'BUTTON') return false
      const label = (el.getAttribute('aria-label') || '').trim()
      const text = (el.textContent || '').trim()
      return (
        (NEW_SESSION_LABELS.includes(label) || NEW_SESSION_LABELS.includes(text)) &&
        // exclude the brand wordmark button (same aria-label, no text) and any
        // button that already carries our marker
        (text.length > 0 || el.querySelector('svg,img') === null)
      )
    }

    /** Re-arm the capture listener on the current sidebar New Session button. */
    function ensureHook() {
      const buttons = document.querySelectorAll('button')
      for (const button of buttons) {
        if (!isNewSessionButton(button)) continue
        if (hookedButtons.has(button)) continue
        button.addEventListener('click', onNewSessionClick, true)
        hookedButtons.add(button)
      }
    }

    /** Capture-phase click: block React's startSession, open the route menu. */
    function onNewSessionClick(event) {
      event.preventDefault()
      event.stopPropagation()
      const button = event.currentTarget
      openMenu(button)
    }

    // ------------------------------------------------------------------- menu
    function openMenu(anchor) {
      closeMenu()
      const rect = anchor.getBoundingClientRect()

      backdropEl = document.createElement('div')
      backdropEl.dataset.dshNewSessionRoute = 'backdrop'
      backdropEl.addEventListener('click', closeMenu, true)

      menuEl = document.createElement('div')
      menuEl.dataset.dshNewSessionRoute = 'menu'

      const row = (title, desc, onClick) => {
        const item = document.createElement('button')
        item.type = 'button'
        item.dataset.dshNewSessionRoute = 'item'
        const name = document.createElement('span')
        name.dataset.dshNewSessionRoute = 'name'
        name.textContent = title
        const sub = document.createElement('span')
        sub.dataset.dshNewSessionRoute = 'desc'
        sub.textContent = desc
        item.appendChild(name)
        item.appendChild(sub)
        item.addEventListener('click', () => {
          closeMenu()
          onClick()
        })
        return item
      }

      menuEl.appendChild(row('默认 DeepSeek Harness', '当前默认后端', () => {
        if (ctx === null) return
        ctx.get('workspaces').startSession()
      }))
      menuEl.appendChild(row('Claude Code', '拉起本机 claude CLI（模型由 ccswitch 配置）', () => {
        void startClaudeCodeSession()
      }))

      document.body.appendChild(backdropEl)
      document.body.appendChild(menuEl)

      // position under the anchor, flush with its left edge; flip up if low.
      const menuW = menuEl.offsetWidth
      const menuH = menuEl.offsetHeight
      let left = rect.left
      if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8
      if (left < 8) left = 8
      let top = rect.bottom + 6
      if (top + menuH > window.innerHeight - 8) top = rect.top - menuH - 6
      menuEl.style.left = `${Math.round(left)}px`
      menuEl.style.top = `${Math.round(top)}px`
    }

    function closeMenu() {
      if (backdropEl !== null) {
        backdropEl.remove()
        backdropEl = null
      }
      if (menuEl !== null) {
        menuEl.remove()
        menuEl = null
      }
    }

    // -------------------------------------------------------------- claude code
    /**
     * Start a new session on the current/default workspace and route its model
     * to the dst-gateway (Claude Code) provider. Reuses a blank session exactly
     * like the default flow, then selects the gateway's first advertised model.
     */
    async function startClaudeCodeSession() {
      if (ctx === null) return
      const workspaces = ctx.get('workspaces')
      const sessions = ctx.get('sessions')
      const api = ctx.get('connection').api

      // Resolve the target workspace the same way startSession() does.
      const wsState = workspaces.list.getSnapshot()
      const current = sessions.list.getSnapshot().current
      const currentWorkspaceId =
        current === undefined
          ? undefined
          : wsState.items.find((item) => item.sessionIds.includes(current))?.workspaceId
      const target = currentWorkspaceId ?? wsState.recentWorkspaceId
      if (target === undefined) {
        sessions.clear()
        return
      }

      // Connect (reuse blank session or create one) — same as default flow.
      let sessionId
      try {
        sessionId = await workspaces.connectWorkspace(target)
      } catch (error) {
        console.warn('[dsh-new-session-route] connect failed:', error)
        return
      }

      // Discover the gateway's model from the live catalog, fall back to default.
      let provider = CLAUDE_PROVIDER
      let model = CLAUDE_MODEL_FALLBACK
      try {
        const { result } = await api.sessions.models({ sessionId })
        if (result.ok) {
          const group = result.value.groups.find((g) => g.id === CLAUDE_PROVIDER)
          if (group !== undefined && group.models.length > 0) {
            model = group.models[0].id
          }
        }
      } catch (error) {
        console.warn('[dsh-new-session-route] model discovery failed, using default:', error)
      }

      try {
        const { result } = await api.sessions.selectModel({
          sessionId,
          provider,
          model,
        })
        if (!result.ok) {
          throw new Error(`${result.error.code}: ${result.error.message}`)
        }
        sessions.open(sessionId)
      } catch (error) {
        console.warn('[dsh-new-session-route] selectModel failed:', error)
      }
    }

    // ------------------------------------------------------------------ styles
    function ensureStyles() {
      if (document.getElementById('dsh-new-session-route-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-new-session-route-styles'
      style.setAttribute('data-plugin', 'dsh-new-session-route')
      style.textContent = `
[data-dsh-new-session-route="backdrop"] {
  position: fixed;
  inset: 0;
  z-index: 9990;
  background: transparent;
}
[data-dsh-new-session-route="menu"] {
  position: fixed;
  z-index: 9991;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border-radius: 12px;
  /* theme-aware: official menu surface token; falls back through the layer
     ladder so body[data-ds-dark-theme] switches it automatically. */
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #fff));
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12));
  box-shadow: 0 8px 28px rgba(0,0,0,0.18);
}
[data-dsh-new-session-route="item"] {
  all: unset;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}
[data-dsh-new-session-route="item"]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
}
[data-dsh-new-session-route="name"] {
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
[data-dsh-new-session-route="desc"] {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #666);
}
`
      document.head.appendChild(style)
    }

    // ------------------------------------------------------------------ apply
    function apply(clientCtx) {
      try {
        ctx = clientCtx
        ensureStyles()
        ensureHook()

        // Self-heal: re-arm the hook when the sidebar re-renders.
        const observer = new MutationObserver(() => {
          ensureHook()
        })
        observer.observe(document.body, { childList: true, subtree: true })

        clientCtx.effect(() => () => {
          observer.disconnect()
          closeMenu()
          ctx = null
        }, 'dsh-new-session-route: hook')
      } catch (error) {
        console.warn('[dsh-new-session-route] mount failed:', error)
      }
    }

    exports.apply = apply
    exports.inject = ['connection', 'sessions', 'workspaces', 'locale']
    return module.exports
  },
})
