/**
 * dsh-own-plugin-manager — browser half (runs inside the dsh web GUI).
 *
 * 设置分区（设置 → 插件管家），视觉体系对齐已安装的第三方「插件管理」
 * （dsh-plugin-manager）：控制台卡片 + 下划线 Tab + 分段筛选 + 搜索框 +
 * 插件卡片网格。
 *
 *   - Tab 区分自有 / 社区：link 指 dsh-plugins monorepo 的包归「自有插件」，
 *     npm / GitHub / tarball 来源归「社区插件」，卡片图标与徽标双重区分。
 *   - 控制台卡片：profile 药丸过滤（全部 / web / desktop…）、自有/社区统计、
 *     「检查更新」、上次检测时间与可用更新摘要。
 *   - 插件卡片：关键词图标（自有为琥珀色调）、自研/来源徽标、版本行
 *     （v1 → v2 / 源码已更新）、描述两行截断、profile 标签、启停开关
 *     （多 profile 时逐个带标签）、更新日志链接、「复制更新命令」
 *     （link = git pull，npm = dsh plugin add）、link 更新「已生效」确认。
 *   - link 类双信号：远端最新版（GitHub release 标签 → 默认分支回退）
 *     与本地漂移（已 pull 未重启）分别提示，互不掩盖。
 *   - 启停走 host 半边行级 patch profile cordis.patch.yml（保留注释），
 *     改动需 profile 重载/重启生效，页脚有明确提示。
 *
 * Implementation notes
 * --------------------
 * - 经典 __ModuleLoader__ 脚本：factory 内 require('react')（模块表种子，
 *     dshmarket / dsh-plugin-manager 同款模式），返回
 *     { apply, inject: ['slots'] }；挂载生命周期交给 slot 系统。
 * - 分区组件外包一层 ErrorBoundary：渲染崩溃只降级本分区
 *     （显示错误行），绝不弄 blank 整个设置对话框。
 * - 配色全部走 --dsw-alias-* / --dsw-specific-* token（局部只定义引用
 *   token 的自定义属性），自动跟随明暗主题；只用纯色，不用渐变。
 * - API：GET /api/dsh-opm/state、POST refresh/toggle/ack（loopback 围栏内）。
 * - toast 挂 document.body（React 树外，fixed 定位）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-own-plugin-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const el = react.createElement

    // ------------------------------------------------------------- constants
    const API_STATE = '/api/dsh-opm/state'
    const API_REFRESH = '/api/dsh-opm/refresh'
    const API_TOGGLE = '/api/dsh-opm/toggle'
    const API_ACK = '/api/dsh-opm/ack'
    const API_REPOS = '/api/dsh-opm/repos'
    const API_REPOS_ADD = '/api/dsh-opm/repos/add'
    const API_REPOS_REMOVE = '/api/dsh-opm/repos/remove'
    const API_REPOS_REFRESH = '/api/dsh-opm/repos/refresh'
    const API_INSTALL = '/api/dsh-opm/install'
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

    /**
     * 跨 profile 按 pkg 聚合（受 profile 过滤约束）：
     * 返回 [{ pkg, own, description, source, bundled, instances:[{profile, info}] }]。
     */
    function aggregate(view, profileFilter) {
      const byPkg = new Map()
      for (const profile of (view && view.profiles) || []) {
        if (profileFilter !== '' && profile.name !== profileFilter) continue
        for (const info of profile.plugins) {
          let card = byPkg.get(info.pkg)
          if (!card) {
            card = { pkg: info.pkg, own: !!info.own, description: info.description || '', source: info.source || { type: 'other' }, bundled: !!info.bundled, instances: [] }
            byPkg.set(info.pkg, card)
          }
          card.instances.push({ profile: profile.name, info })
          card.bundled = card.bundled || !!info.bundled
        }
      }
      return [...byPkg.values()]
    }

    // ------------------------------------------------------------------ icons
    /** 设置导航行内容：插头图标 + 文案（默认齿轮图标由 CSS 隐藏）。 */
    function NavLabel() {
      return el('span', {
        'data-settings-nav-label': SECTION_ID,
        style: { display: 'inline-flex', alignItems: 'center', gap: 8 },
      },
        el('svg', {
          width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
          'aria-hidden': 'true', style: { flex: '0 0 auto' },
        },
          el('path', {
            d: 'M6 1.5v3M10 1.5v3M4.5 6h7v1.5a3.5 3.5 0 0 1-3.5 3.5 3.5 3.5 0 0 1-3.5-3.5zM8 11v3.5',
            stroke: 'currentColor', strokeWidth: 1.5,
            strokeLinecap: 'round', strokeLinejoin: 'round',
          }),
        ),
        el('span', null, '插件管家'),
      )
    }

    function svgWrap(size, className, paths) {
      return el('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': 'true', className: className || '',
      }, ...paths)
    }

    function IconRefresh({ size = 14, className } = {}) {
      return svgWrap(size, className, [
        el('path', { d: 'M21.5 2v6h-6' }),
        el('path', { d: 'M21.34 15.57a10 10 0 1 1-.57-8.38L21.5 8' }),
      ])
    }
    function IconSearch({ size = 14, className } = {}) {
      return svgWrap(size, className, [
        el('circle', { cx: 11, cy: 11, r: 8 }),
        el('path', { d: 'm21 21-4.3-4.3' }),
      ])
    }
    function IconBot({ size = 20 } = {}) {
      return svgWrap(size, '', [
        el('path', { d: 'M12 8V4H8' }),
        el('rect', { width: 16, height: 12, x: 4, y: 8, rx: 2 }),
        el('path', { d: 'M2 14h2' }),
        el('path', { d: 'M20 14h2' }),
        el('path', { d: 'M15 13v2' }),
        el('path', { d: 'M9 13v2' }),
      ])
    }
    function IconTerminal({ size = 20 } = {}) {
      return svgWrap(size, '', [
        el('polyline', { points: '4 17 10 11 4 5' }),
        el('line', { x1: 12, y1: 19, x2: 20, y2: 19 }),
      ])
    }
    function IconArchive({ size = 20 } = {}) {
      return svgWrap(size, '', [
        el('polyline', { points: '21 8 21 21 3 21 3 8' }),
        el('rect', { width: 22, height: 5, x: 1, y: 3 }),
        el('line', { x1: 10, y1: 12, x2: 14, y2: 12 }),
      ])
    }
    function IconGlobe({ size = 20 } = {}) {
      return svgWrap(size, '', [
        el('circle', { cx: 12, cy: 12, r: 10 }),
        el('line', { x1: 2, y1: 12, x2: 22, y2: 12 }),
        el('path', { d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' }),
      ])
    }
    function IconHeart({ size = 20 } = {}) {
      return svgWrap(size, '', [
        el('path', { d: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z' }),
      ])
    }
    function IconScroll({ size = 20 } = {}) {
      return svgWrap(size, '', [
        el('path', { d: 'M12 19V5' }),
        el('path', { d: 'M5 12l7-7 7 7' }),
        el('path', { d: 'M5 19l7-7 7 7' }),
      ])
    }
    function IconPuzzle({ size = 20 } = {}) {
      return svgWrap(size, '', [
        el('path', { d: 'M10 3H6a2 2 0 0 0-2 2v3.5a1.8 1.8 0 0 1 0 3V15a2 2 0 0 0 2 2h3.5a1.8 1.8 0 0 1 3 0H18a2 2 0 0 0 2-2v-3.5a1.8 1.8 0 0 1 0-3V5a2 2 0 0 0-2-2h-3.5a1.8 1.8 0 0 1-3 0z' }),
      ])
    }
    function IconPlug({ size = 20 } = {}) {
      return el('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
        el('path', { d: 'M6 1.5v3M10 1.5v3M4.5 6h7v1.5a3.5 3.5 0 0 1-3.5 3.5 3.5 3.5 0 0 1-3.5-3.5zM8 11v3.5' }),
      )
    }

    /** 关键词 → 卡片图标（自有/社区共用，自有另由色调区分）。 */
    function cardIcon(pkg) {
      const name = String(pkg || '').toLowerCase()
      if (/agent|driver|model|role/.test(name)) return IconBot({})
      if (/terminal/.test(name)) return IconTerminal({})
      if (/archive|session/.test(name)) return IconArchive({})
      if (/site|web|market|hub/.test(name)) return IconGlobe({})
      if (/pet/.test(name)) return IconHeart({})
      if (/scroll|nav/.test(name)) return IconScroll({})
      if (/manager|plugin/.test(name)) return IconPuzzle({})
      return IconPlug({ size: 20 })
    }

    // ------------------------------------------------------------ clipboard
    /** 复制更新命令；剪贴板不可用时降级为 toast 展示命令原文。 */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        toast('已复制更新命令', 'ok')
      } catch {
        toast(text, 'info')
      }
    }

    /** 生成「复制更新命令」：link = git pull，registry = dsh plugin add。 */
    function updateCommand(card) {
      const inst = card.instances.find(i => i.info.check && i.info.check.hasUpdate)
      if (!inst) return null
      const check = inst.info.check
      if (check.type === 'link') {
        if (!check.remoteHasUpdate) return null // 仅本地漂移（已 pull 待重启），无需命令
        return `git -C ${inst.info.source.path} pull --ff-only`
      }
      const spec = inst.info.source.type === 'npm'
        ? `${card.pkg}@${check.latest || 'latest'}`
        : (inst.info.source.spec || card.pkg)
      return `dsh plugin --profile ${inst.profile} add ${spec}`
    }

    // ------------------------------------------------------------ repo sources
    /** 仓库发现的插件的安装 spec：monorepo 用 tgz URL，单插件仓库用 github:。 */
    function repoPluginSpec(p) {
      if (p.tgzUrl) return p.tgzUrl
      if (p.spec) return p.spec
      return `github:${p.repo}`
    }

    /** 关注仓库管理卡：输入添加 + 已关注列表（移除）+ 探测刷新。 */
    function repoSourceCard(repos, onAddRepo, onRemoveRepo, onRefreshRepos, refreshing) {
      let inputEl = null
      const submit = event => {
        const value = (inputEl && inputEl.value || '').trim()
        if (!value) return
        onAddRepo(value)
        if (inputEl) inputEl.value = ''
      }
      return el('div', { className: `${ROOT}-repos` },
        el('div', { className: `${ROOT}-repos-head` },
          el('div', { className: `${ROOT}-repos-title` },
            IconGithub({ size: 16 }),
            el('span', null, '关注仓库源'),
            el('span', { className: `${ROOT}-repos-hint` }, '社区插件无官方市场，关注 GitHub 插件仓库即可浏览其发布并监测更新')),
          el('button', {
            className: `${ROOT}-btn sm`, type: 'button', disabled: refreshing,
            title: '重新探测全部关注仓库',
            onClick: event => { event.stopPropagation(); onRefreshRepos() },
          },
            IconRefresh({ size: 12, className: refreshing ? `${ROOT}-spin` : '' }),
            el('span', null, refreshing ? '探测中…' : '重新探测'))),
        el('div', { className: `${ROOT}-repos-add` },
          el('input', {
            type: 'text', placeholder: 'owner/repo 或 https://github.com/owner/repo…',
            'aria-label': '添加关注仓库',
            ref: node => { inputEl = node },
            onKeyDown: event => { if (event.key === 'Enter') submit(event) },
          }),
          el('button', {
            className: `${ROOT}-btn`, type: 'button',
            onClick: submit,
          }, '添加')),
        el('div', { className: `${ROOT}-repos-list` },
          repos.length === 0
            ? el('span', { className: `${ROOT}-repos-empty` }, '尚未关注任何仓库，输入 GitHub 仓库地址开始（如 veildawn/dsh-plugins）')
            : repos.map(r => {
              const count = (r.plugins || []).length
              return el('div', { className: `${ROOT}-repo-pill`, key: r.repo },
                el('a', {
                  className: `${ROOT}-repo-link`, href: `https://github.com/${r.repo}`, target: '_blank',
                  rel: 'noopener noreferrer', onClick: event => event.stopPropagation(),
                }, r.repo),
                el('span', { className: `${ROOT}-repo-meta` },
                  r.error
                    ? el('span', { className: `${ROOT}-err-txt`, title: r.error }, '探测失败')
                    : (count > 0 ? el('span', null, `${count} 个插件`) : el('span', null, '未发现插件'))),
                el('button', {
                  className: `${ROOT}-btn sm`, type: 'button', title: `移除 ${r.repo}`,
                  onClick: event => { event.stopPropagation(); onRemoveRepo(r.repo) },
                }, '移除')) })))
    }

    /** 仓库发现、但未安装的插件卡片。 */
    function repoPluginCard(p, repo, onInstall, profileTarget) {
      const spec = repoPluginSpec(p)
      const installed = repo.installed && repo.installed[p.pkg] ? repo.installed[p.pkg] : null
      return el('div', { className: `${ROOT}-card repo`, key: `repo:${repo.repo}:${p.pkg}` },
        el('div', { className: `${ROOT}-card-icon` }, cardIcon(p.pkg)),
        el('div', { className: `${ROOT}-card-body` },
          el('div', { className: `${ROOT}-card-head` },
            el('div', { className: `${ROOT}-card-title-row` },
              el('h3', { className: `${ROOT}-card-title`, title: p.pkg }, p.pkg),
              el('span', { className: `${ROOT}-badge repo`, title: `来自 ${repo.repo}` }, '仓库'),
              el('span', { className: `${ROOT}-badge` }, '未安装'))),
          el('div', { className: `${ROOT}-version-row` },
            el('span', { className: `${ROOT}-ver-cur` }, `v${p.version}`),
            installed ? el('span', { key: 'arrow', 'aria-hidden': 'true' }, '→') : null,
            installed ? el('span', { className: `${ROOT}-ver-next`, key: 'inst' }, installed.map(i => `已装 v${i.version}（${i.profile}）`).join(' · ')) : null),
          el('p', { className: `${ROOT}-card-desc` }, `${repo.repo} 发布的插件${p.branch ? `（${p.branch} 分支）` : ''}，尚未安装到当前 profile 范围`),
          el('div', { className: `${ROOT}-card-foot` },
            el('div', { className: `${ROOT}-card-meta` },
              el('span', { className: `${ROOT}-prof-tag` }, repo.repo),
              installed ? el('span', { className: `${ROOT}-prof-tag` }, '有安装实例') : null),
            el('div', { className: `${ROOT}-card-ops` },
              el('button', {
                className: `${ROOT}-btn sm`, type: 'button', title: spec,
                onClick: event => { event.stopPropagation(); void copyText(`dsh plugin --profile ${profileTarget} add ${spec}`) },
              }, '复制安装命令'),
              el('button', {
                className: `${ROOT}-btn sm primary`, type: 'button',
                title: profileTarget ? `安装到 ${profileTarget}（${spec}）` : '先在上方选择一个 profile 作为安装目标',
                onClick: event => { event.stopPropagation(); onInstall(p, profileTarget) },
              }, installed ? '更新' : '安装')))))
    }

    /** GitHub 图标（仓库源标题用）。 */
    function IconGithub({ size = 16, className } = {}) {
      return svgWrap(size, className, [
        el('path', { d: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4' }),
        el('path', { d: 'M9 18c-4.51 2-5-2-7-2' }),
      ])
    }

    // -------------------------------------------------------------- fragments
    function sourceBadge(source) {
      const type = (source && source.type) || 'other'
      const label = SOURCE_LABEL[type] || type
      const title = type === 'link' ? (source.path || type) : (source.spec || type)
      return el('span', { className: `${ROOT}-badge`, title: title }, label)
    }

    function versionRow(card) {
      const updInst = card.instances.find(i => i.info.check && i.info.check.hasUpdate)
      const versions = [...new Set(card.instances.map(i => i.info.version).filter(Boolean))]
      const parts = []
      if (versions.length > 0) {
        parts.push(el('span', { className: `${ROOT}-ver-cur`, key: 'cur' }, versions.map(v => `v${v}`).join(' · ')))
      }
      if (updInst) {
        const check = updInst.info.check
        if (check.type === 'link') {
          // 远端（GitHub release 标签 / 默认分支）有新版 → v1 → v2
          if (check.remoteHasUpdate && check.latest) {
            parts.push(el('span', { key: 'arrow', 'aria-hidden': 'true' }, '→'))
            parts.push(el('span', {
              className: `${ROOT}-ver-next`, key: 'next',
              title: `GitHub ${check.latestSource === 'release' ? 'release 标签' : '默认分支'}有新版（当前 v${updInst.info.version || '?'}），在 monorepo 里 git pull 后重启生效`,
            }, `v${check.latest}`))
          }
          // 本地漂移（已 pull 未重启）→ 源码已更新 + 已生效
          if (check.driftHasUpdate) {
            parts.push(el('span', {
              className: `${ROOT}-badge upd`, key: 'drift',
              title: '本地源码与上次基线不一致（已 pull / 已改动），重启或重载 profile 后点「已生效」对齐基线',
            }, '源码已更新'))
          }
          if (check.remoteError && !check.remoteHasUpdate) {
            parts.push(el('span', { className: `${ROOT}-err-txt`, key: 'rerr', title: check.remoteError }, '远端检测失败'))
          }
        } else if (check.hasUpdate && check.latest) {
          parts.push(el('span', { key: 'arrow', 'aria-hidden': 'true' }, '→'))
          parts.push(el('span', {
            className: `${ROOT}-ver-next`, key: 'next',
            title: `当前 v${updInst.info.version || '?'} → 最新 v${check.latest}`,
          }, `v${check.latest}`))
        }
      } else {
        const errInst = card.instances.find(i => i.info.check && i.info.check.status && String(i.info.check.status).startsWith('error'))
        if (errInst) {
          parts.push(el('span', { className: `${ROOT}-err-txt`, key: 'err', title: String(errInst.info.check.status) }, '检测失败'))
        }
      }
      if (parts.length === 0) return null
      return el('div', { className: `${ROOT}-version-row` }, ...parts)
    }

    function switchEl(profileName, info, onToggle) {
      const on = !info.disabled
      return el('button', {
        className: `${ROOT}-sw`, type: 'button', role: 'switch',
        'aria-checked': String(on),
        'aria-label': `${info.disabled ? '启用' : '停用'} ${info.pkg}（${profileName}）`,
        title: info.bundled ? (info.disabled ? '点击启用（重载 profile 后生效）' : '点击停用（重载 profile 后生效）') : '不在 bundles 中，需手动接线',
        'data-on': String(on),
        'data-locked': String(!info.bundled),
        onClick: event => { event.stopPropagation(); onToggle(profileName, info) },
      }, el('span', { className: `${ROOT}-sw-dot` }))
    }

    function pluginCard(card, onToggle, onAck) {
      const allOff = card.instances.every(i => i.info.disabled)
      const updInst = card.instances.find(i => i.info.check && i.info.check.hasUpdate)
      const linkUpd = card.instances.filter(i => i.info.check && i.info.check.type === 'link' && i.info.check.hasUpdate)
      const multi = card.instances.length > 1
      return el('div', { className: `${ROOT}-card`, 'data-off': String(allOff), key: card.pkg },
        el('div', {
          className: `${ROOT}-card-icon`, 'data-own': String(card.own),
          title: card.own ? '自有插件（dsh-plugins monorepo）' : '社区插件',
        }, cardIcon(card.pkg)),
        el('div', { className: `${ROOT}-card-body` },
          el('div', { className: `${ROOT}-card-head` },
            el('div', { className: `${ROOT}-card-title-row` },
              el('h3', { className: `${ROOT}-card-title`, title: card.pkg }, card.pkg),
              card.own ? el('span', { className: `${ROOT}-badge own`, title: 'dsh-plugins monorepo 自研' }, '自研') : null,
              sourceBadge(card.source)),
            versionRow(card)),
          el('p', { className: `${ROOT}-card-desc`, title: card.description || '' }, card.description || '暂无描述'),
          el('div', { className: `${ROOT}-card-foot` },
            el('div', {
              className: `${ROOT}-card-meta`,
              title: card.source.type === 'link' ? card.source.path : (card.source.spec || card.source.type),
            },
              ...card.instances.map(i => el('span', {
                className: `${ROOT}-prof-tag`, 'data-off': String(i.info.disabled), key: i.profile,
              }, i.profile)),
              !card.bundled ? el('span', { className: `${ROOT}-badge lock`, title: '不在 profile bundles 中，需手动接线' }, '未接线') : null),
            el('div', { className: `${ROOT}-card-ops` },
              (updInst && updInst.info.check.url && (updInst.info.check.type !== 'link' || updInst.info.check.remoteHasUpdate))
                ? el('a', {
                  className: `${ROOT}-btn sm`, href: updInst.info.check.url, target: '_blank',
                  rel: 'noopener noreferrer', title: '查看更新日志',
                  onClick: event => event.stopPropagation(),
                }, '更新日志') : null,
              updateCommand(card) ? el('button', {
                className: `${ROOT}-btn sm`, type: 'button', title: updateCommand(card),
                onClick: event => { event.stopPropagation(); void copyText(updateCommand(card)) },
              }, '复制更新命令') : null,
              linkUpd.length > 0 ? el('button', {
                className: `${ROOT}-btn sm`, type: 'button', title: '已重启/重载，确认基线',
                onClick: event => { event.stopPropagation(); onAck(card) },
              }, '已生效') : null,
              el('div', { className: `${ROOT}-sw-group` },
                ...card.instances.map(i => el('span', { className: `${ROOT}-sw-item`, key: i.profile },
                  switchEl(i.profile, i.info, onToggle),
                  multi ? el('span', { className: `${ROOT}-sw-label` }, i.profile) : null)))))))
    }

    /** 主分区组件：状态加载 + profile/tab/状态/搜索过滤 + 操作。 */
    function OwnPluginManagerSection() {
      // hooks 顺序（client-runtime.mjs 依赖此顺序做有状态渲染测试）：
      // [view, profile, tab, status, query, loading, refreshing]
      const [view, setView] = react.useState(null)
      const [profile, setProfile] = react.useState('')
      const [tab, setTab] = react.useState('own')
      const [status, setStatus] = react.useState('all')
      const [query, setQuery] = react.useState('')
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

      /** 卡片级「已生效」：把该包所有 link 更新实例的基线对齐当前源码。 */
      async function ackCard(card) {
        const targets = card.instances.filter(i => i.info.check && i.info.check.type === 'link' && i.info.check.hasUpdate)
        if (targets.length === 0) return
        try {
          for (const target of targets) {
            await apiPost(API_ACK, { profile: target.profile, plugin: card.pkg })
            patchPlugin(target.profile, card.pkg, x => (x.check ? { ...x, check: { ...x.check, hasUpdate: false } } : x))
          }
          setView(prev => (prev ? { ...prev, updateCount: Math.max(0, (prev.updateCount || 0) - targets.length) } : prev))
          toast(`已确认 ${card.pkg} 更新生效（${targets.map(t => t.profile).join('、')}）`, 'ok')
        } catch (error) {
          toast(`确认失败：${error.message}`, 'error')
        }
      }

      // ------------------------------------------------------------ repo ops
      /** 重新拉取 state（添加/移除仓库后刷新仓库列表与插件全景）。 */
      async function reloadState() {
        try {
          const data = await apiGet(API_STATE)
          setView(data)
          return data
        } catch (error) {
          toast(`状态刷新失败：${error.message}`, 'error')
          return null
        }
      }

      async function addRepoSource(url) {
        try {
          const data = await apiPost(API_REPOS_ADD, { url })
          const found = (data.view || []).reduce((n, r) => n + (r.plugins || []).length, 0)
          toast(`已关注 ${url}，发现 ${found} 个插件`, 'ok')
          await reloadState()
        } catch (error) {
          toast(`添加仓库失败：${error.message}`, 'error')
        }
      }

      async function removeRepoSource(repo) {
        try {
          await apiPost(API_REPOS_REMOVE, { repo })
          toast(`已移除仓库源 ${repo}`, 'ok')
          await reloadState()
        } catch (error) {
          toast(`移除仓库失败：${error.message}`, 'error')
        }
      }

      async function refreshRepos() {
        try {
          const data = await apiPost(API_REPOS_REFRESH, { force: true })
          const total = (data.repos || []).reduce((n, r) => n + (r.plugins || []).length, 0)
          toast(`仓库探测完成：共发现 ${total} 个插件`, 'ok')
          await reloadState()
        } catch (error) {
          toast(`仓库探测失败：${error.message}`, 'error')
        }
      }

      /** 一键安装/更新仓库发现的插件到目标 profile。 */
      async function installRepoPlugin(p, repoKey, targetProfile) {
        if (!targetProfile) {
          toast('请先在上方 profile 过滤中选择安装目标', 'info')
          return
        }
        const spec = repoPluginSpec(p)
        toast(`正在安装 ${p.pkg} 到 ${targetProfile}…`, 'info')
        try {
          const data = await apiPost(API_INSTALL, { profile: targetProfile, spec })
          if (data.ok === false) {
            toast(`安装失败：${data.error || '未知错误'}${data.stderrTail ? `（${data.stderrTail}）` : ''}`, 'error')
            return
          }
          toast(`已安装 ${p.pkg} 到 ${targetProfile}，请重启 dsh web 生效`, 'ok')
          await reloadState()
        } catch (error) {
          toast(`安装失败：${error.message}`, 'error')
        }
      }

      // ------------------------------------------------------------ derived
      const profilesList = (view && view.profiles) || []
      const cards = aggregate(view, profile)
      const ownCards = cards.filter(c => c.own)
      const commCards = cards.filter(c => !c.own)

      /** 当前 profile 范围内已安装的包名集合（用于仓库插件「未安装」判定）。 */
      const installedPkgs = new Set(cards.map(c => c.pkg))
      /** 仓库发现的插件（含已安装关联信息），合并进社区 Tab。 */
      const repos = (view && view.repos) || []
      const repoPlugins = []
      for (const repo of repos) {
        for (const p of (repo.plugins || [])) {
          if (installedPkgs.has(p.pkg)) continue // 已安装的走常规卡片（更新检测已覆盖）
          repoPlugins.push({ p, repo })
        }
      }
      const tabCards = (tab === 'own' ? ownCards : commCards)
        .slice()
        .sort((a, b) => {
          const ua = a.instances.some(i => i.info.check && i.info.check.hasUpdate) ? 1 : 0
          const ub = b.instances.some(i => i.info.check && i.info.check.hasUpdate) ? 1 : 0
          return (ub - ua) || a.pkg.localeCompare(b.pkg)
        })
      const updatesTotal = cards.filter(c => c.instances.some(i => i.info.check && i.info.check.hasUpdate)).length
      /** 社区 Tab 展示卡片：已安装社区插件 + 仓库发现的未安装插件。 */
      const commTabCards = tab === 'community' ? [...tabCards, ...repoPlugins.map(rp => rp.p).sort((a, b) => a.pkg.localeCompare(b.pkg))] : tabCards
      const communityTotal = tab === 'community' ? commCards.length + repoPlugins.length : 0

      const statusPred = card => {
        const instances = card.instances || []
        if (status === 'on') return instances.some(i => !i.info.disabled)
        if (status === 'off') return instances.length > 0 && instances.every(i => i.info.disabled)
        if (status === 'upd') return instances.some(i => i.info.check && i.info.check.hasUpdate)
        return true
      }
      const q = query.trim().toLowerCase()
      const matchQ = card => !q || [card.pkg, card.description, card.source?.spec || '', card.source?.path || '']
        .join(' ').toLowerCase().includes(q)

      const count = { all: commTabCards.length, on: 0, off: 0, upd: 0 }
      for (const card of commTabCards) {
        const instances = card.instances || []
        if (instances.some(i => !i.info.disabled)) count.on += 1
        if (instances.length > 0 && instances.every(i => i.info.disabled)) count.off += 1
        if (instances.some(i => i.info.check && i.info.check.hasUpdate)) count.upd += 1
      }
      const filtered = commTabCards.filter(card => statusPred(card) && matchQ(card))

      // ------------------------------------------------------------- render
      return el('div', { className: `${ROOT}-container` },
        // 标题
        el('h2', { className: `${ROOT}-title` },
          IconPlug({ size: 20 }),
          el('span', null, '插件管家')),
        el('p', { className: `${ROOT}-subtitle` }, '跨 profile 管理自有与社区插件：启停、版本更新监测、link 源码基线确认。'),
        // 控制台卡片
        el('div', { className: `${ROOT}-console` },
          el('div', { className: `${ROOT}-console-row` },
            el('div', { className: `${ROOT}-meta-group` },
              el('button', {
                className: `${ROOT}-prof-pill`, type: 'button', 'data-on': String(profile === ''),
                onClick: () => setProfile(''),
              }, el('span', { className: `${ROOT}-prof-dot` }), `全部 (${cards.length})`),
              ...profilesList.map(p => el('button', {
                className: `${ROOT}-prof-pill`, type: 'button', key: p.name,
                'data-on': String(profile === p.name),
                title: `~/.dsh/profiles/${p.name}`,
                onClick: () => setProfile(p.name),
              }, el('span', { className: `${ROOT}-prof-dot` }), `${p.name} (${p.plugins.length})`))),
            el('div', { className: `${ROOT}-meta-group` },
              el('span', { className: `${ROOT}-stat`, title: '自有 = link 指 dsh-plugins monorepo；社区 = npm/GitHub/发布包' },
                '自有 ', el('strong', null, String(ownCards.length)),
                ' · 社区 ', el('strong', null, String(commCards.length))),
              el('button', {
                className: `${ROOT}-btn primary`, type: 'button', disabled: refreshing,
                onClick: checkUpdates,
              },
                IconRefresh({ size: 13, className: refreshing ? `${ROOT}-spin` : '' }),
                el('span', null, refreshing ? '检测中…' : '检查更新')))),
          el('div', { className: `${ROOT}-console-meta` },
            el('span', { title: (view && view.checkedAt) || '' }, `上次检测：${timeAgo(view && view.checkedAt)}`),
            updatesTotal > 0
              ? el('span', { className: `${ROOT}-upd-txt` }, `发现 ${updatesTotal} 个插件有可用更新`)
              : (!loading ? el('span', null, '暂无可用更新') : null),
            view && view.error ? el('span', { className: `${ROOT}-err-txt`, title: view.error }, '状态加载失败') : null)),
        // 自有 / 社区 Tab
        el('div', { className: `${ROOT}-tabs` },
          el('button', {
            className: `${ROOT}-tab`, type: 'button', 'data-on': String(tab === 'own'),
            onClick: () => setTab('own'),
          }, '自有插件 ', el('span', { className: `${ROOT}-tab-n` }, `(${ownCards.length})`)),
          el('button', {
            className: `${ROOT}-tab`, type: 'button', 'data-on': String(tab === 'community'),
            onClick: () => setTab('community'),
          }, '社区插件 ', el('span', { className: `${ROOT}-tab-n` }, `(${communityTotal})`))),
        // 分段筛选 + 搜索
        el('div', { className: `${ROOT}-filter-bar` },
          el('div', { className: `${ROOT}-seg` },
            [['all', '全部'], ['on', '已启用'], ['off', '已停用'], ['upd', '有更新']].map(([key, label]) => el('button', {
              className: `${ROOT}-seg-btn`, type: 'button', key: key,
              'data-on': String(status === key),
              onClick: () => setStatus(key),
            }, `${label} (${count[key]})`))),
          el('div', { className: `${ROOT}-search` },
            el('span', { className: `${ROOT}-search-icon` }, IconSearch({ size: 14 })),
            el('input', {
              type: 'text', 'aria-label': '搜索插件',
              placeholder: '搜索插件名称、描述或来源…',
              value: query,
              onChange: event => setQuery(event.target.value),
            }),
            query ? el('button', {
              className: `${ROOT}-search-clear`, type: 'button', title: '清空搜索',
              onClick: () => setQuery(''),
            }, '✕') : null)),
        // 关注仓库源（仅社区 Tab）
        tab === 'community' ? repoSourceCard(repos, addRepoSource, removeRepoSource, refreshRepos, false) : null,
        // 卡片网格 / 空态
        el('div', { className: `${ROOT}-grid-wrap` },
          loading
            ? el('div', { className: `${ROOT}-empty` }, '正在加载插件状态…')
            : (view && view.error && profilesList.length === 0)
              ? el('div', { className: `${ROOT}-empty` }, `加载失败：${view.error}`)
              : commTabCards.length === 0
                ? el('div', { className: `${ROOT}-empty` }, tab === 'own' ? '当前 profile 范围内没有自有插件（link 指 dsh-plugins 的包会归入自有）' : '当前 profile 范围内没有社区插件，可在上方关注 GitHub 仓库源浏览社区插件')
                : filtered.length === 0
                  ? el('div', { className: `${ROOT}-empty` }, '没有匹配的插件，调整筛选或搜索词试试')
                  : el('div', { className: `${ROOT}-grid` },
                    ...filtered.map(card => {
                      if (card.instances) return pluginCard(card, togglePlugin, ackCard)
                      // 仓库发现的未安装插件卡片
                      const rp = repoPlugins.find(x => x.p === card)
                      return repoPluginCard(card, rp ? rp.repo : { repo: '?', installed: {} }, (p, target) => installRepoPlugin(p, rp ? rp.repo.repo : '', target), profile)
                    }))),
        el('div', { className: `${ROOT}-foot` }, '启停改动在 profile 重载或 GUI 重启后生效；「未接线」= 不在 profile bundles 中，开关暂不可用'),
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
          return el('div', { className: `${ROOT}-empty` }, `插件管家渲染失败：${message}`)
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

/* 局部调色板：只引用官方 token，跟随明暗主题。 */
.${ROOT}-container {
  --opm-brand: var(--dsw-alias-brand-primary, var(--dsw-alias-button-info-fill, #4d6bfe));
  --opm-warn: var(--dsw-alias-state-warn-primary, #d97706);
  --opm-ok: var(--dsw-alias-state-success-primary, #10b981);
  --opm-err: var(--dsw-alias-state-error-primary, #d84848);
  --opm-border-1: var(--dsw-alias-border-l1, var(--dsw-alias-border-subtle, #e1e4e8));
  --opm-border-2: var(--dsw-alias-border-l2, var(--dsw-alias-border-default, #d0d7de));
  --opm-layer-1: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1, #f6f8fa));
  --opm-base: var(--dsw-alias-bg-base, var(--dsw-alias-background-base, #fff));
  --opm-t1: var(--dsw-alias-label-primary, #1f2328);
  --opm-t2: var(--dsw-alias-label-secondary, #57606a);
  --opm-t3: var(--dsw-alias-label-tertiary, #656d76);
  display: flex; flex-direction: column; gap: 14px;
  width: 100%; max-width: 960px; min-width: 0;
  color: var(--opm-t1); font-size: 13px;
}
.${ROOT}-container button, .${ROOT}-container input {
  -webkit-appearance: none; appearance: none; font: inherit; color: inherit; margin: 0;
}

.${ROOT}-title {
  display: flex; align-items: center; gap: 8px;
  margin: 0; font-size: 18px; font-weight: 600;
  color: var(--opm-t1);
}
.${ROOT}-subtitle { margin: 0; font-size: 12.5px; line-height: 18px; color: var(--opm-t3); }

/* 控制台卡片 */
.${ROOT}-console {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px; border-radius: 10px;
  background: var(--opm-layer-1);
  border: 1px solid var(--opm-border-1);
}
.${ROOT}-console-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; flex-wrap: wrap;
}
.${ROOT}-meta-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.${ROOT}-prof-pill {
  all: unset; box-sizing: border-box; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 11px; border-radius: 999px;
  background: var(--opm-base); border: 1px solid var(--opm-border-1);
  color: var(--opm-t2); font-size: 12px; font-weight: 500;
  white-space: nowrap; transition: all .15s ease;
}
.${ROOT}-prof-pill:hover { border-color: var(--opm-brand); color: var(--opm-brand); }
.${ROOT}-prof-pill[data-on="true"] {
  background: var(--opm-brand); border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.${ROOT}-prof-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--opm-ok); }
.${ROOT}-prof-pill[data-on="true"] .${ROOT}-prof-dot { background: rgba(255,255,255,.85); }
.${ROOT}-stat {
  font-size: 11.5px; padding: 3px 9px; border-radius: 6px;
  background: var(--opm-base); border: 1px solid var(--opm-border-1);
  color: var(--opm-t2);
}
.${ROOT}-stat strong { color: var(--opm-t1); font-weight: 600; }
.${ROOT}-console-meta {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-top: 8px; border-top: 1px dashed var(--opm-border-1);
  font-size: 11.5px; color: var(--opm-t3);
}
.${ROOT}-upd-txt { color: var(--opm-warn); font-weight: 600; }
.${ROOT}-err-txt { color: var(--opm-err); }

/* 按钮 */
.${ROOT}-btn {
  all: unset; box-sizing: border-box; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 30px; padding: 0 11px; border-radius: 6px;
  font-size: 12px; font-weight: 500; white-space: nowrap;
  border: 1px solid var(--opm-border-2);
  background: var(--opm-base); color: var(--opm-t1);
  text-decoration: none; transition: all .15s ease;
}
.${ROOT}-btn:hover { background: var(--dsw-alias-interactive-bg-hover, var(--opm-layer-1)); }
.${ROOT}-btn[disabled] { opacity: .45; cursor: default; }
.${ROOT}-btn.primary { background: var(--opm-brand); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.${ROOT}-btn.primary:hover { opacity: .9; }
.${ROOT}-btn.sm { height: 24px; padding: 0 8px; font-size: 11px; border-radius: 5px; }

/* Tab */
.${ROOT}-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--opm-border-1); }
.${ROOT}-tab {
  all: unset; box-sizing: border-box; cursor: pointer;
  padding: 7px 12px; font-size: 13px; font-weight: 500;
  color: var(--opm-t2); white-space: nowrap;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  transition: color .15s ease;
}
.${ROOT}-tab:hover { color: var(--opm-t1); }
.${ROOT}-tab[data-on="true"] {
  color: var(--opm-t1); font-weight: 600;
  border-bottom-color: var(--opm-brand);
}
.${ROOT}-tab-n { font-size: 11px; opacity: .75; font-variant-numeric: tabular-nums; }

/* 筛选 + 搜索 */
.${ROOT}-filter-bar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; flex-wrap: wrap;
}
.${ROOT}-seg {
  display: inline-flex; align-items: center; padding: 2px;
  border-radius: 8px; background: var(--opm-layer-1);
  border: 1px solid var(--opm-border-1);
}
.${ROOT}-seg-btn {
  all: unset; box-sizing: border-box; cursor: pointer;
  padding: 5px 11px; border-radius: 6px;
  font-size: 12px; font-weight: 500; color: var(--opm-t2);
  white-space: nowrap; transition: all .15s ease;
}
.${ROOT}-seg-btn:hover { color: var(--opm-t1); }
.${ROOT}-seg-btn[data-on="true"] {
  background: var(--opm-base); color: var(--opm-t1); font-weight: 600;
  box-shadow: var(--dsw-shadow-lv1, 0 1px 3px rgba(0,0,0,.08));
}
.${ROOT}-search { position: relative; flex: 1 1 220px; max-width: 320px; box-sizing: border-box; }
.${ROOT}-search-icon {
  position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
  display: flex; align-items: center; color: var(--opm-t3); pointer-events: none;
}
.${ROOT}-search input {
  box-sizing: border-box; width: 100%; height: 32px;
  padding: 0 28px 0 32px; border-radius: 8px;
  border: 1px solid var(--opm-border-2);
  background: var(--opm-base); color: var(--opm-t1);
  outline: none; font-size: 12.5px;
}
.${ROOT}-search input:focus {
  border-color: var(--opm-brand);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--opm-brand) 18%, transparent);
}
.${ROOT}-search-clear {
  all: unset; cursor: pointer;
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  padding: 4px; font-size: 12px; line-height: 1; color: var(--opm-t3);
}
.${ROOT}-search-clear:hover { color: var(--opm-t1); }

/* 卡片网格 */
.${ROOT}-grid-wrap { display: block; }
.${ROOT}-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px;
}
.${ROOT}-card {
  box-sizing: border-box; display: flex; gap: 12px; align-items: flex-start;
  padding: 12px 14px; border-radius: 10px;
  border: 1px solid var(--opm-border-1); background: var(--opm-base);
  transition: border-color .15s ease, box-shadow .15s ease;
}
.${ROOT}-card:hover {
  border-color: var(--opm-border-2);
  box-shadow: var(--dsw-shadow-lv1, 0 2px 8px rgba(0,0,0,.04));
}
.${ROOT}-card[data-off="true"] .${ROOT}-card-title,
.${ROOT}-card[data-off="true"] .${ROOT}-card-desc { opacity: .55; }
.${ROOT}-card-icon {
  flex: 0 0 auto; width: 36px; height: 36px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  color: var(--opm-t2); background: var(--opm-layer-1);
  border: 1px solid var(--opm-border-1);
}
.${ROOT}-card-icon[data-own="true"] {
  color: var(--opm-warn);
  background: color-mix(in srgb, var(--opm-warn) 12%, transparent);
  border-color: color-mix(in srgb, var(--opm-warn) 30%, transparent);
}
.${ROOT}-card-body { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
.${ROOT}-card-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 8px; flex-wrap: wrap;
}
.${ROOT}-card-title-row { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.${ROOT}-card-title {
  margin: 0; font-size: 14px; font-weight: 600; color: var(--opm-t1);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.${ROOT}-card-desc {
  margin: 0; font-size: 12px; line-height: 18px; color: var(--opm-t2);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

.${ROOT}-badge {
  flex: 0 0 auto; font-size: 11px; padding: 2px 6px; border-radius: 4px;
  background: var(--opm-layer-1); color: var(--opm-t2);
  font-weight: 500; white-space: nowrap;
}
.${ROOT}-badge.own {
  color: var(--opm-warn); font-weight: 600;
  background: color-mix(in srgb, var(--opm-warn) 14%, transparent);
}
.${ROOT}-badge.upd {
  color: var(--opm-warn); font-weight: 600;
  background: color-mix(in srgb, var(--opm-warn) 16%, transparent);
}
.${ROOT}-badge.lock { color: var(--opm-t3); }

.${ROOT}-version-row {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  font-size: 11.5px; line-height: 16px; color: var(--opm-t3);
}
.${ROOT}-ver-cur { color: var(--opm-t1); font-weight: 500; font-variant-numeric: tabular-nums; }
.${ROOT}-ver-next { color: var(--opm-warn); font-weight: 600; font-variant-numeric: tabular-nums; }

/* 关注仓库源 */
.${ROOT}-repos {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px; border-radius: 10px;
  background: var(--opm-layer-1); border: 1px solid var(--opm-border-1);
}
.${ROOT}-repos-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; flex-wrap: wrap;
}
.${ROOT}-repos-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 600; color: var(--opm-t1);
}
.${ROOT}-repos-title svg { color: var(--opm-t2); }
.${ROOT}-repos-hint { font-size: 11px; font-weight: 400; color: var(--opm-t3); }
.${ROOT}-repos-add { display: flex; align-items: center; gap: 8px; }
.${ROOT}-repos-add input {
  box-sizing: border-box; flex: 1; height: 32px;
  padding: 0 12px; border-radius: 8px;
  border: 1px solid var(--opm-border-2); background: var(--opm-base);
  color: var(--opm-t1); outline: none; font-size: 12.5px;
}
.${ROOT}-repos-add input:focus {
  border-color: var(--opm-brand);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--opm-brand) 18%, transparent);
}
.${ROOT}-repos-list { display: flex; flex-direction: column; gap: 6px; }
.${ROOT}-repos-empty { font-size: 12px; color: var(--opm-t3); padding: 4px 0; }
.${ROOT}-repo-pill {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-radius: 8px;
  background: var(--opm-base); border: 1px solid var(--opm-border-1);
}
.${ROOT}-repo-link {
  color: var(--opm-brand); font-size: 12.5px; font-weight: 500;
  text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.${ROOT}-repo-link:hover { text-decoration: underline; }
.${ROOT}-repo-meta {
  display: inline-flex; align-items: center; gap: 4px;
  margin-left: auto; font-size: 11px; color: var(--opm-t3);
  white-space: nowrap;
}
.${ROOT}-badge.repo {
  color: var(--opm-brand);
  background: color-mix(in srgb, var(--opm-brand) 14%, transparent);
}

.${ROOT}-card-foot {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; flex-wrap: wrap;
  padding-top: 6px; border-top: 1px solid var(--opm-border-1);
}
.${ROOT}-card-meta { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-width: 0; }
.${ROOT}-prof-tag {
  font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
  background: var(--opm-layer-1); border: 1px solid var(--opm-border-1);
  color: var(--opm-t2); white-space: nowrap;
}
.${ROOT}-prof-tag[data-off="true"] { opacity: .5; text-decoration: line-through; }
.${ROOT}-card-ops { display: flex; align-items: center; gap: 6px; flex-shrink: 0; flex-wrap: wrap; }
.${ROOT}-sw-group { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.${ROOT}-sw-item { display: inline-flex; align-items: center; gap: 4px; }
.${ROOT}-sw-label { font-size: 10.5px; color: var(--opm-t3); }

/* toggle switch */
.${ROOT}-sw {
  all: unset; cursor: pointer; box-sizing: border-box;
  flex: 0 0 auto; position: relative;
  width: 30px; height: 17px; border-radius: 9px;
  background: var(--dsw-alias-border-l2, var(--opm-border-2));
  transition: background .14s ease;
}
.${ROOT}-sw[data-on="true"] { background: var(--opm-brand); }
.${ROOT}-sw[data-locked="true"] { opacity: .45; cursor: default; }
.${ROOT}-sw-dot {
  position: absolute; top: 2px; left: 2px;
  width: 13px; height: 13px; border-radius: 7px;
  background: var(--dsw-alias-bg-base, var(--opm-base));
  transition: left .14s ease;
}
.${ROOT}-sw[data-on="true"] .${ROOT}-sw-dot { left: 15px; }

.${ROOT}-empty {
  padding: 28px 16px; text-align: center; font-size: 13px; color: var(--opm-t3);
  border: 1px dashed var(--opm-border-1); border-radius: 10px;
}
.${ROOT}-foot { font-size: 10.5px; color: var(--opm-t3); padding-top: 2px; }

/* 刷新图标旋转 */
.${ROOT}-spin { animation: ${ROOT}-rotate 1s linear infinite; }
@keyframes ${ROOT}-rotate { to { transform: rotate(360deg); } }

/* toast（body 级，React 树外） */
.${ROOT}-toast {
  position: fixed; z-index: 96; left: 50%; bottom: 28px;
  transform: translateX(-50%) translateY(6px);
  padding: 8px 16px; border-radius: 999px;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff));
  border: 1px solid var(--opm-border-2);
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,0.16));
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 12.5px;
  opacity: 0; pointer-events: none;
  transition: opacity .18s ease, transform .18s ease;
}
.${ROOT}-toast[data-show="true"] { opacity: 1; transform: translateX(-50%) translateY(0); }
.${ROOT}-toast[data-tone="error"] { border-color: color-mix(in srgb, var(--opm-err, var(--dsw-alias-state-error-primary, #d84848)) 45%, transparent); }

@media (max-width: 768px) {
  .${ROOT}-grid { grid-template-columns: 1fr; }
  .${ROOT}-filter-bar { flex-direction: column; align-items: stretch; }
  .${ROOT}-search { max-width: none; }
}
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
        }, () => el(SectionErrorBoundary, null,
          el(OwnPluginManagerSection, null))))
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
