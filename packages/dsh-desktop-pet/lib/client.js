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
 *             assistant streaming  -> typing (faces the chat panel)
 *             tool-call rows added -> work   (faces the chat panel)
 *             user row added       -> happy  (perks up at your message)
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
    const LS_SETTINGS_KEY = 'dsh-desktop-pet:settings'

    // ------------------------------------------------------------- settings
    // User-tunable knobs (right-click the pet to open the config menu).
    const RANGE_PRESETS = { small: 80, medium: 150, large: 260 }   // px
    const SPEED_PRESETS = { slow: 24, medium: 42, fast: 70 }       // px/s
    const DEFAULT_SETTINGS = {
      enabled: true,        // show the pet at all
      range: 'medium',      // wander radius preset around the home anchor
      speed: 'medium',      // walk speed preset
      sessionLink: true,    // react to AI streaming / tool calls / quiet
    }

    let settings = { ...DEFAULT_SETTINGS }

    function loadSettings() {
      try {
        const raw = localStorage.getItem(LS_SETTINGS_KEY)
        if (!raw) return
        const saved = JSON.parse(raw)
        if (typeof saved !== 'object' || saved === null) return
        if (typeof saved.enabled === 'boolean') settings.enabled = saved.enabled
        if (RANGE_PRESETS[saved.range]) settings.range = saved.range
        if (SPEED_PRESETS[saved.speed]) settings.speed = saved.speed
        if (typeof saved.sessionLink === 'boolean') settings.sessionLink = saved.sessionLink
      } catch { /* corrupted settings — keep defaults */ }
    }

    function persistSettings() {
      try { localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(settings)) }
      catch { /* storage unavailable — session-only settings, fine */ }
    }

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

    const WALK_SPEED = () => SPEED_PRESETS[settings.speed] ?? 42   // px per second
    const WALK_RANGE = () => RANGE_PRESETS[settings.range] ?? 150  // px — wander radius

    // Blocked zones: UI the pet must never sit on top of (composer etc.).
    function blockedRects() {
      const rects = []
      document.querySelectorAll('[data-composer-seat], textarea, form input[type="text"]').forEach((el) => {
        if (!(el instanceof HTMLElement)) return
        if (el.offsetParent === null) return // hidden
        rects.push(el.getBoundingClientRect())
      })
      return rects
    }

    /** Push a position (top-left of the 72x84 pet box) out of blocked rects. */
    function avoidBlocked(x, y) {
      const w = 72, h = 84
      for (const r of blockedRects()) {
        if (x < r.right && x + w > r.left && y < r.top && y + h > r.top) {
          // overlapping from above: prefer sitting on top of the zone
          y = r.top - h - 4
          // if that leaves the screen, fall back to below the zone
          if (y < 0) y = r.bottom + 4
          x = Math.min(Math.max(x, r.left), Math.max(0, r.right - w))
        }
      }
      return { x, y }
    }

    // ---------------------------------------------------------------- state
    const state = {
      action: null,
      actionUntil: 0,        // timestamp when the current action expires
      actionTimer: 0,        // setTimeout id for one-shot / wander switching
      x: 0, y: 0,            // pet position (top-left of the pet box)
      home: { x: 0, y: 0 },  // wander anchor — pet stays within WALK_RANGE of it
      walkTarget: null,      // {x, y} current stroll destination, null = none
      dir: 1,                // 1 = facing right, -1 = left
      dragging: false,
      sessionBusyUntil: 0,   // last time we saw streaming / tool activity
      quietCheckTimer: 0,
      rafId: 0,
      disposed: false,
      root: null, pet: null, bubble: null,
      lastNotice: null,
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

/* ---- day / night: subtly follow the GUI light/dark theme ----
   Light (default)  = daytime look  (bright blue, crisp shadow)
   Dark attribute   = nighttime look (deeper indigo, soft glow, pale eyes) */
body[data-ds-dark-theme] .dpet-pet {
  background: radial-gradient(120% 120% at 30% 22%,
              #6f86d6 0%, #3a4a9f 78%);
}
body[data-ds-dark-theme] .dpet-foot {
  background: #3a4a9f;
}
body[data-ds-dark-theme] .dpet-root {
  filter: drop-shadow(0 4px 8px rgba(0,0,0,0.45))
          drop-shadow(0 0 6px rgba(111,134,214,0.35));
}

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

/* ---- hover balance card: model provider balances ---- */
.dpet-tip {
  position: fixed;
  z-index: 46;
  box-sizing: border-box;
  min-width: 230px;
  max-width: 320px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-shadow-lv3);
  font: 12px/1.6 -apple-system, "PingFang SC", "Segoe UI", sans-serif;
  color: var(--dsw-alias-label-primary);
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 0.15s ease, transform 0.15s ease;
  pointer-events: auto;
}
.dpet-tip[data-show="true"] { opacity: 1; transform: translateY(0); }
.dpet-tip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  margin-bottom: 4px;
}
.dpet-tip-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 0;
}
.dpet-tip-name { font-weight: 600; white-space: nowrap; }
.dpet-tip-models {
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
}
.dpet-tip-val { white-space: nowrap; font-variant-numeric: tabular-nums; }
.dpet-tip-val[data-kind="unsupported"] { color: var(--dsw-alias-label-tertiary); }
.dpet-tip-val[data-kind="error"] { color: var(--dsw-alias-label-warning, #c77f1f); }
.dpet-tip-val[data-kind="quota"] { color: var(--dsw-alias-label-success, #2f9e63); }

/* ---- right-click config menu ---- */
.dpet-menu {
  position: fixed;
  z-index: 45;
  min-width: 168px;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 6px 0;
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-shadow-lv3);
  font: 12px/1.6 -apple-system, "PingFang SC", "Segoe UI", sans-serif;
  color: var(--dsw-alias-label-primary);
}
.dpet-menu-head {
  padding: 4px 12px 6px;
  font-size: 11px;
  opacity: 0.55;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  margin-bottom: 4px;
}
.dpet-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 12px;
  cursor: pointer;
  white-space: nowrap;
}
.dpet-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dpet-menu-item .dpet-opt {
  display: inline-flex;
  gap: 2px;
}
.dpet-menu-item .dpet-seg {
  padding: 1px 7px;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0.55;
}
.dpet-menu-item .dpet-seg[data-on="true"] {
  background: var(--dsw-alias-button-info-fill);
  color: var(--dsw-alias-label-primary-foreground);
  opacity: 1;
}
.dpet-menu-item .dpet-check {
  width: 15px; height: 15px;
  border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--dsw-alias-label-primary-foreground);
}
.dpet-menu-item .dpet-check[data-on="true"] {
  background: var(--dsw-alias-button-info-fill);
  border-color: transparent;
}
/* quick-action section inside the config menu */
.dpet-menu-div {
  padding: 4px 12px 2px;
  font-size: 11px;
  opacity: 0.55;
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin-top: 4px;
}
.dpet-menu-item .dpet-act {
  font-size: 11px;
  opacity: 0.5;
}

/* ---- restart confirmation: compact DSH-style modal ---- */
.dpet-restart-mask {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--dsw-alias-bg-mask-1);
}
.dpet-restart-dialog {
  box-sizing: border-box;
  width: min(400px, 100%);
  padding: 20px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
  box-shadow: var(--dsw-shadow-lv3);
  color: var(--dsw-alias-label-primary);
  font: 13px/1.55 -apple-system, "PingFang SC", "Segoe UI", sans-serif;
}
.dpet-restart-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.dpet-restart-icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 16px;
  line-height: 1;
}
.dpet-restart-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
}
.dpet-restart-copy {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
}
.dpet-restart-note {
  margin-top: 14px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.dpet-restart-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
.dpet-restart-button {
  min-width: 72px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}
.dpet-restart-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dpet-restart-button:focus-visible {
  outline: 2px solid var(--dsw-alias-button-info-fill);
  outline-offset: 2px;
}
.dpet-restart-button[data-kind="primary"] {
  border-color: transparent;
  background: var(--dsw-alias-button-info-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dpet-restart-button[data-kind="primary"]:hover {
  background: var(--dsw-alias-button-info-hover);
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
      let { x, y } = avoidBlocked(state.x, state.y)
      state.x = Math.min(Math.max(x, 0), maxX)
      state.y = Math.min(Math.max(y, 0), maxY)
    }

    function renderPosition() {
      state.root.style.left = `${state.x}px`
      state.root.style.top = `${state.y}px`
    }

    // ---------------------------------------------------- state machine core
    const BUBBLES = {
      idle: '', walk: '', sleep: '💤', happy: '💗', eat: '🍪',
      typing: '💭', work: '🔧', dangle: '?!',
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
      // choose a stroll destination within WALK_RANGE of the home anchor
      if (next === 'walk') {
        const maxX = Math.max(0, window.innerWidth - 72)
        const maxY = Math.max(0, window.innerHeight - 84)
        let tx = state.home.x + (Math.random() * 2 - 1) * WALK_RANGE()
        let ty = state.home.y + (Math.random() * 2 - 1) * WALK_RANGE() * 0.5
        const safe = avoidBlocked(
          Math.min(Math.max(tx, 0), maxX),
          Math.min(Math.max(ty, 0), maxY),
        )
        state.walkTarget = safe
        state.dir = safe.x >= state.x ? 1 : -1
      } else {
        state.walkTarget = null
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
      // never park on top of the composer; re-anchor wandering here
      const safe = avoidBlocked(state.x, state.y)
      state.x = safe.x; state.y = safe.y
      clampToViewport()
      renderPosition()
      state.home = { x: state.x, y: state.y }
      state.walkTarget = null
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

    // -------------------------------------------------- hover balance card
    // 悬停宠物弹出已配置模型的余额/余量卡片；数据来自 Host /balance 路由。
    const BALANCE_ENDPOINT = '/api/dsh-desktop-pet/balance'
    const BALANCE_TTL = 60 * 1000  // 后台轮询间隔：1 分钟
    let tipEl = null
    let tipHideTimer = 0
    let balanceCache = { at: 0, data: null }
    let balanceFetching = null

    function fetchBalances() {
      if (balanceFetching) return balanceFetching
      balanceFetching = fetch(BALANCE_ENDPOINT, { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
        .then(data => {
          balanceCache = { at: Date.now(), data }
          if (tipEl && tipEl.dataset.show === 'true') {
            renderTip(data)   // 悬停中数据刷新则就地更新
            positionTip()     // 高度可能变化，重新夹紧视口/避让侧栏
          }
          return data
        })
        .catch(() => { /* 轮询失败：保留上一次数据，下轮再试 */ })
        .finally(() => { balanceFetching = null })
      return balanceFetching
    }

    // 后台定时轮询：每分钟刷一次，悬停时直接展示缓存、零等待。
    let balancePollTimer = 0
    function startBalancePolling() {
      if (balancePollTimer) return
      fetchBalances()
      balancePollTimer = setInterval(() => {
        if (!state.disposed && settings.enabled) fetchBalances()
      }, BALANCE_TTL)
    }

    function stopBalancePolling() {
      if (balancePollTimer) { clearInterval(balancePollTimer); balancePollTimer = 0 }
    }

    function buildTipRow(p) {
      const row = document.createElement('div')
      row.className = 'dpet-tip-row'
      const nameWrap = document.createElement('span')
      const name = document.createElement('div')
      name.className = 'dpet-tip-name'
      name.textContent = p.displayName || p.id
      nameWrap.append(name)
      if (Array.isArray(p.models) && p.models.length) {
        const models = document.createElement('div')
        models.className = 'dpet-tip-models'
        models.textContent = p.models.map(m => m.name || m.id).join(' / ')
        nameWrap.append(models)
      }
      const val = document.createElement('span')
      val.className = 'dpet-tip-val'
      val.dataset.kind = p.kind || 'unsupported'
      val.textContent = p.text || '—'
      row.append(nameWrap, val)
      return row
    }

    function renderTip(data) {
      if (!tipEl) return
      tipEl.textContent = ''
      const head = document.createElement('div')
      head.className = 'dpet-tip-head'
      const title = document.createElement('span')
      title.textContent = '💰 模型余额'
      const stamp = document.createElement('span')
      stamp.textContent = new Date(data.at || Date.now()).toLocaleTimeString()
      head.append(title, stamp)
      tipEl.append(head)
      const providers = Array.isArray(data.providers) ? data.providers : []
      if (!providers.length) {
        const empty = document.createElement('div')
        empty.className = 'dpet-tip-models'
        empty.textContent = 'settings.yaml 中未配置模型提供商'
        tipEl.append(empty)
        return
      }
      providers.forEach(p => tipEl.append(buildTipRow(p)))
    }

    // 定位卡片：完整落在视口内（四周留 8px），优先宠物上方、放不下放下方；
    // 再避开右侧会话导航栏（dsh-chat-scroll-nav 的 .dsn-rail 等固定侧栏）。
    function positionTip() {
      if (!tipEl || !state.root) return
      const tw = tipEl.offsetWidth
      const th = tipEl.offsetHeight
      const maxX = Math.max(8, window.innerWidth - tw - 8)
      let x = Math.min(Math.max(8, state.x + 36 - tw / 2), maxX)
      let y = state.y - th - 10
      if (y < 8) y = state.y + 94
      y = Math.min(y, Math.max(8, window.innerHeight - th - 8))
      // 侧栏避让：与任何可见的固定侧栏相交时，把卡片整体推到侧栏左侧。
      document.querySelectorAll('.dsn-rail, [data-scroll-nav-rail]').forEach((el) => {
        if (!(el instanceof HTMLElement) || el.offsetParent === null) return
        const r = el.getBoundingClientRect()
        if (x < r.right && x + tw > r.left && y < r.bottom && y + th > r.top) {
          const shifted = r.left - tw - 8
          // 左侧放得下就整体推过去；放不下保持视口内，靠更高 z-index 压在侧栏上层。
          if (shifted >= 8) x = shifted
        }
      })
      tipEl.style.left = `${Math.round(x)}px`
      tipEl.style.top = `${Math.round(y)}px`
    }

    function showTip() {
      clearTimeout(tipHideTimer)
      if (!tipEl) {
        tipEl = document.createElement('div')
        tipEl.className = 'dpet-tip'
        tipEl.setAttribute('data-plugin', 'dsh-desktop-pet')
        tipEl.addEventListener('pointerenter', () => clearTimeout(tipHideTimer))
        tipEl.addEventListener('pointerleave', hideTip)
        document.body.append(tipEl)
      }
      tipEl.dataset.show = 'false'
      if (balanceCache.data) {
        renderTip(balanceCache.data)          // 后台轮询缓存：悬停即出，零等待
      } else {
        tipEl.textContent = '💰 模型余额查询中…'
        fetchBalances().then(data => {
          if (data && tipEl && tipEl.dataset.show === 'true') {
            renderTip(data)
            positionTip()                     // 内容到位后高度可能变化，重新定位
          }
        })
      }
      // 内容同步渲染后再量尺寸定位，保证边界计算基于真实高度。
      positionTip()
      tipEl.dataset.show = 'true'
    }

    function hideTip() {
      tipHideTimer = setTimeout(() => {
        tipEl?.remove()
        tipEl = null
      }, 250)
    }

    function onPetEnter() {
      if (state.dragging || !settings.enabled) return
      if (menuEl) return // 右键菜单打开期间不再弹余额卡片
      showTip()
    }

    // ------------------------------------------------------- config menu
    let menuEl = null

    function closeMenu() {
      menuEl?.remove()
      menuEl = null
    }

    function segRow(label, key, presets, names) {
      const row = document.createElement('div')
      row.className = 'dpet-menu-item'
      const name = document.createElement('span')
      name.textContent = label
      const opts = document.createElement('span')
      opts.className = 'dpet-opt'
      Object.keys(presets).forEach((k) => {
        const seg = document.createElement('span')
        seg.className = 'dpet-seg'
        seg.textContent = names[k]
        seg.dataset.on = String(settings[key] === k)
        seg.addEventListener('click', (ev) => {
          ev.stopPropagation()
          settings[key] = k
          persistSettings()
          closeMenu(); openMenu()
        })
        opts.append(seg)
      })
      row.append(name, opts)
      return row
    }

    function checkRow(label, key, onChange) {
      const row = document.createElement('div')
      row.className = 'dpet-menu-item'
      const name = document.createElement('span')
      name.textContent = label
      const box = document.createElement('span')
      box.className = 'dpet-check'
      box.dataset.on = String(settings[key])
      box.textContent = settings[key] ? '✓' : ''
      row.append(name, box)
      row.addEventListener('click', () => {
        settings[key] = !settings[key]
        persistSettings()
        onChange?.()
        closeMenu(); openMenu()
      })
      return row
    }

    function applyEnabled() {
      if (!state.root) return
      if (settings.enabled) {
        state.root.style.display = ''
        clampToViewport()
        renderPosition()
        state.home = { x: state.x, y: state.y }
        setAction('idle')
      } else {
        state.root.style.display = 'none'
        clearActionTimer()
      }
    }

    function openMenu() {
      closeMenu()
      // 右键菜单优先：立即撤下悬停余额卡片，避免遮挡菜单。
      clearTimeout(tipHideTimer)
      tipEl?.remove()
      tipEl = null
      menuEl = document.createElement('div')
      menuEl.className = 'dpet-menu'
      menuEl.setAttribute('data-plugin', 'dsh-desktop-pet')
      const head = document.createElement('div')
      head.className = 'dpet-menu-head'
      head.textContent = '🐾 桌面宠物设置'
      menuEl.append(
        head,
        checkRow('显示宠物', 'enabled', applyEnabled),
        segRow('活动范围', 'range', RANGE_PRESETS, { small: '小', medium: '中', large: '大' }),
        segRow('行走速度', 'speed', SPEED_PRESETS, { slow: '慢', medium: '中', fast: '快' }),
        checkRow('会话联动', 'sessionLink'),
      )
      // quick-action section
      const div = document.createElement('div')
      div.className = 'dpet-menu-div'
      div.textContent = '⚡ 快捷操作'
      menuEl.append(div)
      QUICK_ACTIONS.forEach(({ label, hint, run }) => {
        menuEl.append(actRow(label, hint, run))
      })
      // clamp menu fully inside the viewport using its REAL size
      // (menu grew with the quick-action section; measure after append)
      document.body.append(menuEl)
      const mw = menuEl.offsetWidth
      const mh = menuEl.offsetHeight
      let x = Math.min(state.x, window.innerWidth - mw - 8)
      let y = state.y + 88
      if (y + mh > window.innerHeight - 8) {
        // not enough room below: flip above the pet (pet box is 84 tall)
        y = state.y - mh - 8
      }
      if (y < 8) {
        // still clipped (viewport shorter than the menu): pin to top,
        // the page itself scrolls the overflow
        y = 8
      }
      menuEl.style.left = `${Math.max(8, x)}px`
      menuEl.style.top = `${y}px`
    }

    // ------------------------------------------------------- quick actions
    // 右键菜单快捷操作；重启调用 Host 接口。

    function actRow(label, hint, run) {
      const row = document.createElement('div')
      row.className = 'dpet-menu-item'
      const name = document.createElement('span')
      name.textContent = label
      const tag = document.createElement('span')
      tag.className = 'dpet-act'
      tag.textContent = hint
      row.append(name, tag)
      row.addEventListener('click', () => {
        closeMenu()
        setAction('happy')
        run()
      })
      return row
    }

    const RESTART_DIALOG_ID = 'dsh-desktop-pet-restart-dialog'
    let closeRestartDialog = () => {}

    function confirmRestart() {
      closeRestartDialog()
      return new Promise(resolve => {
        const mask = document.createElement('div')
        mask.id = RESTART_DIALOG_ID
        mask.className = 'dpet-restart-mask'

        const dialog = document.createElement('section')
        dialog.className = 'dpet-restart-dialog'
        dialog.setAttribute('role', 'dialog')
        dialog.setAttribute('aria-modal', 'true')
        dialog.setAttribute('aria-labelledby', 'dpet-restart-title')
        dialog.tabIndex = -1

        const heading = document.createElement('div')
        heading.className = 'dpet-restart-heading'
        const icon = document.createElement('span')
        icon.className = 'dpet-restart-icon'
        icon.setAttribute('aria-hidden', 'true')
        icon.textContent = '↻'
        const title = document.createElement('h2')
        title.id = 'dpet-restart-title'
        title.className = 'dpet-restart-title'
        title.textContent = '重启 DSH Web'
        heading.append(icon, title)

        const copy = document.createElement('p')
        copy.className = 'dpet-restart-copy'
        copy.textContent = '服务会短暂不可用，正在运行的任务将被中断。'
        const note = document.createElement('div')
        note.className = 'dpet-restart-note'
        note.textContent = '服务恢复后，此页面会自动刷新。'

        const actions = document.createElement('div')
        actions.className = 'dpet-restart-actions'
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.className = 'dpet-restart-button'
        cancel.textContent = '取消'
        const confirm = document.createElement('button')
        confirm.type = 'button'
        confirm.className = 'dpet-restart-button'
        confirm.dataset.kind = 'primary'
        confirm.textContent = '确认重启'
        actions.append(cancel, confirm)
        dialog.append(heading, copy, note, actions)
        mask.append(dialog)

        let settled = false
        const finish = value => {
          if (settled) return
          settled = true
          document.removeEventListener('keydown', onKeydown, true)
          mask.remove()
          closeRestartDialog = () => {}
          resolve(value)
        }
        const onKeydown = event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            finish(false)
          }
        }
        cancel.addEventListener('click', () => finish(false))
        confirm.addEventListener('click', () => finish(true))
        mask.addEventListener('mousedown', event => {
          if (event.target === mask) finish(false)
        })
        document.addEventListener('keydown', onKeydown, true)
        document.body.append(mask)
        closeRestartDialog = () => finish(false)
        cancel.focus()
      })
    }

    let restarting = false
    async function restartWeb() {
      if (restarting) return
      if (!await confirmRestart()) return
      restarting = true
      const endpoint = '/api/dsh-desktop-pet/restart'
      try {
        // 第一步：触发重启。请求可能因服务已在重启中被掐断（8s 超时 / 网络错误），
        // 这不一定失败——照常进入轮询，以 instance 是否变化为最终判据。
        let beforeInstance = null
        let triggerError = null
        try {
          const response = await fetch(endpoint, {
            method: 'POST', headers: { 'X-DSH-Pet-Action': 'restart' },
            signal: AbortSignal.timeout(8000),
          })
          const result = await response.json()
          if (!response.ok) throw new Error(result.error || '重启请求失败')
          beforeInstance = result.instance
        } catch (error) {
          triggerError = error
        }
        setAction('work')
        const deadline = Date.now() + 60000
        let reachable = false
        let sawOutage = false   // 触发失败时，用「出现断连又恢复」佐证重启确实发生
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 1000))
          try {
            const status = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(2000) })
            if (status.ok) {
              reachable = true
              const { instance } = await status.json()
              if (instance !== beforeInstance) {
                location.reload()
                return
              }
            } else {
              sawOutage = true
            }
          } catch {
            sawOutage = true  // 重启期间连接暂时不可用，继续等待
          }
        }
        // 60 秒内没等到新实例。触发请求失败、服务始终可达且从未断连，
        // 才判定为「未触发」；否则按恢复超时提示。
        if (triggerError && reachable && !sawOutage) {
          throw new Error(`触发请求失败（${triggerError.message}），请重试`)
        }
        throw new Error('等待服务恢复超时，请检查 ~/.dsh/logs/desktop-pet-restart.log，必要时手动启动 DSH Web')
      } catch (error) {
        window.alert(`重启 DSH Web：${error.message}`)
      } finally {
        restarting = false
        setAction('idle')
      }
    }

    const QUICK_ACTIONS = [
      {
        label: '⏻ 重启 DSH Web', hint: '中断任务',
        run: restartWeb,
      },
      {
        label: '📋 复制调试信息', hint: '',
        run: async () => {
          const info = JSON.stringify({
            plugin: 'dsh-desktop-pet',
            action: state.action,
            position: { x: Math.round(state.x), y: Math.round(state.y) },
            settings,
            href: location.href,
            dark: document.body.hasAttribute('data-ds-dark-theme'),
          }, null, 2)
          try {
            await navigator.clipboard.writeText(info)
          } catch {
            console.info('[dsh-desktop-pet] debug info:', info)
          }
        },
      },
    ]

    function onContextMenu(ev) {
      ev.preventDefault()
      ev.stopPropagation()
      openMenu()
      const onDocDown = (e) => {
        if (menuEl && !menuEl.contains(e.target)) closeMenu()
        document.removeEventListener('pointerdown', onDocDown, true)
      }
      document.addEventListener('pointerdown', onDocDown, true)
    }

    // ------------------------------------------- trigger c: session observer
    /** Turn the pet to face the conversation panel (session activity). */
    function faceChat() {
      const flow = document.querySelector('[data-chat-flow]')
      if (!flow || !state.pet) return
      const cx = flow.getBoundingClientRect().left + 40 // roughly panel center
      state.dir = cx < state.x ? -1 : 1
      state.pet.dataset.dir = String(state.dir)
    }

    function observeSession() {
      const flow = document.querySelector('[data-chat-flow]')
      if (!flow) return // chat not mounted yet; retry on next mount tick
      const mo = new MutationObserver(() => {
        if (state.disposed || !settings.enabled || !settings.sessionLink) return
        state.sessionBusyUntil = Date.now() + 6000 // busy grace window
        const rows = flow.querySelectorAll('[data-chat-anchor-key]')
        const last = rows[rows.length - 1]
        const kind = last ? (last.getAttribute('data-chat-flow-kind') || '') : ''
        if (state.dragging) return
        if (kind === 'tool-call' || kind.includes('tool')) {
          faceChat()
          if (state.action !== 'work') setAction('work', { sticky: true })
        } else if (kind === 'assistant') {
          faceChat()
          if (state.action !== 'typing') setAction('typing', { sticky: true })
        } else if (kind === 'user') {
          // the human just said something: look at the chat and perk up
          faceChat()
          if (state.action !== 'sleep') setAction('happy')
        }
        // quiet -> leave the sticky timer to fall back to wander
      })
      mo.observe(flow, { childList: true, subtree: true })
      state.sessionObserver = mo
    }

    function startQuietCheck() {
      state.quietCheckTimer = setInterval(() => {
        if (state.disposed || state.dragging) return
        if (!settings.enabled || !settings.sessionLink) return
        // long quiet -> nap (unless it's already something interactive)
        if (Date.now() > state.sessionBusyUntil &&
            (state.action === 'idle' || state.action === 'walk')) {
          setAction('sleep')
        }
      }, 30000)
    }

    // ----------------------------------------------------- notice channel
    // 订阅 Host SSE 提醒流；已看过的 id 记在 localStorage，刷新后不重复打扰。
    const LS_SEEN_KEY = 'dpet.seen-notices'
    let noticeSource = null
    let noticeTimer = 0

    function readSeenIds() {
      try { return new Set(JSON.parse(localStorage.getItem(LS_SEEN_KEY) || '[]')) } catch { return new Set() }
    }

    function markSeen(id) {
      try {
        const seen = readSeenIds()
        seen.add(id)
        localStorage.setItem(LS_SEEN_KEY, JSON.stringify([...seen].slice(-50)))
      } catch { /* storage unavailable — session-only dedupe, fine */ }
    }

    function showNotice(notice) {
      if (state.disposed || !settings.enabled) return
      markSeen(notice.id)
      state.lastNotice = notice
      setAction('happy')
      // 气泡显示提醒标题，8 秒后交还给动作自身的气泡逻辑。
      if (state.bubble) {
        state.bubble.textContent = `${notice.icon || '🔔'} ${notice.title}`
        state.bubble.dataset.show = 'true'
        clearTimeout(noticeTimer)
        noticeTimer = setTimeout(() => {
          if (state.bubble) state.bubble.dataset.show = 'false'
        }, 8000)
      }
      if (notice.body) console.info(`[dsh-desktop-pet] ${notice.title}: ${notice.body}`)
    }

    function subscribeNotices() {
      try {
        noticeSource = new EventSource('/api/dsh-desktop-pet/events')
        noticeSource.onmessage = ev => {
          try {
            const notice = JSON.parse(ev.data)
            if (notice && notice.id && !readSeenIds().has(notice.id)) showNotice(notice)
          } catch { /* malformed frame — ignore */ }
        }
        noticeSource.onerror = () => { /* EventSource 自带重连，等恢复即可 */ }
      } catch (error) {
        console.warn('[dsh-desktop-pet] notice stream unavailable:', error)
      }
    }

    // ---------------------------------------------------------- walk engine
    let lastTs = 0
    function tick(ts) {
      if (state.disposed) return
      const dt = lastTs ? (ts - lastTs) / 1000 : 0
      lastTs = ts
      if (state.action === 'walk' && !state.dragging) {
        const t = state.walkTarget
        if (t) {
          // stroll toward the target; arrive -> stop and idle
          const dx = t.x - state.x
          const step = WALK_SPEED() * dt
          if (Math.abs(dx) <= step) {
            state.x = t.x
            state.walkTarget = null
            setAction('idle')
          } else {
            state.dir = dx > 0 ? 1 : -1
            state.x += step * state.dir
          }
          state.y += Math.sign(t.y - state.y) * Math.min(Math.abs(t.y - state.y), step)
        } else {
          setAction('idle')
        }
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
      loadSettings()
      const { root, pet, bubble } = buildPet()
      state.root = root; state.pet = pet; state.bubble = bubble
      if (state.x === 0 && state.y === 0) {
        // default: bottom-right corner of the viewport, clear of the composer
        const safe = avoidBlocked(window.innerWidth - 120, window.innerHeight - 140)
        state.x = safe.x
        state.y = safe.y
      }
      clampToViewport()
      state.home = { x: state.x, y: state.y }
      renderPosition()

      root.addEventListener('pointerdown', onPointerDown)
      root.addEventListener('pointermove', onPointerMove)
      root.addEventListener('pointerup', onPointerUp)
      root.addEventListener('pointercancel', onPointerUp)
      root.addEventListener('click', onClick)
      root.addEventListener('dblclick', onDblClick)
      root.addEventListener('contextmenu', onContextMenu)
      root.addEventListener('pointerenter', onPetEnter)
      root.addEventListener('pointerleave', hideTip)

      if (!settings.enabled) state.root.style.display = 'none'

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
      startBalancePolling()
      subscribeNotices()
      state.rafId = requestAnimationFrame(tick)
      setAction('idle')
      console.info('[dsh-desktop-pet] pet mounted 🐾')
    }

    function dispose() {
      state.disposed = true
      closeMenu()
      closeRestartDialog()
      clearActionTimer()
      clearTimeout(noticeTimer)
      noticeSource?.close()
      if (state.quietCheckTimer) clearInterval(state.quietCheckTimer)
      stopBalancePolling()
      if (state.obsRetryTimer) clearInterval(state.obsRetryTimer)
      if (state.sessionObserver) state.sessionObserver.disconnect()
      if (state.rafId) cancelAnimationFrame(state.rafId)
      if (clickTimer) clearTimeout(clickTimer)
      clearTimeout(tipHideTimer)
      tipEl?.remove()
      tipEl = null
      state.root?.remove()
      document.getElementById(STYLE_ID)?.remove()
      console.info('[dsh-desktop-pet] pet disposed')
    }

    // allow manual teardown / HMR reload from the console
    window.__dshDesktopPet = { dispose, setAction, settings, openMenu, get lastNotice() { return state.lastNotice } }

    // cordis plugin shape: the browser-side registry applies this exports
    // object via registry.plugin(), which requires a function or an object
    // with an `apply` method. Mount in apply() — do NOT mount at factory
    // time, or the plugin fails to activate with:
    //   failed to apply loader entry <id> (dsh-desktop-pet):
    //   invalid plugin, expect function or object with an "apply" method
    function apply(ctx) {
      void ctx
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true })
      } else {
        mount()
      }
    }

    exports.name = 'desktop-pet'
    exports.apply = apply

    module.exports = exports
    return module.exports
  },
})
