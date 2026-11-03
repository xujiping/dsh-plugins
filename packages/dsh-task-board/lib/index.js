/**
 * dsh-task-board — host 半边（跑在 dsh CLI 进程里）。
 *
 * 任务看板的本地存储与回环信任路由：
 *
 *   GET  /api/dsh-board/state        -> { cards: Card[] }
 *   POST /api/dsh-board/cards/add    -> body { title, description?, status?, priority?, tags?, dueDate? }
 *   POST /api/dsh-board/cards/update -> body { id, title?, description?, status?, priority?, tags?, dueDate? }
 *   POST /api/dsh-board/cards/remove -> body { id }
 *   POST /api/dsh-board/cards/move   -> body { id, status, beforeId? }   换列 / 列内排序
 *   POST /api/dsh-board/save         -> body { cards: Card[] }           全量原子写
 *
 * 细粒度路由面向「对话式管理」：AI 会话可直接 curl 单条增删改，不必拉全量
 * 再写回，避免覆盖并发修改。
 *
 * 数据文件 ~/.dsh/board.yaml（可用 DSH_BOARD_CONFIG 覆盖，便于测试隔离）：
 *
 *   cards:
 *     - id: fix-login
 *       title: 修复登录超时
 *       status: doing
 *       priority: high
 *       tags: [后端]
 *       dueDate: '2026-11-10'
 *       order: 0
 *
 * 读盘容忍文件缺失 / 局部损坏（回退空列表）；写入走「临时文件 + rename」原子落盘。
 * yaml 依赖从 dsh 依赖树解析，本包自身零依赖。
 */
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'

export const name = 'task-board'
export const inject = ['webServer']

const DSH_DIR = join(homedir(), '.dsh')

/** 状态机：五列泳道，顺序即看板从左到右的顺序。 */
export const STATUSES = ['backlog', 'todo', 'doing', 'review', 'done']

/** 优先级取值；medium 为缺省。 */
export const PRIORITIES = ['low', 'medium', 'high', 'urgent']

/** 配置路径：可用 DSH_BOARD_CONFIG 覆盖；调用时惰性解析。 */
function boardPath() {
  return process.env.DSH_BOARD_CONFIG || join(DSH_DIR, 'board.yaml')
}

// ------------------------------------------------------------------ helpers

/** 回环信任围栏：只允许本机同源请求读写看板数据。 */
export function trusted(req) {
  const address = (req.socket.remoteAddress || '').toLowerCase().replace(/^::ffff:/, '')
  if (address !== '::1' && !/^127\./.test(address)) return false
  try {
    const host = new URL(`http://${req.headers.host}`)
    if (!['localhost', '[::1]'].includes(host.hostname) && !/^127\./.test(host.hostname)) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    return !req.headers.origin || new URL(req.headers.origin).host === host.host
  } catch {
    return false
  }
}

function loadYamlLib() {
  // 零依赖优先：能从 dsh 依赖树解析到 yaml 就用它。
  const dshBins = ['/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js']
  if (process.argv[1]) dshBins.unshift(process.argv[1])
  for (const base of [import.meta.url, ...dshBins]) {
    try { return createRequire(base)('yaml') } catch { /* 换下一个 */ }
  }
  return null
}

function slugify(text) {
  const base = String(text).trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '')
  return base || `card-${Math.random().toString(36).slice(2, 8)}`
}

function cleanText(value, max = 200) {
  return String(value ?? '').trim().slice(0, max)
}

/** 归一化标签：去空、去重、限 8 个。 */
function normaliseTags(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    const tag = cleanText(item, 24)
    if (tag !== '' && !out.includes(tag)) out.push(tag)
    if (out.length >= 8) break
  }
  return out
}

