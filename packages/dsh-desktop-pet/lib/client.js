/**
 * dsh-desktop-pet — browser half (runs inside the dsh web GUI).
 *
 * Mounts a tiny pure-CSS desktop pet that lives OUTSIDE the React tree
 * (appended to document.body, position:fixed, re-mounted idempotently).
 *
 * Action model — three layers:
 *
 *   1. ANIMATION  — every action is a `[data-action=...]` attribute on the
 *      pet root; CSS keyframes drive body/eye/limb parts (no sprite assets;
 *      swap in a sprite sheet later by styling `.dpet-sprite` instead).
 *
 *   2. STATE MACHINE — `ACTIONS[name] = { loop, then, duration, autonomous }`
 *      defines how long an action plays and what follows it. `setAction()`
 *      is the single write path.
 *
 *   3. TRIGGERS — three sources pick the next action:
 *        a. autonomous timer  — random idle/walk/sleep wander (AI free will)
 *        b. user interaction  — drag (dangle), click (happy), dblclick (eat)
 *        c. session observer — MutationObserver on [data-chat-flow]:
 *             assistant streaming  -> typing
 *             tool-call rows added -> work
 *             quiet for 3 minutes  -> sleep
 *
 * Stable DOM hooks this relies on (same as dsh-chat-scroll-nav):
 *   [data-conversation-scroll] — conversation scroll container (walk bounds)
 *   [data-chat-flow]           — message flow list (session observer)
 *   [data-chat-flow-kind]      — row kind (user | assistant | tool-call | …)
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-pet',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const ROOT_ID = 'dsh-desktop-pet-root'
    const STYLE_ID = 'dsh-desktop-pet-styles'
    const LS_KEY = 'dsh-desktop-pet:state'

    // ------------------------------------------------------------- actions
    // duration: [minMs, maxMs] for looping actions; fixed ms for one-shots.
    // autonomous: may be picked by the wander timer.
    const ACTIONS = {
      idle:    { loop: true,  duration: [4000, 12000], autonomous: true },
      walk:    { loop: true,  duration: [3000, 9000],  autonomous: true },
      sleep:   { loop: true,  duration: [15000, 40000], autonomous: true },
      happy:   { loop: false, duration: 1600, then: 'idle' },
      eat:     { loop: false, duration: 2400, then: 'happy' },
      typing:  { loop: true,  duration: [8000, 20000] },   // AI streaming
      work:    { loop: true,  duration: [6000, 15000] },   // tool running
      dangle:  { loop: true,  duration: [60000, 60000] },  // while dragging
    }

    const WALK_SPEED = 42 // px per second

    // ---------------------------------------------------------------- state
    const state = {
      action: null,
      actionUntil: 0,        // timestamp when the current action expires
      actionTimer: 0,        // setTimeout id for one-shot / wander switching
      x: 0, y: 0,            // pet position (top-left of the pet box)
      dir: 1,                // 1 = facing right, -1 = left
      dragging: false,
      sessionBusyUntil: 0,   // last time we saw streaming / tool activity
      quietCheckTimer: 0,
      rafId: 0,
      disposed: false,
      root: null, pet: null, bubble: null,
    }

    // ------------------------------------------------------------ lifecycle
    /** Load persisted pet state (position); harmless if absent. */
    function loadPersisted() {
      try {
        const raw = localStorage.getItem(LS_KEY)
        if (!raw) return
        const saved = JSON.parse(raw)
        if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          state.x = saved.x
          state.y = saved.y
        }
      } catch { /* corrupted state — ignore */ }
    }

    function persist() {
      try { localStorage.setItem(LS_KEY, JSON.stringify({ x: state.x, y: state.y })) }
      catch { /* storage unavailable — pet forgets, fine */ }
    }

    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', 'dsh-desktop-pet')
      style.textContent = `
/* ---- pet root: draggable fixed overlay, outside the React tree ---- */
.dpet-root {
  position: fixed;
  z-index: 44;
  width: 72px;
  height: 84px;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  filter: drop-shadow(0 4px 6px rgba(0,0,0,0.18));
}
.dpet-root[data-dragging="true"] { cursor: grabbing; }

/* ---- the creature: a blob with eyes, mouth, blush, feet ---- */
.dpet-pet {
  position: absolute;
  inset: 12px 6px 0 6px;         /* leave headroom for bubbles */
  border-radius: 46% 46% 42% 42% / 52% 52% 40% 40%;
  background: radial-gradient(120% 120% at 30% 22%,
              #9db4ff 0%, var(--dsw-static-deepseek-500, #4d6bfe) 78%);
  transition: transform 0.18s ease;
  transform-origin: 50% 100%;
}

/* eyes */
.dpet-eye {
  position: absolute;
  top: 34%;
  width: 9px; height: 11px;
  border-radius: 50%;
  background: #1c2333;
  animation: dpet-blink 4.2s infinite;
}
.dpet-eye[data-side="l"] { left: 26%; }
.dpet-eye[data-side="r"] { right: 26%; }

/* mouth: tiny arc, animated per action */
.dpet-mouth {
  position: absolute;
  top: 55%; left: 50%;
  width: 12px; height: 7px;
  margin-left: -6px;
  border: 2px solid #1c2333;
  border-top: none;
  border-radius: 0 0 12px 12px;
}

/* feet */
.dpet-foot {
  position: absolute;
  bottom: -5px;
  width: 16px; height: 8px;
  border-radius: 0 0 10px 10px;
  background: var(--dsw-static-deepseek-500, #4d6bfe);
}
.dpet-foot[data-side="l"] { left: 18%; }
.dpet-foot[data-side="r"] { right: 18%; }

/* speech bubble (emoji caption, one per action) */
.dpet-bubble {
  position: absolute;
  top: -4px; left: 50%;
  transform: translateX(-50%);
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}
.dpet-bubble[data-show="true"] { opacity: 1; }

/* ---- per-action animation: idle = breathing ---- */
.dpet-pet[data-action="idle"] {
  animation: dpet-breathe 2.6s ease-in-out infinite;
}

/* walk = waddle, feet paddle, root moves via rAF */
.dpet-pet[data-action="walk"] {
  animation: dpet-waddle 0.5s ease-in-out infinite;
}
.dpet-pet[data-action="walk"] .dpet-foot[data-side="l"] {
  animation: dpet-step 0.5s ease-in-out infinite;
}
.dpet-pet[data-action="walk"] .dpet-foot[data-side="r"] {
  animation: dpet-step 0.5s ease-in-out infinite reverse;
}

/* sleep = squashed blob, closed eyes, zzz bubble */
.dpet-pet[data-action="sleep"] {
  animation: dpet-sleep 3s ease-in-out infinite;
  border-radius: 50% 50% 30% 30% / 60% 60% 22% 22%;
}
.dpet-pet[data-action="sleep"] .dpet-eye { height: 2px; top: 42%; animation: none; }
.dpet-pet[data-action="sleep"] .dpet-mouth { display: none; }

/* happy = joyful bouncing */
.dpet-pet[data-action="happy"] {
  animation: dpet-bounce 0.4s cubic-bezier(0.3, 0, 0.6, 1) infinite;
}

/* eat = chew bob */
.dpet-pet[data-action="eat"] {
  animation: dpet-chew 0.28s ease-in-out infinite;
}

/* typing = lean forward, paws drumming (mouth wiggles as the glyph) */
.dpet-pet[data-action="typing"] {
  animation: dpet-type 0.34s ease-in-out infinite;
}

/* work = determined hammering bob */
.dpet-pet[data-action="work"] {
  animation: dpet-hammer 0.6s ease-in-out infinite;
}

/* dangle = held by the scruff, limp swing */
.dpet-pet[data-action="dangle"] {
  animation: dpet-swing 1s ease-in-out infinite;
  transform-origin: 50% 0%;
}
.dpet-pet[data-action="dangle"] .dpet-foot { bottom: -2px; }

/* facing */
.dpet-pet[data-dir="-1"] .dpet-eye[data-side="l"] { left: 30%; }
.dpet-pet[data-dir="-1"] .dpet-eye[data-side="r"] { right: 30%; }

/* ---- keyframes ---- */
@keyframes dpet-blink {
  0%, 92%, 100% { transform: scaleY(1); }
  95% { transform: scaleY(0.1); }
}
@keyframes dpet-breathe {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(0.94) scaleX(1.03); }
}
@keyframes dpet-waddle {
  0%, 100% { transform: rotate(-3deg) translateY(0); }
  50% { transform: rotate(3deg) translateY(-3px); }
}
@keyframes dpet-step {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}
@keyframes dpet-sleep {
  0%, 100% { transform: scale(1, 0.86) translateY(4px); }
  50% { transform: scale(1.04, 0.82) translateY(6px); }
}
@keyframes dpet-bounce {
  0%, 100% { transform: translateY(0) scale(1, 1); }
  40% { transform: translateY(-14px) scale(0.96, 1.06); }
  60% { transform: translateY(-10px) scale(1.02, 0.97); }
}
@keyframes dpet-chew {
  0%, 100% { transform: scale(1, 1); }
  50% { transform: scale(1.03, 0.94) translateY(2px); }
}
@keyframes dpet-type {
  0%, 100% { transform: rotate(-4deg) translateY(0); }
  50% { transform: rotate(-4deg) translateY(-2px) scaleX(1.03); }
}
@keyframes dpet-hammer {
  0%, 100% { transform: rotate(4deg) translateY(0); }
  50% { transform: rotate(-6deg) translateY(-4px); }
}
@keyframes dpet-swing {
  0%, 100% { transform: rotate(6deg) translateY(2px); }
  50% { transform: rotate(-6deg) translateY(2px); }
}
`
      document.head.append(style)
    }

    // ---------------------------------------------------------------- mount
    function buildPet() {
      const root = document.createElement('div')
      root.id = ROOT_ID
      root.className = 'dpet-root'
      root.setAttribute('data-plugin', 'dsh-desktop-pet')
      root.title = 'desktop pet — 拖我 · 点我 · 双击喂食'

      const pet = document.createElement('div')
      pet.className = 'dpet-pet'
      const eyeL = document.createElement('div')
      eyeL.className = 'dpet-eye'
      eyeL.dataset.side = 'l'
      const eyeR = document.createElement('div')
      eyeR.className = 'dpet-eye'
      eyeR.dataset.side = 'r'
      const mouth = document.createElement('div')
      mouth.className = 'dpet-mouth'
      const footL = document.createElement('div')
      footL.className = 'dpet-foot'
      footL.dataset.side = 'l'
      const footR = document.createElement('div')
      footR.className = 'dpet-foot'
      footR.dataset.side = 'r'
      const bubble = document.createElement('div')
      bubble.className = 'dpet-bubble'
      pet.append(eyeL, eyeR, mouth, footL, footR, bubble)
      root.append(pet)
      document.body.append(root)
      return { root, pet, bubble }
    }

    function clampToViewport() {
      const maxX = Math.max(0, window.innerWidth - 72)
      const maxY = Math.max(0, window.innerHeight - 84)
      state.x = Math.min(Math.max(state.x, 0), maxX)
      state.y = Math.min(Math.max(state.y, 0), maxY)
    }

    function renderPosition() {
      state.root.style.left = `${state.x}px`
      state.root.style.top = `${state.y}px`
    }

    // ---------------------------------------------------- state machine core
    const BUBBLES = {
      idle: '', walk: '', sleep: '💤', happy: '💗', eat: '🍪',
      typing: '⌨️', work: '🔧', dangle: '?!',
    }

    function clearActionTimer() {
      if (state.actionTimer) { clearTimeout(state.actionTimer); state.actionTimer = 0 }
    }

    /** Single write path: switch the pet to an action and schedule its exit. */
    function setAction(name, opts = {}) {
      if (state.disposed) return
      const def = ACTIONS[name]
      if (!def) return
      state.action = name
      state.pet.dataset.action = name
      state.pet.dataset.dir = String(state.dir)
      state.bubble.textContent = BUBBLES[name] || ''
      state.bubble.dataset.show = BUBBLES[name] ? 'true' : 'false'

      clearActionTimer()
      if (!def.loop) {
        // one-shot: run once, then follow `then`
        state.actionTimer = setTimeout(() => setAction(def.then), def.duration)
        return
      }
      const [min, max] = def.duration
      const ms = min + Math.random() * (max - min)
      if (opts.sticky) {
        // sticky actions (typing/work) only expire if the session went quiet;
        // we still arm a timer that re-evaluates instead of hard-switching.
        state.actionUntil = Date.now() + ms
        state.actionTimer = setTimeout(() => {
          if (Date.now() < state.sessionBusyUntil) { setAction(name, { sticky: true }) }
          else { wander() }
        }, ms)
      } else {
        state.actionTimer = setTimeout(() => wander(), ms)
      }
    }

    // -------------------------------------------------- trigger a: wander
    function wander() {
      if (state.disposed || state.dragging) return
      const hour = new Date().getHours()
      const roll = Math.random()
      let next
      if (roll < 0.45) next = 'idle'
      else if (roll < 0.85) next = 'walk'
      else next = (hour >= 23 || hour < 7) ? 'sleep' : 'sleep'
      // choose a walk direction / target
      if (next === 'walk') {
        state.dir = Math.random() < 0.5 ? 1 : -1
      }
      setAction(next)
    }

    // -------------------------------------------------- trigger b: dragging
    function onPointerDown(ev) {
      if (ev.button !== 0) return
      state.dragging = true
      state.root.dataset.dragging = 'true'
      state.dragOffsetX = ev.clientX - state.x
      state.dragOffsetY = ev.clientY - state.y
      clearActionTimer()
      setAction('dangle')
      state.root.setPointerCapture(ev.pointerId)
      ev.preventDefault()
    }

    function onPointerMove(ev) {
      if (!state.dragging) return
      state.x = ev.clientX - state.dragOffsetX
      state.y = ev.clientY - state.dragOffsetY
      clampToViewport()
      renderPosition()
    }

    function onPointerUp() {
      if (!state.dragging) return
      state.dragging = false
      state.root.dataset.dragging = 'false'
      persist()
      setAction('happy')
    }

    let clickTimer = 0
    function onClick() {
      // distinguish single (happy) vs double (eat) click
      if (clickTimer) { return } // dblclick path handles it
      clickTimer = setTimeout(() => {
        clickTimer = 0
        if (!state.dragging) setAction('happy')
      }, 260)
    }

    function onDblClick() {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0 }
      setAction('eat')
    }

    // ------------------------------------------- trigger c: session observer
    function observeSession() {
      const flow = document.querySelector('[data-chat-flow]')
      if (!flow) return // chat not mounted yet; retry on next mount tick
      const mo = new MutationObserver(() => {
        if (state.disposed) return
        state.sessionBusyUntil = Date.now() + 6000 // busy grace window
        const rows = flow.querySelectorAll('[data-chat-anchor-key]')
        const last = rows[rows.length - 1]
        const kind = last ? (last.getAttribute('data-chat-flow-kind') || '') : ''
        if (state.dragging) return
        if (kind === 'tool-call' || kind.includes('tool')) {
          if (state.action !== 'work') setAction('work', { sticky: true })
        } else if (kind === 'assistant') {
          if (state.action !== 'typing') setAction('typing', { sticky: true })
        }
        // user rows / quiet -> leave the sticky timer to fall back to wander
      })
      mo.observe(flow, { childList: true, subtree: true })
      state.sessionObserver = mo
    }

    function startQuietCheck() {
      state.quietCheckTimer = setInterval(() => {
        if (state.disposed || state.dragging) return
        // long quiet -> nap (unless it's already something interactive)
        if (Date.now() > state.sessionBusyUntil &&
            (state.action === 'idle' || state.action === 'walk')) {
          setAction('sleep')
        }
      }, 30000)
    }

    // ---------------------------------------------------------- walk engine
    let lastTs = 0
    function tick(ts) {
      if (state.disposed) return
      const dt = lastTs ? (ts - lastTs) / 1000 : 0
      lastTs = ts
      if (state.action === 'walk' && !state.dragging) {
        state.x += WALK_SPEED * dt * state.dir
        const maxX = window.innerWidth - 72
        if (state.x <= 0) { state.x = 0; state.dir = 1 }
        if (state.x >= maxX) { state.x = maxX; state.dir = -1 }
        renderPosition()
      }
      state.rafId = requestAnimationFrame(tick)
    }

    // ---------------------------------------------------------------- boot
    function mount() {
      // idempotent remount (HMR / plugin reload)
      document.getElementById(ROOT_ID)?.remove()
      ensureStyles()
      loadPersisted()
      const { root, pet, bubble } = buildPet()
      state.root = root; state.pet = pet; state.bubble = bubble
      if (state.x === 0 && state.y === 0) {
        // default: bottom-right corner of the viewport
        state.x = window.innerWidth - 120
        state.y = window.innerHeight - 140
      }
      clampToViewport()
      renderPosition()

      root.addEventListener('pointerdown', onPointerDown)
      root.addEventListener('pointermove', onPointerMove)
      root.addEventListener('pointerup', onPointerUp)
      root.addEventListener('pointercancel', onPointerUp)
      root.addEventListener('click', onClick)
      root.addEventListener('dblclick', onDblClick)

      // session observer needs the chat flow; retry until the shell mounts it
      const obsTimer = setInterval(() => {
        if (state.disposed) { clearInterval(obsTimer); return }
        if (document.querySelector('[data-chat-flow]')) {
          clearInterval(obsTimer)
          observeSession()
        }
      }, 1500)
      state.obsRetryTimer = obsTimer

      startQuietCheck()
      state.rafId = requestAnimationFrame(tick)
      setAction('idle')
      console.info('[dsh-desktop-pet] pet mounted 🐾')
    }

    function dispose() {
      state.disposed = true
      clearActionTimer()
      if (state.quietCheckTimer) clearInterval(state.quietCheckTimer)
      if (state.obsRetryTimer) clearInterval(state.obsRetryTimer)
      if (state.sessionObserver) state.sessionObserver.disconnect()
      if (state.rafId) cancelAnimationFrame(state.rafId)
      if (clickTimer) clearTimeout(clickTimer)
      state.root?.remove()
      document.getElementById(STYLE_ID)?.remove()
      console.info('[dsh-desktop-pet] pet disposed')
    }

    // allow manual teardown / HMR reload from the console
    window.__dshDesktopPet = { dispose, setAction }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true })
    } else {
      mount()
    }

    module.exports = exports
    return module.exports
  },
})
