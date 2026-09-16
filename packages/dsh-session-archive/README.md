# dsh-session-archive

DSH 一键归档空闲会话：侧边栏每个项目（workspace）目录行悬停出现「归档」按钮，
一键归档该项目下**超过 N 天未活动**的所有会话（默认 3 天，确认框里可改并记住）。

## 效果

- **悬停按钮**：侧边栏项目目录行悬停时，标题右侧出现归档图标按钮（与内置的
  重命名 / 新建会话按钮同区，互不干扰）。
- **二次确认**：点击弹出确认框，显示「将归档 N 个空闲会话（最后活动超过 N 天）」，
  并列出前几个会话标题；阈值可实时调整，改动即刷新数量。
- **可恢复**：走 DSH 原生 `workspace/archiveSession` RPC 归档，会话保留在项目的
  记账位中，随时可从 DSH 自身的归档面恢复——**不是删除**。
- **安全筛选**：已归档会话、子代理（subagent）会话、以及没有活动时间记录的会话
  一律跳过，绝不误归档。
- 随明暗主题自动适配（全部使用 DSH 官方 `--dsw-*` token，无硬编码颜色）。

## 安装

```bash
# 本地 link 调试（不发布也能用）
dsh plugin --profile desktop add link:~/AiProjects/dsh-plugins/packages/dsh-session-archive

# 或从本仓库（发布后可用）
dsh plugin --profile desktop add github:xujiping/dsh-plugins
```

`--profile` 必填，换成实际 profile 名（桌面 GUI 用的是 `desktop`）。装完重启
`dsh web`（或重载 profile）生效。

> 手动接线（等价于 `link:`）：在 `~/.dsh/profiles/<profile>/package.json` 的
> `dependencies` 加 `"dsh-session-archive": "link:~/AiProjects/dsh-plugins/packages/dsh-session-archive"`、
> 在 profile 的 `cordis.patch.yml` 加
> `- insert:\n    - id: session-archive\n      name: 'dsh-session-archive'`，
> 并在 `node_modules` 下建软链。

## 原理

- 纯 **client 半边**（`lib/client.js`）DOM 注入，`inject: ['workspaces', 'sessions']`、
  `platform: "web"`；host 半边（`lib/index.js`）是空实现（仅用于让 cordis 注册
  插件以带动 client 加载）。
- **空闲判定**：`Date.now() - session.updatedAt > idleDays * 86400000`。
  `updatedAt` 是会话最后一条事件的时间戳（client 侧 `sessions.list` 直接提供，
  host 侧 header 只有 `createdAt`，故本功能放 client 实现最干净）。
- **会话归属**：DSH 的会话归属权威在 workspace 侧——
  `workspace.sessionIds.includes(sessionId)`（client 会话摘要没有 workspaceId 字段）。
- **DOM 钩子**：workspace 行由 React 渲染且类名为 CSS modules 哈希（不稳定），
  因此按结构定位：`[role="treeitem"]` 行内第 3 个子元素（`projectText > title`）
  即标题文本，与 `workspaces.list` 的 `title` 匹配后注入按钮。
- **确认框 / 提示 toast** 挂在 `document.body`（React 树外），MutationObserver 自愈；
  挂载失败只 `console.warn`，绝不影响 GUI 启动。
- 阈值持久化到 `localStorage['dsh.sessionArchive.idleDays']`（默认 3 天）。

## 开发

```bash
cd packages/dsh-session-archive
npm test          # node test/smoke.mjs：按钮注入 / 空闲判定 / 确认归档 / 阈值持久化 / 卸载清理
```

改 `lib/client.js` 后刷新 Web GUI 即可看到效果（纯 DOM，MutationObserver 自愈）。

## License

MIT
