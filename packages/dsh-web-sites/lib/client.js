/**
 * dsh-web-sites — browser half (runs inside the dsh web GUI).
 *
 * A site launcher for your own web systems, all inside the GUI:
 *
 *   - 菜单「🌐 我的网站系统」挂在 body，锚定 sidebar.workspaces 插槽。
 *     工作区容器通过 CSS 预留菜单高度，位于新会话下方、工作区标题上方；
 *     不插入 React 管理的子节点，MutationObserver 负责幂等自愈。
 *   - Clicking the menu drops a floating site list anchored right below it
 *     (position:fixed on document.body, aligned to the menu edges). The list
 *     has a quick-search box, keyboard navigation (↑/↓/Enter/Esc), a hover
 *     "↗" per row to open in a new tab, and dismisses on outside click / Esc.
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
    let resizeTarget = null
    let sites = []
    let siteById = new Map()
    let mounted = false
    // ui flags (kept on the DOM data attributes, mirrored here for logic)
    let listOpen = false
    let panelOpenId = null
    let manageOpen = false
    let listQuery = ''

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
/* 为悬浮菜单保留真实布局空间，避免覆盖工作区标题。 */
[data-slot="sidebar.workspaces"] > :first-child {
  padding-block-start: 36px;
}
body:has([data-sidebar-collapsed="true"]) .dws-menu,
body:has([data-sidebar-collapsed="true"]) .dws-list {
  display: none !important;
}
.dws-menu {
  all: unset;
  box-sizing: border-box;
  position: fixed;
  z-index: 80;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
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

/* ---- site list: floating panel anchored below the sidebar menu row ---- */
.dws-list {
  position: fixed;
  z-index: 49;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff));
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.10));
  border-radius: 12px;
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,0.16));
  transform-origin: top left;
  animation: dws-list-in .16s cubic-bezier(0.2, 0.8, 0.4, 1);
  overflow: hidden;
}
@keyframes dws-list-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.dws-list-head {
  flex: 0 0 auto;
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
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 400;
  line-height: 16px;
  padding: 0 8px;
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary, #666);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
}
.dws-search {
  flex: 0 0 auto;
  position: relative;
  padding: 0 12px 8px;
}
.dws-search-input {
  all: unset;
  box-sizing: border-box;
  display: block;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.14));
  border-radius: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03));
  transition: border-color .12s ease, background-color .12s ease;
}
.dws-search-input::placeholder { color: var(--dsw-alias-label-tertiary, #999); }
.dws-search-input:hover { border-color: var(--dsw-alias-border-l2, rgba(0,0,0,0.20)); }
.dws-search-input:focus {
  border-color: var(--dsw-alias-button-info-fill, #4d6bfe);
  background: var(--dsw-alias-bg-base, #fff);
}
.dws-search-clear {
  all: unset;
  position: absolute;
  top: 15px;
  right: 20px;
  transform: translateY(-50%);
  display: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
  color: var(--dsw-alias-label-tertiary, #999);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.08));
}
.dws-search[data-filled="true"] .dws-search-clear { display: inline-flex; }
.dws-search-clear:hover { color: var(--dsw-alias-label-primary, #1a1a1a); }
.dws-search-clear:focus-visible {
  outline: 2px solid var(--dsw-alias-button-info-fill, #4d6bfe);
}
.dws-list-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-border-l3, rgba(0,0,0,0.15)) transparent;
}
.dws-list-body::-webkit-scrollbar { width: 6px; }
.dws-list-body::-webkit-scrollbar-thumb {
  border-radius: 3px;
  background: var(--dsw-alias-border-l3, rgba(0,0,0,0.15));
}
.dws-list-body::-webkit-scrollbar-track { background: transparent; }
.dws-site {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 8px 7px 10px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  transition: background-color .12s ease;
}
.dws-site:hover,
.dws-site:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
}
.dws-site:active {
  background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.10));
}
.dws-site:focus-visible {
  outline: 2px solid var(--dsw-alias-button-info-fill, #4d6bfe);
  outline-offset: -2px;
}
.dws-site[data-current="true"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
  box-shadow: inset 2px 0 0 var(--dsw-alias-button-info-fill, #4d6bfe);
}
.dws-site-icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  font-size: 15px;
  line-height: 1;
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.05));
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
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-tertiary, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dws-site-tab {
  all: unset;
  box-sizing: border-box;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  color: var(--dsw-alias-label-tertiary, #999);
  opacity: 0;
  transition: opacity .12s ease, color .12s ease, background-color .12s ease;
}
.dws-site:hover .dws-site-tab,
.dws-site:focus-within .dws-site-tab,
.dws-site-tab:focus-visible { opacity: 1; }
.dws-site-tab:hover {
  color: var(--dsw-alias-label-primary, #1a1a1a);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.10));
}
.dws-site-tab:focus-visible {
  outline: 2px solid var(--dsw-alias-button-info-fill, #4d6bfe);
}
.dws-list-empty {
  flex: 0 0 auto;
  padding: 20px 12px;
  text-align: center;
  font-size: 12px;
  line-height: 20px;
  white-space: pre-line;
  color: var(--dsw-alias-label-tertiary, #999);
}
.dws-list-empty .dws-btn { margin-top: 10px; }
@media (prefers-reduced-motion: reduce) {
  .dws-list { animation: none; }
  .dws-site, .dws-site-tab, .dws-search-input { transition: none; }
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

    /** 菜单挂在 body，工作区插槽只用 CSS 占位，不改动 React 子节点。 */
    function ensureMenu() {
      const workspace = workspaceRoot()
      if (workspace !== resizeTarget && resizeObserver) {
        if (resizeTarget) resizeObserver.unobserve(resizeTarget)
        resizeTarget = workspace instanceof HTMLElement ? workspace : null
        if (resizeTarget) resizeObserver.observe(resizeTarget)
      }
      if (!(workspace instanceof HTMLElement)) {
        menuEl?.remove()
        return
      }
      if (menuEl !== null) {
        // 保持菜单在 React 树外，自愈时只更新几何位置。
        if (document.body.contains(menuEl)) {
          positionMenu(workspace)
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
      positionMenu(workspace)
    }

    /**
     * 使用包含标题的工作区容器定位，不能用标题下方的会话树反推位置。
     * 找不到稳定插槽时不显示菜单，避免猜测位置遮挡宿主操作。
     */
    function positionMenu(workspace = workspaceRoot()) {
      if (menuEl === null || !(workspace instanceof HTMLElement)) return
      const rect = workspace.getBoundingClientRect()
      if (frameEl()?.getAttribute('data-sidebar-collapsed') === 'true' || rect.width < 120 || rect.height <= 0) {
        menuEl.style.display = 'none'
        if (listOpen) closeList()
        return
      }
      menuEl.style.display = 'flex'
      menuEl.style.left = `${Math.round(rect.left)}px`
      menuEl.style.top = `${Math.round(rect.top)}px`
      menuEl.style.width = `${Math.round(rect.width - 12)}px`
    }

    function workspaceRoot() {
      return document.querySelector('[data-slot="sidebar.workspaces"]')?.firstElementChild
    }

    /** Refresh the sidebar menu row badge (site count). */
    function refreshMenu() {
      if (menuEl === null) return
      const count = $('.dws-menu-count', menuEl)
      // 相同 textContent 赋值也会替换文本节点，触发 childList 监听。
      // 自愈扫描必须幂等，否则 sweep → refreshMenu → observer 会无限循环。
      const nextCount = `${sites.length}`
      if (count && count.textContent !== nextCount) count.textContent = nextCount
    }

    // ---------------------------------------------------------------- list
    function siteMatches(site, query) {
      if (query === '') return true
      const q = query.toLowerCase()
      if (site.name.toLowerCase().includes(q) || site.url.toLowerCase().includes(q)) return true
      return Array.isArray(site.tags) && site.tags.some(tag => String(tag).toLowerCase().includes(q))
    }

    /** 在新标签打开；列表保持展开，方便连续打开多个站点。 */
    function openSiteExternal(site) {
      window.open(site.url, '_blank', 'noopener')
    }

    function siteRow(site) {
      const row = document.createElement('div')
      row.className = 'dws-site'
      row.setAttribute('role', 'button')
      row.tabIndex = 0
      if (site.id === panelOpenId) row.dataset.current = 'true'
      row.title = `${site.name} · ${site.url}\n点击打开；Ctrl/⌘+点击或 ↗ 在新标签打开`
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
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'dws-site-tab'
      tab.textContent = '↗'
      tab.title = '在新标签页打开'
      tab.setAttribute('aria-label', `在新标签页打开 ${site.name}`)
      tab.addEventListener('click', event => {
        event.stopPropagation()
        openSiteExternal(site)
      })
      row.addEventListener('click', event => {
        if (event.metaKey || event.ctrlKey) {
          openSiteExternal(site)
          return
        }
        openSite(site)
      })
      row.addEventListener('auxclick', event => {
        if (event.button === 1) {
          event.preventDefault()
          openSiteExternal(site)
        }
      })
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openSite(site)
        }
      })
      row.append(icon, meta, tab)
      return row
    }

    function renderList() {
      if (!listEl) return
      const body = $('.dws-list-body', listEl)
      const note = $('.dws-list-head-note', listEl)
      body.replaceChildren()
      if (sites.length === 0) {
        if (note) note.textContent = '0 个'
        const empty = document.createElement('div')
        empty.className = 'dws-list-empty'
        empty.textContent = '还没有配置站点\n编辑 ~/.dsh/sites.yaml，或点下方按钮添加'
        const addBtn = document.createElement('button')
        addBtn.type = 'button'
        addBtn.className = 'dws-btn'
        addBtn.textContent = '＋ 添加第一个站点'
        addBtn.addEventListener('click', () => {
          closeList()
          openManage()
        })
        empty.append(addBtn)
        body.append(empty)
        return
      }
      const visible = sites.filter(site => siteMatches(site, listQuery))
      if (note) {
        note.textContent = listQuery === '' ? `${sites.length} 个` : `${visible.length}/${sites.length}`
      }
      if (visible.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'dws-list-empty'
        empty.textContent = `没有匹配「${listQuery}」的站点`
        body.append(empty)
        return
      }
      for (const site of visible) body.append(siteRow(site))
    }

    function openList() {
      listOpen = true
      menuEl?.setAttribute('data-active', 'true')
      ensureMenu()
      if (listEl === null) {
        listEl = document.createElement('div')
        listEl.className = 'dws-list'
        listEl.setAttribute('data-plugin', 'dsh-web-sites')
        listEl.setAttribute('role', 'dialog')
        listEl.setAttribute('aria-label', '我的网站系统')

        const head = document.createElement('div')
        head.className = 'dws-list-head'
        const title = document.createElement('span')
        title.textContent = '🌐 我的网站系统'
        const note = document.createElement('span')
        note.className = 'dws-list-head-note'
        head.append(title, note)

        const search = document.createElement('div')
        search.className = 'dws-search'
        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'dws-search-input'
        input.placeholder = '搜索站点…'
        input.setAttribute('aria-label', '搜索站点')
        input.spellcheck = false
        const clearBtn = document.createElement('button')
        clearBtn.type = 'button'
        clearBtn.className = 'dws-search-clear'
        clearBtn.textContent = '✕'
        clearBtn.title = '清除搜索'
        clearBtn.setAttribute('aria-label', '清除搜索')
        search.append(input, clearBtn)

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

        listEl.append(head, search, body, foot)
        document.body.append(listEl)
        resizeObserver?.observe(listEl)

        input.addEventListener('input', () => {
          listQuery = input.value
          search.dataset.filled = listQuery === '' ? 'false' : 'true'
          renderList()
        })
        clearBtn.addEventListener('click', () => {
          input.value = ''
          listQuery = ''
          search.dataset.filled = 'false'
          renderList()
          input.focus({ preventScroll: true })
        })
        listEl.addEventListener('keydown', onListKeydown)
      } else {
        // 兜底：重复 openList 时重置上一次的搜索词
        const staleInput = $('.dws-search-input', listEl)
        const staleSearch = $('.dws-search', listEl)
        listQuery = ''
        if (staleInput) staleInput.value = ''
        if (staleSearch) staleSearch.dataset.filled = 'false'
      }
      renderList()
      positionList()
      const input = $('.dws-search-input', listEl)
      if (input && typeof input.focus === 'function') input.focus({ preventScroll: true })
    }

    function closeList() {
      if (!listOpen && listEl === null) return
      listOpen = false
      menuEl?.removeAttribute('data-active')
      const hadFocus = listEl !== null
        && document.activeElement instanceof Element
        && listEl.contains(document.activeElement)
      listEl?.remove()
      listEl = null
      listQuery = ''
      if (hadFocus && menuEl && typeof menuEl.focus === 'function') {
        menuEl.focus({ preventScroll: true })
      }
    }

    function toggleList() {
      if (listOpen) closeList()
      else openList()
    }

    /** 列表内键盘导航：↑/↓ 在搜索框与站点行间循环，Enter 打开首个匹配。 */
    function onListKeydown(event) {
      if (!listOpen || !listEl) return
      const active = document.activeElement
      const input = $('.dws-search-input', listEl)
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (active === input && listQuery !== '') {
          input.value = ''
          listQuery = ''
          const search = $('.dws-search', listEl)
          if (search) search.dataset.filled = 'false'
          renderList()
          return
        }
        closeList()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return
      const rows = typeof listEl.querySelectorAll === 'function'
        ? Array.from(listEl.querySelectorAll('.dws-site'))
        : []
      if (event.key === 'Enter') {
        if (active === input && rows.length > 0 && typeof rows[0].click === 'function') rows[0].click()
        return
      }
      event.preventDefault()
      if (rows.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const idx = rows.indexOf(active)
      if (idx === -1) {
        const target = delta === 1 ? rows[0] : rows[rows.length - 1]
        if (typeof target.focus === 'function') target.focus({ preventScroll: true })
        return
      }
      const next = idx + delta
      if (next < 0 || next >= rows.length) {
        if (input && typeof input.focus === 'function') input.focus({ preventScroll: true })
        return
      }
      if (typeof rows[next].focus === 'function') rows[next].focus({ preventScroll: true })
    }

    /**
     * Anchor the floating panel right below the sidebar menu row, aligned to
     * the menu edges; clamp into the viewport and cap the max height.
     */
    function positionList() {
      if (!listEl) return
      let left = 0
      let width = Math.max(220, layoutWidths().sidebar)
      let top = 120
      if (menuEl instanceof HTMLElement && menuEl.offsetHeight > 0) {
        const rect = menuEl.getBoundingClientRect()
        left = rect.left
        width = Math.max(220, rect.width)
        top = rect.bottom + 4
      }
      // clamp: never run past the viewport bottom
      const maxTop = Math.max(0, window.innerHeight - 80)
      if (top > maxTop) top = maxTop
      const maxHeight = Math.min(
        Math.max(160, window.innerHeight - top - 12),
        Math.round(window.innerHeight * 0.7),
      )
      listEl.style.left = `${Math.round(left)}px`
      listEl.style.width = `${Math.round(width)}px`
      listEl.style.top = `${Math.round(top)}px`
      listEl.style.maxHeight = `${maxHeight}px`
    }

    // ---------------------------------------------------------------- panel
    function openSite(site) {
      closeList()
      // embed: false 的站点直接新标签打开，避开 iframe 第三方 Cookie 拦截
      if (site.embed === false) {
        panelOpenId = null
        try { localStorage.removeItem(LS_OPEN_KEY) } catch { /* ignore */ }
        window.open(site.url, '_blank', 'noopener')
        return
      }
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
      // 面板关闭后，若列表恰好展开则刷新「使用中」高亮
      if (listOpen) renderList()
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
      // 点遮罩空白处关闭（点在对话框内部不关）
      manageEl.addEventListener('click', event => {
        if (event.target === manageEl) closeManage()
      })

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
            if (site && site.embed !== false) openSite(site)
          }
        } catch { /* ignore */ }
      }
    }

    /**
     * Click-away wiring (capture-phase delegation on document):
     *   - clicking outside an open site list dismisses the list;
     *   - when a site panel is open, clicking any sidebar workspace/session
     *     row ([role=treeitem]) dismisses the panel so the conversation shows
     *     through — the user asked for exactly this flow.
     * Clicks inside our own UI ([data-plugin=dsh-web-sites]) are ignored.
     */
    function onDocumentClick(event) {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[data-plugin="dsh-web-sites"]')) return
      if (listOpen) closeList()
      if (panelEl !== null && panelOpenId !== null) {
        const row = target.closest('[role="treeitem"]')
        if (row instanceof Element) closePanel()
      }
    }

    /** Esc：优先关管理对话框，其次关站点列表（焦点在列表内时由列表自行处理）。 */
    function onDocumentKeydown(event) {
      if (event.key !== 'Escape') return
      if (manageOpen) {
        closeManage()
        return
      }
      if (listOpen) closeList()
    }

    function dispose() {
      document.removeEventListener('click', onDocumentClick, true)
      document.removeEventListener('keydown', onDocumentKeydown)
      observer?.disconnect()
      observer = null
      resizeObserver?.disconnect()
      resizeObserver = null
      resizeTarget = null
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
        resizeObserver = new ResizeObserver(() => { sweep() })
        ensureMenu()

        // self-heal: re-inject menu + re-anchor on shell re-render / resize
        observer = new MutationObserver(() => { sweep() })
        observer.observe(document.body, { childList: true, subtree: true })

        const frame = frameEl()
        if (frame) resizeObserver.observe(frame)

        // clicking a sidebar session/workspace row collapses the open site panel
        document.addEventListener('click', onDocumentClick, true)
        // Esc closes the manage dialog / site list
        document.addEventListener('keydown', onDocumentKeydown)

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
