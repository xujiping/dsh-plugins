# Changelog

## 未发布

- 修复：Hermes `/model` 不再使用 ACP 当前提供商的精选子集，改为调用终端同源 inventory，展示完整提供商分组、模型数量及当前状态；支持进入分组、返回、取消和跨提供商选择。真实本机目录已核对为 9 组、57 个模型，与终端截图一致。包含 Host 修改，需重启 DSH 并刷新 GUI。

- 新增：原生 `/model` 使用官方模型选择面板，展示 CLI 实时模型目录；支持菜单、回车和空参数提交，选择按会话持久化并应用到后续 Claude / Hermes 消息。新增严格 Remote 模型查询/选择契约及官方弹窗控制器回归测试。包含 Host 变更，需重启 DSH 并刷新 GUI。

- 修复：原生会话执行斜杠命令时报 `cannot get property "remote.commands" without inject`，命令 UI 适配作用域显式注入 Remote 命令服务，并补充作用域依赖回归验证。

- 新增：按当前会话 agent 展示、执行原生斜杠命令。Claude 使用 stream-json 初始化控制响应，Hermes 使用 ACP 命令通知动态发现；目录按会话隔离，支持参数、别名和带冒号的插件命令，复用 DSH 菜单及串行 turn 通道。原生会话隔离 Harness 同名处理器和客户端弹窗；补充命令发现、Remote 分发、跨会话隔离与卸载回归测试。修复 Hermes 斜杠参数被追加格式指令的问题。Host 增加 `commands` 依赖，更新后需重启 profile。

- 修复：Hermes 回复的树状结构/目录列表渲染成一整行——原因是模型常不加 Markdown 围栏，而聊天界面按 Markdown 渲染会把普通文本的换行折叠成段落（存储原文换行完好，任何 DSH 会话对同样文本行为一致）。处理：给发送给 CLI 的提示词附加不可见的格式指令（不进 DSH 事件流），要求树/目录/多行内容一律用围栏包裹。
- 重构：Hermes 驱动切换到 ACP 模式（`hermes acp`，JSON-RPC over stdio，编辑器集成同款通道），实现真正的流式输出：`agent_thought_chunk` / `agent_message_chunk` / `tool_call` 实时转发为 DSH 事件（此前 `chat -q -Q` 只能整轮结束一次性返回）；turn 结束附 usage。每 turn 独立 spawn，`session/new` / `session/load`（历史 replay 丢弃）串联会话，`acpSessionId` 持久化（driverVersion 2；v1 静默模式旧会话无法续接）。`session/request_permission` 按权限档位自动应答（default→deny，yolo→allow_once）；模型取自 `models.currentModelId`（替代 `hermes status` 探测）。为此 driver-core：`translate` 收到本轮 message、`promptInput` 返回 null 时 stdin 生命周期交给 translate、profile 可声明 `tolerateUncleanExit`（turn 成功后主动终止进程组）。已用真实 hermes 验证流式、两轮续接与进程清理。
- 新增：原生会话显示 CLI 实际使用的模型（只读 chip，权限控件左侧；官方模型切换器在原生会话中隐藏）。Claude Code 取 `system/init` 的 `model`；Hermes 建会话后异步跑 `hermes status` 解析 `Model:` 行（超时 15s，不阻塞创建）。模型名持久化到 sidecar 并随 `getPermission` 返回（可选字段 `model`）；为此 `CliDriverAgent` 通用注入网关引用并新增 `observeModel`。
- 新增：接入本地 Hermes CLI（`lib/hermes.js`，`HERMES_PROFILE`）。每轮 spawn `hermes chat -q <query> -Q --source tool`，从 stderr 捕获 `session_id:` 持久化到独立 sidecar（`~/.dsh/hermes-agent-driver/sessions.json`），后续轮次 `--resume`；权限档位为 安全（默认 fail-closed）/自动（`--yolo`）。新会话菜单新增「Hermes（原生会话）」，权限控件按会话归属驱动自动切换档位；标题前缀 `Hermes · `。为支持该接入，driver-core 新增三个通用钩子：`commandArgs(agent, firstTurn, message)` 传入本轮消息、`promptInput` 覆盖 stdin 投递（argv 传参）、`createDriverApply` 接受 profile 数组，且网关可用 `createAgentFor` 注入自身引用。已用真实 hermes CLI 验证两轮续接。
- 重构：抽出多智能体抽象层 `lib/driver-core.js`（`CliDriverAgent` / `CliDriverGateway` / `CliDriverIndex` / `SentinelAdapter` / `createDriverApply`，均由 `profile` 描述对象参数化）；`lib/index.js` 变为 Claude Code profile（`CLAUDE_PROFILE`）+ 兼容出口（`ClaudeCodeAgent` / `ClaudeCodeDriverGateway` / `DriverIndex` / `NativeSentinelAdapter` / `consumeClaudeJsonl` / `terminateProcessGroup` 导出不变），smoke 测试无需改动全部通过。接入新 CLI 智能体只需另写一份 profile。
- 更名：`dsh-cc-agent-driver` → `dsh-agent-driver`（目录、npm 包名、插件 id、Typert typeSymbol、Remote 命名空间 `ccNative` → `nativeAgent`），为后续接入 Hermes、OpenClaw 等智能体铺路。默认索引路径迁移到 `~/.dsh/agent-driver/sessions.json`，启动时自动从旧路径迁移存量会话（旧文件保留不删）。
- 原生会话输入框新增 Claude Code 权限：计划（`plan`）、自动编辑（`acceptEdits`）和自动（`auto`）。模式持久化在 driver sidecar，并在每轮 `claude -p` / `--resume` 显式传入；`system/init.permissionMode` 会回写实际生效模式。
- 新增严格 Typert Remote：`ccNative.getPermission(sessionId)`、`ccNative.setPermission(sessionId, permissionMode)`；运行中的 turn 拒绝切换，`bypassPermissions` 永不接受。
- 会话列表展示 Agent 名称：原生会话的自动标题（first-prompt fallback）落地后，Host 侧自动补写固定标题 `Claude Code · <主题>`（source=user pin，后续自动标题不再覆盖）；用户手动命名的标题保持原文。冷恢复发布时对未加前缀的存量标题做一次回填。

## 0.1.0

- M0：原生 Claude Code 会话驱动架构验证、Web 新会话入口、真实 Remote 创建和 Host 重启恢复。
- Host `./typert` 使用 zod v4 严格 schema；浏览器 Client 使用无外部依赖的严格 parse codec，以适配 DSH client module table。
