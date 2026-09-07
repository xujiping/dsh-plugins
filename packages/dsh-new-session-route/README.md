# dsh-new-session-route

DSH 插件：把侧边栏「新会话」按钮升级为**路由下拉**——点击后不再是立刻用默认后端开一个新会话，而是弹出两个选项，让用户为新会话选择后端：

| 选项 | 行为 |
|---|---|
| **默认 DeepSeek Harness** | 原行为：`ctx.workspaces.startSession()`，用部署默认后端 |
| **Claude Code** | 在相同工作区开一个空白会话，把该会话的模型 `selectModel` 到 `dst-gateway` provider（Anthropic 兼容网关，代理到 Claude Code），然后打开 |

纯 client 插件，不改 DSH 源码：`lib/client.js` 用 `window.__ModuleLoader__.load` 注册 cordis client 插件（`inject` 拉取 `connection` / `sessions` / `workspaces` / `locale`），通过 DOM 钩住侧边栏「新会话」按钮，用 capture 阶段监听器 `stopPropagation` 挡住 React 自己的 `startSession`，改为打开自绘下拉。

## 安装

```bash
# 从本仓库 link 安装（推荐，可热改代码）
dsh plugin --profile web add link:~/AiProjects/dsh-plugins/packages/dsh-new-session-route

# 重启 dsh web 生效
```

装完重启 `dsh web`（或重载 profile）。刷新浏览器页面即可看到侧边栏「新会话」按钮被插件接管。

> 手动接线（零依赖插件等价于 `link:`，用于 GUI 实际 profile）：
> 在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 加
> `"dsh-new-session-route": "link:~/AiProjects/dsh-plugins/packages/dsh-new-session-route"`，
> `dsh.profile.bundles` 数组追加 `"dsh-new-session-route"`，并在 `node_modules` 下建软链。

## 配置

默认无需配置即可用。要改 Claude Code 路由的 provider / model，编辑
`lib/client.js` 顶部的常量：

```js
const CLAUDE_PROVIDER = 'dst-gateway'          // settings 里注册的 provider 路由
const CLAUDE_MODEL_FALLBACK = 'deepseek-v4-flash' // 兜底 model（优先从实时 catalog 发现）
```

运行时优先从 `sessions.models` 的实时 catalog 里找 `dst-gateway` 组的第一个
model，找不到才用兜底值——所以网关的模型清单变了也能自适应。

## 实现要点

- **不侵入 React**：下拉和遮罩都 append 到 `document.body`（`position: fixed`），
  完全在 React 树外，绝不会干扰 shell 的 reconciliation。
- **拦截点击**：capture 阶段监听器 + `preventDefault` + `stopPropagation`，
  挡掉 React 委托到根节点的 `startSession` 处理，再打开我们自己的菜单。
- **自愈**：MutationObserver 监听 `document.body`，侧边栏每次重渲染都会重新
  给「新会话」按钮挂上监听器（用 `WeakSet` 去重）。
- **Claude Code 流程**：
  1. 按 `startSession` 同样的规则解析目标工作区（当前会话的工作区 → 最近工作区）；
  2. `workspaces.connectWorkspace(target)` 复用/新建空白会话拿到 `sessionId`；
  3. `api.sessions.models({ sessionId })` 发现 `dst-gateway` 组的 model；
  4. `api.sessions.selectModel({ sessionId, provider, model })` 完成路由；
  5. `sessions.open(sessionId)` 导航过去。
- **主题**：用 DSH 官方 `--dsw-alias-*` token，自动跟随明暗切换，不硬编码颜色。

## 已知限制

- 只接管**侧边栏**的「新会话」按钮；工作区浏览器的「新会话」入口、以及新会话
  空态屏里的入口不受影响（仍走默认后端）。
- 选择是「一次性」的：每次点「新会话」都会重新弹出下拉；不会把选择记住到下次。
- Claude Code 路由依赖 `dst-gateway` provider 在 settings 里已配置且网关可达。
  如果网关不可达，会话仍会创建，但首次对话会失败（与直接手动选该 provider 一致）。

## 开发

```bash
node test/smoke.mjs   # 冒烟测试（若有）
```

改 client 半边后刷新 Web GUI 即可看到效果（DOM 钩子 + MutationObserver 自愈）。

## License

MIT
