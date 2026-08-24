# dsh-chat-scroll-nav

DSH 对话右侧快速导航条：在聊天区右缘渲染一条竖向迷你导航（类似手机通讯录
快速索引），解决「对话很长时忘了在处理什么、要手动滚动找位置」的问题。

## 效果

- **右侧导航条**：对话消息区右缘一条竖向细轨，每个「用户 / AI」消息一个
  可点击圆点（用户消息为品牌蓝、AI 消息为中性灰），圆点位置与该消息在
  滚动内容中的比例一致。
- **点击跳转**：点某个圆点，对话滚动定位到对应消息。
- **拖动快滚**：在轨道上按住拖动，按比例快速滚动整段对话（类滚动条）。
- **当前位置高亮**：视口正在读的消息对应的圆点放大并高亮（品牌色）。
- **悬浮摘要**：鼠标悬停圆点，显示该消息的角色与首行文字。
- **总数徽标**：悬浮时底部显示消息总数。
- 随明暗主题自动适配（全部使用 DSH 官方 `--dsw-*` token，无硬编码颜色）。

## 安装

```bash
# 从 npm（发布后可用）
dsh plugin --profile web add dsh-chat-scroll-nav

# 或从本仓库
dsh plugin --profile web add github:xujiping/dsh-plugins

# 或本地 link 调试（不发布也能用）
dsh plugin --profile web add link:~/AiProjects/dsh-plugins/packages/dsh-chat-scroll-nav
```

`--profile` 必填，换成实际 profile 名（桌面 GUI 用的是 `desktop`）。装完重启
`dsh web`（或重载 profile）生效。

> 手动接线（等价于 `link:`）：在 `~/.dsh/profiles/<profile>/package.json` 的
> `dependencies` 加 `"dsh-chat-scroll-nav": "link:~/AiProjects/dsh-plugins/packages/dsh-chat-scroll-nav"`、
> 在 profile 的 `cordis.patch.yml` 加
> `- insert:\n    - id: chat-scroll-nav\n      name: 'dsh-chat-scroll-nav'`，
> 并在 `node_modules` 下建软链。

## 原理

- 纯 **client 半边**（`lib/client.js`）DOM 注入，`inject: []`、`platform: "web"`；
  host 半边（`lib/index.js`）是空实现（仅用于让 cordis 注册插件以带动 client 加载）。
- 依赖 DSH 官方稳定 DOM 钩子（来自 `@deepseek-ai/dsh-client-ui-conversation`）：
  - `[data-conversation-scroll]` —— 对话滚动容器；
  - `[data-chat-flow]` —— 消息流列表；
  - `[data-chat-anchor-key]` / `[data-chat-flow-kind]` —— 单条消息行及其类型
    （仅对 `user` / `assistant` 渲染导航点）；
  - `[data-composer-seat]` —— 输入框（导航条下缘以此为界，不遮输入区）。
- 导航条以 `position: fixed` 挂在 `document.body`（在 React 树之外），
  滚动 / 缩放 / 消息变更时通过 `scroll` 事件 + `MutationObserver` +
  `ResizeObserver` 重新同步；挂载失败只 `console.warn`，绝不影响 GUI 启动。

## 开发

改 `lib/client.js` 后刷新 Web GUI 即可看到效果（纯 DOM，MutationObserver 自愈）。

## License

MIT
