window.__ModuleLoader__.load({
  id: 'dsh-cc-agent-driver',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // Keep the Client descriptor self-contained. The DSH module loader does
    // not expose zod as a shared browser module, while Typert only requires a
    // synchronous parse() boundary for a strict codec.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    const workspaceIdSchema = {
      parse(value) {
        if (typeof value !== 'string' || value.length === 0) throw new TypeError('cc-agent-driver: invalid workspaceId')
        return value
      },
    }
    const createSessionResultSchema = {
      parse(value) {
        if (value === null || typeof value !== 'object' || !uuid.test(value.sessionId)) {
          throw new TypeError('cc-agent-driver: invalid createSession result')
        }
        return { sessionId: value.sessionId }
      },
    }
    const contribution = {
      package: 'dsh-cc-agent-driver',
      descriptors: [{
        id: 'dsh-cc-agent-driver#ccNative/createSession',
        service: 'ccNative',
        namespace: 'ccNative',
        method: 'createSession',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'workspaceId', wire: 'workspaceId', source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-cc-agent-driver#WorkspaceId', schema: workspaceIdSchema },
        }],
        result: {
          mode: 'strict', typeSymbol: 'dsh-cc-agent-driver#CreateSessionResult',
          schema: createSessionResultSchema,
        },
        sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
      }],
    }

    const NEW_SESSION_LABELS = ['新会话', 'New Session', '新建会话', 'New session']
    let ctx = null
    let ccNative = null
    let menu = null
    let backdrop = null
    let notice = null
    let creating = false

    function isNewSessionButton(element) {
      if (!(element instanceof HTMLElement) || element.tagName !== 'BUTTON') return false
      const label = (element.getAttribute('aria-label') || '').trim()
      const text = (element.textContent || '').trim()
      return NEW_SESSION_LABELS.includes(label) || NEW_SESSION_LABELS.includes(text)
    }

    function onNewSessionClick(event) {
      const button = event.target instanceof Element ? event.target.closest('button') : null
      if (!isNewSessionButton(button)) return
      event.preventDefault()
      // React's delegation can attach at document. Window capture runs before
      // that boundary, so it can suppress the built-in startSession before it
      // creates a default session.
      event.stopImmediatePropagation()
      openMenu(button)
    }

    function closeMenu() {
      backdrop?.remove()
      menu?.remove()
      backdrop = null
      menu = null
      notice = null
      creating = false
    }

    function setNotice(message, isError = false) {
      if (notice === null) return
      notice.textContent = message
      notice.dataset.error = isError ? 'true' : 'false'
    }

    function button(title, description, onClick) {
      const item = document.createElement('button')
      item.type = 'button'
      item.dataset.ccDriver = 'item'
      const name = document.createElement('span')
      name.dataset.ccDriver = 'name'
      name.textContent = title
      const detail = document.createElement('span')
      detail.dataset.ccDriver = 'description'
      detail.textContent = description
      item.append(name, detail)
      item.addEventListener('click', () => { void onClick() })
      return item
    }

    function openMenu(anchor) {
      closeMenu()
      const rect = anchor.getBoundingClientRect()
      backdrop = document.createElement('div')
      backdrop.dataset.ccDriver = 'backdrop'
      backdrop.addEventListener('click', closeMenu, true)

      menu = document.createElement('div')
      menu.dataset.ccDriver = 'menu'
      menu.setAttribute('role', 'dialog')
      menu.setAttribute('aria-label', '选择新会话类型')
      menu.append(
        button('默认 DeepSeek Harness', '使用当前默认模型', createHarnessSession),
        button('Claude Code（原生会话）', '本机 Claude CLI；默认只读工具和安全模式', createNativeSession),
      )
      notice = document.createElement('div')
      notice.dataset.ccDriver = 'notice'
      notice.textContent = ccNative === null ? '正在连接原生会话服务…' : ''
      menu.append(notice)
      document.body.append(backdrop, menu)

      const menuWidth = menu.offsetWidth
      const menuHeight = menu.offsetHeight
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8))
      const top = rect.bottom + menuHeight + 8 > window.innerHeight ? rect.top - menuHeight - 6 : rect.bottom + 6
      menu.style.left = `${Math.round(left)}px`
      menu.style.top = `${Math.round(Math.max(8, top))}px`
    }

    function workspaceId() {
      if (ctx === null) return undefined
      const workspaces = ctx.get('workspaces')
      const sessions = ctx.get('sessions')
      const workspaceState = workspaces.list.getSnapshot()
      const currentSession = sessions.list.getSnapshot().current
      const currentWorkspace = currentSession === undefined
        ? undefined
        : workspaceState.items.find((item) => item.sessionIds.includes(currentSession))?.workspaceId
      return currentWorkspace ?? workspaceState.recentWorkspaceId
    }

    async function createHarnessSession() {
      if (creating || ctx === null) return
      const target = workspaceId()
      if (target === undefined) {
        ctx.get('sessions').clear()
        closeMenu()
        return
      }
      creating = true
      setNotice('正在创建 DeepSeek Harness 会话…')
      try {
        // workspaces.startSession() reuses *any* blank session in the same
        // workspace. A native blank session must not be adopted as a standard
        // loop, so explicitly create the normal Session + Agent instead.
        const sessionId = await ctx.get('sessions').create({ workspaceId: target })
        ctx.get('sessions').open(sessionId)
        closeMenu()
      } catch (error) {
        creating = false
        setNotice(`创建失败：${error instanceof Error ? error.message : String(error)}`, true)
        console.warn('[dsh-cc-agent-driver] create Harness session failed:', error)
      }
    }

    async function createNativeSession() {
      if (creating) return
      if (ctx === null || ccNative === null) {
        setNotice('原生会话服务尚未就绪，请稍候重试。', true)
        return
      }
      const target = workspaceId()
      if (target === undefined) {
        setNotice('请先选择或添加一个工作区。', true)
        return
      }
      creating = true
      setNotice('正在创建 Claude Code 原生会话…')
      try {
        const created = await ccNative.createSession(target)
        if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`)
        // The Host seeds this session's request header with the native route.
        // Calling generic selectModel here would overwrite DSH's persisted
        // global default and affect later default Harness sessions.
        ctx.get('sessions').open(created.value.sessionId)
        closeMenu()
      } catch (error) {
        creating = false
        setNotice(`创建失败：${error instanceof Error ? error.message : String(error)}`, true)
        console.warn('[dsh-cc-agent-driver] create native session failed:', error)
      }
    }

    function ensureStyles() {
      if (document.getElementById('dsh-cc-agent-driver-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-cc-agent-driver-styles'
      style.dataset.plugin = 'dsh-cc-agent-driver'
      style.textContent = `
[data-cc-driver="backdrop"] { position: fixed; inset: 0; z-index: 9990; background: transparent; }
[data-cc-driver="menu"] { position: fixed; z-index: 9991; min-width: 248px; display: flex; flex-direction: column; gap: 2px; padding: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 10px; background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 8px 24px rgba(0,0,0,.16); }
[data-cc-driver="item"] { all: unset; display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 7px; cursor: pointer; text-align: left; }
[data-cc-driver="item"]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
[data-cc-driver="name"] { color: var(--dsw-alias-label-primary, #1a1a1a); font-size: 14px; font-weight: 500; line-height: 20px; }
[data-cc-driver="description"], [data-cc-driver="notice"] { color: var(--dsw-alias-label-secondary, #666); font-size: 12px; line-height: 17px; }
[data-cc-driver="notice"] { min-height: 0; padding: 2px 10px 4px; }
[data-cc-driver="notice"]:empty { display: none; }
[data-cc-driver="notice"][data-error="true"] { color: var(--dsw-alias-state-error-primary, #b42318); }
`
      document.head.appendChild(style)
    }

    async function apply(clientCtx) {
      ctx = clientCtx
      if (typeof document !== 'undefined') {
        ensureStyles()
        window.addEventListener('click', onNewSessionClick, true)
        clientCtx.effect(() => () => {
          window.removeEventListener('click', onNewSessionClick, true)
          closeMenu()
          ctx = null
        }, 'cc-agent-driver: new session menu capture')
      }
      clientCtx.effect(async () => {
        const dispose = await clientCtx.remote.$mount(contribution)
        ccNative = clientCtx.reflect.get('remote.ccNative') ?? null
        if (ccNative === null) throw new Error('cc-agent-driver: ccNative Remote namespace did not mount')
        if (notice !== null) setNotice('')
        return () => {
          ccNative = null
          void dispose()
        }
      }, 'cc-agent-driver: Remote')
    }

    return { inject: ['connection', 'remote', 'sessions', 'workspaces'], apply }
  },
})
