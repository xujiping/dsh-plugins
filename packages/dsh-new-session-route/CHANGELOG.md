# Changelog

## 0.1.2 — 2026-09-02

- Claude Code 路由改走 `dsh-llm-agent-bridge`（provider `claude-code`，拉起本机
  `claude` CLI，模型由 ccswitch 配置），不再指向 `dst-gateway`（该网关只提供
  `deepseek-v4-flash`，切过去模型不变，等于没切）。

## 0.1.1 — 2026-09-02

- 修复深色主题不适配：菜单背景原来用的 `--dsw-alias-surface-floating` token 不存在
  （回落到浅色兜底），改用官方菜单 token `--dsw-specific-menu`（→ `bg-layer-3`），
  随 `body[data-ds-dark-theme]` 自动切换明暗。

## 0.1.0 — 2026-09-02

- 初版：侧边栏「新会话」按钮路由下拉。
  - 默认 DeepSeek Harness：保留原 `startSession()` 行为。
  - Claude Code：同工作区开空白会话 + `selectModel` 到 `dst-gateway` provider。
  - DOM capture 拦截 + MutationObserver 自愈，不侵入 React，不改 DSH 源码。
