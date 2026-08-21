# dsh-plugins

我（xujiping）的 DeepSeek Harness（DSH）自研插件全家桶。每个子目录 `packages/<name>`
是一个独立可安装的 DSH 插件（monorepo），均可通过 `dsh plugin add` 安装。

## 收录的插件

| 包 | 功能 | 安装 |
|---|---|---|
| `packages/dsh-memory` | 全局记忆：侧边栏「全局记忆」页，直接查看/编辑 `~/.dsh/AGENTS.md` 与 `~/.dsh/memory/*.md` | `dsh plugin --profile <name> add dsh-global-memory` |

> **已搁置（2026-08-21 起从 desktop profile 卸载）**：`dsh-llm-agent-bridge` 与
> `dsh-agent-terminal` 两个插件对效果不满意，暂时不用，源码保留在
> `packages/` 下；以后有更好的想法时可能重新优化再装回。装回方式见下文
> 「安装方式」与包内 README。

```
packages/
  dsh-memory/              全局记忆插件（host 半边 lib/index.js + client 半边 lib/client.js）
  dsh-llm-agent-bridge/    LLM 适配器桥接（已搁置；host 半边，无 client；接入外部 agent CLI）
  dsh-agent-terminal/      智能体终端（已搁置；host 半边 PTY 注册表 + client 半边 xterm 面板；src/client.ts 构建产物为 lib/client.js）
```

## 安装方式（以 dsh-memory 为例）

```bash
# 从 npm（发布后可用）
dsh plugin --profile web add dsh-global-memory

# 或从本仓库
dsh plugin --profile web add github:xujiping/dsh-plugins

# 或本地 link 调试（不发布也能用）
dsh plugin --profile web add link:~/AiProjects/dsh-plugins/packages/dsh-memory
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

每个包自带测试（如 `packages/dsh-memory/test/smoke.mjs`，`node test/smoke.mjs` 运行）。
改 client 半边后刷新 Web GUI 即可看到效果（纯 DOM，MutationObserver 自愈）。

## License

MIT
