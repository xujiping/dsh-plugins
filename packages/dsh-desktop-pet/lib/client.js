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

/* ---- right-click config menu ---- */
.dpet-menu {
  position: fixed;
  z-index: 45;
  min-width: 168px;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 6px 0;
  border-radius: 10px;
  background: var(--dsw-bg-elevated, #fff);
  border: 1px solid rgba(0,0,0,0.1);
  box-shadow: 0 8px 24px rgba(0,0,0,0.16);
  font: 12px/1.6 -apple-system, "PingFang SC", "Segoe UI", sans-serif;
  color: var(--dsw-fg, #1c2333);
}
.dpet-menu-head {
  padding: 4px 12px 6px;
  font-size: 11px;
  opacity: 0.55;
  border-bottom: 1px solid rgba(0,0,0,0.06);
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
.dpet-menu-item:hover { background: rgba(77,107,254,0.08); }
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
  background: var(--dsw-static-deepseek-500, #4d6bfe);
  color: #fff;
  opacity: 1;
}
.dpet-menu-item .dpet-check {
  width: 15px; height: 15px;
  border-radius: 4px;
  border: 1px solid rgba(0,0,0,0.25);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: #fff;
}
.dpet-menu-item .dpet-check[data-on="true"] {
  background: var(--dsw-static-deepseek-500, #4d6bfe);
  border-color: transparent;
}
/* quick-action section inside the config menu */
.dpet-menu-div {
  padding: 4px 12px 2px;
  font-size: 11px;
  opacity: 0.55;
  border-top: 1px solid rgba(0,0,0,0.08);
  margin-top: 4px;
}
.dpet-menu-item .dpet-act {
  font-size: 11px;
  opacity: 0.5;
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
    // Utility tricks surfaced in the right-click menu. All browser-side;
    // the new-session one needs the cordis client context (see apply()).
    let clientCtx = null

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

    const QUICK_ACTIONS = [
      {
        label: '🔄 刷新页面', hint: 'F5',
        run: () => location.reload(),
      },
      {
        label: '⬇️ 滚动到最新消息', hint: '',
        run: () => {
          const scroller = document.querySelector('[data-conversation-scroll]')
          if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
        },
      },
      {
        label: '➕ 新建会话', hint: '',
        run: () => {
          try {
            clientCtx?.get('workspaces').startSession()
          } catch (error) {
            console.warn('[dsh-desktop-pet] startSession failed:', error)
          }
        },
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
        if (!settings.enabled || !settings.sessionLink) return
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
      state.rafId = requestAnimationFrame(tick)
      setAction('idle')
      console.info('[dsh-desktop-pet] pet mounted 🐾')
    }

    function dispose() {
      state.disposed = true
      closeMenu()
      clearActionTimer()
      if (state.quietCheckTimer) clearInterval(state.quietCheckTimer)
      if (state.obsRetryTimer) clearInterval(state.obsRetryTimer)
      if (state.sessionObserver) state.sessionObserver.disconnect()
      if (state.rafId) cancelAnimationFrame(state.rafId)
      if (clickTimer) clearTimeout(clickTimer)
      state.root?.remove()
      document.getElementById(STYLE_ID)?.remove()
      clientCtx = null
      console.info('[dsh-desktop-pet] pet disposed')
    }

    // allow manual teardown / HMR reload from the console
    window.__dshDesktopPet = { dispose, setAction, settings, openMenu }

    // cordis plugin shape: the browser-side registry applies this exports
    // object via registry.plugin(), which requires a function or an object
    // with an `apply` method. Mount in apply() — do NOT mount at factory
    // time, or the plugin fails to activate with:
    //   failed to apply loader entry <id> (dsh-desktop-pet):
    //   invalid plugin, expect function or object with an "apply" method
    function apply(ctx) {
      clientCtx = ctx ?? null   // cordis client root context (quick actions)
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true })
      } else {
        mount()
      }
    }

    exports.name = 'desktop-pet'
    exports.inject = ['workspaces']
    exports.apply = apply

    module.exports = exports
    return module.exports
  },
})