/** 截止日只接受 YYYY-MM-DD；其他一律丢弃。 */
function normaliseDueDate(raw) {
  const text = cleanText(raw, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

/** 把 yaml 原始文档归一化成 Card[]；损坏条目静默丢弃，列内按 order 排序。 */
function normaliseCards(raw) {
  const list = Array.isArray(raw?.cards) ? raw.cards : Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const title = cleanText(item.title, 120)
    if (title === '') continue
    let id = cleanText(item.id, 64) || slugify(title)
    // id 冲突时追加序号，保证前端按 id 定位不出错。
    if (seen.has(id)) {
      let n = 2
      while (seen.has(`${id}-${n}`)) n += 1
      id = `${id}-${n}`
    }
    seen.add(id)
    const order = Number.isFinite(Number(item.order)) ? Number(item.order) : out.length
    out.push({
      id,
      title,
      description: cleanText(item.description, 2000),
      status: STATUSES.includes(item.status) ? item.status : 'backlog',
      priority: PRIORITIES.includes(item.priority) ? item.priority : 'medium',
      tags: normaliseTags(item.tags),
      dueDate: normaliseDueDate(item.dueDate),
      order,
      createdAt: cleanText(item.createdAt, 32) || new Date().toISOString(),
      updatedAt: cleanText(item.updatedAt, 32) || new Date().toISOString(),
    })
  }
  // 列内按 order 升序；跨列顺序由 status 决定（渲染时按列分组）。
  return out.sort((a, b) => a.order - b.order)
}

export function readBoard(path = boardPath()) {
  try {
    const yaml = loadYamlLib()
    if (!yaml) throw new Error('未找到 yaml 解析依赖')
    return normaliseCards(yaml.parse(readFileSync(path, 'utf8')))
  } catch {
    return [] // 文件不存在或损坏：回退空看板
  }
}

export function writeBoard(cards, path = boardPath()) {
  const yaml = loadYamlLib()
  if (!yaml) throw new Error('未找到 yaml 序列化依赖')
  const list = normaliseCards({ cards })
  const body = yaml.stringify({ cards: list }, { indent: 2, lineWidth: 0 })
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, path)
  return list
}

/** 读盘 + 变更 + 原子写回的公共通道；mutate 抛错即整条拒绝，不落盘。 */
function mutateBoard(mutate) {
  const cards = readBoard()
  return writeBoard(mutate(cards))
}

function findIndex(cards, ref) {
  const key = String(ref ?? '').trim()
  if (!key) return -1
  return cards.findIndex(card => card.id === key)
}

/** 重排某一列：按给定卡片集合重新编号 order（0..n-1），其他列不动。
 *  columnCards 是目标列的最终成员（含刚移入的卡片）；其余列必须排除这些 id，
 *  否则原列里同一张卡片会被重复计入，落盘后出现重复 id。 */
function renumberColumn(cards, status, columnCards) {
  const byId = new Map(cards.map(card => [card.id, card]))
  const movingIds = new Set(columnCards.map(card => card.id))
  const others = cards.filter(card => card.status !== status && !movingIds.has(card.id))
  const rebuilt = []
  for (const card of columnCards) {
    const current = byId.get(card.id)
    if (!current) continue
    rebuilt.push({ ...current, status, order: rebuilt.length })
  }
  // 其余列保持原有相对次序，order 重新压紧以免与目标列冲突。
  const rest = others
    .slice()
    .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.order - b.order)
  const out = []
  for (const status_ of STATUSES) {
    if (status_ === status) { out.push(...rebuilt); continue }
    const bucket = rest.filter(card => card.status === status_)
    bucket.forEach((card, index) => out.push({ ...card, order: index }))
  }
  return out
}

// -------------------------------------------------------------------- apply

