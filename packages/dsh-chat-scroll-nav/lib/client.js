/**
 * dsh-chat-scroll-nav — browser half (runs inside the dsh web GUI).
 *
 * Adds a message quick-nav rail on the right edge of the chat conversation:
 * a fixed-height list (max 10 rows) of the user's own messages, vertically
 * centered on the conversation area. Each label shows the message text
 * (truncated with ellipsis; hover for the full preview). Click a label to
 * jump to that message; when there are more than 10, up/down buttons scroll
 * the list and the active message's label is kept in view automatically.
 *
 * Plain-DOM injection with a self-healing MutationObserver — the rail lives
 * OUTSIDE the React tree (appended to document.body, position:fixed) and is
 * re-synced on scroll / resize / content mutation, so it can never disturb
 * the shell's React reconciliation. Mount failures are logged, never thrown.
 *
 * Stable DOM hooks this relies on (from @deepseek-ai/dsh-client-ui-conversation):
 *   [data-conversation-scroll] — the conversation scroll container
 *   [data-chat-flow]           — the message flow list column
 *   [data-chat-anchor-key]     — one message/turn row, with
 *   [data-chat-flow-kind]      — its kind (user | assistant | tool-call | …)
 *   [data-composer-seat]       — the composer (marks the bottom of messages)
 */
