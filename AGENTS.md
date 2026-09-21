# AGENTS.md — dsh-plugins

本仓库是 xujiping 的 DeepSeek Harness（DSH）自研插件 monorepo，每个 `packages/<name>` 是一个独立可安装的 DSH 插件。AI 协作时遵守以下约定。

## 项目结构

- `packages/<name>/` —— 每个目录一个独立插件包（零依赖优先，各自带 `README.md` / `CHANGELOG.md` / `test/`）。
- `docs/` —— 设计与规划文档（如 Claude Code agent driver 的方案）。
- 无根 `package.json`，不做 workspace 统一构建；每个包自含。

## 插件包结构约定（两半边架构）

- **Host 半边**（`lib/index.js`，ESM）：导出 `name` / `inject` / `apply`。
  - `inject: ['webServer']`，用 `ctx.webServer.register({ kind: 'exact', path, handler })` 注册路由。
  - 所有路由必须做回环信任围栏（loopback trust fence）。
  - 用 `ctx.effect(() => disposer, 'label')` 管理资源清理。
- **Client 半边**（`lib/client.js`，`window.__ModuleLoader__.load` 包裹的经典脚本，factory 返回 `{ apply, inject }`）：
  - 纯 DOM 注入（侧边栏行 + 中心面板），自带 `<style data-plugin>`，MutationObserver 自愈。
  - 挂载失败只 `console.warn`，绝不能让 GUI 启动失败。
  - 纯 client 插件（无 host 逻辑）时 host 半边写空实现。
- `package.json`：`main` 指 host 半边；`exports["./client"]` 指 client 半边；`dsh.bundle.patch` 指 `cordis.patch.yml`；`dsh.client` 声明 `{ inject: [], platform: "web" }`。

## 样式与 UI 规则

- 配色一律用 DSH 官方 `--dsw-alias-*` / `--dsw-specific-*` token，自动跟随 `body[data-ds-dark-theme]` 明暗切换，禁止硬编码颜色。
- UI 只用纯色，不用渐变。

## 开发与验证

- 测试：各包自带（如 `node test/smoke.mjs`），改完必须跑一遍。
- Client 半边改动：刷新 Web GUI 即可见效（纯 DOM + MutationObserver 自愈）。
- 本地调试安装：`dsh plugin --profile <name> add link:~/AiProjects/dsh-plugins/packages/<pkg>`；装完重启 `dsh web` 或重载 profile。
- GUI（Desktop）实际用 `desktop` profile；pnpm store 版本不一致报 `ERR_PNPM_UNEXPECTED_STORE` 时，可手动接线（见 README「安装方式」注释）。

## 当前状态

- 活跃插件（均装于对应 profile）：`dsh-agent-driver`（web，M0 验证中）、`dsh-chat-scroll-nav`（desktop）、`dsh-desktop-pet`（desktop + web）、`dsh-session-archive`（desktop + web）、`dsh-web-sites`（web）、`dsh-own-plugin-manager`（web，自研插件管家：设置对话框「插件管家」分区（`settings.section` slot），卡片式 UI（对齐 dsh-plugin-manager 视觉体系），自有/社区双 Tab，跨 profile 聚合，启停/版本更新监测（link 类走 GitHub 远端：release 标签 → 分支 package.json 回退 + 本地漂移双信号，repo 从 git remote 推导），改动生效需重启 `dsh web`）。
- 已删除（2026-09-16，功能被 agent-driver 取代 / 本地未安装，可从 git 历史恢复）：`dsh-new-session-route`（新会话下拉由 agent-driver 内置）、`dsh-llm-agent-bridge`、`dsh-agent-terminal`（旧外挂 agent CLI 方案）、`dsh-global-memory`（本地未安装，npm 已发布 @0.1.0）。

## 修改文件前置规则（强制）

- 遇到 `FS_NOT_OBSERVED` 错误时，先 Read 再重试，禁止直接重复 Edit。

## 其他

- 代码与标识符用英文，注释/文档用中文。
- 不提交明文密钥；敏感值走环境变量。
