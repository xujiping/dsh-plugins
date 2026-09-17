/**
 * dsh-web-sites — browser half (runs inside the dsh web GUI).
 *
 * A site launcher for your own web systems, all inside the GUI:
 *
 *   - A menu row「🌐 我的网站系统」is injected INTO the sidebar, right above
 *     the workspace/session tree ([role="tree"]) — i.e. below the
 *     new-session button. It is a tree sibling, so React's reconciliation of
 *     the tree children is never disturbed; a MutationObserver re-inserts it
 *     if the shell re-renders it away.
 *   - Clicking the menu drops a site list anchored right below it
 *     (position:fixed on document.body, sidebar-wide).
 *   - Clicking a site opens a full-height iframe PANEL on the RIGHT side
 *     of the app frame (from the sidebar's right edge to the viewport /
 *     rightbar edge). The panel has a header bar: 刷新 / 新标签打开 / 管理 /
 *     关闭. While the panel is open, clicking ANY sidebar workspace/session
 *     row ([role=treeitem]) dismisses it so the conversation shows through.
 *   - 「管理」opens a dialog to add / edit / delete sites; saving POSTs the
 *     full list back to the host, which persists it to ~/.dsh/sites.yaml.
 *
 * Layout anchoring (robust, no hashed class names):
 *   The DSH shell frame is a 3-column CSS grid (sidebar | center | rightbar)
 *   on `[data-sidebar-collapsed]`. We parse `gridTemplateColumns` to get the
 *   sidebar width (1st px) and rightbar width (3rd px) — authoritative layout
 *   that survives theme / width changes. A ResizeObserver re-anchors on every
 *   grid change.
 *
 * Implementation notes
 * --------------------
 * - Overlays (list / panel / dialogs) are appended to document.body (outside
 *   React), position:fixed, mounted idempotently, and self-healed by a
 *   MutationObserver. Mount failures are logged, never thrown.
 * - The panel iframe has `sandbox` omitted on purpose: sites need cookies /
 *   JS to function. Cross-origin login is subject to the browser's third-party
 *   cookie policy — the README documents how to make self-hosted sites
 *   iframe-friendly.
 */

