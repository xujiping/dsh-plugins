/**
 * dsh-task-board — browser 半边（跑在 dsh web GUI 里）。
 *
 * 原生插槽实现（不用 DOM 注入）：
 *   - `sidebar.panellist`：侧边栏全局面板图标（看板入口，id = 'task-board'）；
 *   - `main`（key = 'task-board'）：右侧主面板，五列泳道看板。
 * 侧边栏按钮由宿主拥有，点它触发 `ctx.layout.selectPanel('task-board')`，
 * 主面板就渲染我们注册的看板组件。
 *
 * 看板能力：
 *   - 五列泳道 backlog / todo / doing / review / done，列头显示数量；
 *   - 卡片显示标题、描述摘要、优先级色条、标签、截止日（逾期标红）；
 *   - 新建卡片、点卡片展开编辑（改标题/描述/优先级/标签/截止日）、删除；
 *   - 列间拖拽移动（HTML5 drag & drop），落点按 beforeId 精确排序；
 *   - 顶部搜索框 + 优先级筛选 + 「刷新」；
 *   - 全部走 `--dsw-alias-*` token，自动跟随明暗主题；纯色，无渐变。
 *
 * 数据经 host 半边回环路由读写 ~/.dsh/board.yaml；渲染崩溃只降级本面板。
 */

