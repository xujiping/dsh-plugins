# dsh-task-board

DSH 任务看板：侧边栏一个看板入口，右侧主面板一块五列泳道看板，卡片拖来拖去就是
你的工作流。数据存 `~/.dsh/board.yaml`，**纯本地、零网络**。

纯两半边架构（不改 DSH 源码）：

- **Host 半边**（`lib/index.js`）：回环信任的 `/api/dsh-board/*` 卡片路由，
  读写 `~/.dsh/board.yaml`（原子写）。
- **Client 半边**（`lib/client.js`）：注册官方原生插槽
  `sidebar.panellist`（侧边栏入口）+ `main`（主面板看板页），
  不是 DOM 注入，宿主重绘不会掉。

## 功能

- **五列泳道**：待规划 → 待开始 → 进行中 → 待审核 → 已完成，列头显示数量，
  列内可滚动；配色只走 `--dsw-alias-*` token，自动跟随明暗主题。
- **卡片**：标题 + 描述两行摘要 + 优先级色条（紧急/高/中/低）+ 标签 +
  截止日（今天标黄、逾期标红）。
- **新建 / 编辑 / 删除**：每列列头「＋」直接在该列新建；点卡片打开编辑对话框
  （标题、描述、状态、优先级、标签、截止日）；对话框内可删除。
- **拖拽移动**：HTML5 拖放，跨列拖到列空白处 → 追加到该列末尾；拖到某张卡片上
  → 精确插到它前面（落盘时按 `beforeId` 重排 `order`）。
- **搜索 + 优先级筛选 + 刷新**：顶部工具栏即时过滤标题/描述/标签。
- **渲染隔离**：主面板包了一层 ErrorBoundary，看板崩了只降级本面板，
  不会把整个主区域弄白。

## 安装

```bash
# 从本仓库本地 link 调试
dsh plugin --profile <profile> add link:~/AiProjects/dsh-plugins/packages/dsh-task-board
```

`--profile` 换成实际 profile 名（桌面 GUI 用 `desktop`）。装完重启 `dsh web`
（或重载 profile）生效。

> **pnpm store 版本不一致**（`ERR_PNPM_UNEXPECTED_STORE`）时 `plugin add` 会失败，
> 按 AGENTS.md 记录的手动接线即可（等价于 `link:`）：
>
> 1. `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 加
>    `"dsh-task-board": "link:~/AiProjects/dsh-plugins/packages/dsh-task-board"`；
> 2. profile 的 `cordis.patch.yml` 追加
>    `- insert:\n    - id: task-board\n      name: 'dsh-task-board'`；
> 3. `~/.dsh/profiles/<profile>/node_modules` 下建同名软链。

## 配置

看板数据默认在 `~/.dsh/board.yaml`（可用环境变量 `DSH_BOARD_CONFIG` 指到别处）：

```yaml
cards:
  - id: fix-login
    title: 修复登录超时
    description: 增加重试与超时兜底
    status: doing
    priority: high
    tags: [后端]
    dueDate: '2026-11-10'
    order: 0
```

- `status`：`backlog` / `todo` / `doing` / `review` / `done`，非法值回落 `backlog`。
- `priority`：`low` / `medium` / `high` / `urgent`，非法值回落 `medium`。
- `dueDate`：只接受 `YYYY-MM-DD`，其他丢弃。
- `id` 可省略，缺省由标题生成（中文保留）；同 id 冲突时自动追加序号。
- `tags` 去空去重，最多 8 个。
- 在 GUI 里增删改拖拽，效果等同直接编辑该文件。

## 给 AI 会话用的 HTTP 接口

路由都在回环信任围栏内（非本机同源请求一律 403），可直接在会话里 curl 管理卡片：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-board/state` | 读全量卡片 |
| POST | `/api/dsh-board/cards/add` | 新建（`title` 必填） |
| POST | `/api/dsh-board/cards/update` | 改字段 / 换列 |
| POST | `/api/dsh-board/cards/remove` | 删除（`id`） |
| POST | `/api/dsh-board/cards/move` | 换列 + 列内排序（`id` / `status` / `beforeId`） |
| POST | `/api/dsh-board/save` | 全量原子写（`cards: []`） |

```bash
# 例：给看板加一张「待开始」的高优卡片
curl -s -X POST http://127.0.0.1:60508/api/dsh-board/cards/add \
  -H 'content-type: application/json' \
  -d '{"title":"补全看板拖拽","status":"todo","priority":"high","tags":["前端"]}'
```

## 测试

```bash
node test/smoke.mjs
```

覆盖：回环围栏、yaml 归一化与往返、路由注册与守卫、add/update/move/remove/save
行为（含 `beforeId` 精确排序与换列重排）、client 半边静态契约（原生插槽、
五列顺序、无硬编码颜色、无渐变、ErrorBoundary）。
