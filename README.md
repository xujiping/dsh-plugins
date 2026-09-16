# dsh-plugins

我（xujiping）的 DeepSeek Harness（DSH）自研插件全家桶。每个子目录 `packages/<name>`
是一个独立可安装的 DSH 插件（monorepo），均可通过 `dsh plugin add` 安装。

## 收录的插件

| 包 | 功能 | 安装 |
|---|---|---|
| `packages/dsh-agent-driver` | 原生智能体会话驱动（Claude Code + Hermes 双驱动）：新会话菜单选后端，同 UUID 绑定 DSH 与 CLI 会话，含严格 Remote、原子发布、只读工具与 MCP 隔离 | `dsh plugin --profile <name> add link:~/AiProjects/dsh-plugins/packages/dsh-agent-driver` |
| `packages/dsh-chat-scroll-nav` | 对话右侧快速导航条：聊天区右缘竖向迷你导航（类似手机通讯录索引），点/拖即跳转到对应消息，当前消息高亮 | `dsh plugin --profile <name> add dsh-chat-scroll-nav` |
| `packages/dsh-desktop-pet` | 桌面宠物：Web GUI 里一只纯 CSS 小宠，状态机驱动 idle/walk/sleep/happy/eat/typing/work，点击/拖拽/双击喂食，联动会话状态（AI 输出中打字、工具执行中敲锤） | `dsh plugin --profile <name> add link:~/AiProjects/dsh-plugins/packages/dsh-desktop-pet` |
| `packages/dsh-session-archive` | 一键归档空闲会话：侧边栏 workspace 目录行悬停出按钮，按天数（默认 3 天）归档不活动会话，可恢复 | `dsh plugin --profile <name> add link:~/AiProjects/dsh-plugins/packages/dsh-session-archive` |

```
packages/
  dsh-agent-driver/    原生智能体会话驱动（Host+Client 半边；Claude Code / Hermes 双驱动 + 新会话菜单）
  dsh-chat-scroll-nav/ 对话右侧快速导航条（纯 client 半边 lib/client.js；host 半边空实现）
  dsh-desktop-pet/     桌面宠物（纯 client 半边；CSS 关键帧动作 + 状态机 + 节律/交互/会话三类触发器）
  dsh-session-archive/ 一键归档空闲会话（纯 client 半边；workspace 目录行按钮 + archiveSession RPC）
```

> 曾有的 `dsh-new-session-route`、`dsh-llm-agent-bridge`、`dsh-agent-terminal` 三个
> 插件（及 `dsh-global-memory`）已删除：前三个的功能均被 `dsh-agent-driver` 取代
> （新会话下拉选后端已由 agent-driver 内置），`dsh-global-memory` 本地未安装。
> 历史版本可从 git 历史恢复。

## 安装方式（以 dsh-agent-driver 为例）

```bash
# 从本仓库
dsh plugin --profile web add link:~/AiProjects/dsh-plugins/packages/dsh-agent-driver
```

`--profile` 必填（`dsh plugin` 转发到 pnpm 按 profile 安装），`web` 换成你的实际
profile 名。装完重启 `dsh web`（或重载 profile）生效。

> 注意：GUI（Desktop）实际用的是 `desktop` profile。若 GUI 的 pnpm store 版本与
> `dsh plugin` 内置 pnpm 不一致导致 `ERR_PNPM_UNEXPECTED_STORE`，可手动接线
> （零依赖插件等价于 `link:`）：在 `~/.dsh/profiles/desktop/package.json` 的
> `dependencies` 加 `"<pkg>": "link:~/AiProjects/dsh-plugins/packages/<pkg>"`、
> `dsh.profile.bundles` 数组追加包名，并在 `node_modules` 下建软链。

## 插件包约定

- `package.json`：`main` 指向 host 半边（ESM，导出 `name` / `inject` / `apply`）；
  `exports["./client"]` 指向浏览器半边（`window.__ModuleLoader__.load` 包裹的经典脚本，
  factory 返回 `{ apply, inject }`）；`dsh.bundle.patch` 指向 `cordis.patch.yml`；
  `dsh.client` 声明 `{ inject: [], platform: "web" }`。
- Host 半边：`inject: ['webServer']`，用 `ctx.webServer.register({ kind: 'exact', path, handler })`
  注册路由；所有路由必须做回环信任围栏；`ctx.effect(() => disposer, 'label')` 管理清理。
- Client 半边：纯 DOM 注入（侧边栏行 + 中心面板），自带 `<style data-plugin>`，
  MutationObserver 自愈；挂载失败只 `console.warn`，绝不让 GUI 启动失败。
- 主题：配色一律用 DSH 官方 `--dsw-alias-*` / `--dsw-specific-*` token，
  自动跟随 `body[data-ds-dark-theme]` 明暗切换，不用硬编码颜色。
- UI 只用纯色，不用渐变。

## 开发

每个包自带测试（如 `packages/dsh-agent-driver/test/smoke.mjs`，`node test/smoke.mjs` 运行；
agent-driver 与 session-archive 在 package.json 里声明了 `npm test` 脚本）。
改 client 半边后刷新 Web GUI 即可看到效果（纯 DOM，MutationObserver 自愈）。

## License

MIT
