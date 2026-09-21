/**
 * dsh-own-plugin-manager — browser half (runs inside the dsh web GUI).
 *
 * 设置分区（设置 → 插件管家）：
 *
 *   - 注册官方 settings.section slot：设置对话框导航中的独立分区
 *     （order 34，紧邻第三方「插件管理」35），带插头图标。
 *   - profile chips 分组过滤、每插件一行（版本/来源徽标/自研★/启停
 *     开关/更新徽标）、「检查更新」按钮、link 源码更新「已生效」基线对齐。
 *   - 启停走 host 半边行级 patch profile cordis.patch.yml（保留注释），
 *     改动需 profile 重载/重启生效，UI 有明确提示。
 *
 * Implementation notes
 * --------------------
 * - 经典 __ModuleLoader__ 脚本：factory 内 require('react')（模块表种子，
 *     dshmarket / dsh-plugin-manager 同款模式），返回
 *     { apply, inject: ['slots'] }；挂载生命周期交给 slot 系统，
 *     不再需要 MutationObserver 自愈与 fixed 定位面板。
 * - 分区组件外包一层 ErrorBoundary：渲染崩溃只降级本分区
 *     （显示错误行），绝不弄 blank 整个设置对话框。
 * - 配色全部走 --dsw-alias-* / --dsw-specific-* token，自动跟随明暗主题；
 *   只用纯色，不用渐变。
 * - API：GET /api/dsh-opm/state、POST refresh/toggle/ack（loopback 围栏内）。
 * - toast 仍挂 document.body（React 树外，fixed 定位）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-own-plugin-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    // ------------------------------------------------------------- constants
    const API_STATE = '/api/dsh-opm/state'
    const API_REFRESH = '/api/dsh-opm/refresh'
    const API_TOGGLE = '/api/dsh-opm/toggle'
    const API_ACK = '/api/dsh-opm/ack'
    const ROOT = 'opm'
    const SECTION_ID = 'own-plugin-manager'
    const SOURCE_LABEL = { npm: 'npm', github: 'GitHub', link: '本地', tarball: '发布包', other: '其他' }

    // ---------------------------------------------------------------- helpers
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

    // toast（React 树外的 body 级元素，避免每分区重复渲染）
    let toastEl = null
    let toastTimer = null
    function toast(message, tone = 'info') {
      try {
        if (toastEl === null) {
          toastEl = document.createElement('div')
          toastEl.className = `${ROOT}-toast`
          toastEl.setAttribute('role', 'status')
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

    // -------------------------------------------------------------- components
    /** 设置导航行内容：插头图标 + 文案（默认齿轮图标由 CSS 隐藏）。 */
    function NavLabel() {
      return react.createElement('span', {
        'data-settings-nav-label': SECTION_ID,
        style: { display: 'inline-flex', alignItems: 'center', gap: 8 },
      },
        react.createElement('svg', {
          width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
          'aria-hidden': 'true', style: { flex: '0 0 auto' },
        },
          react.createElement('path', {
            d: 'M6 1.5v3M10 1.5v3M4.5 6h7v1.5a3.5 3.5 0 0 1-3.5 3.5 3.5 3.5 0 0 1-3.5-3.5zM8 11v3.5',
            stroke: 'currentColor', strokeWidth: 1.5,
            strokeLinecap: 'round', strokeLinejoin: 'round',
          }),
        ),
        react.createElement('span', null, '插件管家'),
      )
    }

    function badge(kind, text, title) {
      return react.createElement('span', {
        className: `${ROOT}-badge`, 'data-kind': kind, title: title || '',
      }, text)
    }

    function sourceBadge(info) {
      const type = (info.source && info.source.type) || 'other'
      const label = SOURCE_LABEL[type] || type
      const title = type === 'link' ? info.source.path : (info.source.spec || type)
      return badge('src', label, title)
    }

    function updateBadge(profileName, info, onAck) {
      const check = info.check
      if (!check) return null
      if (check.type === 'link' && check.hasUpdate) {
        const parts = []
        if (check.base && check.base.version && check.base.version !== check.current) {
          parts.push(`v${check.base.version} → v${check.current}`)
        }
        return react.createElement('span', { className: `${ROOT}-upd` },
          badge('link', '源码已更新'),
          parts.length > 0 ? react.createElement('span', { className: `${ROOT}-upd-ver` }, parts.join(' · ')) : null,
          react.createElement('button', {
            className: `${ROOT}-ack`, type: 'button', title: '已重启/重载，确认基线',
            onClick: event => { event.stopPropagation(); onAck(profileName, info) },
          }, '已生效'),
        )
      }
      if (check.hasUpdate && check.latest) {
        return react.createElement('span', { className: `${ROOT}-upd` },
          react.createElement('span', {
            className: `${ROOT}-upd-ver`,
            title: `当前 v${info.version || '?'} → 最新 v${check.latest}`,
          }, `v${info.version || '?'} → ${check.latest.startsWith('v') ? '' : 'v'}${check.latest}`),
          check.url ? react.createElement('a', {
            className: `${ROOT}-upd-link`, href: check.url, target: '_blank', rel: 'noopener',
            title: '查看更新日志', onClick: event => event.stopPropagation(),
          }, '更新日志') : null,
        )
      }
      if (check.status && check.status.startsWith('error')) {
        return react.createElement('span', { className: `${ROOT}-upd-err`, title: check.status }, '检测失败')
      }
      return null
    }

    function switchEl(profileName, info, onToggle) {
      const on = !info.disabled
      return react.createElement('button', {
        className: `${ROOT}-sw`, type: 'button', role: 'switch',
        'aria-checked': String(on),
        'aria-label': `${info.disabled ? '启用' : '停用'} ${info.pkg}`,
        title: info.bundled ? (info.disabled ? '点击启用（重载 profile 后生效）' : '点击停用（重载 profile 后生效）') : '不在 bundles 中，需手动接线',
        'data-on': String(on),
        'data-locked': String(!info.bundled),
        onClick: event => { event.stopPropagation(); onToggle(profileName, info) },
      }, react.createElement('span', { className: `${ROOT}-sw-dot` }))
    }

    function pluginRow(profileName, info, onToggle, onAck) {
      return react.createElement('div', { className: `${ROOT}-row`, 'data-off': String(info.disabled), key: info.pkg },
        react.createElement('div', { className: `${ROOT}-row-head` },
          react.createElement('span', { className: `${ROOT}-row-dot`, 'data-off': String(info.disabled) }),
          react.createElement('span', { className: `${ROOT}-row-name`, title: info.pkg },
            info.own ? react.createElement('span', { className: `${ROOT}-row-own`, title: '自研插件（dsh-plugins monorepo）' }, '★') : null,
            info.pkg.replace(/^dsh-/, ''),
          ),
          info.version ? react.createElement('span', { className: `${ROOT}-row-ver` }, `v${info.version}`) : null,
          sourceBadge(info),
        ),
        react.createElement('div', { className: `${ROOT}-row-ops` }, updateBadge(profileName, info, onAck), switchEl(profileName, info, onToggle)),
        info.description ? react.createElement('div', { className: `${ROOT}-row-desc`, title: info.description }, info.description) : null,
      )
    }

    function profileSection(profile, onToggle, onAck) {
      const updates = profile.plugins.filter(p => p.check && p.check.hasUpdate).length
      return react.createElement('div', { className: `${ROOT}-sec`, key: profile.name },
        react.createElement('div', { className: `${ROOT}-sec-head` },
          react.createElement('span', { className: `${ROOT}-sec-name` }, profile.name),
          react.createElement('span', { className: `${ROOT}-sec-meta` }, `${profile.plugins.length} 个插件${updates > 0 ? ` · ${updates} 个更新` : ''}`),
        ),
        ...profile.plugins.map(info => pluginRow(profile.name, info, onToggle, onAck)),
      )
    }

    /** 主分区组件：状态加载 + profile 过滤 + 操作。 */
    function OwnPluginManagerSection() {
      const [view, setView] = react.useState(null)
      const [activeProfile, setActiveProfile] = react.useState('')
      const [loading, setLoading] = react.useState(true)
      const [refreshing, setRefreshing] = react.useState(false)

      react.useEffect(() => {
        let alive = true
        apiGet(API_STATE)
          .then(data => { if (alive) setView(data) })
          .catch(error => {
            if (!alive) return
            setView({ profiles: [], updateCount: 0, checkedAt: null, error: error.message })
            console.warn('[own-plugin-manager] state load failed', error)
          })
          .finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [])

      async function checkUpdates() {
        if (refreshing) return
        setRefreshing(true)
        try {
          const data = await apiPost(API_REFRESH, { force: true })
          if (data.view) setView(data.view)
          const count = (data.view && data.view.updateCount) || 0
          toast(count > 0 ? `检测完成：${count} 个可用更新` : '检测完成：全部插件均为最新', 'ok')
        } catch (error) {
          toast(`检测失败：${error.message}`, 'error')
        } finally {
          setRefreshing(false)
        }
      }

      function patchPlugin(profileName, pkg, patch) {
        setView(prev => {
          if (!prev) return prev
          return {
            ...prev,
            profiles: prev.profiles.map(p => {
              if (p.name !== profileName) return p
              return { ...p, plugins: p.plugins.map(x => (x.pkg === pkg ? patch(x) : x)) }
            }),
          }
        })
      }

      async function togglePlugin(profileName, plugin) {
        const next = !plugin.disabled
        try {
          await apiPost(API_TOGGLE, { profile: profileName, plugin: plugin.pkg, disabled: next })
          patchPlugin(profileName, plugin.pkg, x => ({ ...x, disabled: next }))
          toast(next ? `已停用 ${plugin.pkg}（重载 profile 后生效）` : `已启用 ${plugin.pkg}（重载 profile 后生效）`, 'ok')
        } catch (error) {
          toast(`启停失败：${error.message}`, 'error')
        }
      }

      async function ackPlugin(profileName, plugin) {
        try {
          await apiPost(API_ACK, { profile: profileName, plugin: plugin.pkg })
          patchPlugin(profileName, plugin.pkg, x => ({ ...x, check: x.check ? { ...x.check, hasUpdate: false } : x.check }))
          setView(prev => (prev ? { ...prev, updateCount: Math.max(0, (prev.updateCount || 0) - 1) } : prev))
          toast(`已确认 ${plugin.pkg} 更新生效`, 'ok')
        } catch (error) {
          toast(`确认失败：${error.message}`, 'error')
        }
      }

      const profiles = (view && view.profiles || []).filter(p => activeProfile === '' || p.name === activeProfile)
      const names = (view && view.profiles || []).map(p => p.name)

      return react.createElement('div', { className: `${ROOT}-page` },
        // 顶部：上次检测时间 + 检查更新
        react.createElement('div', { className: `${ROOT}-meta` },
          react.createElement('span', { className: `${ROOT}-meta-time`, title: (view && view.checkedAt) || '' },
            `上次检测：${timeAgo(view && view.checkedAt)}`),
          react.createElement('button', {
            className: `${ROOT}-btn`, type: 'button', disabled: refreshing,
            onClick: checkUpdates,
          }, refreshing ? '检测中…' : '检查更新'),
        ),
        // profile chips
        names.length > 0 ? react.createElement('div', { className: `${ROOT}-chips` },
          react.createElement('button', {
            className: `${ROOT}-chip`, type: 'button', 'data-on': String(activeProfile === ''),
            onClick: () => setActiveProfile(''),
          }, '全部'),
          ...names.map(name => {
            const p = view.profiles.find(x => x.name === name)
            const updates = (p && p.plugins.filter(x => x.check && x.check.hasUpdate).length) || 0
            return react.createElement('button', {
              className: `${ROOT}-chip`, type: 'button', key: name,
              'data-on': String(activeProfile === name),
              onClick: () => setActiveProfile(name),
            },
              name,
              updates > 0 ? react.createElement('span', { className: `${ROOT}-chip-n` }, String(updates)) : null,
            )
          }),
        ) : null,
        // 主体
        react.createElement('div', { className: `${ROOT}-list` },
          loading
            ? react.createElement('div', { className: `${ROOT}-empty` }, '正在加载插件状态…')
            : profiles.length === 0
              ? react.createElement('div', { className: `${ROOT}-empty` }, (view && view.error) ? `加载失败：${view.error}` : '未发现任何 profile 插件')
              : profiles.map(profile => profileSection(profile, togglePlugin, ackPlugin)),
        ),
        react.createElement('div', { className: `${ROOT}-foot` }, '启停改动在 profile 重载或 GUI 重启后生效；★ 为自研插件'),
      )
    }

    /** 分区级错误边界：崩溃只降级本分区，不波及整个设置对话框。 */
    class SectionErrorBoundary extends react.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) { return { error } }
      componentDidCatch(error) { console.warn('[own-plugin-manager] section crashed', error) }
      render() {
        if (this.state.error !== null) {
          const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error)
          return react.createElement('div', { className: `${ROOT}-empty` }, `插件管家渲染失败：${message}`)
        }
        return this.props.children
      }
    }

    // ---------------------------------------------------------------- styles
    function ensureStyles() {
      if (document.getElementById('dsh-own-plugin-manager-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-own-plugin-manager-styles'
      style.setAttribute('data-plugin', 'dsh-own-plugin-manager')
      style.textContent = `
/* 设置导航：隐藏本分区默认齿轮图标（label 自带插头图标）。 */
button:has([data-settings-nav-label="${SECTION_ID}"]) > svg:first-child { display: none; }

.${ROOT}-page {
  display: flex; flex-direction: column; gap: 10px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font-size: 13px;
}

.${ROOT}-meta {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.${ROOT}-meta-time { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); }
.${ROOT}-btn {
  all: unset; cursor: pointer; box-sizing: border-box;
  padding: 4px 12px; border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
  color: var(--dsw-alias-label-secondary, #666);
  font-size: 12px;
}
.${ROOT}-btn:hover { color: var(--dsw-alias-label-primary, #1a1a1a); background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.10)); }
.${ROOT}-btn[disabled] { opacity: .5; cursor: default; }

.${ROOT}-chips {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
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

.${ROOT}-list { display: flex; flex-direction: column; gap: 2px; }
.${ROOT}-empty { padding: 24px 8px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary, #999); }

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
  padding-top: 4px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08));
  font-size: 10px; color: var(--dsw-alias-label-tertiary, #999);
}

/* toast（body 级，React 树外） */
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
    function applyClient(ctx) {
      try {
        ensureStyles()
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
          console.warn('[own-plugin-manager] slots service unavailable — settings section not registered')
          return
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 34,
          label: NavLabel,
        }, () => react.createElement(SectionErrorBoundary, null,
          react.createElement(OwnPluginManagerSection, null))))
      } catch (error) {
        console.warn('[own-plugin-manager] settings section registration failed', error)
      }
    }

    module.exports = { apply: applyClient, inject: ['slots'] }
    exports.apply = applyClient
    exports.inject = ['slots']
    return module.exports
  },
})
