/**
 * dsh-memory — browser half (runs inside the dsh web GUI).
 *
 * Settings-section client: registers “全局记忆” as a first-level DSH Settings
 * item and renders its file list + editor panel through the official
 * `settings.section` slot. File actions use plain DOM only inside the React
 * section root, so they never interfere with the shell's reconciliation.
 */
window.__ModuleLoader__.load({
  // Must match the package name used by DSH's client-module loader.
  id: 'dsh-global-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const useEffect = React.useEffect
    const useRef = React.useRef

    const API = {
      files: '/api/dsh-memory/files',
      file: '/api/dsh-memory/file',
    }
    const GLOBAL_KEY = '__global__'


    // -------------------------------------------------------------- state
    const state = {
      files: [],
      currentKey: null,
      original: '',
      dirty: false,
      loading: false,
      message: '',
    }
    const settingsRoots = new Set()

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
      const editor = [...settingsRoots].map((root) => root.querySelector('textarea')).find((node) => node !== null) ?? null
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
.dshm-settingsRoot { min-width: 0; }
.dshm-settingsPanel { display: flex; flex-direction: column; min-height: 520px; color: var(--dsw-alias-label-primary); }
.dshm-bar { display: flex; align-items: flex-start; gap: 12px; padding: 4px 0 16px; flex: none; }
.dshm-barTitle { font-size: 18px; font-weight: 600; line-height: 1.35; }
.dshm-barDesc { margin-top: 3px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.45; }
.dsvm-barSpacer { flex: 1; }
.dshm-footer { display: flex; align-items: center; gap: 8px; padding: 12px 0 0; border-top: 1px solid var(--dsw-alias-border-l2); flex: none; }
.dshm-footerSpacer { flex: 1; }
.dshm-btn { padding: 4px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
.dshm-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshm-btn:disabled { opacity: 0.5; cursor: default; }
.dshm-btnPrimary { background: var(--dsw-alias-button-info-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
.dshm-btnPrimary:hover { background: var(--dsw-alias-button-info-hover); opacity: 1; }
.dshm-body { display: flex; flex: 1; min-height: 420px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; overflow: hidden; }
.dshm-list { width: 220px; flex: none; overflow-y: auto; border-right: 1px solid var(--dsw-alias-border-l2); padding: 8px; background: var(--dsw-alias-bg-module-platform); }
.dshm-item { display: block; width: 100%; padding: 7px 9px; margin: 2px 0; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dshm-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshm-item[data-current="true"] { background: var(--dsw-alias-interactive-bg-active); }
.dshm-itemTitle { font-size: 13px; font-weight: 600; }
.dshm-itemMeta { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; }
.dshm-editorCol { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.dshm-meta { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 12px; color: var(--dsw-alias-label-secondary); flex: none; }
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
@media (max-width: 640px) { .dshm-settingsPanel { min-height: 420px; } .dshm-body { min-height: 360px; } .dshm-list { width: 156px; } }
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
      const panel = el('section', 'dshm-settingsPanel')
      const bar = el('div', 'dshm-bar')
      const title = el('div', 'dshm-barTitle', '全局记忆')
      const heading = el('div')
      heading.append(title, el('div', 'dshm-barDesc', '管理适用于所有会话的全局指令与长期记忆。'))
      bar.append(heading)
      bar.append(el('div', 'dsvm-barSpacer'))
      const refreshBtn = el('button', 'dshm-btn', '刷新')
      refreshBtn.addEventListener('click', () => { loadFiles().catch((e) => { state.message = '刷新失败：' + e.message; render() }) })
      bar.append(refreshBtn)
      const newBtn = el('button', 'dshm-btn', '新建')
      newBtn.addEventListener('click', () => { createFile() })
      bar.append(newBtn)
      panel.append(bar)
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
      panel.append(body)
      // bottom operation bar
      const footer = el('div', 'dshm-footer')
      footer.append(el('div', 'dshm-footerSpacer'))
      const saveBtn = el('button', 'dshm-btn dshm-btnPrimary', '保存')
      saveBtn.disabled = state.loading || state.currentKey === null
      saveBtn.addEventListener('click', () => { saveFile() })
      footer.append(saveBtn)
      panel.append(footer)
      container.append(panel)
    }

    function render() {
      for (const root of settingsRoots) renderPanel(root)
    }

    // ------------------------------------------------------ settings section
    function MemorySettingsSection() {
      const rootRef = useRef(null)
      useEffect(() => {
        const root = rootRef.current
        if (root === null) return undefined
        ensureStyles()
        settingsRoots.add(root)
        renderPanel(root)
        loadFiles().catch((error) => { state.message = '加载失败：' + error.message; render() })
        return () => { settingsRoots.delete(root) }
      }, [])
      return h('div', { ref: rootRef, className: 'dshm-settingsRoot', 'data-dsh-plugin': 'memory' })
    }

    // --------------------------------------------------------------- apply
    function apply(ctx) {
      if (ctx.slots === undefined) {
        console.warn('[dsh-memory] settings.section slot is unavailable')
        return
      }
      ctx.slots.inject('settings.section', () => {
        try {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'global-memory',
            order: 120,
            label: () => '全局记忆',
          }, MemorySettingsSection)
        } catch (error) {
          console.warn('[dsh-memory] settings registration failed:', error)
          return () => {}
        }
      })
      ctx.effect(() => () => {
        document.getElementById('dsh-memory-styles')?.remove()
      }, 'dsh-memory: styles')
    }
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
