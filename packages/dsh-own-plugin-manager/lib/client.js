/**
 * dsh-own-plugin-manager — browser half (runs inside the dsh web GUI).
 *
 * 侧边栏「🔌 插件管理」入口 + 悬浮管理面板：
 *
 *   - 菜单行锚定 sidebar.workspaces 插槽（与 dsh-web-sites 共存：若检测到
 *     其菜单存在，则定位在其下方并动态加大插槽顶部留白）。
 *   - 徽标显示可用更新总数（npm/github/tgz 新版本 + link 源码变化）。
 *   - 面板：profile 分组 chips、每插件一行（版本/来源徽标/自研★/启停
 *     开关/更新徽标）、「检查更新」按钮、link 源码更新「已生效」基线对齐。
 *   - 启停走 host 半边行级 patch profile cordis.patch.yml（保留注释），
 *     改动需 profile 重载/重启生效，UI 有明确提示。
 *
 * Implementation notes
 * --------------------
 * - 面板/菜单挂在 document.body（React 树外，position:fixed），幂等挂载，
 *   MutationObserver 自愈；挂载失败仅 console.warn，绝不阻断 GUI。
 * - 配色全部走 --dsw-alias-* / --dsw-specific-* token，自动跟随明暗主题；
 *   只用纯色，不用渐变。
 * - API：GET /api/dsh-opm/state、POST refresh/toggle/ack（loopback 围栏内）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-own-plugin-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ------------------------------------------------------------- constants
    const API_STATE = '/api/dsh-opm/state'
    const API_REFRESH = '/api/dsh-opm/refresh'
    const API_TOGGLE = '/api/dsh-opm/toggle'
    const API_ACK = '/api/dsh-opm/ack'
    const ROOT = 'opm'
    const SOURCE_LABEL = { npm: 'npm', github: 'GitHub', link: '本地', tarball: '发布包', other: '其他' }

    // ------------------------------------------------------------------ state
    let ctx = null
    let observer = null
    let menuEl = null
    let panelEl = null
    let view = null            // latest /state payload
    let activeProfile = ''     // '' = all profiles
    let loading = false
    let refreshing = false
    let toastEl = null
    let toastTimer = null

    // ---------------------------------------------------------------- helpers
    function $(sel, root) { return (root || document).querySelector(sel) }
    function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)) }

    function el(tag, props = {}, children = []) {
      const node = document.createElement(tag)
      for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key === 'html') node.innerHTML = value
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
        else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : value)
      }
      for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue
        node.append(child.nodeType ? child : document.createTextNode(String(child)))
      }
      return node
    }

    /** 相对时间：3 分钟前 / 2 小时前 / —。 */
    function timeAgo(iso) {
      if (!iso) return '—'
      const ms = Date.now() - Date.parse(iso)
      if (!Number.isFinite(ms) || ms < 0) return '—'
      const min = Math.floor(ms / 60000)
      if (min < 1) return '刚刚'
      if (min < 60) return `${min} 分钟前`
      const hours = Math.floor(min / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.floor(hours / 24)} 天前`
    }

    function toast(message, tone = 'info') {
      try {
        if (toastEl === null) {
          toastEl = el('div', { class: `${ROOT}-toast`, role: 'status' })
          document.body.append(toastEl)
        }
        toastEl.dataset.tone = tone
        toastEl.textContent = message
        toastEl.dataset.show = 'true'
        clearTimeout(toastTimer)
        toastTimer = setTimeout(() => { if (toastEl) toastEl.dataset.show = 'false' }, 2600)
      } catch (error) { console.warn('[own-plugin-manager] toast failed', error) }
    }

    async function apiGet(url) {
      const res = await fetch(url, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }
    async function apiPost(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    // ------------------------------------------------------------------ data
    async function loadState() {
      loading = true
      renderPanel()
      try {
        view = await apiGet(API_STATE)
      } catch (error) {
        toast(`插件状态加载失败：${error.message}`, 'error')
        view = { profiles: [], updateCount: 0, checkedAt: null, error: error.message }
      } finally {
        loading = false
        renderPanel()
        refreshMenuBadge()
      }
    }

    async function checkUpdates() {
      refreshing = true
      renderPanel()
      try {
        const data = await apiPost(API_REFRESH, { force: true })
        view = data.view || view
        const count = view?.updateCount || 0
        toast(count > 0 ? `检测完成：${count} 个可用更新` : '检测完成：全部插件均为最新', 'ok')
      } catch (error) {
        toast(`检测失败：${error.message}`, 'error')
      } finally {
        refreshing = false
        renderPanel()
        refreshMenuBadge()
      }
    }

    async function togglePlugin(profileName, plugin) {
      const next = !plugin.disabled
      try {
        await apiPost(API_TOGGLE, { profile: profileName, plugin: plugin.pkg, disabled: next })
        plugin.disabled = next
        toast(next ? `已停用 ${plugin.pkg}（重载 profile 后生效）` : `已启用 ${plugin.pkg}（重载 profile 后生效）`, 'ok')
        renderPanel()
      } catch (error) {
        toast(`启停失败：${error.message}`, 'error')
      }
    }

    async function ackPlugin(profileName, plugin) {
      try {
        await apiPost(API_ACK, { profile: profileName, plugin: plugin.pkg })
        if (plugin.check) { plugin.check.hasUpdate = false }
        toast(`已确认 ${plugin.pkg} 更新生效`, 'ok')
        renderPanel()
        refreshMenuBadge()
      } catch (error) {
        toast(`确认失败：${error.message}`, 'error')
      }
    }

    // -------------------------------------------------------------- rendering
    function badge(kind, text, title) {
      return el('span', { class: `${ROOT}-badge`, 'data-kind': kind, title: title || '' }, text)
    }

    function sourceBadge(info) {
      const type = info.source?.type || 'other'
      const label = SOURCE_LABEL[type] || type
      const title = type === 'link' ? info.source.path : info.source.spec || type
      return badge('src', label, title)
    }

    function updateBadge(profileName, info) {
      const check = info.check
      if (!check) return null
      if (check.type === 'link' && check.hasUpdate) {
        const parts = []
        if (check.base?.version && check.base.version !== check.current) parts.push(`v${check.base.version} → v${check.current}`)
        const wrap = el('span', { class: `${ROOT}-upd` },
          badge('link', '源码已更新'),
          parts.length > 0 ? el('span', { class: `${ROOT}-upd-ver`, text: parts.join(' · ') }) : null,
          el('button', {
            class: `${ROOT}-ack`, type: 'button', title: '已重启/重载，确认基线',
            onclick: event => { event.stopPropagation(); ackPlugin(profileName, info) },
          }, '已生效'),
        )
        return wrap
      }
      if (check.hasUpdate && check.latest) {
        return el('span', { class: `${ROOT}-upd` },
          el('span', { class: `${ROOT}-upd-ver`, title: `当前 v${info.version || '?'} → 最新 v${check.latest}`, text: `v${info.version || '?'} → ${check.latest.startsWith('v') ? '' : 'v'}${check.latest}` }),
          check.url ? el('a', { class: `${ROOT}-upd-link`, href: check.url, target: '_blank', rel: 'noopener', title: '查看更新日志', onclick: event => event.stopPropagation() }, '更新日志') : null,
        )
      }
      if (check.status && check.status.startsWith('error')) {
        return el('span', { class: `${ROOT}-upd-err`, title: check.status }, '检测失败')
      }
      return null
    }

    function switchEl(profileName, info) {
      const sw = el('button', {
        class: `${ROOT}-sw`, type: 'button', role: 'switch',
        'aria-checked': String(!info.disabled),
        'aria-label': `${info.disabled ? '启用' : '停用'} ${info.pkg}`,
        title: info.bundled ? (info.disabled ? '点击启用（重载 profile 后生效）' : '点击停用（重载 profile 后生效）') : '不在 bundles 中，需手动接线',
        onclick: event => { event.stopPropagation(); togglePlugin(profileName, info) },
      }, el('span', { class: `${ROOT}-sw-dot` }))
      sw.dataset.on = String(!info.disabled)
      sw.dataset.locked = String(!info.bundled)
      return sw
    }

    function pluginRow(profileName, info) {
      const head = el('div', { class: `${ROOT}-row-head` },
        el('span', { class: `${ROOT}-row-dot`, 'data-off': String(info.disabled) }),
        el('span', { class: `${ROOT}-row-name`, title: info.pkg },
          info.own ? el('span', { class: `${ROOT}-row-own`, title: '自研插件（dsh-plugins monorepo）' }, '★') : null,
          info.pkg.replace(/^dsh-/, ''),
        ),
        info.version ? el('span', { class: `${ROOT}-row-ver`, text: `v${info.version}` }) : null,
        sourceBadge(info),
      )
      const ops = el('div', { class: `${ROOT}-row-ops` }, updateBadge(profileName, info), switchEl(profileName, info))
      const desc = info.description
        ? el('div', { class: `${ROOT}-row-desc`, title: info.description, text: info.description })
        : null
      return el('div', { class: `${ROOT}-row`, 'data-off': String(info.disabled) }, head, ops, desc)
    }

    function profileSection(profile) {
      const updates = profile.plugins.filter(p => p.check?.hasUpdate).length
      const section = el('div', { class: `${ROOT}-sec` },
        el('div', { class: `${ROOT}-sec-head` },
          el('span', { class: `${ROOT}-sec-name`, text: profile.name }),
          el('span', { class: `${ROOT}-sec-meta`, text: `${profile.plugins.length} 个插件${updates > 0 ? ` · ${updates} 个更新` : ''}` }),
        ),
      )
      for (const info of profile.plugins) section.append(pluginRow(profile.name, info))
      return section
    }

    function profileChips() {
      const names = (view?.profiles || []).map(p => p.name)
      const chips = el('div', { class: `${ROOT}-chips` })
      const all = el('button', {
        class: `${ROOT}-chip`, type: 'button',
        onclick: () => { activeProfile = ''; renderPanel() },
      }, '全部')
      if (activeProfile === '') all.dataset.on = 'true'
      chips.append(all)
      for (const name of names) {
        const p = view.profiles.find(x => x.name === name)
        const updates = p?.plugins.filter(x => x.check?.hasUpdate).length || 0
        const chip = el('button', {
          class: `${ROOT}-chip`, type: 'button',
          onclick: () => { activeProfile = name; renderPanel() },
        }, [name, updates > 0 ? el('span', { class: `${ROOT}-chip-n`, text: String(updates) }) : null])
        if (activeProfile === name) chip.dataset.on = 'true'
        chips.append(chip)
      }
      return chips
    }

    function renderPanel() {
      if (panelEl === null) return
      const chipsBox = $(`.${ROOT}-chipsbox`, panelEl)
      if (chipsBox) chipsBox.replaceChildren(profileChips())
      const body = $(`.${ROOT}-body`, panelEl)
      if (!body) return
      body.replaceChildren()

      // header meta row
      const meta = $(`.${ROOT}-meta`, panelEl)
      if (meta) {
        meta.replaceChildren(
          el('span', { class: `${ROOT}-meta-time`, title: view?.checkedAt || '', text: `上次检测：${timeAgo(view?.checkedAt)}` }),
          el('button', {
            class: `${ROOT}-btn`, type: 'button',
            onclick: checkUpdates,
          }, refreshing ? '检测中…' : '检查更新'),
        )
      }

      if (loading) {
        body.append(el('div', { class: `${ROOT}-empty`, text: '正在加载插件状态…' }))
        return
      }
      const profiles = (view?.profiles || []).filter(p => activeProfile === '' || p.name === activeProfile)
      if (profiles.length === 0) {
        body.append(el('div', { class: `${ROOT}-empty`, text: view?.error ? `加载失败：${view.error}` : '未发现任何 profile 插件' }))
        return
      }
      for (const profile of profiles) body.append(profileSection(profile))
    }

    function openPanel() {
      if (panelEl === null) return
      anchorPanel()
      panelEl.dataset.show = 'true'
      if (view === null) loadState()
    }

    function closePanel() {
      if (panelEl !== null) panelEl.dataset.show = 'false'
    }

    function panelOpen() {
      return panelEl !== null && panelEl.dataset.show === 'true'
    }

    function anchorPanel() {
      if (panelEl === null || menuEl === null) return
      const rect = menuEl.getBoundingClientRect()
      panelEl.style.left = `${Math.round(rect.left)}px`
      const top = Math.round(rect.bottom + 6)
      panelEl.style.top = `${Math.min(top, Math.max(8, window.innerHeight - 120))}px`
    }

    function refreshMenuBadge() {
      if (menuEl === null) return
      const badgeNode = $(`.${ROOT}-menu-n`, menuEl)
      const count = view?.updateCount || 0
      if (badgeNode) {
        badgeNode.dataset.show = String(count > 0)
        const next = String(count)
        if (badgeNode.textContent !== next) badgeNode.textContent = next
      }
    }

    // ------------------------------------------------------------ mount / ui
    function mountMenu() {
      if (menuEl !== null && document.body.contains(menuEl)) return
      menuEl = el('button', {
        class: `${ROOT}-menu`, type: 'button',
        title: '管理已装插件 · 检查版本更新',
        'aria-haspopup': 'dialog',
      },
        el('span', { class: `${ROOT}-menu-icon`, 'aria-hidden': 'true' }, '🔌'),
        el('span', { class: `${ROOT}-menu-label` }, '插件管理'),
        el('span', { class: `${ROOT}-menu-n`, 'data-show': 'false' }, '0'),
      )
      menuEl.addEventListener('click', () => { panelOpen() ? closePanel() : openPanel() })
      document.body.append(menuEl)
      positionMenu()
      refreshMenuBadge()
    }

    /**
     * 菜单 fixed 定位在 sidebar.workspaces 插槽顶端；dsh-web-sites 的菜单
     * 也在那里时让位到其下方，并把插槽留白扩到双菜单高度。
     */
    function positionMenu() {
      if (menuEl === null) return
      const collapsed = document.body.querySelector('[data-sidebar-collapsed="true"]') !== null
        || document.documentElement.getAttribute('data-sidebar-collapsed') === 'true'
      if (collapsed) { menuEl.style.display = 'none'; return }
      menuEl.style.display = 'flex'

      const slotRoot = document.querySelector('[data-slot="sidebar.workspaces"]')?.firstElementChild
      if (!slotRoot) return
      const rect = slotRoot.getBoundingClientRect()
      const sitesMenu = document.querySelector('.dws-menu')
      let top = Math.round(rect.top)
      let reserved = 36
      if (sitesMenu && sitesMenu.offsetParent !== null) {
        const below = Math.round(sitesMenu.getBoundingClientRect().bottom) + 2
        if (below >= top - 4) { top = below; reserved = 70 }
      }
      menuEl.style.left = `${Math.round(rect.left)}px`
      menuEl.style.top = `${top}px`
      menuEl.style.width = `${Math.round(rect.width - 12)}px`
      // 插槽留白：web-sites 的 CSS 给 36px；双菜单共存时 inline 提到 70px。
      const current = slotRoot.style.paddingBlockStart
      if (reserved === 70 ? current !== '70px' : current !== '' && current !== '36px') {
        slotRoot.style.paddingBlockStart = reserved === 70 ? '70px' : ''
      } else if (reserved === 36 && current === '70px' && !sitesMenu) {
        slotRoot.style.paddingBlockStart = ''
      }
    }

    function mountPanel() {
      if (panelEl !== null && document.body.contains(panelEl)) return
      panelEl = el('div', { class: `${ROOT}-panel`, role: 'dialog', 'aria-label': '插件管理', 'data-show': 'false' },
        el('div', { class: `${ROOT}-head` },
          el('span', { class: `${ROOT}-title` }, '插件管理'),
          el('button', { class: `${ROOT}-close`, type: 'button', 'aria-label': '关闭', onclick: closePanel }, '✕'),
        ),
        el('div', { class: `${ROOT}-meta` }),
        el('div', { class: `${ROOT}-chipsbox` }),
        el('div', { class: `${ROOT}-body` }),
        el('div', { class: `${ROOT}-foot` }, '启停改动在 profile 重载或 GUI 重启后生效；★ 为自研插件'),
      )
      document.body.append(panelEl)
    }

    function boot() {
      ensureStyles()
      mountMenu()
      mountPanel()

      observer = new MutationObserver(() => {
        try {
          mountMenu()
          mountPanel()
          positionMenu()
          if (panelOpen()) anchorPanel()
        } catch (error) { console.warn('[own-plugin-manager] self-heal failed', error) }
      })
      observer.observe(document.body, { childList: true, subtree: true })

      document.addEventListener('click', event => {
        if (!panelOpen()) return
        if (panelEl.contains(event.target) || menuEl.contains(event.target)) return
        const inSidebar = event.target.closest?.('[data-slot^="sidebar."]')
        if (inSidebar && !inSidebar.contains(menuEl)) closePanel()
      }, true)
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && panelOpen()) closePanel()
      })
      window.addEventListener('resize', () => { positionMenu(); if (panelOpen()) anchorPanel() })

      // 静默预热一次状态（不打扰用户，仅刷新菜单徽标）。
      loadState()
    }

    // ---------------------------------------------------------------- styles
    function ensureStyles() {
      if (document.getElementById('dsh-own-plugin-manager-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-own-plugin-manager-styles'
      style.setAttribute('data-plugin', 'dsh-own-plugin-manager')
      style.textContent = `
/* 菜单留白兜底：无 web-sites 时也保证 36px（与 web-sites 的规则等价）。 */
[data-slot="sidebar.workspaces"] > :first-child { padding-block-start: 36px; }
body:has([data-sidebar-collapsed="true"]) .${ROOT}-menu,
body:has([data-sidebar-collapsed="true"]) .${ROOT}-panel { display: none !important; }

.${ROOT}-menu {
  all: unset; box-sizing: border-box;
  position: fixed; z-index: 81;
  display: flex; align-items: center; gap: 8px;
  height: 32px; margin: 0; padding: 0 10px;
  border-radius: 8px; cursor: pointer;
  color: var(--dsw-alias-label-secondary, #666);
  font-size: 13px;
  transition: color .12s ease, background-color .12s ease;
}
.${ROOT}-menu:hover { color: var(--dsw-alias-label-primary, #1a1a1a); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)); }
.${ROOT}-menu[data-active="true"], .${ROOT}-menu:focus-visible { color: var(--dsw-alias-label-primary, #1a1a1a); }
.${ROOT}-menu:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #4d6bfe); outline-offset: -2px; }
.${ROOT}-menu-icon { font-size: 13px; line-height: 1; }
.${ROOT}-menu-label { flex: 1 1 auto; min-width: 0; text-align: left; font-weight: 500; }
.${ROOT}-menu-n {
  display: none; flex: 0 0 auto;
  min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: 8px;
  background: var(--dsw-alias-button-info-fill, #4d6bfe);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-size: 10px; line-height: 16px; text-align: center;
}
.${ROOT}-menu-n[data-show="true"] { display: inline-block; }

/* ---- panel ---- */
.${ROOT}-panel {
  position: fixed; z-index: 82;
  display: none; flex-direction: column;
  width: min(440px, calc(100vw - 24px)); max-height: 76vh;
  box-sizing: border-box;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff));
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.10));
  border-radius: 12px;
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,0.16));
  overflow: hidden;
  animation: ${ROOT}-panel-in .16s cubic-bezier(0.2, 0.8, 0.4, 1);
}
.${ROOT}-panel[data-show="true"] { display: flex; }
@keyframes ${ROOT}-panel-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.${ROOT}-head {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px 8px;
  font-size: 13px; font-weight: 600;
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.${ROOT}-close {
  all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px;
  color: var(--dsw-alias-label-tertiary, #999); font-size: 12px;
}
.${ROOT}-close:hover { color: var(--dsw-alias-label-primary, #1a1a1a); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)); }
.${ROOT}-meta {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 0 14px 8px;
}
.${ROOT}-meta-time { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); }
.${ROOT}-btn {
  all: unset; cursor: pointer; box-sizing: border-box;
  padding: 3px 10px; border-radius: 7px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
  color: var(--dsw-alias-label-secondary, #666);
  font-size: 11px;
}
.${ROOT}-btn:hover { color: var(--dsw-alias-label-primary, #1a1a1a); background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.10)); }
.${ROOT}-btn[disabled] { opacity: .5; cursor: default; }

.${ROOT}-body { flex: 1 1 auto; overflow-y: auto; padding: 0 8px 8px; }
.${ROOT}-empty { padding: 24px 8px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary, #999); }

.${ROOT}-chipsbox {
  flex: 0 0 auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 0 14px 8px;
}
.${ROOT}-chip {
  all: unset; cursor: pointer; box-sizing: border-box;
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 9px; border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
  color: var(--dsw-alias-label-secondary, #666);
  font-size: 11px; line-height: 16px;
}
.${ROOT}-chip:hover { color: var(--dsw-alias-label-primary, #1a1a1a); background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.10)); }
.${ROOT}-chip[data-on="true"] {
  background: var(--dsw-alias-button-info-fill, #4d6bfe);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.${ROOT}-chip-n {
  min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px;
  background: var(--dsw-alias-state-warn-primary, #d97706);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-size: 9px; line-height: 14px; text-align: center;
}
.${ROOT}-chip[data-on="true"] .${ROOT}-chip-n { background: rgba(255,255,255,0.28); }

.${ROOT}-sec { padding: 2px 4px 6px; }
.${ROOT}-sec-head {
  display: flex; align-items: baseline; gap: 8px;
  padding: 8px 6px 4px;
}
.${ROOT}-sec-name {
  font-size: 12px; font-weight: 600;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  text-transform: uppercase; letter-spacing: .04em;
}
.${ROOT}-sec-meta { font-size: 10px; color: var(--dsw-alias-label-tertiary, #999); }

.${ROOT}-row {
  display: flex; flex-direction: column; gap: 2px;
  padding: 7px 8px; border-radius: 9px;
}
.${ROOT}-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.${ROOT}-row[data-off="true"] .${ROOT}-row-name,
.${ROOT}-row[data-off="true"] .${ROOT}-row-ver,
.${ROOT}-row[data-off="true"] .${ROOT}-row-desc { opacity: .55; }
.${ROOT}-row-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.${ROOT}-row-dot {
  flex: 0 0 auto; width: 6px; height: 6px; border-radius: 3px;
  background: var(--dsw-alias-button-info-fill, #4d6bfe);
}
.${ROOT}-row-dot[data-off="true"] { background: var(--dsw-alias-border-l2, rgba(0,0,0,0.15)); }
.${ROOT}-row-name {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12.5px; font-weight: 500;
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.${ROOT}-row-own { color: var(--dsw-alias-state-warn-primary, #d97706); margin-right: 2px; }
.${ROOT}-row-ver { flex: 0 0 auto; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #999); font-variant-numeric: tabular-nums; }
.${ROOT}-row-desc {
  font-size: 11px; line-height: 1.45;
  color: var(--dsw-alias-label-secondary, #666);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.${ROOT}-row-ops { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.${ROOT}-badge {
  flex: 0 0 auto; display: inline-block;
  padding: 1px 6px; border-radius: 6px;
  font-size: 10px; line-height: 16px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
  color: var(--dsw-alias-label-secondary, #666);
}
.${ROOT}-badge[data-kind="link"] {
  background: var(--dsw-alias-state-warn-primary, #d97706);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.${ROOT}-upd { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.${ROOT}-upd-ver {
  font-size: 10.5px; font-weight: 500;
  color: var(--dsw-alias-button-info-fill, #4d6bfe);
  font-variant-numeric: tabular-nums;
}
.${ROOT}-upd-link {
  font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #999);
  text-decoration: none; border-bottom: 1px dotted currentColor;
}
.${ROOT}-upd-link:hover { color: var(--dsw-alias-button-info-fill, #4d6bfe); }
.${ROOT}-upd-err { font-size: 10.5px; color: var(--dsw-alias-state-warn-primary, #d97706); }
.${ROOT}-ack {
  all: unset; cursor: pointer; box-sizing: border-box;
  padding: 1px 7px; border-radius: 6px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
  color: var(--dsw-alias-label-secondary, #666);
  font-size: 10px; line-height: 16px;
}
.${ROOT}-ack:hover { color: var(--dsw-alias-label-primary, #1a1a1a); background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.10)); }

/* toggle switch */
.${ROOT}-sw {
  all: unset; cursor: pointer; box-sizing: border-box;
  flex: 0 0 auto; position: relative;
  width: 30px; height: 17px; border-radius: 9px;
  background: var(--dsw-alias-border-l2, rgba(0,0,0,0.18));
  transition: background .14s ease;
}
.${ROOT}-sw[data-on="true"] { background: var(--dsw-alias-button-info-fill, #4d6bfe); }
.${ROOT}-sw[data-locked="true"] { opacity: .45; cursor: default; }
.${ROOT}-sw-dot {
  position: absolute; top: 2px; left: 2px;
  width: 13px; height: 13px; border-radius: 7px;
  background: var(--dsw-alias-bg-base, #fff);
  transition: left .14s ease;
}
.${ROOT}-sw[data-on="true"] .${ROOT}-sw-dot { left: 15px; }

.${ROOT}-foot {
  flex: 0 0 auto; padding: 7px 14px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08));
  font-size: 10px; color: var(--dsw-alias-label-tertiary, #999);
}

/* toast */
.${ROOT}-toast {
  position: fixed; z-index: 96; left: 50%; bottom: 28px;
  transform: translateX(-50%) translateY(6px);
  padding: 7px 14px; border-radius: 9px;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff));
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.10));
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,0.16));
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font-size: 12px;
  opacity: 0; pointer-events: none;
  transition: opacity .18s ease, transform .18s ease;
}
.${ROOT}-toast[data-show="true"] { opacity: 1; transform: translateX(-50%) translateY(0); }
.${ROOT}-toast[data-tone="error"] { border-color: var(--dsw-alias-state-warn-primary, #d97706); }
`
      document.head.append(style)
    }

    // ------------------------------------------------------------------ apply
    function applyClient(context) {
      ctx = context
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { try { boot() } catch (error) { console.warn('[own-plugin-manager] boot failed', error) } }, { once: true })
      } else {
        try { boot() } catch (error) { console.warn('[own-plugin-manager] boot failed', error) }
      }
    }

    module.exports = { apply: applyClient, inject: [] }
    exports.apply = applyClient
    exports.inject = []
    return module.exports
  },
})
