/**
 * dsh-memory — browser half (runs inside the dsh web GUI).
 *
 * Plain-DOM client: registers no services (inject: []), injects a sidebar
 * entry row ("全局记忆") and, when toggled, takes over the center column
 * with a file list + editor panel backed by /api/dsh-memory. The row is
 * plain DOM with a self-healing MutationObserver (task-board / dsh-ssh
 * precedent), so it can never disturb the shell's React reconciliation.
 * Failure policy: mount problems are logged, never thrown.
 */
window.__ModuleLoader__.load({
  // Must match the package name used by DSH's client-module loader.
  id: 'dsh-global-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const API = {
      files: '/api/dsh-memory/files',
      file: '/api/dsh-memory/file',
    }
    const GLOBAL_KEY = '__global__'
    const ENTRY_SELECTOR = '[data-dsh-memory-entry]'
    const VIEW_SELECTOR = '[data-dsh-memory-view]'
    const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
    const ACTIVE_ATTR = 'data-dsh-memory-active'
    const OTHER_ACTIVE_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active']
    const ACTIVATE_EVENT = 'dsh-panel-activate'
    const PANEL_NAME = 'memory'
    const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

    const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.2c1.6-.9 3.4-.9 5 0v9.6c-1.6-.9-3.4-.9-5 0z"/><path d="M13.5 3.2c-1.6-.9-3.4-.9-5 0v9.6c1.6-.9 3.4-.9 5 0z"/></svg>'

    // -------------------------------------------------------------- state
    const state = {
      open: false,
      files: [],
      currentKey: null,
      original: '',
      dirty: false,
      loading: false,
      message: '',
    }
    const listeners = new Set()
    function notify() {
      for (const fn of [...listeners]) fn()
    }

    // ---------------------------------------------------------- api calls
    async function fetchJson(url, options) {
      let response
      try {
        response = await fetch(url, options)
      } catch (error) {
        throw new Error('网络错误：' + (error instanceof Error ? error.message : String(error)))
      }
      let body = null
      try {
        body = await response.json()
      } catch {
        /* empty body */
      }
      if (!response.ok) {
        const message = body && typeof body.error === 'string' ? body.error : 'HTTP ' + response.status
        throw new Error(message)
      }
      return body
    }

    async function loadFiles() {
      const body = await fetchJson(API.files)
      state.files = Array.isArray(body.files) ? body.files : []
      if (state.currentKey === null && state.files.length > 0) selectFile(state.files[0].key)
      else if (state.currentKey !== null && !state.files.some((f) => f.key === state.currentKey)) {
        state.currentKey = null
        if (state.files.length > 0) selectFile(state.files[0].key)
      }
      render()
    }

    async function loadFile(key) {
      state.loading = true
      render()
      try {
        const body = await fetchJson(API.file + '?key=' + encodeURIComponent(key))
        state.currentKey = key
        state.original = typeof body.content === 'string' ? body.content : ''
        state.dirty = false
        state.message = ''
      } catch (error) {
        state.message = '读取失败：' + error.message
      } finally {
        state.loading = false
        render()
      }
    }

    function selectFile(key) {
      if (state.dirty) {
        showModal({
          title: '未保存的修改',
          message: '当前文件有未保存的修改，切换将丢失，确定吗？',
          okText: '放弃并切换',
          cancelText: '取消',
        }).then((r) => { if (r.ok) loadFile(key) })
        return
      }
      loadFile(key)
    }

    async function saveFile() {
      if (state.currentKey === null) return
      const editor = document.querySelector(VIEW_SELECTOR + ' textarea')
      const content = editor !== null ? editor.value : ''
      state.loading = true
      state.message = ''
      render()
      try {
        await fetchJson(API.file, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: state.currentKey, content }),
        })
        state.original = content
        state.dirty = false
        state.message = '已保存 ' + new Date().toLocaleTimeString()
        await loadFiles()
      } catch (error) {
        state.message = '保存失败：' + error.message
      } finally {
        state.loading = false
        render()
      }
    }

    async function createFile() {
      const result = await showModal({
        title: '新建记忆文件',
        message: '自动加 .md 后缀；需以字母或数字开头，仅含字母数字与 . _ -',
        placeholder: '例如：prefs',
        okText: '创建',
        cancelText: '取消',
      })
      if (!result.ok) return
      const trimmed = result.value.trim().replace(/\.md$/i, '')
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
        await showModal({
          title: '文件名不合法',
          message: '需以字母或数字开头，仅含字母数字与 . _ -',
          okText: '知道了',
        })
        return
      }
      const key = trimmed + '.md'
      if (state.files.some((f) => f.key === key)) {
        await showModal({ title: '文件已存在', message: '已存在：' + key, okText: '知道了' })
        return
      }
      try {
        await fetchJson(API.file, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key, content: '# ' + trimmed + '\n\n' }),
        })
        state.original = '# ' + trimmed + '\n\n'
        state.dirty = false
        state.currentKey = key
        await loadFiles()
      } catch (error) {
        await showModal({ title: '创建失败', message: error.message, okText: '知道了' })
      }
    }

    // ------------------------------------------------------------- styles
    function ensureStyles() {
      if (document.getElementById('dsh-memory-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-memory-styles'
      style.setAttribute('data-plugin', 'dsh-memory')
      style.textContent = `
.dshm-entry { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; margin: 1px 0; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.dshm-entry:hover { background: var(--dsw-specific-sidebar-nav-item-hover); color: var(--dsw-alias-label-primary); }
.dshm-entry[data-active="true"] { background: var(--dsw-specific-sidebar-nav-item-active); color: var(--dsw-alias-label-primary); font-weight: 600; }
.dshm-entryIcon { display: inline-flex; align-items: center; }
.dshm-entryLabel { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshm-view { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); z-index: 5; }
html[data-dsh-memory-active] [data-pane="conversation"] > :not([data-dsh-memory-view]),
html[data-dsh-memory-active] [class*="centerCol"] > :not([data-dsh-memory-view]) { display: none !important; }
.dshm-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); flex: none; }
.dshm-barTitle { font-size: 13px; font-weight: 600; }
.dsvm-barSpacer { flex: 1; }
.dshm-footer { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l2); flex: none; }
.dshm-footerSpacer { flex: 1; }
.dshm-btn { padding: 4px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
.dshm-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshm-btn:disabled { opacity: 0.5; cursor: default; }
.dshm-btnPrimary { background: var(--dsw-alias-button-info-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
.dshm-btnPrimary:hover { background: var(--dsw-alias-button-info-hover); opacity: 1; }
.dshm-body { display: flex; flex: 1; min-height: 0; }
.dshm-list { width: 210px; flex: none; overflow-y: auto; border-right: 1px solid var(--dsw-alias-border-l2); padding: 6px; }
.dshm-item { display: block; width: 100%; padding: 7px 9px; margin: 2px 0; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dshm-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshm-item[data-current="true"] { background: var(--dsw-alias-interactive-bg-active); }
.dshm-itemTitle { font-size: 13px; font-weight: 600; }
.dshm-itemMeta { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; }
.dshm-editorCol { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.dshm-meta { display: flex; align-items: center; gap: 10px; padding: 5px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 12px; color: var(--dsw-alias-label-secondary); flex: none; }
.dshm-dirty { color: var(--dsw-alias-state-warn-primary); opacity: 1; }
.dshm-textarea { flex: 1; width: 100%; resize: none; border: 0; outline: none; padding: 12px 14px; font-family: var(--ds-font-family-code, Menlo, Consolas, monospace); font-size: 12.5px; line-height: 1.6; background: transparent; color: inherit; }
.dshm-empty { display: flex; align-items: center; justify-content: center; flex: 1; color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.dshm-modalBackdrop { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.4)); }
.dshm-modal { display: flex; flex-direction: column; gap: 12px; min-width: 320px; max-width: calc(100vw - 48px); padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-shadow-lv3, 0 8px 30px rgba(0, 0, 0, 0.2)); }
.dshm-modalTitle { font-size: 14px; font-weight: 700; }
.dshm-modalMsg { font-size: 12.5px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.dshm-modalInput { color: var(--dsw-alias-label-primary); background: var(--dsw-specific-input-major); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; outline: none; padding: 7px 10px; font: inherit; font-size: 13px; }
.dshm-modalInput:focus { border-color: var(--dsw-alias-state-business-primary); }
.dshm-modalBtns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
`
      document.head.append(style)
    }

    // -------------------------------------------------------------- render
    function el(tag, className, text) {
      const node = document.createElement(tag)
      if (className !== undefined) node.className = className
      if (text !== undefined) node.textContent = text
      return node
    }

    // ------------------------------------------------------------- dialog
    /**
     * Inline DOM dialog replacing native window.prompt/confirm/alert, which are
     * unreliable (silently null / never shown) inside the DSH web GUI.
     * Options: { title, message, value, placeholder, okText, cancelText }.
     * Resolves { ok, value } — ok false on cancel/Escape; value is the input
     * text when an input is shown (always supplied, empty string when blank).
     */
    function showModal(opts) {
      return new Promise((resolve) => {
        const hasInput = opts.placeholder !== undefined && opts.placeholder !== null
        const backdrop = el('div', 'dshm-modalBackdrop')
        const modal = el('div', 'dshm-modal')
        modal.append(el('div', 'dshm-modalTitle', opts.title || ''))
        if (opts.message) modal.append(el('div', 'dshm-modalMsg', opts.message))
        let input = null
        if (hasInput) {
          input = document.createElement('input')
          input.className = 'dshm-modalInput'
          input.type = 'text'
          input.value = opts.value || ''
          input.placeholder = opts.placeholder
          input.spellcheck = false
          modal.append(input)
        }
        const btns = el('div', 'dshm-modalBtns')
        const okBtn = el('button', 'dshm-btn dshm-btnPrimary', opts.okText || '确定')
        const cancelBtn = opts.cancelText ? el('button', 'dshm-btn', opts.cancelText) : null
        if (cancelBtn !== null) btns.append(cancelBtn)
        btns.append(okBtn)
        modal.append(btns)
        const close = (ok) => {
          backdrop.remove()
          document.removeEventListener('keydown', onKey, true)
          resolve({ ok, value: input !== null ? input.value : '' })
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close(false)
          } else if (event.key === 'Enter' && hasInput) {
            event.preventDefault()
            event.stopPropagation()
            close(true)
          }
        }
        okBtn.addEventListener('click', () => close(true))
        if (cancelBtn !== null) cancelBtn.addEventListener('click', () => close(false))
        backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(false) })
        backdrop.append(modal)
        document.body.append(backdrop)
        if (input !== null) input.focus()
        document.addEventListener('keydown', onKey, true)
      })
    }

    function renderPanel(container) {
      container.replaceChildren()
      // top bar (title only — right side is left clear to avoid colliding with
      // other plugins' fixed top-right buttons, e.g. dsh-better-sidebar)
      const bar = el('div', 'dshm-bar')
      bar.append(el('div', 'dshm-barTitle', '全局记忆'))
      bar.append(el('div', 'dsvm-barSpacer'))
      container.append(bar)
      // body
      const body = el('div', 'dshm-body')
      const list = el('div', 'dshm-list')
      for (const file of state.files) {
        const item = el('button', 'dshm-item')
        item.dataset.current = file.key === state.currentKey ? 'true' : 'false'
        const meta = file.exists ? Math.ceil(file.bytes / 1024) + ' KB · ' + new Date(file.mtimeMs).toLocaleDateString() : '不存在（保存时创建）'
        const itemDiv = el('div', 'dshm-itemTitle', file.title)
        item.append(itemDiv, el('div', 'dshm-itemMeta', file.subtitle))
        item.title = file.path + '\n' + meta
        item.addEventListener('click', () => { selectFile(file.key) })
        list.append(item)
      }
      if (state.files.length === 0) list.append(el('div', 'dshm-itemMeta', '（暂无文件）'))
      body.append(list)
      const editorCol = el('div', 'dshm-editorCol')
      const meta = el('div', 'dshm-meta')
      const current = state.files.find((f) => f.key === state.currentKey)
      meta.append(el('span', undefined, current ? current.path : ''))
      if (state.dirty) meta.append(el('span', 'dshm-dirty', '● 未保存'))
      if (state.message !== '') meta.append(el('span', undefined, state.message))
      if (state.loading) meta.append(el('span', undefined, '处理中…'))
      editorCol.append(meta)
      if (state.currentKey !== null) {
        const textarea = document.createElement('textarea')
        textarea.className = 'dshm-textarea'
        textarea.spellcheck = false
        textarea.value = state.original
        textarea.disabled = state.loading
        textarea.addEventListener('input', () => {
          state.dirty = textarea.value !== state.original
          const dirtyNode = container.querySelector('.dshm-dirty')
          if (dirtyNode !== null) dirtyNode.textContent = state.dirty ? '● 未保存' : ''
        })
        textarea.addEventListener('keydown', (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 's') {
            event.preventDefault()
            saveFile()
          }
        })
        editorCol.append(textarea)
      } else {
        editorCol.append(el('div', 'dshm-empty', '选择左侧文件查看与编辑'))
      }
      body.append(editorCol)
      container.append(body)
      // bottom operation bar
      const footer = el('div', 'dshm-footer')
      const refreshBtn = el('button', 'dshm-btn', '刷新')
      refreshBtn.addEventListener('click', () => { loadFiles().catch((e) => { state.message = '刷新失败：' + e.message; render() }) })
      footer.append(refreshBtn)
      const newBtn = el('button', 'dshm-btn', '新建')
      newBtn.addEventListener('click', () => { createFile() })
      footer.append(newBtn)
      footer.append(el('div', 'dshm-footerSpacer'))
      const saveBtn = el('button', 'dshm-btn dshm-btnPrimary', '保存')
      saveBtn.disabled = state.loading || state.currentKey === null
      saveBtn.addEventListener('click', () => { saveFile() })
      footer.append(saveBtn)
      const closeBtn = el('button', 'dshm-btn', '关闭')
      closeBtn.addEventListener('click', () => { setOpen(false) })
      footer.append(closeBtn)
      container.append(footer)
    }

    function render() {
      const container = document.querySelector(VIEW_SELECTOR)
      if (container !== null) renderPanel(container)
    }

    // ------------------------------------------------------------ open/close
    function setOpen(open) {
      if (state.open === open) return
      state.open = open
      if (open) {
        for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
        document.documentElement.setAttribute(ACTIVE_ATTR, '')
        document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
        loadFiles().catch((error) => { state.message = '加载失败：' + error.message; render() })
      } else {
        document.documentElement.removeAttribute(ACTIVE_ATTR)
      }
      syncEntryActive()
      notify()
    }

    // --------------------------------------------------------- sidebar entry
    function sidebarRoot() {
      const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
      if (column === null) return undefined
      const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement
      return logoOwner ?? (column.firstElementChild ?? undefined)
    }

    function newSessionButton(root) {
      const nested = root.querySelector('button[class*="newSession"]')
      if (nested !== null) return nested
      for (const child of root.children) {
        if (child.tagName === 'BUTTON') return child
      }
      return undefined
    }

    function placeEntry(root, entry) {
      const button = newSessionButton(root)
      if (button === undefined) return false
      if (entry.parentElement !== root) {
        const row = button.closest('[class*="logoRow"]')
        const base = (row !== null && row.parentElement === root) ? row : button
        const family = Array.from(root.children).filter(
          (node) => node instanceof HTMLElement
            && node.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-memory-entry]'),
        )
        const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling
        root.insertBefore(entry, anchor)
      }
      return true
    }

    let entryElement = null
    function syncEntryActive() {
      if (entryElement === null) return
      if (state.open) entryElement.dataset.active = 'true'
      else delete entryElement.dataset.active
    }

    function mountSidebarEntry() {
      if (document.querySelector(ENTRY_SELECTOR) !== null) return () => {}
      ensureStyles()
      const entry = document.createElement('button')
      entry.type = 'button'
      entry.setAttribute('data-dsh-memory-entry', '')
      entry.setAttribute('data-dsh-plugin', 'memory')
      entry.setAttribute('data-dsh-part', 'sidebar-entry')
      entry.className = 'dshm-entry'
      entry.setAttribute('aria-label', '全局记忆')
      entry.setAttribute('title', '查看/编辑全局指令与跨会话记忆')
      entry.innerHTML = '<span class="dshm-entryIcon">' + ICON + '</span><span class="dshm-entryLabel">全局记忆</span>'
      entry.addEventListener('click', () => { setOpen(!state.open) })
      entryElement = entry
      let root = undefined
      let placed = false

      const tryPlace = () => {
        if (placed && document.body.contains(entry)) return
        root = sidebarRoot()
        if (root === undefined) return
        placed = placeEntry(root, entry)
      }
      const waitObserver = new MutationObserver(() => { tryPlace() })
      waitObserver.observe(document.body, { childList: true, subtree: true })
      tryPlace()
      syncEntryActive()

      return () => {
        waitObserver.disconnect()
        entry.remove()
        entryElement = null
      }
    }

    // --------------------------------------------------------- center panel
    function mountPanel() {
      let container = undefined

      const ensure = () => {
        if (container !== undefined && container.isConnected) return
        const column = document.querySelector(CONVERSATION_COLUMN_SELECTOR)
        if (column === null) return
        column.style.position = column.style.position === '' ? 'relative' : column.style.position
        container = el('div', 'dshm-view')
        container.setAttribute('data-dsh-memory-view', '')
        container.setAttribute('data-dsh-plugin', 'memory')
        container.style.display = state.open ? 'flex' : 'none'
        column.append(container)
        renderPanel(container)
      }
      const waitObserver = new MutationObserver(() => { ensure() })
      waitObserver.observe(document.body, { childList: true, subtree: true })

      const applyVisible = () => {
        if (container !== undefined) container.style.display = state.open ? 'flex' : 'none'
      }
      listeners.add(applyVisible)

      const onOtherActivate = (event) => {
        const detail = event instanceof CustomEvent ? event.detail : undefined
        if (detail !== undefined && detail !== PANEL_NAME) setOpen(false)
      }
      document.addEventListener(ACTIVATE_EVENT, onOtherActivate)

      const onClickSidebarRow = (event) => {
        if (!state.open) return
        const target = event.target
        if (target instanceof HTMLElement && target.closest(SIDEBAR_ROW_SELECTOR) !== null) setOpen(false)
      }
      document.addEventListener('click', onClickSidebarRow, true)

      ensure()

      return () => {
        waitObserver.disconnect()
        listeners.delete(applyVisible)
        document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
        document.removeEventListener('click', onClickSidebarRow, true)
        document.documentElement.removeAttribute(ACTIVE_ATTR)
        container?.remove()
        container = undefined
      }
    }

    // --------------------------------------------------------------- apply
    function apply(ctx) {
      const disposers = []
      try {
        disposers.push(mountSidebarEntry())
        disposers.push(mountPanel())
      } catch (error) {
        console.warn('[dsh-memory] mount failed:', error)
      }
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) dispose()
      }, 'dsh-memory: ui mounts')
    }
    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