window.__ModuleLoader__.load({
  id: 'dsh-chat-scroll-nav',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ------------------------------------------------------------- selectors
    const SCROLLER_SEL = '[data-conversation-scroll]'
    const FLOW_SEL = '[data-chat-flow]'
    const ITEM_SEL = '[data-chat-anchor-key]'
    const COMPOSER_SEL = '[data-composer-seat]'
    const RAIL_SEL = '[data-dsh-scroll-nav="rail"]'
    const TICK_SEL = '[data-dsh-scroll-nav="tick"]'

    // ---------------------------------------------------------------- styles
    function ensureStyles() {
      if (document.getElementById('dsh-scroll-nav-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-scroll-nav-styles'
      style.setAttribute('data-plugin', 'dsh-chat-scroll-nav')
      style.textContent = `
/* rail: fixed overlay on the right edge of the conversation area.
   Fixed height = up button + 10 label rows + down button; vertically centered. */
.dsn-rail {
  position: fixed;
  z-index: 45;
  width: 168px;
  border-radius: 10px;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  background: transparent;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  transition: background 0.15s ease, box-shadow 0.15s ease, backdrop-filter 0.15s ease;
}
.dsn-rail:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12));
  -webkit-backdrop-filter: blur(12px) saturate(1.4);
  backdrop-filter: blur(12px) saturate(1.4);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.18), 0 4px 16px rgba(0,0,0,0.10);
}
.dsn-rail[data-hidden="true"] { display: none; }

/* up / down scroll buttons */
.dsn-btn {
  flex: 0 0 auto;
  height: 20px;
  line-height: 20px;
  text-align: center;
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8));
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease, color 0.12s ease;
}
.dsn-rail:hover .dsn-btn[data-enabled="true"] { opacity: 1; pointer-events: auto; }
.dsn-btn:hover { color: var(--dsw-static-deepseek-500, #4d6bfe); }

/* scrollable list of labels: exactly 10 rows tall, centered when short */
.dsn-list {
  position: relative;
  flex: 0 0 auto;
  height: 252px; /* 10 * 18px rows + 9 * 8px gaps */
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  justify-content: safe center;
  align-items: flex-end;
  gap: 8px;
  padding: 4px 0;
  scrollbar-width: none;
}
.dsn-list::-webkit-scrollbar { display: none; }

/* one label per user message: fixed spacing, truncated text */
.dsn-tick {
  position: relative;
  flex: 0 0 auto;
  max-width: 150px;
  height: 18px;
  line-height: 18px;
  padding: 0 7px;
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #555);
  font-size: 11px;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
}
.dsn-tick[data-kind="user"] {
  background: transparent;
  color: var(--dsw-alias-label-secondary, #555);
}
.dsn-tick[data-kind="assistant"] { display: none; }
.dsn-tick[data-active="true"] {
  background: var(--dsw-static-deepseek-500, #4d6bfe);
  color: var(--dsw-alias-bg-base, #fff);
  box-shadow: 0 0 0 2px var(--dsw-alias-bg-base, #fff);
}
.dsn-rail:hover .dsn-tick[data-active="true"] { background: var(--dsw-static-deepseek-500, #4d6bfe); box-shadow: 0 0 0 2px var(--dsw-alias-bg-base, #fff); }

/* message count chip (bottom of rail, shown on hover) */
.dsn-count {
  flex: 0 0 auto;
  height: 12px;
  line-height: 12px;
  text-align: center;
  font-size: 9px;
  font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8));
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
}
.dsn-rail:hover .dsn-count { opacity: 1; }

/* tooltip: message preview to the left of the rail */
.dsn-tooltip {
  position: fixed;
  z-index: 46;
  max-width: 300px;
  padding: 7px 11px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25));
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #111);
  box-shadow: var(--dsw-shadow-lv3, 0 8px 30px rgba(0,0,0,0.18));
  font-size: 12px;
  line-height: 1.55;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.dsn-tooltip[data-show="true"] { opacity: 1; }
.dsn-tooltipRole {
  font-weight: 600;
  color: var(--dsw-static-deepseek-500, #4d6bfe);
  margin-bottom: 1px;
}
.dsn-tooltipRole[data-kind="user"] { color: var(--dsw-static-deepseek-500, #4d6bfe); }
.dsn-tooltipRole[data-kind="assistant"] { color: var(--dsw-alias-label-secondary, #555); }
.dsn-tooltipText {
  color: var(--dsw-alias-label-secondary, #555);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
`
      document.head.append(style)
    }

    // --------------------------------------------------------------- helpers
    /** Preview text cache — cloning every row on every sync is far too costly. */
    const previewCache = new Map()

    /** Text preview for one message row: strip UI chrome, collapse whitespace. */
    function messagePreview(item, key) {
      const cacheKey = key || item.getAttribute('data-chat-anchor-key') || ''
      if (cacheKey !== '' && previewCache.has(cacheKey)) return previewCache.get(cacheKey)
      const clone = item.cloneNode(true)
      clone.querySelectorAll(
        'button, svg, [role="button"], [aria-hidden="true"], [data-dsh-scroll-nav], script, style',
      ).forEach((node) => node.remove())
      const text = (clone.textContent || '').replace(/\s+/g, ' ').trim()
      const preview = text.length === 0 ? '' : text.slice(0, 90)
      if (cacheKey !== '') {
        if (previewCache.size > 600) previewCache.clear()
        previewCache.set(cacheKey, preview)
      }
      return preview
    }

    /** Cached message targets; invalidated when the row set may have changed. */
    let targetsCache = null
    let targetsCacheInvalid = true
    function invalidateTargets() {
      targetsCacheInvalid = true
    }

    /** Resolve the real scroll container (the conversation scroll body). */
    function findScroller() {
      const explicit = document.querySelector(SCROLLER_SEL)
      if (explicit !== null) return explicit
      // Fallback: nearest scrollable ancestor of the message flow.
      const flow = document.querySelector(FLOW_SEL)
      if (flow === null) return null
      let node = flow.parentElement
      while (node !== null) {
        if (node.scrollHeight > node.clientHeight + 1) {
          const style = window.getComputedStyle(node)
          if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay') return node
        }
        node = node.parentElement
      }
      return null
    }

    /** All rendered user messages in order (cached between row-set changes). */
    function collectTargets() {
      if (!targetsCacheInvalid && targetsCache !== null) return targetsCache
      const flow = document.querySelector(FLOW_SEL)
      if (flow === null) return []
      const items = flow.querySelectorAll(ITEM_SEL)
      const targets = []
      for (const item of items) {
        const kind = item.getAttribute('data-chat-flow-kind') || ''
        if (kind === 'user') {
          targets.push({ item, kind, key: item.getAttribute('data-chat-anchor-key') || '' })
        }
      }
      targetsCache = targets
      targetsCacheInvalid = false
      return targets
    }

    /** Content-space offset of an item's vertical center within the scroller. */
    function itemOffset(item, scroller) {
      const scrollerRect = scroller.getBoundingClientRect()
      const rect = item.getBoundingClientRect()
      const center = rect.top + rect.height / 2
      return scroller.scrollTop + (center - scrollerRect.top)
    }

    /** The message currently being read: first whose bottom passes the top edge.
     *  Rows are laid out in order, so binary-search instead of walking all. */
    function activeIndex(targets, scroller) {
      if (targets.length === 0) return -1
      const rect = scroller.getBoundingClientRect()
      const topEdge = rect.top + 8
      let lo = 0
      let hi = targets.length - 1
      let result = targets.length - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (targets[mid].item.getBoundingClientRect().bottom >= topEdge) {
          result = mid
          hi = mid - 1
        } else {
          lo = mid + 1
        }
      }
      return result
    }

    // ------------------------------------------------------------------ rail
    let rail = null
    let upBtn = null
    let downBtn = null
    let list = null
    let tooltip = null
    let count = null
    let rafPending = false

    function buildRail() {
      ensureStyles()
      rail = document.createElement('div')
      rail.setAttribute('data-dsh-scroll-nav', 'rail')
      rail.className = 'dsn-rail'
      rail.setAttribute('aria-hidden', 'true')

      upBtn = document.createElement('div')
      upBtn.setAttribute('data-dsh-scroll-nav', 'btn-up')
      upBtn.className = 'dsn-btn'
      upBtn.textContent = '▲'
      rail.append(upBtn)

      list = document.createElement('div')
      list.className = 'dsn-list'
      rail.append(list)

      downBtn = document.createElement('div')
      downBtn.setAttribute('data-dsh-scroll-nav', 'btn-down')
      downBtn.className = 'dsn-btn'
      downBtn.textContent = '▼'
      rail.append(downBtn)

      count = document.createElement('div')
      count.className = 'dsn-count'
      rail.append(count)

      tooltip = document.createElement('div')
      tooltip.className = 'dsn-tooltip'
      tooltip.setAttribute('data-show', 'false')
      tooltip.innerHTML = '<div class="dsn-tooltipRole" data-kind=""></div><div class="dsn-tooltipText"></div>'
      document.body.append(tooltip)

      document.body.append(rail)
      wireEvents()
    }

    function scrollToKey(key) {
      if (key === '') return
      const scroller = findScroller()
      if (scroller === null) return
      const flow = document.querySelector(FLOW_SEL)
      if (flow === null) return
      const row = Array.from(flow.querySelectorAll(ITEM_SEL)).find((el) => el.getAttribute('data-chat-anchor-key') === key)
      if (row === undefined) return
      const rect = row.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      const offset = scroller.scrollTop + (rect.top - scrollerRect.top)
      scroller.scrollTop = Math.max(0, offset - 12)
    }

    function showTooltip(target, clientX, clientY) {
      if (tooltip === null) return
      const roleEl = tooltip.querySelector('.dsn-tooltipRole')
      const textEl = tooltip.querySelector('.dsn-tooltipText')
      if (roleEl === null || textEl === null) return
      roleEl.textContent = target.kind === 'user' ? '你' : 'AI'
      roleEl.dataset.kind = target.kind
      const preview = messagePreview(target.item, target.key)
      textEl.textContent = preview
      tooltip.setAttribute('data-show', 'true')
      // position to the left of the tick, vertically centered on it
      const tw = tooltip.offsetWidth || 220
      const th = tooltip.offsetHeight || 40
      let left = clientX - tw - 10
      if (left < 8) left = clientX + 18
      let top = clientY - th / 2
      top = Math.max(8, Math.min(window.innerHeight - th - 8, top))
      tooltip.style.left = left + 'px'
      tooltip.style.top = top + 'px'
    }

    function hideTooltip() {
      if (tooltip === null) return
      tooltip.setAttribute('data-show', 'false')
    }

    /** Scroll the label list by one page (up/down buttons). */
    function scrollListBy(direction) {
      if (list === null) return
      const page = list.clientHeight || 252
      if (typeof list.scrollBy === 'function') {
        list.scrollBy({ top: direction * page, behavior: 'smooth' })
      } else {
        list.scrollTop += direction * page
      }
    }

    function wireEvents() {
      if (rail === null) return
      rail.addEventListener('click', (event) => {
        const tick = event.target.closest(TICK_SEL)
        if (tick !== null) {
          const key = tick.getAttribute('data-anchor-key') || ''
          scrollToKey(key)
          return
        }
        if (event.target === upBtn) scrollListBy(-1)
        else if (event.target === downBtn) scrollListBy(1)
      })
      // re-evaluate button states after the list itself scrolls (wheel / follow)
      list.addEventListener('scroll', () => syncButtons())
      // delegated hover tooltip
      rail.addEventListener('mouseover', (event) => {
        const tick = event.target.closest(TICK_SEL)
        if (tick !== null) {
          const index = Number(tick.getAttribute('data-index') || '-1')
          const targets = collectTargets()
          if (index >= 0 && index < targets.length) {
            const rect = tick.getBoundingClientRect()
            showTooltip(targets[index], rect.left, rect.top + rect.height / 2)
          }
        }
      })
      rail.addEventListener('mouseout', () => {
        hideTooltip()
      })
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') hideTooltip()
      })
    }

    /** Signature of the current message set — used to detect real set changes. */
    function targetsSignature(targets) {
      let sig = String(targets.length)
      for (const t of targets) sig += ':' + t.key
      return sig
    }

    let lastSignature = null

    /** Update the rail's fixed overlay geometry: fixed height, vertically centered. */
    function updateGeometry(scroller) {
      const scrollerRect = scroller.getBoundingClientRect()
      const railHeight = rail.offsetHeight || 304 // btn + list(10 rows) + btn + count
      // center the fixed-height rail on the conversation area
      const top = scrollerRect.top + Math.max(0, (scrollerRect.height - railHeight) / 2)
      rail.style.top = Math.round(top) + 'px'
      // hug the scroller's right edge, inset enough to clear the native scrollbar
      const insetFromViewport = window.innerWidth - scrollerRect.right + 10
      rail.style.right = Math.max(4, insetFromViewport) + 'px'
    }

    /** Rebuild all labels from the current target list (fixed spacing).
     *  Long conversations: shells mount immediately; preview text (the costly
     *  cloneNode part) fills in over a few frames instead of one big jank. */
    let tickCache = []
    let lastActiveTick = null
    let fillJob = 0
    function rebuildTicks(scroller, targets) {
      fillJob++
      for (const old of Array.from(list.querySelectorAll(TICK_SEL))) old.remove()
      const job = fillJob
      tickCache = targets.map((target, index) => {
        const tick = document.createElement('div')
        tick.setAttribute('data-dsh-scroll-nav', 'tick')
        tick.className = 'dsn-tick'
        tick.setAttribute('data-kind', target.kind)
        tick.setAttribute('data-index', String(index))
        tick.setAttribute('data-anchor-key', target.key)
        list.append(tick)
        return tick
      })
      lastActiveTick = null
      const fillFrom = (start) => {
        if (job !== fillJob) return // superseded by a newer rebuild
        const end = Math.min(targets.length, start + 50)
        for (let i = start; i < end; i++) {
          const preview = messagePreview(targets[i].item, targets[i].key)
          tickCache[i].setAttribute('title', preview)
          tickCache[i].textContent = preview
        }
        if (end < targets.length) requestAnimationFrame(() => fillFrom(end))
      }
      fillFrom(0)
    }

    /** Enable the up/down buttons only when the list can scroll that way. */
    function syncButtons() {
      if (list === null || upBtn === null || downBtn === null) return
      const scrollHeight = list.scrollHeight || 0
      const clientHeight = list.clientHeight || 0
      const overflow = scrollHeight > clientHeight + 1
      const scrollTop = list.scrollTop || 0
      upBtn.setAttribute('data-enabled', overflow && scrollTop > 1 ? 'true' : 'false')
      downBtn.setAttribute(
        'data-enabled',
        overflow && scrollTop + clientHeight < scrollHeight - 1 ? 'true' : 'false',
      )
    }

    /** Highlight the message currently in view; keep it visible in the list. */
    function syncActive(scroller, targets) {
      if (targets.length === 0) return
      const active = activeIndex(targets, scroller)
      const activeTick = active >= 0 && active < tickCache.length ? tickCache[active] : null
      // touch at most two nodes per sync instead of re-writing all labels
      if (activeTick !== lastActiveTick) {
        if (lastActiveTick !== null && lastActiveTick.isConnected) lastActiveTick.removeAttribute('data-active')
        if (activeTick !== null) activeTick.setAttribute('data-active', 'true')
        lastActiveTick = activeTick
        // follow the active label when the list itself overflows and scrolls
        if (activeTick !== null && typeof activeTick.scrollIntoView === 'function') {
          activeTick.scrollIntoView({ block: 'nearest' })
        }
      }
      if (count !== null && count.textContent !== String(targets.length)) {
        count.textContent = String(targets.length)
      }
      syncButtons()
    }

    /**
     * Full re-sync. Rebuilds ticks only when the message set actually changed;
     * on every call it updates geometry and the active marker.
     */
    function render() {
      if (rail === null) return
      const scroller = findScroller()
      if (scroller === null) {
        rail.setAttribute('data-hidden', 'true')
        hideTooltip()
        return
      }
      const targets = collectTargets()
      updateGeometry(scroller)
      const signature = targetsSignature(targets)
      if (signature !== lastSignature) {
        lastSignature = signature
        rebuildTicks(scroller, targets)
      }
      syncActive(scroller, targets)
      rail.setAttribute('data-hidden', targets.length === 0 ? 'true' : 'false')
    }

    /** Lightweight sync for scroll/resize: geometry + active only. */
    function syncLight() {
      if (rail === null) return
      if (rail.getAttribute('data-hidden') === 'true') return
      const scroller = findScroller()
      if (scroller === null) return
      updateGeometry(scroller)
      syncActive(scroller, collectTargets())
    }

    function schedule(fn) {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        fn()
      })
    }

    const scheduleRender = () => schedule(render)
    const scheduleLight = () => schedule(syncLight)

    // -------------------------------------------------------------- observers
    /** Did these mutations add/remove message rows (vs. in-place text updates)? */
    function touchesAnchors(mutations) {
      if (mutations == null) return true // unknown → assume the worst, full re-sync
      for (const m of mutations) {
        for (const nodes of [m.addedNodes, m.removedNodes]) {
          if (nodes == null) continue
          for (const node of nodes) {
            if (node.nodeType !== undefined && node.nodeType !== 1) continue
            if (typeof node.matches === 'function' && node.matches(ITEM_SEL)) return true
            if (typeof node.querySelector === 'function' && node.querySelector(ITEM_SEL) !== null) return true
          }
        }
      }
      return false
    }

    function wireObservers() {
      // message flow mutations: row add/remove → full re-sync; streaming text
      // updates (assistant tokens etc.) only need geometry + active refresh.
      const flowObserver = new MutationObserver((mutations) => {
        if (touchesAnchors(mutations)) {
          invalidateTargets()
          scheduleRender()
        } else {
          scheduleLight()
        }
      })
      const observeFlow = () => {
        const flow = document.querySelector(FLOW_SEL)
        if (flow !== null) {
          flowObserver.observe(flow, { childList: true, subtree: true })
          return true
        }
        return false
      }
      if (!observeFlow()) {
        // flow not mounted yet: watch the whole body until it appears
        flowObserver.observe(document.body, { childList: true, subtree: true })
      }
      // scroller swap / composer mount → rebind listeners + full re-sync.
      // While a scroller is already bound, DOM churn elsewhere in the body
      // (streaming!) only needs a light refresh, not a full scan.
      let currentScroller = null
      let currentComposer = null
      const scrollerObserver = new MutationObserver(() => {
        const next = findScroller()
        const composer = document.querySelector(COMPOSER_SEL)
        if (next !== currentScroller || composer !== currentComposer) {
          if (currentScroller !== null && currentScroller !== next) {
            currentScroller.removeEventListener('scroll', scheduleLight)
          }
          if (next !== null && next !== currentScroller) {
            next.addEventListener('scroll', scheduleLight, { passive: true })
          }
          currentScroller = next
          currentComposer = composer
          observeComposer()
          invalidateTargets()
          scheduleRender()
        } else {
          scheduleLight()
        }
      })
      scrollerObserver.observe(document.body, { childList: true, subtree: true })
      window.addEventListener('resize', scheduleLight)
      // composer size changes (multi-line input) → geometry may shift
      let composerObserver = null
      const observeComposer = () => {
        const composer = document.querySelector(COMPOSER_SEL)
        if (composer === null) return
        if (composerObserver === null && typeof ResizeObserver === 'function') {
          composerObserver = new ResizeObserver(() => scheduleLight())
        }
        composerObserver?.disconnect()
        composerObserver?.observe(composer)
      }
      observeComposer()
      // theme switch → geometry may shift
      const themeObserver = new MutationObserver(() => scheduleLight())
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })

      return () => {
        flowObserver.disconnect()
        scrollerObserver.disconnect()
        themeObserver.disconnect()
        if (currentScroller !== null) currentScroller.removeEventListener('scroll', scheduleLight)
        window.removeEventListener('resize', scheduleLight)
        composerObserver?.disconnect()
        composerObserver = null
      }
    }

    // ------------------------------------------------------------------ apply
    function apply(ctx) {
      try {
        buildRail()
        render()
        const disposeObservers = wireObservers()
        ctx.effect(() => () => {
          disposeObservers()
          rail?.remove()
          rail = null
          tooltip?.remove()
          tooltip = null
        }, 'dsh-chat-scroll-nav: rail mounts')
      } catch (error) {
        console.warn('[dsh-chat-scroll-nav] mount failed:', error)
      }
    }
    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
