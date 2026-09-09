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
    const permissionModes = ['plan', 'acceptEdits', 'auto', 'default', 'yolo']
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
        if (value.model !== undefined && typeof value.model !== 'string') {
          throw new TypeError('agent-driver: invalid permission state result')
        }
        const base = value.effectivePermissionMode === undefined
          ? { permissionMode }
          : { permissionMode, effectivePermissionMode: value.effectivePermissionMode }
        return value.model === undefined ? base : { ...base, model: value.model }
      },
    }
    // Hermes 原生驱动复用同一套契约，只是挂在 hermesAgent 命名空间。
    const hermesDescriptors = [{
      id: 'dsh-agent-driver#hermesAgent/createSession',
      service: 'hermesAgent', namespace: 'hermesAgent', method: 'createSession', invocation: { kind: 'direct' },
      parameters: [{
        name: 'workspaceId', wire: 'workspaceId', source: 'json',
        codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#WorkspaceId', schema: workspaceIdSchema },
      }],
      result: {
        mode: 'strict', typeSymbol: 'dsh-agent-driver#CreateSessionResult', schema: createSessionResultSchema,
      },
      sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
    }, {
      id: 'dsh-agent-driver#hermesAgent/getPermission',
      service: 'hermesAgent', namespace: 'hermesAgent', method: 'getPermission', invocation: { kind: 'direct' },
      parameters: [{
        name: 'sessionId', wire: 'sessionId', source: 'json',
        codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#SessionId', schema: sessionIdSchema },
      }],
      result: {
        mode: 'strict', typeSymbol: 'dsh-agent-driver#PermissionStateResult', schema: permissionStateResultSchema,
      },
      sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
    }, {
      id: 'dsh-agent-driver#hermesAgent/setPermission',
      service: 'hermesAgent', namespace: 'hermesAgent', method: 'setPermission', invocation: { kind: 'direct' },
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
    }]
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
      }, ...hermesDescriptors],
    }

    const modelIdSchema = { parse(value) {
      if (typeof value !== 'string' || !value.trim()) throw new TypeError('agent-driver: invalid modelId')
      return value
    } }
    const modelListSchema = { parse(value) {
      if (!Array.isArray(value)) throw new TypeError('agent-driver: invalid model list')
      return value.map((item) => {
        if (!item || typeof item.label !== 'string' || typeof item.description !== 'string') throw new TypeError('agent-driver: invalid model option')
        for (const key of ['providerId', 'providerLabel']) {
          if (item[key] !== undefined && typeof item[key] !== 'string') throw new TypeError('agent-driver: invalid model provider')
        }
        if (item.current !== undefined && typeof item.current !== 'boolean') throw new TypeError('agent-driver: invalid current model')
        return { id: modelIdSchema.parse(item.id), label: item.label, description: item.description,
          ...(item.providerId === undefined ? {} : { providerId: item.providerId }),
          ...(item.providerLabel === undefined ? {} : { providerLabel: item.providerLabel }),
          ...(item.current === undefined ? {} : { current: item.current }),
        }
      })
    } }
    for (const service of ['nativeAgent', 'hermesAgent']) {
      for (const method of ['getModels', 'setModel']) {
        contribution.descriptors.push({
          id: `dsh-agent-driver#${service}/${method}`, service, namespace: service, method, invocation: { kind: 'direct' },
          parameters: [
            { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#SessionId', schema: sessionIdSchema } },
            ...(method === 'setModel' ? [{ name: 'modelId', wire: 'modelId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#ModelId', schema: modelIdSchema } }] : []),
          ],
          result: { mode: 'strict', typeSymbol: method === 'getModels' ? 'dsh-agent-driver#ModelList' : 'dsh-agent-driver#PermissionStateResult', schema: method === 'getModels' ? modelListSchema : permissionStateResultSchema },
          sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
        })
      }
    }

    const NEW_SESSION_LABELS = ['新会话', 'New Session', '新建会话', 'New session']
    let ctx = null
    let nativeAgent = null
    let hermesAgent = null
    let menu = null
    let backdrop = null
    let notice = null
    let creating = false
    let permissionSlotRegistered = false
    let unobserveNativeSession = null
    let nativeSessionProbe = 0
    const nativeSessionIds = new Set()
    const permissionListeners = new Set()

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
        button('Claude Code（原生会话）', '本机 Claude CLI；默认只读工具和安全模式', () => createNativeSession(nativeAgent, 'Claude Code')),
        button('Hermes（原生会话）', '本机 Hermes CLI；ACP 流式输出，权限分安全/自动', () => createNativeSession(hermesAgent, 'Hermes')),
      )
      notice = document.createElement('div')
      notice.dataset.agentDriver = 'notice'
      notice.textContent = nativeAgent === null && hermesAgent === null ? '正在连接原生会话服务…' : ''
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

    async function createNativeSession(remote, agentLabel) {
      if (creating) return
      if (ctx === null || remote === null) {
        setNotice('原生会话服务尚未就绪，请稍候重试。', true)
        return
      }
      const target = workspaceId()
      if (target === undefined) {
        setNotice('请先选择或添加一个工作区。', true)
        return
      }
      creating = true
      setNotice(`正在创建 ${agentLabel} 原生会话…`)
      try {
        const created = await remote.createSession(target)
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

    // 各驱动的权限档位不同：Claude Code 用 plan/acceptEdits/auto，
    // Hermes 用 default（危险操作自动拒绝）/yolo（跳过审批）。
    const PERMISSION_OPTIONS = Object.freeze({
      claude: Object.freeze({
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
      }),
      hermes: Object.freeze({
        default: {
          label: '安全',
          description: '非交互运行时危险操作审批自动拒绝（fail-closed）。',
        },
        yolo: {
          label: '自动',
          description: '跳过 Hermes 的危险操作审批（--yolo），请谨慎使用。',
        },
      }),
    })

    function remoteValue(result) {
      if (result?.ok === true) return result.value
      if (result?.ok === false) throw new Error(`${result.error?.code ?? 'REMOTE'}: ${result.error?.message ?? '请求失败'}`)
      return result
    }

    async function getPermissionState(sessionId, strict = false) {
      // 同一会话只属于一个驱动；依次探测，记录归属以便 setPermission 走对网关。
      for (const [driver, remote] of [['claude', nativeAgent], ['hermes', hermesAgent]]) {
        if (remote === null) continue
        try {
          const state = remoteValue(await remote.getPermission(sessionId))
          nativeSessionIds.add(sessionId)
          return { driver, state }
        } catch (error) {
          // 命令路由不可把断线等错误当成普通会话，否则会误用 DSH 同名命令。
          if (strict && !String(error?.message).includes('is not a live native')) throw error
        }
      }
      throw Object.assign(new Error('会话不属于原生驱动'), { code: 'NOT_NATIVE_SESSION' })
    }

    async function setPermissionState(driver, sessionId, permissionMode) {
      const remote = driver === 'hermes' ? hermesAgent : nativeAgent
      if (remote === null) throw new Error('原生会话服务尚未就绪')
      return remoteValue(await remote.setPermission(sessionId, permissionMode))
    }

    async function selectNativeModel(sessionId, modelId) {
      const { driver } = await getPermissionState(sessionId, true)
      const remote = driver === 'hermes' ? hermesAgent : nativeAgent
      const state = remoteValue(await remote.setModel(sessionId, modelId))
      for (const listener of permissionListeners) listener(sessionId, { driver, state })
    }

    function NativePermissionSelect({ session }) {
      const sessionId = session?.sessionId
      const [state, setState] = React.useState(undefined)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const rootRef = React.useRef(null)

      // 点击控件外部或按 Esc 时自动收起浮层
      React.useEffect(() => {
        if (!open) return
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

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

      React.useEffect(() => {
        const listener = (id, next) => { if (id === sessionId) setState(next) }
        permissionListeners.add(listener)
        return () => permissionListeners.delete(listener)
      }, [sessionId])

      if (state === undefined || state === null || typeof sessionId !== 'string') return null
      const options = PERMISSION_OPTIONS[state.driver]
      if (options === undefined) return null
      const option = options[state.state.permissionMode]
      if (option === undefined) return null
      const effective = state.state.effectivePermissionMode
      const title = effective !== undefined && effective !== state.state.permissionMode
        ? `${option.description} 当前 CLI 生效模式：${effective}。`
        : option.description
      const choose = async (permissionMode) => {
        if (busy || permissionMode === state.state.permissionMode) {
          setOpen(false)
          return
        }
        setBusy(true)
        setError('')
        try {
          const next = await setPermissionState(state.driver, sessionId, permissionMode)
          setState({ driver: state.driver, state: next })
          setOpen(false)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { ref: rootRef, className: 'dsh-agent-permission', 'data-mode': state.state.permissionMode },
        state.state.model === undefined ? null : h('span', {
          className: 'dsh-agent-model',
          title: `${state.driver === 'hermes' ? 'Hermes' : 'Claude Code'} 当前实际使用的模型`,
        }, state.state.model),
        h('button', {
          type: 'button',
          className: 'dsh-agent-permissionTrigger',
          'aria-label': `原生会话权限，当前：${option.label}`,
          title,
          disabled: busy,
          onClick: () => setOpen(!open),
        }, h('span', { 'aria-hidden': true, className: 'dsh-agent-permissionIcon' }, '⌁'), h('span', null, option.label), h('span', { 'aria-hidden': true, className: 'dsh-agent-permissionChevron' }, open ? '⌃' : '⌄')),
        open ? h('div', { className: 'dsh-agent-permissionPopover', role: 'dialog', 'aria-label': '选择原生会话权限' },
          Object.keys(options).map((permissionMode) => {
            const item = options[permissionMode]
            return h('button', {
              key: permissionMode,
              type: 'button',
              className: 'dsh-agent-permissionOption',
              'data-current': permissionMode === state.state.permissionMode ? 'true' : 'false',
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

    function registerNativeCommands(clientCtx) {
      // rc.6 没有 provider 专属命令 UI：保留官方菜单、键盘和参数 claim，
      // 原生会话跳过 DSH 的客户端贡献及装饰器（尤其是同名 /model）。
      clientCtx.inject(['commandUi', 'sessions', 'remote', 'remote.commands'], (scope) => {
        const ui = scope.get('commandUi')
        const methods = ['candidates', 'dispatch', 'matchSpace', 'matchEnter']
        if (!ui?.live || methods.some((name) => typeof ui[name] !== 'function')) {
          console.warn('[dsh-agent-driver] 当前 DSH 命令 UI 不兼容，请升级插件适配。')
          return
        }
        const nativeUi = Object.create(ui)
        // 命令提交的闭包使用适配器作用域，显式声明其 Remote 依赖。
        nativeUi.ctx = scope
        nativeUi.live = { ...ui.live, contributions: new Map(), decorations: new Map() }
        const modelOption = (model) => ({ id: model.id, label: model.label, detail: model.description, active: model.current === true })
        const cancelOption = { id: 'navigation:cancel', label: '取消' }
        const navigatePicker = (session, spec) => {
          const actx = nativeUi.scopeFor(session.sessionId)
          if (!actx) throw new Error('当前会话已关闭')
          const controller = nativeUi.popupFor(actx)
          const binding = controller.binding
          if (!binding) return
          // 换绑定让官方控制器保留输入 token，直到真正选中模型才消费。
          controller.open('model', spec, session, binding.segment)
        }
        const providerSpec = (models) => {
          const groups = new Map()
          for (const model of models) {
            if (!groups.has(model.providerId)) groups.set(model.providerId, { label: model.providerLabel, models: [] })
            groups.get(model.providerId).models.push(model)
          }
          return {
            kind: 'popupSelect',
            options: async () => [...groups].map(([id, group]) => ({
              id, label: `${group.label}（${group.models.length} 个模型）`,
              detail: group.models.some((model) => model.current) ? '当前提供商' : '选择提供商',
              active: group.models.some((model) => model.current),
            })).concat(cancelOption),
            onSelect: async (option, session) => {
              if (option.id === cancelOption.id) { nativeUi.popupFor(nativeUi.scopeFor(session.sessionId)).dismiss(); return }
              const group = groups.get(option.id)
              if (!group) throw new Error('提供商目录已失效，请重新打开 /model')
              navigatePicker(session, {
                kind: 'popupSelect',
                options: async () => group.models.map((model) => ({ ...modelOption(model), detail: `${group.label} · ${model.current ? '当前模型' : model.label}` }))
                  .concat({ id: 'navigation:back', label: '← 返回提供商列表' }, cancelOption),
                onSelect: async (model, target) => {
                  if (model.id === 'navigation:back') { navigatePicker(target, providerSpec(models)); return }
                  if (model.id === cancelOption.id) { nativeUi.popupFor(nativeUi.scopeFor(target.sessionId)).dismiss(); return }
                  await selectNativeModel(target.sessionId, model.id)
                },
              })
            },
          }
        }
        const modelPicker = {
          kind: 'popupSelect',
          options: async (session, signal) => {
            const { driver } = await getPermissionState(session.sessionId, true)
            const remote = driver === 'hermes' ? hermesAgent : nativeAgent
            const models = remoteValue(await remote.getModels(session.sessionId))
            if (signal?.aborted) throw new Error('模型选择已取消')
            if (driver !== 'hermes') return models.map(modelOption)
            // 根列表的每个行携带同一目录快照，翻页不重新探测配置。
            const spec = providerSpec(models)
            return (await spec.options()).map((option) => ({ ...option, selectProvider: spec.onSelect }))
          },
          onSelect: (option, session) => option.selectProvider
            ? option.selectProvider(option, session) : selectNativeModel(session.sessionId, option.id),
        }
        nativeUi.live.decorations.set('model', { name: 'model', available: () => true, ui: modelPicker })
        // 空参数 claim（例如输入 /model 后空格再回车）也打开模型选择。
        const leadingClaim = ui.leadingClaim
        nativeUi.leadingClaim = function (desc, session) {
          const claim = leadingClaim.call(this, desc, session)
          if (desc.name !== 'model') return claim
          return { ...claim, submit: async (args, actx) => {
            if (args.trim()) {
              await selectNativeModel(session.sessionId, args.trim())
              return { kind: 'success' }
            }
            this.openPopup('model', modelPicker, session, { via: 'enter', token: '/model' })
            return { kind: 'success' }
          } }
        }
        const originals = new Map()
        const wrappers = new Map()
        for (const name of methods) {
          const original = ui[name]
          originals.set(name, Object.getOwnPropertyDescriptor(ui, name))
          const wrapper = function (...args) {
            const session = name === 'dispatch' ? args[0].session : args[0]
            const invoke = () => original.apply(nativeSessionIds.has(session.sessionId) ? nativeUi : this, args)
            if ((name === 'candidates' || name === 'matchEnter') && !nativeSessionIds.has(session.sessionId)) {
              if (nativeAgent === null && hermesAgent === null) return Promise.reject(new Error('原生命令服务尚未就绪，请稍后重试'))
              return getPermissionState(session.sessionId, true).catch((error) => {
                if (error?.code !== 'NOT_NATIVE_SESSION') throw error
              }).then(invoke)
            }
            return invoke()
          }
          // facade 内部方法互调仍使用原始方法，避免再次套用包装器。
          nativeUi[name] = original
          wrappers.set(name, wrapper)
          ui[name] = wrapper
        }
        scope.effect(() => () => {
          for (const [name, descriptor] of originals) {
            if (Object.getOwnPropertyDescriptor(ui, name)?.value !== wrappers.get(name)) continue
            if (descriptor) Object.defineProperty(ui, name, descriptor)
            else delete ui[name]
          }
        }, 'agent-driver: native command UI')
      })
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
   通过 conversation.input.left 的官方 slot 注册。
   模型切换器同理：原生会话的模型由 CLI 本机配置决定（Claude settings /
   hermes model），官方选择器走 session.selectModel（普通会话专用且持久化
   全局默认），在原生会话中既显示不准也可能污染全局选择，因此一并隐藏；
   想换模型请到对应 CLI 里改配置。 */
body[data-native-agent-access="true"] button[aria-label*="访问模式"],
body[data-native-agent-access="true"] button[aria-label*="Access mode"],
body[data-native-agent-access="true"] button[aria-label^="选择模型"],
body[data-native-agent-access="true"] button[aria-label^="Select model"] { display: none !important; }
.dsh-agent-permission { position: relative; display: inline-flex; align-items: center; min-width: 0; }
.dsh-agent-model { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-caption, #8a8a8a); font-size: 12px; line-height: 17px; padding: 0 4px 0 10px; }
.dsh-agent-permissionTrigger { min-width: 0; max-width: 240px; height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 6px 0 10px; border: 0; border-radius: 24px; outline: none; background: transparent; color: var(--dsw-alias-label-secondary, #666); font: 500 14px/22px inherit; cursor: pointer; }
.dsh-agent-permissionTrigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
.dsh-agent-permissionTrigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3, rgba(0,0,0,.18)); }
.dsh-agent-permissionTrigger:disabled { cursor: default; opacity: .62; }
.dsh-agent-permissionIcon { font-size: 18px; line-height: 1; transform: rotate(-25deg); }
.dsh-agent-permissionChevron { color: var(--dsw-alias-label-caption, #8a8a8a); font-size: 16px; line-height: 1; }
.dsh-agent-permissionPopover { position: absolute; z-index: 50; left: 0; bottom: calc(100% + 8px); width: min(300px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 2px; padding: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 10px; background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 8px 24px rgba(0,0,0,.16); }
.dsh-agent-permissionOption { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-primary, #1a1a1a); font: inherit; text-align: left; cursor: pointer; }
.dsh-agent-permissionOption:hover:not(:disabled), .dsh-agent-permissionOption[data-current="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
.dsh-agent-permissionOption:disabled { cursor: default; opacity: .62; }
.dsh-agent-permissionOptionName { font-size: 14px; font-weight: 600; line-height: 22px; }
.dsh-agent-permissionOptionDesc { color: var(--dsw-alias-label-secondary, #666); font-size: 13px; line-height: 18px; }
.dsh-agent-permissionError { padding: 4px 10px 2px; color: var(--dsw-alias-state-error-primary, #b42318); font-size: 12px; line-height: 17px; }
`
      document.head.appendChild(style)
    }

    async function apply(clientCtx) {
      ctx = clientCtx
      try { registerNativeCommands(clientCtx) } catch (error) {
        console.warn('[dsh-agent-driver] 命令 UI 挂载失败：', error)
      }
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
        hermesAgent = clientCtx.reflect.get('remote.hermesAgent') ?? null
        if (nativeAgent === null && hermesAgent === null) throw new Error('agent-driver: no native agent Remote namespace mounted')
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
          hermesAgent = null
          nativeSessionIds.clear()
          void dispose()
        }
      }, 'agent-driver: Remote')
    }

    return { inject: ['connection', 'remote', 'sessions', 'workspaces', 'slots'], apply }
  },
})