window.__ModuleLoader__.load({
  id: 'dsh-task-board',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const el = react.createElement

    // ------------------------------------------------------------- constants
    const API_STATE = '/api/dsh-board/state'
    const API_ADD = '/api/dsh-board/cards/add'
    const API_UPDATE = '/api/dsh-board/cards/update'
    const API_REMOVE = '/api/dsh-board/cards/remove'
    const API_MOVE = '/api/dsh-board/cards/move'
    const PANEL_ID = 'task-board'
    const ROOT = 'dtb'

    const COLUMNS = [
      { id: 'backlog', label: '待规划' },
      { id: 'todo', label: '待开始' },
      { id: 'doing', label: '进行中' },
      { id: 'review', label: '待审核' },
      { id: 'done', label: '已完成' },
    ]

    const PRIORITIES = [
      { id: 'urgent', label: '紧急', tone: 'urgent' },
      { id: 'high', label: '高', tone: 'high' },
      { id: 'medium', label: '中', tone: 'medium' },
      { id: 'low', label: '低', tone: 'low' },
    ]

    // --------------------------------------------------------------- helpers
    function priorityMeta(id) {
      return PRIORITIES.find(item => item.id === id) || PRIORITIES[2]
    }

    /** 本地日期 YYYY-MM-DD（截止日比较用）。 */
    function todayIso() {
      const now = new Date()
      const pad = n => String(n).padStart(2, '0')
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    }

    /** 截止日展示：MM-DD；逾期返回 overdue 标记。 */
    function dueMeta(dueDate) {
      if (!dueDate) return null
      const today = todayIso()
      return {
        text: dueDate.slice(5),
        overdue: dueDate < today,
        isToday: dueDate === today,
      }
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
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    // ------------------------------------------------------------------ styles
    function ensureStyles() {
      if (document.getElementById('dsh-task-board-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-task-board-styles'
      style.setAttribute('data-plugin', 'dsh-task-board')
      style.textContent = `
.${ROOT}-page {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  /* 宿主 main 面板是 flex column 容器：用 flex:1 撑满，height:100% 在这里不生效 */
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
}

/* ---- 工具栏 ---- */
.${ROOT}-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: .5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  /* 窄面板时允许换行，避免各控件被压成竖排文字 */
  flex-wrap: wrap;
}
.${ROOT}-title {
  flex: 0 0 auto;
  font-size: 15px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary);
  margin-right: 4px;
}
.${ROOT}-count {
  flex: 0 0 auto;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
  padding: 0 8px;
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.${ROOT}-search {
  all: unset;
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 80px;
  max-width: 320px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  /* all: unset 会把 font-family 重置为浏览器初始值，必须显式继承宿主字体 */
  font-family: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
}
.${ROOT}-search::placeholder { color: var(--dsw-alias-label-secondary); }
.${ROOT}-search:focus { border-color: var(--dsw-alias-brand-primary); }
.${ROOT}-select {
  all: unset;
  box-sizing: border-box;
  flex: 0 0 auto;
  height: 30px;
  /* 右侧留出原生下拉箭头的位置，避免箭头压住文字 */
  padding: 0 24px 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  font-family: inherit;
  font-size: 12px;
  line-height: 28px;
  cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  /* all: unset 后显式恢复原生下拉箭头 */
  appearance: auto;
  -webkit-appearance: menulist;
}
.${ROOT}-select:focus { border-color: var(--dsw-alias-brand-primary); }
.${ROOT}-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  transition: background-color .12s ease;
}
.${ROOT}-btn:hover { background: var(--dsw-alias-bg-layer-1); }
.${ROOT}-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
/* 主按钮：背景是 brand-primary（浅色主题下近黑），文字必须用配对的
   label-primary-foreground（浅色主题下为白色），否则就是黑底黑字。 */
.${ROOT}-btn[data-kind="primary"] {
  color: var(--dsw-alias-label-primary-foreground);
  background: var(--dsw-alias-brand-primary);
}
.${ROOT}-btn[data-kind="primary"]:hover {
  background: var(--dsw-alias-button-primary-hover);
}
.${ROOT}-btn[data-kind="ghost"] {
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.${ROOT}-btn[data-kind="ghost"]:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.${ROOT}-btn[data-kind="danger"] {
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
}
.${ROOT}-btn[data-kind="danger"]:hover { background: var(--dsw-alias-bg-layer-2); }
.${ROOT}-btn:disabled { opacity: .5; cursor: default; }

/* ---- 泳道区 ---- */
.${ROOT}-lanes {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  gap: 10px;
  padding: 12px 16px 16px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}
.${ROOT}-lane {
  flex: 0 0 264px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.${ROOT}-lane[data-dropping="true"] {
  border-color: var(--dsw-alias-brand-primary);
}
.${ROOT}-lane-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: .5px solid var(--dsw-alias-border-l1);
}
.${ROOT}-lane-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--dsw-alias-state-idle-primary);
}
.${ROOT}-lane[data-column="doing"] .${ROOT}-lane-dot { background: var(--dsw-alias-state-warn-primary); }
.${ROOT}-lane[data-column="review"] .${ROOT}-lane-dot { background: var(--dsw-alias-brand-primary); }
.${ROOT}-lane[data-column="done"] .${ROOT}-lane-dot { background: var(--dsw-alias-state-success-primary); }
.${ROOT}-lane-label {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${ROOT}-lane-count {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.${ROOT}-lane-add {
  all: unset;
  box-sizing: border-box;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
}
.${ROOT}-lane-add:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
}
.${ROOT}-lane-add:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }
.${ROOT}-lane-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scrollbar-width: thin;
}
.${ROOT}-lane-empty {
  padding: 18px 8px;
  text-align: center;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

/* ---- 卡片 ---- */
.${ROOT}-card {
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 10px 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
  cursor: pointer;
  transition: border-color .12s ease, background-color .12s ease;
}
.${ROOT}-card:hover { border-color: var(--dsw-alias-border-l2); }
.${ROOT}-card:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.${ROOT}-card[data-dragging="true"] { opacity: .45; }
/* 优先级色条：纯色，无渐变 */
.${ROOT}-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 999px;
  background: var(--dsw-alias-state-idle-primary);
}
.${ROOT}-card[data-priority="urgent"]::before { background: var(--dsw-alias-state-error-primary); }
.${ROOT}-card[data-priority="high"]::before { background: var(--dsw-alias-state-warn-primary); }
.${ROOT}-card[data-priority="medium"]::before { background: var(--dsw-alias-brand-primary); }
.${ROOT}-card[data-priority="low"]::before { background: var(--dsw-alias-state-success-primary); }
.${ROOT}-card-title {
  font-size: 12.5px;
  font-weight: 600;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  word-break: break-word;
}
.${ROOT}-card-desc {
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.${ROOT}-card-foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.${ROOT}-tag {
  font-size: 10px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.${ROOT}-due {
  font-size: 10px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.${ROOT}-due[data-overdue="true"] {
  color: var(--dsw-alias-state-error-primary);
}
.${ROOT}-due[data-today="true"] {
  color: var(--dsw-alias-state-warn-primary);
}

/* ---- 卡片编辑对话框 ---- */
.${ROOT}-mask {
  position: fixed;
  z-index: 60;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.32));
}
.${ROOT}-dialog {
  box-sizing: border-box;
  width: min(520px, 100%);
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-base);
  overflow: hidden;
}
.${ROOT}-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 16px 10px;
}
.${ROOT}-dialog-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.${ROOT}-dialog-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px 16px 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.${ROOT}-field { display: flex; flex-direction: column; gap: 4px; }
.${ROOT}-field > label {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.${ROOT}-input,
.${ROOT}-textarea,
.${ROOT}-field-select {
  all: unset;
  box-sizing: border-box;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  /* all: unset 后必须显式继承宿主字体，否则中文回退到浏览器默认字体 */
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
}
.${ROOT}-textarea { min-height: 84px; resize: vertical; }
.${ROOT}-input:focus,
.${ROOT}-textarea:focus,
.${ROOT}-field-select:focus { border-color: var(--dsw-alias-brand-primary); }
.${ROOT}-field-select {
  cursor: pointer;
  padding-right: 24px;
  /* all: unset 清掉了原生下拉箭头，显式恢复 */
  appearance: auto;
  -webkit-appearance: menulist;
}
.${ROOT}-dialog-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: .5px solid var(--dsw-alias-border-l1);
}
.${ROOT}-dialog-foot-spacer { flex: 1 1 auto; }

/* ---- toast ---- */
.${ROOT}-toast {
  position: fixed;
  z-index: 70;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  max-width: calc(100vw - 32px);
  padding: 10px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay);
  opacity: 0;
  pointer-events: none;
  transition: opacity .18s ease;
}
.${ROOT}-toast[data-show="true"] { opacity: 1; }

@media (prefers-reduced-motion: reduce) {
  .${ROOT}-card, .${ROOT}-btn, .${ROOT}-toast { transition: none; }
}
`
      document.head.append(style)
    }

    // -------------------------------------------------------------------- toast
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
      } catch (error) { console.warn('[task-board] toast failed', error) }
    }

    // ------------------------------------------------------------------ 图标
    /** 侧边栏图标：看板三列小方块（装饰性，无障碍名称由侧边栏行提供）。 */
    function BoardIcon({ size }) {
      const s = Number.isFinite(size) && size > 0 ? size : 18
      const unit = s / 18
      const bar = (x, h) => el('rect', {
        key: `b${x}`,
        x: 2 + x * 5,
        y: 18 - h,
        width: 3.5,
        height: h,
        rx: 1.2,
        fill: 'currentColor',
      })
      return el('svg', {
        viewBox: '0 0 18 18',
        width: s,
        height: s,
        'aria-hidden': true,
        style: { display: 'block', transform: `scale(${unit / unit})` },
      }, [bar(0, 11), bar(1, 8), bar(2, 13)])
    }

    // ------------------------------------------------------------------ 卡片
    function CardView({ card, onOpen, onDragStart, onDragEnd }) {
      const due = dueMeta(card.dueDate)
      return el('div', {
        className: `${ROOT}-card`,
        role: 'button',
        tabIndex: 0,
        draggable: true,
        'data-card-id': card.id,
        'data-priority': card.priority,
        title: card.description || card.title,
        onClick: () => onOpen(card),
        onKeyDown: event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen(card)
          }
        },
        onDragStart: event => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', card.id)
          onDragStart(card.id)
        },
        onDragEnd: () => onDragEnd(),
      },
      el('div', { className: `${ROOT}-card-title` }, card.title),
      card.description !== ''
        ? el('div', { className: `${ROOT}-card-desc` }, card.description)
        : null,
      (card.tags.length > 0 || due !== null)
        ? el('div', { className: `${ROOT}-card-foot` },
            card.tags.map(tag => el('span', { key: `t-${tag}`, className: `${ROOT}-tag` }, tag)),
            due !== null
              ? el('span', {
                  className: `${ROOT}-due`,
                  'data-overdue': due.overdue ? 'true' : 'false',
                  'data-today': due.isToday ? 'true' : 'false',
                }, due.overdue ? `逾期 ${due.text}` : due.text)
              : null,
          )
        : null,
      )
    }

    // ------------------------------------------------------------------ 泳道
    function Lane({ column, cards, isDropTarget, onOpen, onAdd, onDragStart, onDragEnd, onDropCard }) {
      const [over, setOver] = react.useState(false)
      return el('div', {
        className: `${ROOT}-lane`,
        'data-column': column.id,
        'data-dropping': over || isDropTarget ? 'true' : 'false',
        onDragOver: event => {
          // 只允许移动类拖拽落进泳道
          if (event.dataTransfer?.types?.includes('text/plain')) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            if (!over) setOver(true)
          }
        },
        onDragLeave: event => {
          // 仅当真正离开泳道容器（而非进入子卡片）时复位
          if (event.currentTarget.contains(event.relatedTarget)) return
          if (over) setOver(false)
        },
        onDrop: event => {
          event.preventDefault()
          setOver(false)
          const cardId = event.dataTransfer?.getData('text/plain') || ''
          if (cardId !== '') onDropCard(cardId, column.id, null)
        },
      },
      el('div', { className: `${ROOT}-lane-head` },
        el('span', { className: `${ROOT}-lane-dot` }),
        el('span', { className: `${ROOT}-lane-label` }, column.label),
        el('span', { className: `${ROOT}-lane-count` }, `${cards.length}`),
        el('button', {
          type: 'button',
          className: `${ROOT}-lane-add`,
          title: `在「${column.label}」新建卡片`,
          'aria-label': `在「${column.label}」新建卡片`,
          onClick: () => onAdd(column.id),
        }, '＋'),
      ),
      el('div', { className: `${ROOT}-lane-body` },
        cards.length === 0
          ? el('div', { className: `${ROOT}-lane-empty` }, '拖入卡片或点 ＋ 新建')
          : cards.map(card => el('div', {
              key: card.id,
              className: `${ROOT}-card-slot`,
              onDragOver: event => {
                if (!event.dataTransfer?.types?.includes('text/plain')) return
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'move'
              },
              onDrop: event => {
                // 落在某张卡片上 → 插到它前面（beforeId）
                event.preventDefault()
                event.stopPropagation()
                const cardId = event.dataTransfer?.getData('text/plain') || ''
                if (cardId !== '' && cardId !== card.id) onDropCard(cardId, column.id, card.id)
              },
            }, el(CardView, {
              card,
              onOpen,
              onDragStart,
              onDragEnd,
            }))),
      ),
      )
    }

    // ------------------------------------------------------------- 编辑对话框
    function CardDialog({ draft, isNew, onCancel, onSave, onDelete }) {
      const [title, setTitle] = react.useState(draft.title || '')
      const [description, setDescription] = react.useState(draft.description || '')
      const [status, setStatus] = react.useState(draft.status || 'backlog')
      const [priority, setPriority] = react.useState(draft.priority || 'medium')
      const [tags, setTags] = react.useState((draft.tags || []).join(', '))
      const [dueDate, setDueDate] = react.useState(draft.dueDate || '')
      const [busy, setBusy] = react.useState(false)
      const titleRef = react.useRef(null)

      react.useEffect(() => {
        if (titleRef.current && typeof titleRef.current.focus === 'function') titleRef.current.focus()
      }, [])

      const submit = async () => {
        if (busy) return
        const trimmed = title.trim()
        if (trimmed === '') { toast('标题不能为空', 'error'); return }
        setBusy(true)
        try {
          await onSave({
            title: trimmed,
            description: description.trim(),
            status,
            priority,
            tags: tags.split(',').map(item => item.trim()).filter(item => item !== ''),
            dueDate,
          })
        } finally { setBusy(false) }
      }

      return el('div', {
        className: `${ROOT}-mask`,
        onClick: event => { if (event.target === event.currentTarget) onCancel() },
      },
      el('div', {
        className: `${ROOT}-dialog`,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': isNew ? '新建卡片' : '编辑卡片',
        onKeyDown: event => {
          if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit() }
        },
      },
      el('div', { className: `${ROOT}-dialog-head` },
        el('div', { className: `${ROOT}-dialog-title` }, isNew ? '＋ 新建卡片' : '编辑卡片'),
      ),
      el('div', { className: `${ROOT}-dialog-body` },
        el('div', { className: `${ROOT}-field` },
          el('label', null, '标题'),
          el('input', {
            ref: titleRef,
            className: `${ROOT}-input`,
            value: title,
            placeholder: '一句话说明要做什么',
            maxLength: 120,
            onChange: event => setTitle(event.target.value),
          }),
        ),
        el('div', { className: `${ROOT}-field` },
          el('label', null, '描述'),
          el('textarea', {
            className: `${ROOT}-textarea`,
            value: description,
            placeholder: '补充背景、验收标准（可留空）',
            maxLength: 2000,
            onChange: event => setDescription(event.target.value),
          }),
        ),
        el('div', { className: `${ROOT}-field` },
          el('label', null, '状态'),
          el('select', {
            className: `${ROOT}-field-select`,
            value: status,
            onChange: event => setStatus(event.target.value),
          }, COLUMNS.map(item => el('option', { key: item.id, value: item.id }, item.label))),
        ),
        el('div', { className: `${ROOT}-field` },
          el('label', null, '优先级'),
          el('select', {
            className: `${ROOT}-field-select`,
            value: priority,
            onChange: event => setPriority(event.target.value),
          }, PRIORITIES.map(item => el('option', { key: item.id, value: item.id }, item.label))),
        ),
        el('div', { className: `${ROOT}-field` },
          el('label', null, '标签（逗号分隔）'),
          el('input', {
            className: `${ROOT}-input`,
            value: tags,
            placeholder: '前端, 后端, 运维',
            onChange: event => setTags(event.target.value),
          }),
        ),
        el('div', { className: `${ROOT}-field` },
          el('label', null, '截止日'),
          el('input', {
            className: `${ROOT}-input`,
            type: 'date',
            value: dueDate,
            onChange: event => setDueDate(event.target.value),
          }),
        ),
      ),
      el('div', { className: `${ROOT}-dialog-foot` },
        isNew
          ? null
          : el('button', {
              type: 'button',
              className: `${ROOT}-btn`,
              'data-kind': 'danger',
              onClick: () => { if (!busy) onDelete() },
            }, '删除'),
        el('div', { className: `${ROOT}-dialog-foot-spacer` }),
        el('button', {
          type: 'button',
          className: `${ROOT}-btn`,
          onClick: onCancel,
        }, '取消'),
        el('button', {
          type: 'button',
          className: `${ROOT}-btn`,
          'data-kind': 'primary',
          disabled: busy,
          onClick: () => { void submit() },
        }, busy ? '保存中…' : '保存'),
      ),
      ),
      )
    }

    // ------------------------------------------------------------------ 面板
    function BoardPage(props) {
      const [cards, setCards] = react.useState([])
      const [loading, setLoading] = react.useState(true)
      const [error, setError] = react.useState('')
      const [search, setSearch] = react.useState('')
      const [priorityFilter, setPriorityFilter] = react.useState('all')
      const [editing, setEditing] = react.useState(null) // { draft, isNew }
      const [draggingId, setDraggingId] = react.useState(null)
      const layout = props.layout

      const reload = react.useCallback(async () => {
        try {
          const data = await apiGet(API_STATE)
          setCards(Array.isArray(data.cards) ? data.cards : [])
          setError('')
        } catch (err) {
          setError(err.message || '读取看板失败')
        } finally {
          setLoading(false)
        }
      }, [])

      react.useEffect(() => { void reload() }, [reload])

      /** 按列分组 + 搜索/优先级过滤，列内按 order 升序。 */
      const grouped = react.useMemo(() => {
        const query = search.trim().toLowerCase()
        const visible = cards.filter(card => {
          if (priorityFilter !== 'all' && card.priority !== priorityFilter) return false
          if (query === '') return true
          return card.title.toLowerCase().includes(query)
            || card.description.toLowerCase().includes(query)
            || card.tags.some(tag => tag.toLowerCase().includes(query))
        })
        const out = {}
        for (const column of COLUMNS) {
          out[column.id] = visible
            .filter(card => card.status === column.id)
            .sort((a, b) => a.order - b.order)
        }
        return out
      }, [cards, search, priorityFilter])

      const totalVisible = COLUMNS.reduce((sum, column) => sum + grouped[column.id].length, 0)

      const saveCard = async (draft) => {
        const editingId = editing?.draft?.id
        try {
          if (editingId) await apiPost(API_UPDATE, { id: editingId, ...draft })
          else await apiPost(API_ADD, draft)
          setEditing(null)
          await reload()
          toast(editingId ? '已保存' : '已新建卡片')
        } catch (err) {
          toast(`保存失败：${err.message}`, 'error')
        }
      }

      const removeCard = async () => {
        const id = editing?.draft?.id
        if (!id) return
        try {
          await apiPost(API_REMOVE, { id })
          setEditing(null)
          await reload()
          toast('已删除')
        } catch (err) {
          toast(`删除失败：${err.message}`, 'error')
        }
      }

      /** 拖拽落位：status 为目标列，beforeId 为插入点（null = 列末尾）。 */
      const dropCard = async (cardId, status, beforeId) => {
        setDraggingId(null)
        const current = cards.find(card => card.id === cardId)
        if (!current) return
        // 同列且位置没变 → 不发请求
        if (current.status === status) {
          const column = grouped[status]
          const index = column.findIndex(card => card.id === cardId)
          const target = beforeId === null ? column.length : column.findIndex(card => card.id === beforeId)
          if (target === index || target === index + 1) return
        }
        try {
          await apiPost(API_MOVE, { id: cardId, status, beforeId })
          await reload()
        } catch (err) {
          toast(`移动失败：${err.message}`, 'error')
        }
      }

      if (loading) {
        return el('div', { className: `${ROOT}-page` },
          el('div', { className: `${ROOT}-toolbar` }, el('div', { className: `${ROOT}-title` }, '任务看板')),
          el('div', { className: `${ROOT}-lane-empty` }, '加载中…'),
        )
      }

      return el('div', { className: `${ROOT}-page` },
        el('div', { className: `${ROOT}-toolbar` },
          el('div', { className: `${ROOT}-title` }, '任务看板'),
          el('span', { className: `${ROOT}-count` }, `${totalVisible} / ${cards.length}`),
          el('input', {
            className: `${ROOT}-search`,
            value: search,
            placeholder: '搜索标题 / 描述 / 标签…',
            'aria-label': '搜索卡片',
            onChange: event => setSearch(event.target.value),
          }),
          el('select', {
            className: `${ROOT}-select`,
            value: priorityFilter,
            'aria-label': '按优先级筛选',
            onChange: event => setPriorityFilter(event.target.value),
          },
          el('option', { value: 'all' }, '全部优先级'),
          PRIORITIES.map(item => el('option', { key: item.id, value: item.id }, item.label)),
          ),
          el('button', {
            type: 'button',
            className: `${ROOT}-btn`,
            'data-kind': 'ghost',
            onClick: () => { void reload() },
          }, '刷新'),
          el('button', {
            type: 'button',
            className: `${ROOT}-btn`,
            'data-kind': 'primary',
            onClick: () => setEditing({ draft: { status: 'todo' }, isNew: true }),
          }, '＋ 新建'),
        ),
        error !== ''
          ? el('div', { className: `${ROOT}-lane-empty` }, `读取失败：${error}（点「刷新」重试）`)
          : null,
        el('div', { className: `${ROOT}-lanes` },
          COLUMNS.map(column => el(Lane, {
            key: column.id,
            column,
            cards: grouped[column.id],
            isDropTarget: false,
            onOpen: card => setEditing({ draft: { ...card }, isNew: false }),
            onAdd: status => setEditing({ draft: { status }, isNew: true }),
            onDragStart: id => setDraggingId(id),
            onDragEnd: () => setDraggingId(null),
            onDropCard: dropCard,
          })),
        ),
        editing !== null
          ? el(CardDialog, {
              draft: editing.draft,
              isNew: editing.isNew,
              onCancel: () => setEditing(null),
              onSave: saveCard,
              onDelete: removeCard,
            })
          : null,
      )
    }

    /** 渲染崩溃只降级本面板，不弄 blank 整个主区域。 */
    class BoardBoundary extends react.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() { return { failed: true } }
      componentDidCatch(error) {
        console.warn('[task-board] render failed:', error)
      }
      render() {
        if (this.state.failed) {
          return el('div', { className: `${ROOT}-lane-empty` }, '任务看板渲染失败，请刷新页面重试')
        }
        return this.props.children
      }
    }

    // ------------------------------------------------------------------ apply
    function applyClient(ctx) {
      try {
        ensureStyles()
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
          console.warn('[task-board] slots service unavailable — board not registered')
          return
        }
        // 主面板：侧边栏选中 task-board 时渲染看板
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ layout: ctx.get('layout') }),
        }, props => el(BoardBoundary, null, el(BoardPage, props))))
        // 侧边栏全局面板图标（宿主渲染按钮并分发到上面的 main 面板）
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: '任务看板',
        }, BoardIcon))
      } catch (error) {
        console.warn('[task-board] registration failed:', error)
      }
    }

    module.exports = { apply: applyClient, inject: ['slots'] }
    exports.apply = applyClient
    exports.inject = ['slots']
    return module.exports
  },
})
