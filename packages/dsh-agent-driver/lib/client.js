window.__ModuleLoader__.load({
  id: 'dsh-agent-driver',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement

    // Keep the Client descriptor self-contained. The DSH module loader does
    // not expose zod as a shared browser module, while Typert only requires a
    // synchronous parse() boundary for a strict codec.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    const workspaceIdSchema = {
      parse(value) {
        if (typeof value !== 'string' || value.length === 0) throw new TypeError('agent-driver: invalid workspaceId')
        return value
      },
    }
    const createSessionResultSchema = {
      parse(value) {
        if (value === null || typeof value !== 'object' || !uuid.test(value.sessionId)) {
          throw new TypeError('agent-driver: invalid createSession result')
        }
        return { sessionId: value.sessionId }
      },
    }
    const permissionModes = ['plan', 'acceptEdits', 'auto']
    const sessionIdSchema = {
      parse(value) {
        if (typeof value !== 'string' || !uuid.test(value)) throw new TypeError('agent-driver: invalid sessionId')
        return value
      },
    }
    const permissionModeSchema = {
      parse(value) {
        if (!permissionModes.includes(value)) throw new TypeError('agent-driver: invalid permissionMode')
        return value
      },
    }
    const permissionStateResultSchema = {
      parse(value) {
        if (value === null || typeof value !== 'object') throw new TypeError('agent-driver: invalid permission state result')
        const permissionMode = permissionModeSchema.parse(value.permissionMode)
        if (value.effectivePermissionMode !== undefined && typeof value.effectivePermissionMode !== 'string') {
          throw new TypeError('agent-driver: invalid permission state result')
        }
        return value.effectivePermissionMode === undefined ? { permissionMode } : { permissionMode, effectivePermissionMode: value.effectivePermissionMode }
      },
    }
    const contribution = {
      package: 'dsh-agent-driver',
      descriptors: [{
        id: 'dsh-agent-driver#nativeAgent/createSession',
        service: 'nativeAgent',
        namespace: 'nativeAgent',
        method: 'createSession',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'workspaceId', wire: 'workspaceId', source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#WorkspaceId', schema: workspaceIdSchema },
        }],
        result: {
          mode: 'strict', typeSymbol: 'dsh-agent-driver#CreateSessionResult',
          schema: createSessionResultSchema,
        },
        sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
      }, {
        id: 'dsh-agent-driver#nativeAgent/getPermission',
        service: 'nativeAgent', namespace: 'nativeAgent', method: 'getPermission', invocation: { kind: 'direct' },
        parameters: [{
          name: 'sessionId', wire: 'sessionId', source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#SessionId', schema: sessionIdSchema },
        }],
        result: {
          mode: 'strict', typeSymbol: 'dsh-agent-driver#PermissionStateResult', schema: permissionStateResultSchema,
        },
        sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
      }, {
        id: 'dsh-agent-driver#nativeAgent/setPermission',
        service: 'nativeAgent', namespace: 'nativeAgent', method: 'setPermission', invocation: { kind: 'direct' },
        parameters: [{
          name: 'sessionId', wire: 'sessionId', source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#SessionId', schema: sessionIdSchema },
        }, {
          name: 'permissionMode', wire: 'permissionMode', source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#PermissionMode', schema: permissionModeSchema },
        }],
        result: {
          mode: 'strict', typeSymbol: 'dsh-agent-driver#PermissionStateResult', schema: permissionStateResultSchema,
        },
        sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
      }],
    }

    const NEW_SESSION_LABELS = ['新会话', 'New Session', '新建会话', 'New session']
    let ctx = null
    let nativeAgent = null
    let menu = null
    let backdrop = null
    let notice = null
    let creating = false
    let permissionSlotRegistered = false
    let unobserveNativeSession = null
    let nativeSessionProbe = 0

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
      item.dataset.agentDriver = 'item'
      const name = document.createElement('span')
      name.dataset.agentDriver = 'name'
      name.textContent = title
      const detail = document.createElement('span')
      detail.dataset.agentDriver = 'description'
      detail.textContent = description
      item.append(name, detail)
      item.addEventListener('click', () => { void onClick() })
      return item
    }

    function openMenu(anchor) {
      closeMenu()
      const rect = anchor.getBoundingClientRect()
      backdrop = document.createElement('div')
      backdrop.dataset.agentDriver = 'backdrop'
      backdrop.addEventListener('click', closeMenu, true)

      menu = document.createElement('div')
      menu.dataset.agentDriver = 'menu'
      menu.setAttribute('role', 'dialog')
      menu.setAttribute('aria-label', '选择新会话类型')
      menu.append(
        button('默认 DeepSeek Harness', '使用当前默认模型', createHarnessSession),
        button('Claude Code（原生会话）', '本机 Claude CLI；默认只读工具和安全模式', createNativeSession),
      )
      notice = document.createElement('div')
      notice.dataset.agentDriver = 'notice'
      notice.textContent = nativeAgent === null ? '正在连接原生会话服务…' : ''
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
        console.warn('[dsh-agent-driver] create Harness session failed:', error)
      }
    }

    async function createNativeSession() {
      if (creating) return
      if (ctx === null || nativeAgent === null) {
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
        const created = await nativeAgent.createSession(target)
        if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`)
        // The Host seeds this session's request header with the native route.
        // Calling generic selectModel here would overwrite DSH's persisted
        // global default and affect later default Harness sessions.
        ctx.get('sessions').open(created.value.sessionId)
        closeMenu()
      } catch (error) {
        creating = false
        setNotice(`创建失败：${error instanceof Error ? error.message : String(error)}`, true)
        console.warn('[dsh-agent-driver] create native session failed:', error)
      }
    }

    const PERMISSION_OPTIONS = Object.freeze({
      plan: {
        label: '计划',
        description: '仅分析和读取；修改前请切换权限。',
      },
      acceptEdits: {
        label: '自动编辑',
        description: '允许工作区文件修改；Git 提交和推送仍可能被拒绝。',
      },
      auto: {
        label: '自动',
        description: '由 Claude 的安全分类器自动决定是否执行。',
      },
    })

    function remoteValue(result) {
      if (result?.ok === true) return result.value
      if (result?.ok === false) throw new Error(`${result.error?.code ?? 'REMOTE'}: ${result.error?.message ?? '请求失败'}`)
      return result
    }

    async function getPermissionState(sessionId) {
      if (nativeAgent === null) throw new Error('原生会话服务尚未就绪')
      return remoteValue(await nativeAgent.getPermission(sessionId))
    }

    async function setPermissionState(sessionId, permissionMode) {
      if (nativeAgent === null) throw new Error('原生会话服务尚未就绪')
      return remoteValue(await nativeAgent.setPermission(sessionId, permissionMode))
    }

    function NativePermissionSelect({ session }) {
      const sessionId = session?.sessionId
      const [state, setState] = React.useState(undefined)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        let active = true
        setOpen(false)
        setError('')
        setState(undefined)
        if (typeof sessionId !== 'string') return () => { active = false }
        void getPermissionState(sessionId).then((next) => {
          if (active) setState(next)
        }).catch(() => {
          // 非 Claude 原生会话也会渲染这个官方 list slot；没有 driver
          // ownership 时 Host 会拒绝查询，此处安静地不渲染任何控件。
          if (active) setState(null)
        })
        return () => { active = false }
      }, [sessionId])

      if (state === undefined || state === null || typeof sessionId !== 'string') return null
      const option = PERMISSION_OPTIONS[state.permissionMode]
      if (option === undefined) return null
      const effective = state.effectivePermissionMode
      const title = effective !== undefined && effective !== state.permissionMode
        ? `${option.description} 当前 CLI 生效模式：${effective}。`
        : option.description
      const choose = async (permissionMode) => {
        if (busy || permissionMode === state.permissionMode) {
          setOpen(false)
          return
        }
        setBusy(true)
        setError('')
        try {
          const next = await setPermissionState(sessionId, permissionMode)
          setState(next)
          setOpen(false)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'dsh-agent-permission', 'data-mode': state.permissionMode },
        h('button', {
          type: 'button',
          className: 'dsh-agent-permissionTrigger',
          'aria-label': `Claude Code 权限，当前：${option.label}`,
          title,
          disabled: busy,
          onClick: () => setOpen(!open),
        }, h('span', { 'aria-hidden': true, className: 'dsh-agent-permissionIcon' }, '⌁'), h('span', null, option.label), h('span', { 'aria-hidden': true, className: 'dsh-agent-permissionChevron' }, open ? '⌃' : '⌄')),
        open ? h('div', { className: 'dsh-agent-permissionPopover', role: 'dialog', 'aria-label': '选择 Claude Code 权限' },
          permissionModes.map((permissionMode) => {
            const item = PERMISSION_OPTIONS[permissionMode]
            return h('button', {
              key: permissionMode,
              type: 'button',
              className: 'dsh-agent-permissionOption',
              'data-current': permissionMode === state.permissionMode ? 'true' : 'false',
              disabled: busy,
              onClick: () => { void choose(permissionMode) },
            }, h('span', { className: 'dsh-agent-permissionOptionName' }, item.label), h('span', { className: 'dsh-agent-permissionOptionDesc' }, item.description))
          }),
          error === '' ? null : h('div', { className: 'dsh-agent-permissionError', role: 'alert' }, error),
        ) : null,
      )
    }

    function syncNativeAccessMode() {
      const ticket = ++nativeSessionProbe
      const root = document.body
      const sessionId = ctx?.get('sessions').list.getSnapshot().current
      if (typeof sessionId !== 'string' || nativeAgent === null) {
        delete root.dataset.nativeAgentAccess
        return
      }
      void getPermissionState(sessionId).then(() => {
        if (ticket === nativeSessionProbe) root.dataset.nativeAgentAccess = 'true'
      }).catch(() => {
        if (ticket === nativeSessionProbe) delete root.dataset.nativeAgentAccess
      })
    }

    function registerPermissionControl(clientCtx) {
      if (permissionSlotRegistered || clientCtx.slots === undefined) return
      permissionSlotRegistered = true
      clientCtx.slots.inject('conversation.input.left', () => clientCtx.slots.register({
        name: 'conversation.input.left',
        id: 'claude-code-permission',
        order: -100,
      }, NativePermissionSelect))
    }

    function ensureStyles() {
      if (document.getElementById('dsh-agent-driver-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-agent-driver-styles'
      style.dataset.plugin = 'dsh-agent-driver'
      style.textContent = `
[data-agent-driver="backdrop"] { position: fixed; inset: 0; z-index: 9990; background: transparent; }
[data-agent-driver="menu"] { position: fixed; z-index: 9991; min-width: 248px; display: flex; flex-direction: column; gap: 2px; padding: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 10px; background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 8px 24px rgba(0,0,0,.16); }
[data-agent-driver="item"] { all: unset; display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 7px; cursor: pointer; text-align: left; }
[data-agent-driver="item"]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
[data-agent-driver="name"] { color: var(--dsw-alias-label-primary, #1a1a1a); font-size: 14px; font-weight: 500; line-height: 20px; }
[data-agent-driver="description"], [data-agent-driver="notice"] { color: var(--dsw-alias-label-secondary, #666); font-size: 12px; line-height: 17px; }
[data-agent-driver="notice"] { min-height: 0; padding: 2px 10px 4px; }
[data-agent-driver="notice"]:empty { display: none; }
[data-agent-driver="notice"][data-error="true"] { color: var(--dsw-alias-state-error-primary, #b42318); }
/* DSH rc.6 没有 provider 专属 access-mode 插槽。原始控件在原生会话中
   仅代表 DSH sandbox，保留会造成误导；此兼容规则只隐藏它，新控件本身
   通过 conversation.input.left 的官方 slot 注册。 */
body[data-native-agent-access="true"] button[aria-label*="访问模式"],
body[data-native-agent-access="true"] button[aria-label*="Access mode"] { display: none !important; }
.dsh-agent-permission { position: relative; display: inline-flex; align-items: center; min-width: 0; }
.dsh-agent-permissionTrigger { min-width: 0; max-width: 220px; height: 28px; display: inline-flex; align-items: center; gap: 4px; padding: 0 4px 0 8px; border: 0; border-radius: 24px; outline: none; background: transparent; color: var(--dsw-alias-label-secondary, #666); font: 500 13px/20px inherit; cursor: pointer; }
.dsh-agent-permissionTrigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
.dsh-agent-permissionTrigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3, rgba(0,0,0,.18)); }
.dsh-agent-permissionTrigger:disabled { cursor: default; opacity: .62; }
.dsh-agent-permissionIcon { font-size: 16px; line-height: 1; transform: rotate(-25deg); }
.dsh-agent-permissionChevron { color: var(--dsw-alias-label-caption, #8a8a8a); font-size: 14px; line-height: 1; }
.dsh-agent-permissionPopover { position: absolute; z-index: 50; left: 0; bottom: calc(100% + 8px); width: min(300px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 2px; padding: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 10px; background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 8px 24px rgba(0,0,0,.16); }
.dsh-agent-permissionOption { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-primary, #1a1a1a); font: inherit; text-align: left; cursor: pointer; }
.dsh-agent-permissionOption:hover:not(:disabled), .dsh-agent-permissionOption[data-current="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
.dsh-agent-permissionOption:disabled { cursor: default; opacity: .62; }
.dsh-agent-permissionOptionName { font-size: 14px; font-weight: 600; line-height: 20px; }
.dsh-agent-permissionOptionDesc { color: var(--dsw-alias-label-secondary, #666); font-size: 12px; line-height: 17px; }
.dsh-agent-permissionError { padding: 4px 10px 2px; color: var(--dsw-alias-state-error-primary, #b42318); font-size: 12px; line-height: 17px; }
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
        }, 'agent-driver: new session menu capture')
      }
      clientCtx.effect(async () => {
        const dispose = await clientCtx.remote.$mount(contribution)
        nativeAgent = clientCtx.reflect.get('remote.nativeAgent') ?? null
        if (nativeAgent === null) throw new Error('agent-driver: nativeAgent Remote namespace did not mount')
        if (notice !== null) setNotice('')
        if (typeof document !== 'undefined') {
          registerPermissionControl(clientCtx)
          const sessions = clientCtx.get('sessions')
          unobserveNativeSession = sessions.list.subscribe(syncNativeAccessMode)
          syncNativeAccessMode()
        }
        return () => {
          unobserveNativeSession?.()
          unobserveNativeSession = null
          if (typeof document !== 'undefined') delete document.body.dataset.nativeAgentAccess
          permissionSlotRegistered = false
          nativeAgent = null
          void dispose()
        }
      }, 'agent-driver: Remote')
    }

    return { inject: ['connection', 'remote', 'sessions', 'workspaces', 'slots'], apply }
  },
})
