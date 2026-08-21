# Changelog

## 0.1.2 — 2026-08-21

- **修复** 输出样式乱：`claude-code` 协议之前把工具活动（`⚙ Bash {完整 JSON 命令}`、`↳ 整段工具输出`）
  当文本块灌进消息流，与 DSH 渲染不搭。现在**默认隐藏工具活动**，只看最终回答（markdown 正常渲染）；
  新增 `showTools` 配置（默认 `false`），开启时显示精简单行摘要（换行折叠 + 截断），不再原始转储。
- 测试：新增「默认隐藏工具」「showTools 精简摘要」两个冒烟用例；真实 claude 端到端确认输出干净。

## 0.1.1 — 2026-08-21

- **修复** GUI 里报 `spawn claude ENOENT`：DSH Desktop 宿主进程 PATH 很窄。
  - 子进程环境自动补 `/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin` 到 PATH；
  - `command` 非绝对路径时按「父 PATH → 常见目录」解析成绝对路径再 spawn；
  - 监听 spawn 的异步 `error` 事件（ENOENT 不会同步 throw），转成优雅的
    `finish { kind: 'error', code: 'SPAWN_FAILED' }`，不再以 Uncaught Exception 崩溃宿主；
  - 新增缺失命令冒烟测试；真实 claude / hermes 在窄 PATH（`/usr/bin:/bin`）下端到端验证通过。

## 0.1.0 — 2026-08-21

- 首个可用版本。LLM 适配器桥接插件：把对话框模型路由接到本机外部 agent CLI。
- 内置 `claude-code`（stream-json JSONL 协议）与 `hermes`（plain one-shot）两个默认路由。
- 支持自定义 agent：`protocol`（claude-code / plain）、`command`、`args`、`promptVia`
  （stdin / arg）、`cwd`、`idleTimeoutMs` 等。
- 流式映射到 DSH StreamChunk 协议（text / reasoning / usage / finish），外部 agent 的
  tool 活动以文本块展示，每轮以 `finish { kind: 'stop' }` 结束。
- 测试：`test/smoke.mjs`（fake CLI 全链路）、`test/integration.mjs`（真实 cordis +
  dsh-llm 运行时 + BlockAssembler 组装）、真实 `claude` CLI 端到端验证通过。
