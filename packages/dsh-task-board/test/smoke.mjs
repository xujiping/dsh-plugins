/**
 * dsh-task-board host 半边冒烟测试。
 *
 * 覆盖纯 Node 逻辑：
 *   1. `trusted` 回环围栏 —— 本机通过，远程 / 跨站 / 伪造 host 拒绝
 *   2. `readBoard` —— 合法 yaml 归一化；缺文件回退 []；坏条目丢弃；列内按 order 排序
 *   3. `writeBoard` —— 归一化 + 往返一致；非法条目丢弃；原子落盘
 *   4. 路由注册 —— apply 注册 state / add / update / remove / move / save
 *   5. 路由守卫 —— 非回环 403、方法错 405、坏 JSON 400
 *   6. add —— 缺 title 400；正常落盘；id 冲突 400
 *   7. update —— 改字段；换列时挪到目标列末尾并重排 order
 *   8. move —— 跨列 + 列内 beforeId 精确插入
 *   9. remove —— 删除；未知 id 400
 *  10. save —— 全量写回
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { apply, trusted, readBoard, writeBoard, STATUSES, PRIORITIES } from '../lib/index.js'

// ------------------------------------------------------------------ helpers
function tmpFile(name = 'board.yaml') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-task-board-'))
  return { dir, file: join(dir, name) }
}

function request(address = '127.0.0.1', headers = {}) {
  return { socket: { remoteAddress: address }, headers: { host: 'localhost:3000', ...headers } }
}

/** 用桩 req/res 跑一次路由处理函数，收集状态码 + JSON 体。 */
async function callHandler(handler, { method = 'GET', body = null, rawBody = null, address = '127.0.0.1', headers = {} } = {}) {
  let status = 0
  let payload = null
  const req = request(address, headers)
  req.method = method
  if (body !== null || rawBody !== null) {
    const data = rawBody !== null ? rawBody : JSON.stringify(body)
    req.on = (event, cb) => {
      if (event === 'data') {
        // 拆成两个 chunk，顺带验证累积逻辑
        const mid = Math.ceil(data.length / 2)
        cb(data.slice(0, mid))
        cb(data.slice(mid))
      }
      if (event === 'end') cb()
    }
  } else {
    req.on = () => {}
  }
  const res = {
    writeHead(code) { status = code },
    end(value) { if (value) payload = JSON.parse(value) },
  }
  await handler(req, res)
  // CRUD 壳走 Promise 后异步回包，放一轮事件循环让 res.end 落地。
  await new Promise(resolve => setImmediate(resolve))
  return { status, payload }
}

// --------------------------------------------------------------- trust fence
assert.equal(trusted(request()), true)
assert.equal(trusted(request('::ffff:127.0.0.1')), true)
assert.equal(trusted(request('::1')), true)
assert.equal(trusted(request('192.168.1.2')), false)
assert.equal(trusted(request('10.0.0.1')), false)
assert.equal(trusted(request('127.0.0.1', { origin: 'https://evil.example' })), false)
assert.equal(trusted(request('127.0.0.1', { host: 'evil.example' })), false)
assert.equal(trusted(request('127.0.0.1', { 'sec-fetch-site': 'cross-site' })), false)
assert.equal(trusted(request('127.0.0.1', { origin: 'http://localhost:3000' })), true)

// ------------------------------------------------------------------ 常量契约
assert.deepEqual(STATUSES, ['backlog', 'todo', 'doing', 'review', 'done'])
assert.deepEqual(PRIORITIES, ['low', 'medium', 'high', 'urgent'])

