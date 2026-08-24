/**
 * dsh-chat-scroll-nav — browser half (runs inside the dsh web GUI).
 *
 * Adds a slim quick-nav rail on the right edge of the chat conversation,
 * phone-contacts style: one tappable dot per substantive message (user or
 * assistant), positioned proportionally along the scroll content. Click or
 * drag to jump; the message currently in view is highlighted; hovering a dot
 * shows the message's first line.
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
    /** Kinds we render a nav dot for: the substantive conversation turns. */
    const NAV_KINDS = new Set(['user', 'assistant'])
    const RAIL_SEL = '[data-dsh-scroll-nav="rail"]'
    const TICK_SEL = '[data-dsh-scroll-nav="tick"]'

    // ---------------------------------------------------------------- styles
    function ensureStyles() {
      if (document.getElementById('dsh-scroll-nav-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-scroll-nav-styles'
      style.setAttribute('data-plugin', 'dsh-chat-scroll-nav')
      style.textContent = `
/* rail: fixed overlay on the right edge of the conversation area */
.dsn-rail {
  position: fixed;
  z-index: 45;
  width: 14px;
  border-radius: 8px;
  cursor: pointer;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  background: transparent;
  transition: background 0.15s ease;
}
.dsn-rail:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }
.dsn-rail[data-hidden="true"] { display: none; }

/* thin center track */
.dsn-track {
  position: absolute;
  left: 50%;
  top: 5px;
  bottom: 5px;
  width: 2px;
  border-radius: 1px;
  transform: translateX(-50%);
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(127,127,127,0.35));
  opacity: 0.55;
}
.dsn-rail:hover .dsn-track { opacity: 0.85; }

/* one dot per message */
.dsn-tick {
  position: absolute;
  left: 50%;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.7));
  transition: transform 0.12s ease, background 0.12s ease, box-shadow 0.12s ease;
}
.dsn-tick[data-kind="user"] {
  background: var(--dsw-static-deepseek-500, #4d6bfe);
  width: 7px;
  height: 7px;
}
.dsn-tick[data-kind="assistant"] {
  background: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.7));
}
.dsn-tick[data-active="true"] {
  background: var(--dsw-static-deepseek-500, #4d6bfe);
  transform: translate(-50%, -50%) scale(1.55);
  box-shadow: 0 0 0 2px var(--dsw-alias-bg-base, #fff);
}
.dsn-rail:hover .dsn-tick { box-shadow: 0 0 0 1px var(--dsw-alias-bg-base, #fff); }
.dsn-rail:hover .dsn-tick[data-active="true"] { box-shadow: 0 0 0 2px var(--dsw-alias-bg-base, #fff); }

/* message count chip (bottom of rail, shown on hover) */
.dsn-count {
  position: absolute;
  left: 50%;
  bottom: 2px;
  transform: translateX(-50%);
  font-size: 9px;
  line-height: 1;
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
    /** Text preview for one message row: strip UI chrome, collapse whitespace. */
    function messagePreview(item) {
      const clone = item.cloneNode(true)
      clone.querySelectorAll(
        'button, svg, [role="button"], [aria-hidden="true"], [data-dsh-scroll-nav], script, style',
      ).forEach((node) => node.remove())
      const text = (clone.textContent || '').replace(/\s+/g, ' ').trim()
      return text.length === 0 ? '' : text.slice(0, 90)
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

    /** All rendered substantive messages in order. */
    function collectTargets() {
      const flow = document.querySelector(FLOW_SEL)
      if (flow === null) return []
      const items = Array.from(flow.querySelectorAll(ITEM_SEL))
      const targets = []
      for (const item of items) {
        const kind = item.getAttribute('data-chat-flow-kind') || ''
        if (NAV_KINDS.has(kind)) {
          targets.push({ item, kind, key: item.getAttribute('data-chat-anchor-key') || '' })
        }
      }
      return targets
    }

    /** Content-space offset of an item's vertical center within the scroller. */
    function itemOffset(item, scroller) {
      const scrollerRect = scroller.getBoundingClientRect()
      const rect = item.getBoundingClientRect()
      const center = rect.top + rect.height / 2
      return scroller.scrollTop + (center - scrollerRect.top)
    }

    /** The message currently being read: first whose bottom passes the top edge. */
    function activeIndex(targets, scroller) {
      const rect = scroller.getBoundingClientRect()
      const topEdge = rect.top + 8
      for (let i = 0; i < targets.length; i++) {
        const r = targets[i].item.getBoundingClientRect()
        if (r.bottom >= topEdge) return i
      }
      return targets.length - 1
    }

    // ------------------------------------------------------------------ rail
    let rail = null
    let track = null
    let tooltip = null
    let count = null
    let rafPending = false
    let dragging = false
    let mutationObserver = null

    function buildRail() {
      ensureStyles()
      rail = document.createElement('div')
      rail.setAttribute('data-dsh-scroll-nav', 'rail')
      rail.className = 'dsn-rail'
      rail.setAttribute('aria-hidden', 'true')

      track = document.createElement('div')
      track.className = 'dsn-track'
      rail.append(track)

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

    function scrubTo(clientY) {
      if (rail === null) return
      const scroller = findScroller()
      if (scroller === null) return
      const rect = rail.getBoundingClientRect()
      if (rect.height <= 0) return
      const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      scroller.scrollTop = ratio * maxScroll
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
      const preview = messagePreview(target.item)
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

    function wireEvents() {
      if (rail === null) return
      rail.addEventListener('mousedown', (event) => {
        dragging = true
        scrubTo(event.clientY)
        event.preventDefault()
      })
      window.addEventListener('mousemove', (event) => {
        if (dragging) scrubTo(event.clientY)
      })
      window.addEventListener('mouseup', () => {
        dragging = false
      })
      rail.addEventListener('click', (event) => {
        const tick = event.target.closest(TICK_SEL)
        if (tick !== null) {
          const key = tick.getAttribute('data-anchor-key') || ''
          scrollToKey(key)
        }
      })
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
        if (!dragging) hideTooltip()
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

    /** Update the rail's fixed overlay geometry (top/height/right). */
    function updateGeometry(scroller) {
      const scrollerRect = scroller.getBoundingClientRect()
      const composer = scroller.querySelector(COMPOSER_SEL)
      const composerRect = composer === null ? null : composer.getBoundingClientRect()
      const top = scrollerRect.top
      let bottom = scrollerRect.bottom
      // rail spans the message area: shrink to the composer when it is in view
      if (composerRect !== null && composerRect.top > scrollerRect.top && composerRect.top < scrollerRect.bottom) {
        bottom = composerRect.top
      }
      rail.style.top = Math.round(top) + 'px'
      rail.style.height = Math.max(0, Math.round(bottom - top)) + 'px'
      // hug the scroller's right edge, inset enough to clear the native scrollbar
      const insetFromViewport = window.innerWidth - scrollerRect.right + 10
      rail.style.right = Math.max(4, insetFromViewport) + 'px'
    }

    /** Rebuild all tick dots from the current target list. */
    function rebuildTicks(scroller, targets) {
      for (const old of Array.from(rail.querySelectorAll(TICK_SEL))) old.remove()
      const scrollHeight = Math.max(1, scroller.scrollHeight)
      targets.forEach((target, index) => {
        const tick = document.createElement('div')
        tick.setAttribute('data-dsh-scroll-nav', 'tick')
        tick.className = 'dsn-tick'
        tick.setAttribute('data-kind', target.kind)
        tick.setAttribute('data-index', String(index))
        tick.setAttribute('data-anchor-key', target.key)
        const ratio = Math.min(1, Math.max(0, itemOffset(target.item, scroller) / scrollHeight))
        tick.style.top = Math.round(ratio * rail.clientHeight) + 'px'
        rail.append(tick)
      })
    }

    /** Highlight the message currently in view; update the count chip. */
    function syncActive(scroller, targets) {
      if (targets.length === 0) return
      const active = activeIndex(targets, scroller)
      const ticks = Array.from(rail.querySelectorAll(TICK_SEL))
      ticks.forEach((tick, index) => {
        if (index === active) tick.setAttribute('data-active', 'true')
        else tick.removeAttribute('data-active')
      })
      if (count !== null) count.textContent = String(targets.length)
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

    function scheduleRender() {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        render()
      })
    }

    function scheduleLight() {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        syncLight()
      })
    }

    // -------------------------------------------------------------- observers
    function wireObservers() {
      // message flow mutations → full re-sync (streaming, prepends, switches)
      const flowObserver = new MutationObserver(() => scheduleRender())
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
      // scroller change / window resize → light sync (scroll + geometry)
      let currentScroller = null
      const scrollerObserver = new MutationObserver(() => {
        const next = findScroller()
        if (next !== currentScroller) {
          if (currentScroller !== null) currentScroller.removeEventListener('scroll', scheduleLight)
          currentScroller = next
          if (next !== null) next.addEventListener('scroll', scheduleLight, { passive: true })
        }
        observeComposer()
        scheduleRender()
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