window.__ModuleLoader__.load({
  id: 'dsh-web-sites',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ------------------------------------------------------------- constants
    const LS_OPEN_KEY = 'dsh.webSites.openSiteId'
    const API_LIST = '/api/dsh-sites/list'
    const API_SAVE = '/api/dsh-sites/save'
    const ROOT_PREFIX = 'dws'

    // ------------------------------------------------------------------ state
    let ctx = null
    let observer = null
    let resizeObserver = null
    let sites = []
    let siteById = new Map()
    let mounted = false
    // ui flags (kept on the DOM data attributes, mirrored here for logic)
    let listOpen = false
    let panelOpenId = null
    let manageOpen = false

    // ---------------------------------------------------------------- helpers
    function $(sel, root) {
      return (root || document).querySelector(sel)
    }

    function frameEl() {
      return document.querySelector('[data-sidebar-collapsed]')
    }

    /** Parse the shell grid template into { sidebar, rightbar } widths (px). */
    function layoutWidths() {
      const frame = frameEl()
      if (frame) {
        const parts = (frame.style.gridTemplateColumns || '').trim().split(/\s+/)
        const px = v => { const m = /^(\d+(?:\.\d+)?)px$/.exec(v || ''); return m ? parseFloat(m[1]) : 0 }
        if (parts.length >= 1) {
          return {
            sidebar: parts[0] === 'minmax(0,1fr)' ? 0 : px(parts[0]),
            rightbar: parts.length >= 3 ? px(parts[2]) : 0,
          }
        }
      }
      return { sidebar: 280, rightbar: 0 }
    }

    // ------------------------------------------------------------ api access
    async function fetchSites() {
      const res = await fetch(API_LIST, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return Array.isArray(data.sites) ? data.sites : []
    }

    async function saveSites(list) {
      const res = await fetch(API_SAVE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sites: list }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || '保存失败')
      return data.sites
    }

    // ---------------------------------------------------------------- styles
    function ensureStyles() {
      if (document.getElementById('dsh-web-sites-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-web-sites-styles'
      style.setAttribute('data-plugin', 'dsh-web-sites')
      style.textContent = `
/* ---- inline menu row: lives in the sidebar, above the workspace tree ---- */
.dws-menu {
  all: unset;
  box-sizing: border-box;
  position: fixed;
  z-index: 80;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  margin: 0;
  padding: 0 10px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary, #666);
  font-size: 13px;
  transition: color .12s ease, background-color .12s ease;
}
.dws-menu:hover {
  color: var(--dsw-alias-label-primary, #1a1a1a);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
}
.dws-menu:focus-visible {
  outline: 2px solid var(--dsw-alias-button-info-fill, #4d6bfe);
  outline-offset: -2px;
}
.dws-menu[data-active="true"] {
  color: var(--dsw-alias-label-primary, #1a1a1a);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
}
.dws-menu-icon { font-size: 14px; line-height: 1; }
.dws-menu-label { flex: 1 1 auto; min-width: 0; font-weight: 500; }
.dws-menu-count {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #999);
}
.dws-menu-caret { flex: 0 0 auto; font-size: 10px; transition: transform .12s ease; }
.dws-menu[data-active="true"] .dws-menu-caret { transform: rotate(90deg); }

/* ---- expanded site list: dropdown anchored below the sidebar menu row ---- */
.dws-list {
  position: fixed;
  left: 0;
  z-index: 49;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff));
  border-right: .5px solid var(--dsw-alias-border-l3);
  border-bottom: .5px solid var(--dsw-alias-border-l3);
  box-shadow: var(--dsw-shadow-lv3, 0 8px 28px rgba(0,0,0,0.14));
  border-radius: 0 0 12px 0;
  animation: dws-list-in .14s var(--ds-ease-in-out, ease);
  overflow: hidden;
}
@keyframes dws-list-in {
  from { opacity: 0; transform: translateX(-6px); }
  to   { opacity: 1; transform: translateX(0); }
}
.dws-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 12px 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.dws-list-head-note {
  font-size: 10px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary, #999);
}
.dws-list-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dws-site {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.dws-site:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
}
.dws-site:focus-visible {
  outline: 2px solid var(--dsw-alias-button-info-fill, #4d6bfe);
  outline-offset: -2px;
}
.dws-site-icon {
  flex: 0 0 auto;
  width: 24px;
  text-align: center;
  font-size: 16px;
  line-height: 1;
}
.dws-site-meta { flex: 1 1 auto; min-width: 0; }
.dws-site-name {
  font-size: 13px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dws-site-url {
  font-size: 10px;
  line-height: 14px;
  color: var(--dsw-alias-label-tertiary, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dws-list-empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary, #999);
}
.dws-list-foot {
  padding: 8px;
  border-top: .5px solid var(--dsw-alias-border-l3);
}
.dws-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
}
.dws-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.10)); }
.dws-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-button-info-fill, #4d6bfe);
  outline-offset: 1px;
}
.dws-btn[data-kind="primary"] {
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: var(--dsw-alias-button-info-fill, #4d6bfe);
}
.dws-btn[data-kind="primary"]:hover { background: var(--dsw-alias-button-info-hover, #3d5ae0); }
.dws-btn[data-kind="ghost"] {
  background: transparent;
  color: var(--dsw-alias-label-secondary, #666);
}
.dws-btn[data-kind="danger"] {
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: var(--dsw-alias-state-error-primary, #d5484d);
}
.dws-btn:disabled { opacity: .5; cursor: default; }
.dws-btn[data-kind="manage"] { width: 100%; }

/* ---- iframe panel: covers the main area right of the sidebar ---- */
.dws-panel {
  position: fixed;
  top: 0;
  bottom: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base, #fff);
  border-left: .5px solid var(--dsw-alias-border-l3);
  animation: dws-panel-in .18s var(--ds-ease-in-out, ease);
}
@keyframes dws-panel-in {
  from { opacity: 0; transform: translateX(10px); }
  to   { opacity: 1; transform: translateX(0); }
}
.dws-panel-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 10px 0 14px;
  box-sizing: border-box;
  border-bottom: .5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff));
}
.dws-panel-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dws-panel-hint {
  flex: 0 0 auto;
  max-width: 40%;
  font-size: 10px;
  line-height: 14px;
  color: var(--dsw-alias-label-tertiary, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dws-panel-body {
  flex: 1 1 auto;
  position: relative;
  min-height: 0;
  background: #fff;
}
body[data-ds-dark-theme] .dws-panel-body { background: #1b1d23; }
.dws-panel-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
}
.dws-panel-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary, #999);
  background: var(--dsw-alias-bg-base, #fff);
  z-index: 1;
}

/* ---- manage dialog ---- */
.dws-manage-mask {
  position: fixed;
  z-index: 60;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.32));
}
.dws-manage {
  box-sizing: border-box;
  width: min(520px, 100%);
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #fff);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  box-shadow: 0 16px 48px rgba(0,0,0,0.22);
  overflow: hidden;
}
.dws-manage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 16px 10px;
}
.dws-manage-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dws-manage-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); margin-top: 2px; }
.dws-manage-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px 16px 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dws-site-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, #f7f7f7);
}
.dws-row { display: flex; gap: 8px; align-items: center; }
.dws-row > label {
  flex: 0 0 48px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #666);
  text-align: right;
}
.dws-input {
  all: unset;
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.18));
  border-radius: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  background: var(--dsw-alias-bg-base, #fff);
}
.dws-input:focus { border-color: var(--dsw-alias-button-info-fill, #4d6bfe); }
.dws-input-icon { flex: 0 0 auto !important; width: 34px !important; text-align: center; }
.dws-card-foot { display: flex; justify-content: flex-end; gap: 8px; }
.dws-manage-foot {
  flex: 0 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: .5px solid var(--dsw-alias-border-l3);
}
.dws-manage-foot-actions { display: flex; gap: 8px; margin-left: auto; }
.dws-toast {
  position: fixed;
  z-index: 70;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100vw - 32px);
  padding: 10px 16px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  background: var(--dsw-alias-bg-base, #fff);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 8px 28px rgba(0,0,0,0.18);
}
`
      document.head.append(style)
    }

    // ------------------------------------------------------------------ dom
    let menuEl = null
    let listEl = null
    let panelEl = null
    let manageEl = null
    let toastEl = null
    let toastTimer = 0

    function showToast(message) {
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = 0 }
      if (toastEl !== null) toastEl.remove()
      toastEl = document.createElement('div')
      toastEl.className = 'dws-toast'
      toastEl.textContent = message
      document.body.append(toastEl)
      toastTimer = setTimeout(() => {
        toastEl?.remove()
        toastEl = null
        toastTimer = 0
      }, 3000)
    }

    /**
     * Inject the inline menu row into the sidebar, right above the workspace /
     * session tree ([role="tree"]) — i.e. below the new-session button. The row
     * is inserted as a sibling of the tree, so React's reconciliation of the
     * tree's own children is never disturbed; if a re-render removes it, the
     * MutationObserver sweep re-inserts it.
     */
    function ensureMenu() {
      const tree = sidebarTree()
      if (!(tree instanceof HTMLElement)) {
        menuEl?.remove()
        return
      }
      if (menuEl !== null) {
        // 菜单不能作为 React 侧边栏的子节点；新版 DSH 会在重绘时移除它，
        // 与 MutationObserver 互相触发，最终阻塞客户端插件装配。
        if (document.body.contains(menuEl)) {
          positionMenu(tree)
          return
        }
        menuEl.remove()
      }
      menuEl = document.createElement('button')
      menuEl.type = 'button'
      menuEl.className = 'dws-menu'
      menuEl.setAttribute('data-plugin', 'dsh-web-sites')
      menuEl.title = '我的网站系统'
      menuEl.setAttribute('aria-label', '我的网站系统')
      const icon = document.createElement('span')
      icon.className = 'dws-menu-icon'
      icon.textContent = '🌐'
      const label = document.createElement('span')
      label.className = 'dws-menu-label'
      label.textContent = '我的网站系统'
      const count = document.createElement('span')
      count.className = 'dws-menu-count'
      count.textContent = `${sites.length}`
      const caret = document.createElement('span')
      caret.className = 'dws-menu-caret'
      caret.textContent = '›'
      menuEl.append(icon, label, count, caret)
      menuEl.addEventListener('click', () => toggleList())
      if (listOpen) menuEl.setAttribute('data-active', 'true')
      document.body.append(menuEl)
      positionMenu(tree)
    }

    /**
     * 菜单脱离 React 树后仍贴在会话树上方；布局变化由 ResizeObserver 与
     * 自愈扫描驱动，避免直接改写 React 管理的 DOM。
     */
    function positionMenu(tree = sidebarTree()) {
      if (menuEl === null || !(tree instanceof HTMLElement)) return
      const rect = tree.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        menuEl.style.display = 'none'
        return
      }
      const height = menuEl.getBoundingClientRect().height || 30
      menuEl.style.display = 'flex'
      menuEl.style.left = `${Math.round(rect.left)}px`
      menuEl.style.top = `${Math.max(8, Math.round(rect.top - height - 4))}px`
      menuEl.style.width = `${Math.round(rect.width)}px`
    }

    /**
     * The sidebar workspace/session tree (stable structural hook). The session
     * list is the FIRST [role=tree] inside the app frame — DOM order is stable
     * even when a search-results tree mounts later, so we never follow it.
     */
    function sidebarTree() {
      const frame = frameEl()
      const scope = frame instanceof HTMLElement ? frame : document
      return scope.querySelector('[role="tree"]')
    }

    /** Refresh the sidebar menu row badge (site count). */
    function refreshMenu() {
      if (menuEl === null) return
      const count = $('.dws-menu-count', menuEl)
      if (count) count.textContent = `${sites.length}`
    }

    // ---------------------------------------------------------------- list
    function renderList() {
      if (!listEl) return
      const body = $('.dws-list-body', listEl)
      body.replaceChildren()
      if (sites.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'dws-list-empty'
        empty.textContent = '还没有配置站点\n点下方「管理」添加，或编辑 ~/.dsh/sites.yaml'
        body.append(empty)
        return
      }
      for (const site of sites) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'dws-site'
        row.title = `${site.name}\n${site.url}`
        const icon = document.createElement('span')
        icon.className = 'dws-site-icon'
        icon.textContent = site.icon || '🌐'
        const meta = document.createElement('span')
        meta.className = 'dws-site-meta'
        const name = document.createElement('div')
        name.className = 'dws-site-name'
        name.textContent = site.name
        const url = document.createElement('div')
        url.className = 'dws-site-url'
        url.textContent = site.url
        meta.append(name, url)
        row.append(icon, meta)
        row.addEventListener('click', () => openSite(site))
        body.append(row)
      }
    }

    function openList() {
      listOpen = true
      menuEl?.setAttribute('data-active', 'true')
      ensureMenu()
      if (listEl === null) {
        listEl = document.createElement('div')
        listEl.className = 'dws-list'
        listEl.setAttribute('data-plugin', 'dsh-web-sites')

        const head = document.createElement('div')
        head.className = 'dws-list-head'
        const title = document.createElement('span')
        title.textContent = '🌐 我的网站系统'
        const note = document.createElement('span')
        note.className = 'dws-list-head-note'
        note.textContent = `${sites.length} 个`
        head.append(title, note)

        const body = document.createElement('div')
        body.className = 'dws-list-body'

        const foot = document.createElement('div')
        foot.className = 'dws-list-foot'
        const manageBtn = document.createElement('button')
        manageBtn.type = 'button'
        manageBtn.className = 'dws-btn'
        manageBtn.dataset.kind = 'manage'
        manageBtn.textContent = '⚙ 管理站点'
        manageBtn.addEventListener('click', () => {
          closeList()
          openManage()
        })
        foot.append(manageBtn)

        listEl.append(head, body, foot)
        document.body.append(listEl)
        resizeObserver?.observe(listEl)
      }
      renderList()
      positionList()
    }

    function closeList() {
      listOpen = false
      menuEl?.removeAttribute('data-active')
      listEl?.remove()
      listEl = null
    }

    function toggleList() {
      if (listOpen) closeList()
      else openList()
    }

    /** Anchor the dropdown right below the sidebar menu row, sidebar-wide. */
    function positionList() {
      if (!listEl) return
      const { sidebar } = layoutWidths()
      const width = Math.max(180, sidebar)
      let top = 120
      if (menuEl instanceof HTMLElement && menuEl.offsetHeight > 0) {
        top = menuEl.getBoundingClientRect().bottom + 2
      }
      // clamp: never run past the viewport bottom
      const maxTop = Math.max(0, window.innerHeight - 80)
      if (top > maxTop) top = maxTop
      listEl.style.width = `${width}px`
      listEl.style.top = `${top}px`
    }

    // ---------------------------------------------------------------- panel
    function openSite(site) {
      closeList()
      panelOpenId = site.id
      try { localStorage.setItem(LS_OPEN_KEY, site.id) } catch { /* ignore */ }
      renderPanel(site)
      positionPanel()
    }

    function renderPanel(site) {
      if (panelEl !== null) panelEl.remove()
      panelEl = document.createElement('div')
      panelEl.className = 'dws-panel'
      panelEl.setAttribute('data-plugin', 'dsh-web-sites')

      const head = document.createElement('div')
      head.className = 'dws-panel-head'

      const title = document.createElement('div')
      title.className = 'dws-panel-title'
      title.textContent = `${site.icon || '🌐'} ${site.name}`

      const hint = document.createElement('span')
      hint.className = 'dws-panel-hint'
      hint.textContent = '空白或需登录？点「新标签」'

      const refreshBtn = iconButton('⟳', '刷新', () => refreshFrame())
      const newTabBtn = iconButton('↗', '在新标签页打开', () => {
        window.open(site.url, '_blank', 'noopener')
      })
      const manageBtn = iconButton('⚙', '管理站点', () => openManage())
      const closeBtn = iconButton('✕', '关闭', () => closePanel())

      head.append(title, hint, refreshBtn, newTabBtn, manageBtn, closeBtn)

      const body = document.createElement('div')
      body.className = 'dws-panel-body'

      const loading = document.createElement('div')
      loading.className = 'dws-panel-loading'
      loading.textContent = '加载中…'

      const frame = document.createElement('iframe')
      frame.className = 'dws-panel-frame'
      frame.setAttribute('data-site-id', site.id)
      frame.title = site.name
      frame.referrerPolicy = 'no-referrer-when-downgrade'
      frame.addEventListener('load', () => {
        loading.remove()
        frame.classList.remove('dws-hidden')
      })

      body.append(frame, loading)
      panelEl.append(head, body)
      document.body.append(panelEl)

      // kick off the load
      frame.classList.add('dws-hidden')
      frame.src = site.url

      resizeObserver?.observe(panelEl)
    }

    function refreshFrame() {
      if (!panelEl) return
      const frame = $('.dws-panel-frame', panelEl)
      if (!frame) return
      const loading = $('.dws-panel-loading', panelEl)
      const src = frame.src
      if (loading) loading.style.display = 'grid'
      frame.classList.add('dws-hidden')
      // force reload by clearing and re-setting src
      frame.removeAttribute('src')
      // rAF so the src clear is committed before we re-assign
      requestAnimationFrame(() => {
        frame.src = src
        if (loading) loading.style.display = ''
      })
    }

    function closePanel() {
      panelOpenId = null
      try { localStorage.removeItem(LS_OPEN_KEY) } catch { /* ignore */ }
      panelEl?.remove()
      panelEl = null
    }

    function positionPanel() {
      if (!panelEl) return
      const { sidebar, rightbar } = layoutWidths()
      const left = Math.max(0, sidebar)
      const right = rightbar > 0 ? rightbar : 0
      panelEl.style.left = `${left}px`
      panelEl.style.right = `${right}px`
    }

    // ---------------------------------------------------------------- manage
    function openManage() {
      manageOpen = true
      if (manageEl !== null) return
      manageEl = document.createElement('div')
      manageEl.className = 'dws-manage-mask'
      manageEl.setAttribute('data-plugin', 'dsh-web-sites')

      const panel = document.createElement('div')
      panel.className = 'dws-manage'

      const head = document.createElement('div')
      head.className = 'dws-manage-head'
      const headText = document.createElement('div')
      const title = document.createElement('div')
      title.className = 'dws-manage-title'
      title.textContent = '⚙ 管理网站系统'
      const sub = document.createElement('div')
      sub.className = 'dws-manage-sub'
      sub.textContent = '保存在 ~/.dsh/sites.yaml'
      headText.append(title, sub)
      const closeX = iconButton('✕', '关闭', () => closeManage())
      head.append(headText, closeX)

      const body = document.createElement('div')
      body.className = 'dws-manage-body'

      const foot = document.createElement('div')
      foot.className = 'dws-manage-foot'
      const addBtn = document.createElement('button')
      addBtn.type = 'button'
      addBtn.className = 'dws-btn'
      addBtn.textContent = '+ 添加站点'
      addBtn.addEventListener('click', () => {
        const draft = { id: '', name: '', url: '', icon: '', tags: [] }
        body.append(siteCard(draft, true))
        siteCardFocusFirst(body.lastChild)
      })
      const actions = document.createElement('div')
      actions.className = 'dws-manage-foot-actions'
      const cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.className = 'dws-btn'
      cancelBtn.textContent = '取消'
      cancelBtn.addEventListener('click', () => closeManage())
      const saveBtn = document.createElement('button')
      saveBtn.type = 'button'
      saveBtn.className = 'dws-btn'
      saveBtn.dataset.kind = 'primary'
      saveBtn.textContent = '保存'
      saveBtn.addEventListener('click', () => doSave())
      actions.append(cancelBtn, saveBtn)
      foot.append(addBtn, actions)

      panel.append(head, body, foot)
      manageEl.append(panel)
      document.body.append(manageEl)

      renderManageCards()
    }

    function siteCardFocusFirst(card) {
      const input = card?.querySelector('.dws-input')
      if (input) {
        input.focus()
        input.select()
      }
    }

    function siteCard(site, isNew) {
      const card = document.createElement('div')
      card.className = 'dws-site-card'
      card.dataset.siteId = site.id

      const mkRow = (label, input) => {
        const row = document.createElement('div')
        row.className = 'dws-row'
        const lab = document.createElement('label')
        lab.textContent = label
        row.append(lab, input)
        return row
      }
      const mkInput = (value, placeholder) => {
        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'dws-input'
        input.value = value
        input.placeholder = placeholder
        return input
      }

      const iconInput = mkInput(site.icon || '', '🌐')
      iconInput.className += ' dws-input-icon'
      iconInput.maxLength = 4
      iconInput.title = '图标（1-2 个字符）'
      const iconRow = document.createElement('div')
      iconRow.className = 'dws-row'
      iconRow.append(iconInput)

      const nameRow = mkRow('名称', mkInput(site.name, '站点名称'))
      const urlRow = mkRow('地址', mkInput(site.url, 'http://localhost:8080'))

      const foot = document.createElement('div')
      foot.className = 'dws-card-foot'
      if (!isNew) {
        const delBtn = document.createElement('button')
        delBtn.type = 'button'
        delBtn.className = 'dws-btn'
        delBtn.dataset.kind = 'danger'
        delBtn.textContent = '删除'
        delBtn.addEventListener('click', () => card.remove())
        foot.append(delBtn)
      }

      card.append(iconRow, nameRow, urlRow, foot)
      return card
    }

    function renderManageCards() {
      const body = $('.dws-manage-body', manageEl)
      body.replaceChildren()
      for (const site of sites) {
        body.append(siteCard(site, false))
      }
    }

    /** Collect editable drafts from the DOM cards and normalise into sites[]. */
    function collectDrafts() {
      const out = []
      if (!manageEl) return out
      for (const card of manageEl.querySelectorAll('.dws-site-card')) {
        const inputs = card.querySelectorAll('input.dws-input')
        const icon = inputs[0]?.value.trim() || ''
        const name = inputs[1]?.value.trim() || ''
        const url = inputs[2]?.value.trim() || ''
        if (name === '' || url === '') continue
        const old = card.dataset.siteId ? siteById.get(card.dataset.siteId) : null
        out.push({
          id: old?.id || slugifyClient(name),
          name,
          url,
          icon: icon || '🌐',
          tags: old?.tags || [],
        })
      }
      return out
    }

    function slugifyClient(text) {
      const base = String(text).trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '')
      return base || `site-${Math.random().toString(36).slice(2, 8)}`
    }

    async function doSave() {
      const drafts = collectDrafts()
      try {
        const saved = await saveSites(drafts)
        sites = saved
        siteById = new Map(saved.map(s => [s.id, s]))
        closeManage()
        if (listOpen) renderList()
        refreshMenu()
        showToast(`已保存 ${saved.length} 个站点`)
      } catch (error) {
        showToast(`保存失败：${error.message}`)
      }
    }

    function closeManage() {
      manageOpen = false
      manageEl?.remove()
      manageEl = null
    }

    // ------------------------------------------------------- small ui helpers
    function iconButton(label, tip, onClick) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'dws-btn'
      btn.dataset.kind = 'ghost'
      btn.textContent = label
      btn.title = tip
      btn.setAttribute('aria-label', tip)
      btn.addEventListener('click', onClick)
      return btn
    }

    // ------------------------------------------------------------ lifecycle
    async function reloadSites() {
      try {
        sites = await fetchSites()
        siteById = new Map(sites.map(s => [s.id, s]))
      } catch (error) {
        console.warn('[dsh-web-sites] 拉取站点失败:', error)
        sites = []
        siteById = new Map()
      }
      if (listOpen) renderList()
      refreshMenu()
    }

    /** Re-inject the sidebar menu if the shell re-rendered; re-anchor geometry. */
    function sweep() {
      if (ctx === null || !mounted) return
      ensureMenu()
      refreshMenu()
      positionMenu()
      if (listOpen) positionList()
      if (panelEl !== null && panelOpenId !== null) positionPanel()
      // restore an open site after a reload
      if (panelEl === null && panelOpenId === null) {
        try {
          const saved = localStorage.getItem(LS_OPEN_KEY)
          if (saved) {
            const site = siteById.get(saved)
            if (site) openSite(site)
          }
        } catch { /* ignore */ }
      }
    }

    /**
     * Click-away wiring: when a site panel is open, clicking any sidebar
     * workspace/session row ([role=treeitem]) dismisses the panel so the
     * conversation shows through — the user asked for exactly this flow.
     * Capture-phase delegation on document; ignores clicks inside our own UI.
     */
    function onDocumentClick(event) {
      if (panelEl === null || panelOpenId === null) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[data-plugin="dsh-web-sites"]')) return
      const row = target.closest('[role="treeitem"]')
      if (row instanceof Element) closePanel()
    }

    function dispose() {
      document.removeEventListener('click', onDocumentClick, true)
      observer?.disconnect()
      observer = null
      resizeObserver?.disconnect()
      resizeObserver = null
      closeList()
      closePanel()
      closeManage()
      menuEl?.remove()
      menuEl = null
      document.getElementById('dsh-web-sites-styles')?.remove()
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = 0 }
      if (toastEl !== null) { toastEl.remove(); toastEl = null }
      mounted = false
      ctx = null
    }

    // ------------------------------------------------------------------ apply
    function mount(clientCtx) {
      try {
        ctx = clientCtx
        mounted = true
        ensureStyles()
        ensureMenu()

        // self-heal: re-inject menu + re-anchor on shell re-render / resize
        observer = new MutationObserver(() => { sweep() })
        observer.observe(document.body, { childList: true, subtree: true })

        resizeObserver = new ResizeObserver(() => { sweep() })
        const frame = frameEl()
        if (frame) resizeObserver.observe(frame)

        // clicking a sidebar session/workspace row collapses the open site panel
        document.addEventListener('click', onDocumentClick, true)

        void reloadSites().then(() => { sweep() })
      } catch (error) {
        console.warn('[dsh-web-sites] mount failed:', error)
      }
    }

    function apply(clientCtx) {
      // 插件装配阶段只登记生命周期；等核心 UI 先完成首次渲染后再触碰 DOM，
      // 防止侧边栏仍在由 React 建树时发生竞争，卡住 "Loading plugins"。
      let disposed = false
      const timer = setTimeout(() => {
        if (!disposed) mount(clientCtx)
      }, 0)
      clientCtx.effect(() => () => {
        disposed = true
        clearTimeout(timer)
        dispose()
      }, 'dsh-web-sites: inject')
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