// ------------------------------------------------------------------ readBoard
{
  const { dir, file } = tmpFile()
  try {
    assert.deepEqual(readBoard(file), []) // 缺文件 → 空看板

    writeFileSync(file, [
      'cards:',
      '  - id: fix-login',
      '    title: 修复登录超时',
      '    status: doing',
      '    priority: high',
      '    tags: [后端]',
      '    dueDate: "2026-11-10"',
      '    order: 0',
      '  - title: 无 id 卡片',
      '    status: unknown-status',
      '    priority: nope',
      '    dueDate: not-a-date',
      '    order: 1',
      '  - title: ""',       // 空标题 → 丢弃
      '  - 42',              // 非对象 → 丢弃
    ].join('\n'), 'utf8')

    const cards = readBoard(file)
    assert.equal(cards.length, 2)
    assert.equal(cards[0].id, 'fix-login')
    assert.equal(cards[0].status, 'doing')
    assert.equal(cards[0].priority, 'high')
    assert.deepEqual(cards[0].tags, ['后端'])
    assert.equal(cards[0].dueDate, '2026-11-10')
    // 非法 status/priority 回落默认；非法日期丢弃
    assert.equal(cards[1].status, 'backlog')
    assert.equal(cards[1].priority, 'medium')
    assert.equal(cards[1].dueDate, '')
    assert.ok(cards[1].id.length > 0, '无 id 时由标题生成')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ----------------------------------------------------------------- writeBoard
{
  const { dir, file } = tmpFile()
  try {
    const written = writeBoard([
      { id: 'a', title: '卡片A', status: 'todo', priority: 'urgent', tags: ['x', 'x', ''], dueDate: '2026-01-01' },
      { title: '', status: 'todo' },              // 丢弃
      'garbage',                                   // 丢弃
    ], file)
    assert.equal(written.length, 1)
    assert.deepEqual(written[0].tags, ['x'], '标签去重去空')
    // 往返一致
    assert.deepEqual(readBoard(file), written)
    const raw = readFileSync(file, 'utf8')
    assert.match(raw, /^cards:/m)
    assert.match(raw, /title: 卡片A/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ 路由注册 + 清理
{
  const routes = {}
  const cleanups = []
  apply({
    effect(fn) { cleanups.push(fn()) },
    webServer: { register(route) { routes[route.path] = route; return () => {} } },
  })
  for (const path of [
    '/api/dsh-board/state',
    '/api/dsh-board/cards/add',
    '/api/dsh-board/cards/update',
    '/api/dsh-board/cards/remove',
    '/api/dsh-board/cards/move',
    '/api/dsh-board/save',
  ]) assert.ok(routes[path], `${path} 已注册`)
  assert.equal(cleanups.length, 1)
  assert.equal(typeof cleanups[0], 'function', 'disposer 必须是函数')
}

// ------------------------------------------------------- 路由行为（隔离配置文件）
{
  const { dir, file } = tmpFile()
  const prev = process.env.DSH_BOARD_CONFIG
  process.env.DSH_BOARD_CONFIG = file
  try {
    const routes = {}
    apply({
      effect(fn) { fn() },
      webServer: { register(route) { routes[route.path] = route; return () => {} } },
    })
    const state = routes['/api/dsh-board/state']
    const add = routes['/api/dsh-board/cards/add']
    const update = routes['/api/dsh-board/cards/update']
    const remove = routes['/api/dsh-board/cards/remove']
    const move = routes['/api/dsh-board/cards/move']
    const save = routes['/api/dsh-board/save']

    // ---- 守卫
    assert.equal((await callHandler(state.handler, { method: 'POST' })).status, 405)
    assert.equal((await callHandler(state.handler, { address: '10.0.0.1' })).status, 403)
    const empty = await callHandler(state.handler, { method: 'GET' })
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.payload, { cards: [] })

    for (const route of [add, update, remove, move, save]) {
      assert.equal((await callHandler(route.handler, { method: 'GET' })).status, 405)
      assert.equal((await callHandler(route.handler, { method: 'POST', address: '10.0.0.1' })).status, 403)
    }

    // ---- add
    assert.equal((await callHandler(add.handler, { method: 'POST', body: {} })).status, 400)
    const added = await callHandler(add.handler, {
      method: 'POST',
      body: { title: '修复登录超时', status: 'todo', priority: 'high', tags: ['后端'], dueDate: '2026-11-10' },
    })
    assert.equal(added.status, 200)
    assert.equal(added.payload.cards.length, 1)
    assert.equal(added.payload.cards[0].status, 'todo')
    assert.equal(added.payload.cards[0].order, 0)
    const id1 = added.payload.cards[0].id
    // id 冲突 → 400
    assert.equal((await callHandler(add.handler, { method: 'POST', body: { title: 'x', id: id1 } })).status, 400)

    const added2 = await callHandler(add.handler, {
      method: 'POST', body: { title: '写测试', status: 'todo', priority: 'low' },
    })
    assert.equal(added2.payload.cards.length, 2)
    assert.equal(added2.payload.cards[1].order, 1, '同列新卡片追加到末尾')
    const id2 = added2.payload.cards[1].id

    // ---- update（改字段，不改列）
    const upd = await callHandler(update.handler, {
      method: 'POST', body: { id: id1, title: '修复登录超时（含重试）', priority: 'urgent' },
    })
    assert.equal(upd.status, 200)
    const card1 = upd.payload.cards.find(card => card.id === id1)
    assert.equal(card1.title, '修复登录超时（含重试）')
    assert.equal(card1.priority, 'urgent')
    assert.equal(card1.status, 'todo', '未传 status 时保持')
    assert.equal((await callHandler(update.handler, { method: 'POST', body: { id: 'nope' } })).status, 400)

    // ---- update 换列：挪到目标列末尾
    const movedByUpdate = await callHandler(update.handler, {
      method: 'POST', body: { id: id1, status: 'doing' },
    })
    assert.equal(movedByUpdate.status, 200)
    const doingCards = movedByUpdate.payload.cards.filter(card => card.status === 'doing')
    assert.equal(doingCards.length, 1)
    assert.equal(doingCards[0].order, 0)
    const todoCards = movedByUpdate.payload.cards.filter(card => card.status === 'todo')
    assert.equal(todoCards.length, 1)
    assert.equal(todoCards[0].order, 0, '原列重排压紧 order')

    // ---- move 跨列
    const moved = await callHandler(move.handler, {
      method: 'POST', body: { id: id2, status: 'doing' },
    })
    assert.equal(moved.status, 200)
    const doingAfter = moved.payload.cards.filter(card => card.status === 'doing').sort((a, b) => a.order - b.order)
    assert.deepEqual(doingAfter.map(card => card.id), [id1, id2], '无 beforeId 时追加到末尾')

    // ---- move 列内 beforeId 精确插入
    const reordered = await callHandler(move.handler, {
      method: 'POST', body: { id: id2, status: 'doing', beforeId: id1 },
    })
    const doingFinal = reordered.payload.cards.filter(card => card.status === 'doing').sort((a, b) => a.order - b.order)
    assert.deepEqual(doingFinal.map(card => card.id), [id2, id1], 'beforeId 决定插入点')

    // ---- move 非法 status → 400
    assert.equal((await callHandler(move.handler, { method: 'POST', body: { id: id1, status: 'bogus' } })).status, 400)

    // ---- remove
    const removed = await callHandler(remove.handler, { method: 'POST', body: { id: id2 } })
    assert.equal(removed.status, 200)
    assert.equal(removed.payload.cards.length, 1)
    assert.equal((await callHandler(remove.handler, { method: 'POST', body: { id: id2 } })).status, 400)

    // ---- save 全量写回
    const saved = await callHandler(save.handler, {
      method: 'POST',
      body: { cards: [{ title: '全量卡片', status: 'done', priority: 'medium' }] },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.payload.cards.length, 1)
    assert.equal(saved.payload.cards[0].status, 'done')
    assert.equal((await callHandler(save.handler, { method: 'POST', body: { cards: 'nope' } })).status, 400)

    // ---- 坏 JSON → 400
    assert.equal((await callHandler(add.handler, { method: 'POST', rawBody: '{not-json!!' })).status, 400)

    // ---- 落盘可被 state 再读回
    const finalState = await callHandler(state.handler, { method: 'GET' })
    assert.equal(finalState.payload.cards.length, 1)
    assert.equal(finalState.payload.cards[0].title, '全量卡片')
  } finally {
    if (prev === undefined) delete process.env.DSH_BOARD_CONFIG
    else process.env.DSH_BOARD_CONFIG = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

// -------------------------------------------------- client 半边静态契约断言
{
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 必须用原生插槽，不许 DOM 注入到 React 树外
  assert.match(client, /ctx\.slots\.inject\('main'/)
  assert.match(client, /ctx\.slots\.inject\('sidebar\.panellist'/)
  assert.doesNotMatch(client, /document\.body\.append\(menuEl\)/, '不得沿用 DOM 菜单注入方案')
  // 五列泳道顺序固定
  for (const status of STATUSES) assert.match(client, new RegExp(`id: '${status}'`))
  // 配色只走官方 token，禁止硬编码 hex 与渐变
  assert.doesNotMatch(client, /linear-gradient|radial-gradient/, '不得使用渐变')
  const hardcoded = client.match(/#[0-9a-fA-F]{3,8}\b/g) || []
  assert.deepEqual(hardcoded, [], `样式里不得硬编码颜色：${hardcoded.join(', ')}`)
  // 面板必须包 ErrorBoundary，渲染崩溃不弄 blank 主区域
  assert.match(client, /class BoardBoundary extends react\.Component/)
  // 主按钮前景/背景必须配对：brand-primary 是近黑色，前景必须用
  // label-primary-foreground，否则黑底黑字（曾出现过的回归）
  const primaryRule = client.match(/\[data-kind="primary"\]\s*\{[^}]*\}/)
  assert.ok(primaryRule, '主按钮样式必须存在')
  assert.match(primaryRule[0], /label-primary-foreground/, '主按钮前景必须用配对 token')
  // all: unset 之后必须显式继承字体，否则中文回退到浏览器默认字体
  const unsetBlocks = client.match(/all: unset;[\s\S]{0,700}?\}/g) || []
  assert.ok(unsetBlocks.length > 0, '应当存在 all: unset 控件样式')
  for (const block of unsetBlocks) {
    assert.match(block, /font-family: inherit/, `all: unset 控件必须显式 font-family: inherit：${block.slice(0, 60)}`)
  }
  // 原生 select 在 all: unset 后必须恢复下拉箭头。
  // 同一选择器可能分多条规则（组合规则 + 单独恢复规则），收集全部再判定。
  for (const selector of ['select', 'field-select']) {
    const rules = client.match(new RegExp(`\\.\\$\\{ROOT\\}-${selector}\\s*\\{[^}]*\\}`, 'g')) || []
    assert.ok(rules.length > 0, `${selector} 样式必须存在`)
    assert.ok(
      rules.some(rule => /appearance:\s*(auto|menulist)/.test(rule)),
      `${selector} 必须恢复原生下拉外观，实际规则：${rules.join(' | ').slice(0, 120)}`,
    )
  }
}

console.log('dsh-task-board smoke: OK')
