/**
 * dsh-session-archive — browser half (runs inside the dsh web GUI).
 *
 * One-click archive of idle sessions per project (workspace):
 *
 *   - A small archive button appears on every sidebar workspace row when the
 *     row is hovered (it joins the row's existing hover actions).
 *   - Clicking it opens a confirmation dialog that lists how many sessions in
 *     this workspace were last active more than N days ago (default 3, the
 *     threshold is editable in the dialog and persisted to localStorage).
 *   - Confirming archives them all through the DSH-native
 *     `workspaces.archiveSession(sessionId)` RPC — archived sessions keep
 *     their workspace accounting slot and can be unarchived from DSH's own
 *     archived-session surface, so this is safe and reversible.
 *
 * Implementation notes
 * --------------------
 * - Cordis client plugin: `inject` pulls the services we need, `apply(ctx)`
 *   receives the client root context. We use `ctx.get("workspaces").list`
 *   (store snapshot: `{items, archivedSessionIds, phase}`) and
 *   `ctx.get("sessions").list` (store snapshot: `{byId, ids, phase}`).
 * - Session→workspace membership is authoritative on the workspace side:
 *   `workspace.sessionIds.includes(sessionId)` (the client session summary
 *   has no workspaceId field).
 * - Idle = `Date.now() - summary.updatedAt > idleDays * 86400000`. Sessions
 *   without an `updatedAt` are conservatively treated as NOT idle (never
 *   archived by mistake).
 * - The workspace row is rendered by React (dsh-client-ui-workspace) with
 *   hashed CSS-module class names, so we locate it structurally instead:
 *   `div[role="treeitem"]` whose 3rd child holds the title span
 *   (`projectText > title`). A MutationObserver re-injects the buttons
 *   whenever the sidebar re-renders.
 * - The dialog/toast live OUTSIDE the React tree (appended to document.body,
 *   position fixed), so they can never disturb the shell's reconciliation.
 *   Mount failures are logged, never thrown.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-archive',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ------------------------------------------------------------------ config
    const IDLE_DAYS_DEFAULT = 3
    const STORAGE_KEY = 'dsh.sessionArchive.idleDays'
    const DAY_MS = 86400000

    // ------------------------------------------------------------------- state
    let ctx = null
    let observer = null
    let injectedRows = new WeakSet()
    let dialogEl = null
    let backdropEl = null
    let toastEl = null
    let toastTimer = null

    // ---------------------------------------------------------------- helpers
    function idleDays() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        const n = raw === null ? NaN : Number(raw)
        if (Number.isFinite(n) && n > 0) return n
      } catch (error) {
        /* localStorage may be unavailable; fall through to default. */
      }
      return IDLE_DAYS_DEFAULT
    }

    function storeIdleDays(days) {
      try {
        localStorage.setItem(STORAGE_KEY, String(days))
      } catch (error) {
        /* persist best-effort only. */
      }
    }

    /** Extract the title text of a workspace row without relying on hashed class names. */
    function rowTitle(row) {
      const projectText = row.children[2]
      const title = projectText?.children?.[0]
      if (title && typeof title.textContent === 'string') {
        const text = title.textContent.trim()
        if (text.length > 0) return text
      }
      return ''
    }

    /**
     * Collect (workspaceId, title, sessionIds) for every workspace that is
     * currently visible in the sidebar, matched structurally by row title.
     */
    function visibleWorkspaces(wsState) {
      const rows = new Map()
      for (const row of document.querySelectorAll('[role="treeitem"]')) {
        const title = rowTitle(row)
        if (title === '') continue
        if (!rows.has(title)) rows.set(title, row)
      }
      const out = []
      for (const item of wsState.items) {
        const row = rows.get(item.title)
        if (row === undefined) continue
        out.push({ workspaceId: item.workspaceId, title: item.title, row, sessionIds: item.sessionIds ?? [] })
      }
      return out
    }

    /**
     * Idle candidates for one workspace: its accounted sessions that are not
     * archived, are not subagent children, and were last active more than
     * `days` ago. Sessions with no updatedAt are never considered idle.
     */
    function idleCandidates(wsState, sessionsState, workspace, days) {
      const archived = new Set(wsState.archivedSessionIds)
      const cutoff = Date.now() - days * DAY_MS
      const candidates = []
      for (const sessionId of workspace.sessionIds) {
        const summary = sessionsState.byId[sessionId]
        if (summary === undefined) continue
        if (archived.has(sessionId)) continue
        if (summary.origin === 'subagent') continue
        if (typeof summary.updatedAt !== 'number') continue
        if (summary.updatedAt > cutoff) continue
        candidates.push({ sessionId, title: summary.displayTitle ?? summary.title ?? '' })
      }
      return candidates
    }

    /** Short human label for a session (empty for blank/provisional rows). */
    function shortLabel(session, index, total) {
      const base = session.title.trim()
      if (base !== '') return base.length > 24 ? `${base.slice(0, 24)}…` : base
      return `（未命名会话 ${index + 1}/${total}）`
    }

    // ---------------------------------------------------------------- archive
    async function archiveCandidates(workspaceTitle, candidates) {
      if (candidates.length === 0) return 0
      const workspaces = ctx.get('workspaces')
      let ok = 0
      for (const candidate of candidates) {
        try {
          await workspaces.archiveSession(candidate.sessionId)
          ok += 1
        } catch (error) {
          console.warn(`[dsh-session-archive] archive ${candidate.sessionId} failed:`, error)
        }
      }
      return ok
    }

    // -------------------------------------------------------------------- ui
    function openDialog(workspaceTitle, initialDays) {
      closeDialog()
      const wsState = ctx.get('workspaces').list.getSnapshot()
      const sessionsState = ctx.get('sessions').list.getSnapshot()
      const workspace = wsState.items.find((item) => item.title === workspaceTitle)
      if (workspace === undefined) return

      const daysInput = document.createElement('input')
      daysInput.type = 'number'
      daysInput.min = '1'
      daysInput.step = '1'
      daysInput.value = String(initialDays)
      daysInput.dataset.dshSessionArchive = 'days'

      const countLine = document.createElement('div')
      countLine.dataset.dshSessionArchive = 'count'
      const preview = document.createElement('ul')
      preview.dataset.dshSessionArchive = 'preview'

      const refresh = () => {
        const days = Math.max(1, Math.floor(Number(daysInput.value) || initialDays))
        const candidates = idleCandidates(wsState, sessionsState, workspace, days)
        const n = candidates.length
        countLine.textContent =
          n === 0
            ? '该项目下没有超过该天数未活动的会话'
            : `将归档 ${n} 个空闲会话（最后活动超过 ${days} 天）`
        preview.replaceChildren()
        for (let i = 0; i < Math.min(candidates.length, 5); i += 1) {
          const li = document.createElement('li')
          li.textContent = shortLabel(candidates[i], i, candidates.length)
          preview.appendChild(li)
        }
        if (candidates.length > 5) {
          const li = document.createElement('li')
          li.textContent = `… 等共 ${candidates.length} 个`
          li.dataset.dshSessionArchive = 'more'
          preview.appendChild(li)
        }
        return candidates
      }

      const title = document.createElement('div')
      title.dataset.dshSessionArchive = 'title'
      title.textContent = '归档空闲会话'

      const name = document.createElement('div')
      name.dataset.dshSessionArchive = 'name'
      name.textContent = `项目「${workspaceTitle}」`

      const field = document.createElement('label')
      field.dataset.dshSessionArchive = 'field'
      field.append('空闲阈值（天）：', daysInput)
      daysInput.addEventListener('input', refresh)

      const confirm = document.createElement('button')
      confirm.type = 'button'
      confirm.dataset.dshSessionArchive = 'confirm'
      confirm.textContent = '归档'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.dataset.dshSessionArchive = 'cancel'
      cancel.textContent = '取消'

      const actions = document.createElement('div')
      actions.dataset.dshSessionArchive = 'actions'
      actions.appendChild(cancel)
      actions.appendChild(confirm)

      const panel = document.createElement('div')
      panel.dataset.dshSessionArchive = 'panel'
      panel.appendChild(title)
      panel.appendChild(name)
      panel.appendChild(field)
      panel.appendChild(countLine)
      panel.appendChild(preview)
      panel.appendChild(actions)

      backdropEl = document.createElement('div')
      backdropEl.dataset.dshSessionArchive = 'backdrop'
      backdropEl.addEventListener('click', closeDialog, true)

      dialogEl = document.createElement('div')
      dialogEl.dataset.dshSessionArchive = 'dialog'
      dialogEl.appendChild(panel)

      document.body.appendChild(backdropEl)
      document.body.appendChild(dialogEl)

      const finish = (close) => {
        closeDialog()
        if (close) return
        const days = Math.max(1, Math.floor(Number(daysInput.value) || initialDays))
        storeIdleDays(days)
        const candidates = refresh()
        if (candidates.length === 0) {
          showToast(`项目「${workspaceTitle}」没有可归档的空闲会话`)
          return
        }
        void (async () => {
          const ok = await archiveCandidates(workspaceTitle, candidates)
          showToast(`已归档 ${ok} 个空闲会话${ok < candidates.length ? `（${candidates.length - ok} 个失败）` : ''}`)
        })()
      }

      cancel.addEventListener('click', () => finish(true))
      confirm.addEventListener('click', () => finish(false))
      refresh()
    }

    function closeDialog() {
      if (backdropEl !== null) {
        backdropEl.remove()
        backdropEl = null
      }
      if (dialogEl !== null) {
        dialogEl.remove()
        dialogEl = null
      }
    }

    function showToast(message) {
      if (toastTimer !== null) {
        clearTimeout(toastTimer)
        toastTimer = null
      }
      if (toastEl !== null) toastEl.remove()
      toastEl = document.createElement('div')
      toastEl.dataset.dshSessionArchive = 'toast'
      toastEl.textContent = message
      document.body.appendChild(toastEl)
      toastTimer = setTimeout(() => {
        toastEl?.remove()
        toastEl = null
        toastTimer = null
      }, 3000)
    }

    // ---------------------------------------------------------------- inject
    function ensureButton(row, workspaceId, title) {
      if (injectedRows.has(row)) return
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.dshSessionArchive = 'button'
      button.title = `归档「${title}」的空闲会话`
      button.setAttribute('aria-label', `归档「${title}」的空闲会话`)
      button.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M2.5 5.5h11M3.5 5.5v7a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5v-7M5.5 5.5V3.75A1.25 1.25 0 0 1 6.75 2.5h2.5A1.25 1.25 0 0 1 10.5 3.75V5.5"/>' +
        '<path d="M6.5 8.5h3"/>' +
        '</svg>'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (ctx === null) return
        openDialog(title, idleDays())
      })
      row.appendChild(button)
      injectedRows.add(row)
    }

    function sweep() {
      if (ctx === null) return
      const wsState = ctx.get('workspaces').list.getSnapshot()
      if (wsState.phase !== 'ready') return
      for (const workspace of visibleWorkspaces(wsState)) {
        ensureButton(workspace.row, workspace.workspaceId, workspace.title)
      }
    }

    // ------------------------------------------------------------------ styles
    function ensureStyles() {
      if (document.getElementById('dsh-session-archive-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-session-archive-styles'
      style.setAttribute('data-plugin', 'dsh-session-archive')
      style.textContent = `
[data-dsh-session-archive="button"] {
  all: unset;
  position: absolute;
  right: 34px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary, #666);
  opacity: 0;
  transition: opacity .12s var(--ds-ease-in-out, ease), background-color .12s var(--ds-ease-in-out, ease);
  z-index: 2;
}
[data-dsh-session-archive="button"]:hover {
  color: var(--dsw-alias-label-primary, #1a1a1a);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
}
[data-dsh-session-archive="backdrop"] {
  position: fixed;
  inset: 0;
  z-index: 9990;
  background: rgba(0,0,0,0.32);
}
[data-dsh-session-archive="dialog"] {
  position: fixed;
  z-index: 9991;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 360px;
  max-width: calc(100vw - 32px);
  border-radius: 14px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #fff));
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12));
  box-shadow: 0 16px 48px rgba(0,0,0,0.22);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
[data-dsh-session-archive="title"] {
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
[data-dsh-session-archive="name"] {
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #666);
}
[data-dsh-session-archive="field"] {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #666);
}
[data-dsh-session-archive="days"] {
  all: unset;
  box-sizing: border-box;
  width: 64px;
  height: 28px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.18));
  border-radius: 8px;
  padding: 0 8px;
  font-size: 13px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  background: var(--dsw-alias-bg-layer-2, #f7f7f7);
}
[data-dsh-session-archive="count"] {
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
[data-dsh-session-archive="preview"] {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 140px;
  overflow-y: auto;
}
[data-dsh-session-archive="preview"] li {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #666);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-session-archive="preview"] li[data-dsh-session-archive="more"] {
  color: var(--dsw-alias-label-tertiary, #999);
}
[data-dsh-session-archive="actions"] {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
[data-dsh-session-archive="cancel"],
[data-dsh-session-archive="confirm"] {
  all: unset;
  box-sizing: border-box;
  height: 32px;
  padding: 0 16px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-align: center;
}
[data-dsh-session-archive="cancel"] {
  color: var(--dsw-alias-label-secondary, #666);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
}
[data-dsh-session-archive="cancel"]:hover {
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
[data-dsh-session-archive="confirm"] {
  color: #fff;
  background: var(--dsw-alias-state-error-primary, #d5484d);
}
[data-dsh-session-archive="confirm"]:hover {
  filter: brightness(1.06);
}
[data-dsh-session-archive="confirm"]:disabled {
  opacity: .5;
  cursor: default;
}
[data-dsh-session-archive="toast"] {
  position: fixed;
  z-index: 9992;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100vw - 32px);
  padding: 10px 16px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #fff));
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12));
  box-shadow: 0 8px 28px rgba(0,0,0,0.18);
}
`
      document.head.appendChild(style)
    }

    // ------------------------------------------------------------------ apply
    function apply(clientCtx) {
      try {
        ctx = clientCtx

        // Make the workspace row position:relative so the absolutely positioned
        // button anchors to the row, and reveal the button on row hover
        // (mirrors the built-in rowActions hover behaviour).
        const anchorCss = document.createElement('style')
        anchorCss.id = 'dsh-session-archive-anchor'
        anchorCss.setAttribute('data-plugin', 'dsh-session-archive')
        anchorCss.textContent = [
          'div[role="treeitem"]:has([data-dsh-session-archive="button"]){position:relative}',
          'div[role="treeitem"]:hover [data-dsh-session-archive="button"]{opacity:1}',
        ].join('\n')
        document.head.appendChild(anchorCss)

        ensureStyles()
        sweep()

        // Self-heal: re-inject when the sidebar re-renders.
        observer = new MutationObserver(() => {
          sweep()
        })
        observer.observe(document.body, { childList: true, subtree: true })

        clientCtx.effect(() => () => {
          observer?.disconnect()
          observer = null
          closeDialog()
          if (toastTimer !== null) {
            clearTimeout(toastTimer)
            toastTimer = null
          }
          if (toastEl !== null) {
            toastEl.remove()
            toastEl = null
          }
          for (const button of document.querySelectorAll('[data-dsh-session-archive="button"]')) {
            button.remove()
          }
          document.getElementById('dsh-session-archive-styles')?.remove()
          document.getElementById('dsh-session-archive-anchor')?.remove()
          ctx = null
        }, 'dsh-session-archive: inject')
      } catch (error) {
        console.warn('[dsh-session-archive] mount failed:', error)
      }
    }

    exports.apply = apply
    exports.inject = ['workspaces', 'sessions']
    return module.exports
  },
})