export function apply(ctx) {
  ctx.effect(() => {
    const reply = (res, code, data) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(data))
    }

    const readBody = req => new Promise((resolve, reject) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })

    /** POST 路由公共壳：围栏 + 方法 + JSON 解析；handler 返回卡片数组则包成 {ok, cards}。 */
    const post = handler => (req, res) => {
      if (!trusted(req)) return reply(res, 403, { error: '仅允许本机同源请求' })
      if (req.method !== 'POST') return reply(res, 405, { error: '不支持的请求方法' })
      readBody(req).then(body => {
        try {
          const parsed = JSON.parse(body || '{}')
          const result = handler(parsed)
          if (result && typeof result === 'object' && 'status' in result) {
            return reply(res, result.status, result.data)
          }
          const data = Array.isArray(result) ? { cards: result } : result
          reply(res, 200, { ok: true, ...data })
        } catch (error) {
          reply(res, 400, { ok: false, error: error.message })
        }
      }, () => reply(res, 400, { ok: false, error: '请求体读取失败' }))
    }

    const disposers = [
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-board/state',
        handler(req, res) {
          if (!trusted(req)) return reply(res, 403, { error: '仅允许本机同源请求' })
          if (req.method !== 'GET') return reply(res, 405, { error: '不支持的请求方法' })
          reply(res, 200, { cards: readBoard() })
        },
      }),
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-board/cards/add',
        handler: post(parsed => {
          const title = cleanText(parsed.title, 120)
          if (title === '') throw new Error('title 必填')
          return mutateBoard(cards => {
            const status = STATUSES.includes(parsed.status) ? parsed.status : 'backlog'
            const order = cards.filter(card => card.status === status).length
            const now = new Date().toISOString()
            const card = {
              id: cleanText(parsed.id, 64) || slugify(title),
              title,
              description: cleanText(parsed.description, 2000),
              status,
              priority: PRIORITIES.includes(parsed.priority) ? parsed.priority : 'medium',
              tags: normaliseTags(parsed.tags),
              dueDate: normaliseDueDate(parsed.dueDate),
              order,
              createdAt: now,
              updatedAt: now,
            }
            if (cards.some(existing => existing.id === card.id)) throw new Error(`卡片 id 已存在：${card.id}`)
            return [...cards, card]
          })
        }),
      }),
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-board/cards/update',
        handler: post(parsed => {
          const ref = parsed.id ?? parsed.title
          return mutateBoard(cards => {
            const idx = findIndex(cards, ref)
            if (idx < 0) throw new Error(`未找到卡片：${ref}`)
            const cur = cards[idx]
            const next = {
              ...cur,
              title: parsed.title !== undefined ? (cleanText(parsed.title, 120) || cur.title) : cur.title,
              description: parsed.description !== undefined ? cleanText(parsed.description, 2000) : cur.description,
              status: STATUSES.includes(parsed.status) ? parsed.status : cur.status,
              priority: PRIORITIES.includes(parsed.priority) ? parsed.priority : cur.priority,
              tags: parsed.tags !== undefined ? normaliseTags(parsed.tags) : cur.tags,
              dueDate: parsed.dueDate !== undefined ? normaliseDueDate(parsed.dueDate) : cur.dueDate,
              updatedAt: new Date().toISOString(),
            }
            const out = [...cards]
            out[idx] = next
            // 换列时把卡片挪到目标列末尾，并重排两列的 order。
            if (next.status !== cur.status) {
              const target = out.filter(card => card.status === next.status && card.id !== next.id)
              return renumberColumn(out, next.status, [...target, next])
            }
            return out
          })
        }),
      }),
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-board/cards/remove',
        handler: post(parsed => {
          const ref = parsed.id ?? parsed.title
          return mutateBoard(cards => {
            const idx = findIndex(cards, ref)
            if (idx < 0) throw new Error(`未找到卡片：${ref}`)
            const out = [...cards]
            out.splice(idx, 1)
            return out
          })
        }),
      }),
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-board/cards/move',
        handler: post(parsed => {
          const ref = parsed.id
          const status = parsed.status
          if (!STATUSES.includes(status)) throw new Error(`status 必须是 ${STATUSES.join(' / ')}`)
          return mutateBoard(cards => {
            const idx = findIndex(cards, ref)
            if (idx < 0) throw new Error(`未找到卡片：${ref}`)
            const card = { ...cards[idx], updatedAt: new Date().toISOString() }
            const column = cards
              .filter(item => item.status === status && item.id !== card.id)
              .sort((a, b) => a.order - b.order)
            const before = String(parsed.beforeId ?? '').trim()
            const at = before === '' ? column.length : column.findIndex(item => item.id === before)
            const insertAt = at < 0 ? column.length : at
            column.splice(insertAt, 0, card)
            return renumberColumn(cards, status, column)
          })
        }),
      }),
      ctx.webServer.register({
        kind: 'exact', path: '/api/dsh-board/save',
        handler: post(parsed => {
          if (!Array.isArray(parsed.cards)) throw new Error('cards 必须是数组')
          return writeBoard(parsed.cards)
        }),
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'task-board: board routes')
}
