# Claude Code 原生会话驱动执行计划（dsh-agent-driver）

> 目标：在 DSH Web 中创建 Claude Code 会话，并保留 Claude Code 自己的会话、工具执行和续接能力；DSH 负责侧边栏、消息流、事件回放、取消和会话浏览。
>
> 结论：**有条件可行**。DSH 的公开 `Agent`、Session 和 Typert Remote 接口足以实现独立驱动；但必须先通过 M0 验证自定义创建入口与冷恢复接管。M0 未通过前，不承诺“零内核改动”“完整保真”或具体工期。
>
> 已核实环境：DSH `0.1.0-rc.6`（实际 profile 依赖），Claude Code `2.1.237`。
>
> M0 执行状态（2026-09-07）：核心包、严格 Typert Remote、原子 Agent/Session 发布、fake CLI 流转换、真实 Claude JSONL/`--resume` 采样、Web 新会话入口、真实 Remote 创建、Host 重启恢复和真实 UI 流式请求均已完成。当前正常 `web` profile 有一个**驱动无关**的第三方启动故障（`dsh-tool-describe-image` 未注入 `tools`）；隔离测试通过临时 overlay 禁用该条目。修复该 profile 故障并完成一次真实 UI cancel 后，才可给正常 profile 标记为完整 Go。

---

## 1. 范围与非目标

### 1.1 首版承诺

- 在当前 workspace 中创建 Claude Code 原生会话。
- 通过 DSH 的普通会话 UI 发送消息、展示文本、展示通用工具活动、取消运行、刷新后回放历史。
- 首轮使用 `claude --session-id <uuid>`，后续使用 `claude --resume <uuid>`；同一个 UUID 同时是 DSH session ID 和 Claude session ID。
- DSH 的事件日志是 UI 回放真相源；Claude Code 的本地会话是下一轮推理续接真相源。

### 1.2 首版明确不承诺

- 将 Claude 的 `Task`/subagent 自动变成 DSH 子会话或任务树。
- 复刻每一种 DSH 原生工具的专属预览（例如文件 diff）。首版提供通用 Claude 工具活动卡。
- 在没有 Claude Code 官方权限委托接口的情况下，提供 DSH 的事前审批弹窗。
- 自动修复用户在终端直接 `claude --resume` 同一 UUID 后造成的双端历史分叉。

## 2. 可行性判断与前置条件

| 维度 | 结论 | 依据与约束 |
|---|---|---|
| 自定义 Agent | 可行 | DSH 的 `Agent` 是公开接口，`ctx.agents.enter/announce` 允许发布已构造的独立驱动；不能只实现 `followup()`，还须维护 inbox、status、scope、取消和销毁。 |
| Session 生命周期 | 可行，但原设计错误 | Agent 驱动会话必须使用 `sessions.prepare → sessions.enter → sessions.announce`，再配合 `agents.enter → agents.announce`。**禁止** `sessions.create() + agents.register()`，后者不能保证结束事件先于 Session 卸载。 |
| 创建入口 | 待 M0 验证 | Typert Gateway 支持 Host/Client 双端 Remote；新能力须带生成的 descriptor 与 Client `ctx.remote.$mount()`，不是随意增加一个 websocket 方法。 |
| UUID 会话续接 | 可行 | DSH `SessionId` 没有前缀校验；Claude `--session-id` 要求 UUID。因此两侧使用同一个 UUID，无需另存 `ccSessionId` 映射。 |
| 冷恢复 | 待 M0 验证，且是阻塞项 | 标准 `ctx.agents.resume()` 只会调用全局默认 factory，无法按 driver 分派。插件必须在 API resolver 首次打开会话前识别并发布自定义 Agent。 |
| 工具卡与轨迹 | 可行，但需专门翻译/呈现层 | 事件名相同不足以得到原生卡片；需满足完整 payload、surface 元数据和通用 Claude 工具呈现器。 |
| DSH 事前审批 | 当前不可行 | 本机 Claude CLI 没有 `--permission-prompt-tool`。stdout 中看到 `tool_use` 时不能可靠地抢在工具执行前拦截。 |

**Go / No-go：**只有 M0 的创建、重启恢复和事件回放全部通过，才进入功能开发。若冷恢复无法在默认 resolver 前接管，应向 DSH 增加正式 driver registry / 持久 `driver` 字段，或将本方案降级为现有 LLM bridge 的文本型集成；不能静默回落到默认 loop。

## 3. 核心架构

```text
浏览器 Client 插件
  新会话菜单（默认 / Claude Code 原生）
      → ctx.remote.ccNative.createSession(workspaceId)
                         │
                         ▼
Host Typert Remote（生成的双端契约）
  生成 UUID
  创建未发布 Session + ClaudeDriverAgent
  原子 publish + workspace.attachSession
                         │
                         ▼
ClaudeDriverAgent
  followup / steer / inject / cancel / whenIdle
  一次活跃 turn 对应一个 claude -p 子进程
  stdin JSONL  ← 用户消息或中途 steer
  stdout JSONL → DSH 标准 Session 事件
                         │
                         ▼
DSH Session 日志 ── UI / 侧边栏 / 回放
Claude 本地会话 ── --resume <同一 UUID>
```

### 3.1 原子创建与销毁

创建事务须参考内置 `AgentLoop` 的公开生命周期，严格采用以下顺序：

1. `sessions.prepare(uuid, { meta: { cwd } })`；
2. 构造尚未发布的 `ClaudeDriverAgent`，并建立该 agent 的 scope / inbox；
3. `agent.ctx.sessions.enter(session)`；
4. `ctx.agents.enter(agent, owner)`；
5. `agent.ctx.sessions.announce(session)`；
6. `ctx.agents.announce(agent)`，随后发出 `agent/session-start`；
7. 仅在 Session 已持久化可被 workspace 读取后执行 `workspace.attachSession(uuid)`。

销毁时先停止并等待子进程和事件泵结束，再依次 detach Agent、detach Session、释放 agent scope。每个 disposer 由同一 owner effect 管理；任一发布步骤失败须回滚全部已进入的对象。

不替换全局 `AgentFactory`，也不复用 `ctx.agents.register()` 作为本驱动的创建交易。

### 3.2 Driver 身份与冷恢复

Session header 只允许既有字段，不能写 `driver: 'claude-code'`；未知 Session 事件也不能作为必需的插件持久事件。因此插件需要一个自己的、可原子读取的持久索引：

```text
sessionId(UUID) → {
  driver: "claude-code-native",
  driverVersion,
  securityProfile,
  permissionMode,          // plan | acceptEdits | auto
  effectivePermissionMode, // Claude system/init 回报，可能不同于请求模式
  createdAt
}
```

该索引不保存密钥，也不再保存 Claude session ID。启动时：

1. 读取索引和 `sessionPersistence` 元数据；
2. 对已存在且标为 `claude-code-native` 的会话，使用 `sessionPersistence.prepare()` 加载；
3. 按 3.1 的事务发布 `ClaudeDriverAgent`；
4. 仅在这些 Agent 都已发布后，允许 API resolver 接受请求。

若索引丢失、Session 日志损坏，或 Claude 返回的 session ID 与 UUID 不一致，停止自动续接，显示“需要恢复处理”，绝不自动重放最后一条用户消息。这样避免崩溃后重复执行写操作。

### 3.3 Provider 与模型选择

`session.prompt` 会检查当前 provider 是否有已注册 adapter。原生 Driver 使用独立的 `claude-code-native` provider / sentinel adapter 通过此检查，**不得复用**现有 `dsh-llm-agent-bridge` 的 `claude-code` provider：后者会扁平化 DSH 历史并重新运行 CLI，作为冷恢复回退会造成静默分叉。

创建原生 Session 时，Host 立即在**该 Session 自身**写入 `claude-code-native/default` request header；浏览器只打开返回的 session。严禁为此调用通用 `sessions.selectModel()`：该 API 除了切换当前会话，还会持久化 DSH 的全局默认模型。若将 sentinel 写入全局默认值，下一次“默认 DeepSeek Harness”创建的标准 loop 会错误调用 `LlmRuntime.stream()`，而 sentinel 必然拒绝该路径。默认 Harness 入口也不能调用 `workspaces.startSession()`，因为它会复用同工作区任意空会话（包括原生会话）；必须经 `sessions.create({ workspaceId })` 显式创建标准 Session + loop Agent。

自定义 Agent 的 `ctx` 必须由 `createScope(rootCtx, agent)` 创建，不能只执行 `rootCtx.extend({ agent })`。后者会让 `agent/session-start` 安装的模型选择监听器注册到全局 Context；原生 Agent 的 sentinel 路由便会污染后续标准 Harness Agent，即使 UI 仍显示默认模型。

首轮不传 `--model`，让 ccswitch / Claude Code 当前配置决定模型；从 `system/init` 读取实际模型并写入助手消息 source。Session request header 保持 native route 的 sentinel model，以避免将本机 CLI 选择伪装成可由 Harness adapter 直接调用的模型。

## 4. CLI 调用与安全边界

### 4.1 基础调用

首轮：

```text
claude -p --session-id <uuid> \
  --input-format stream-json --output-format stream-json \
  --include-partial-messages --verbose
```

后续轮：将 `--session-id <uuid>` 替换为 `--resume <uuid>`。实际 stdin JSONL 架构、partial 事件和终态字段必须由 M0 真实采样固定；不能只依据帮助文本猜测。

`--include-partial-messages` 是获得增量输出的必要参数，原计划遗漏它。`--forward-subagent-text` 可在后续里程碑开启，但只作为父会话内的关联活动文本，不创建 DSH 子会话。

真实 `2.1.237` 采样已确认 stdin 是以下 JSONL 形状，`--resume <uuid>` 会返回相同 `system/init.session_id`：

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

stdout 的增量不是顶层 `assistant`：它是 `type: "stream_event"` 包裹的 Anthropic `content_block_start` / `content_block_delta` / `content_block_stop`。随后 Claude 可能用同一个 message ID 分多条顶层 `assistant` 输出 thinking 和 text，最后才发带总 usage/cost 的 `result`。翻译器必须保留增量、按 message ID 聚合最终 content，并仅在收到同一 message 的全部 block stop 后 append DSH `assistant/message`。

### 4.2 默认安全策略

M0/M1 不允许 `bypassPermissions` 或 `--dangerously-skip-permissions`。同时：

- 使用 `--tools` 提供经审查的工作区工具集合。默认明确开放 `Bash`、`Read`、`Glob`、`Grep`、`Edit`、`Write`，让原生 Claude Code 能完成常规代码任务；如需只读会话，可通过插件 `tools` 配置显式改为 `Read,Glob,Grep`。不使用 `default`，避免 Claude CLI 升级后静默扩大工具面；
- **`--tools` 不会禁用用户 MCP。**真实采样中即使传入 `--tools Read,Glob,Grep`，仍列出了用户 MCP 工具。首版固定增加 `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`，实测 MCP 列表为空；
- 默认使用 `--safe-mode`，它会关闭 CLAUDE.md、skills、plugins、hooks、MCP、定制命令等自定义项。不能使用 `--bare` 作为默认，因为它可能改变当前 ccswitch/认证读取方式；
- 把 Claude CLI 作为外部进程，不假设 DSH sandbox 会自动约束它；
- 启动独立进程组。取消先发 SIGINT，短暂宽限后升级终止整组，防止 Bash 或 subagent 遗留。

`--allowedTools` / `--disallowedTools` 只能视为 Claude 内部权限策略的一部分，不能替代 OS 级隔离，也不能实现 DSH 事前审批。M4 不再承诺不存在的权限回调；若未来 CLI 提供官方委托通道，再单独设计审批桥接。

### 4.3 Claude Code 原生权限（已实现）

DSH 的 `read-only`、`workspace-write`、`danger-full-access` 只影响 DSH 自身的 sandbox / approval 服务，不能约束外部 `claude -p` 进程。因此原生会话不复用 `/permission`，而是通过 `ccNative.getPermission(sessionId)` / `ccNative.setPermission(sessionId, permissionMode)` 维护自己的模式。首版只公开：

| UI | CLI | 约束 |
|---|---|---|
| 计划 | `plan` | 分析、读取；编辑被阻止。 |
| 自动编辑 | `acceptEdits` | 可编辑工作区；不承诺 Git 提交、推送等 shell 动作。 |
| 自动 | `auto` | Claude 分类器决定是否执行。 |

新会话默认 `plan`。因为非交互 `claude -p --resume` 不会可靠恢复先前的权限模式，sidecar 是请求模式的真相源，Driver 必须在**每一轮**显式传入 `--permission-mode <mode>`。解析 `system/init.permissionMode` 后写回 `effectivePermissionMode`；若 CLI / 模型降级，Client 显示实际生效值而非伪造已生效。

`manual` 当前不能暴露为“DSH 可审批”：本机 CLI 没有 `--permission-prompt-tool`，headless 运行会直接拒绝需审批操作。`dontAsk` 需要另行设计可审核的 `--allowedTools` 白名单，`bypassPermissions` 及所有跳过权限的 flag 永久拒绝。模式仅可在 Agent idle 时变更，避免同一个子进程运行中产生前后不一致的权限。

DSH `0.1.0-rc.6` 没有 provider 专属 access-mode 插槽。Client 使用官方 `conversation.input.left` 注册 Claude 控件，并仅对当前原生会话隐藏 DSH 原 access 控件；该兼容层依赖其“访问模式 / Access mode”无障碍标签，DSH 升级时必须做 UI 回归。长期正确修复是上游增加 `conversation.input.access` 的 single slot 或 provider access-selector registry，再删除这段兼容 CSS。

## 5. 事件翻译契约

必须只写 DSH 已知事件类型，并遵守 surface 校验。最小一轮的顺序为：

```text
turn/start
user/message                  （surface append）
request/header                （provider / 实际模型 / 工具声明；不写 usage 或 cost）
step/start
assistant/chunk*              （保留原始 stream chunk 的可回放增量）
assistant/message             （surface append，引用 chunk seq；usage 在这里）
tool/call*                    （arguments 必须为 JSON 字符串）
tool/result*                  （surface append，携带 ToolResultMessage 并与 callId 配对）
step/end
turn/end
```

实现要点：

- `followup()` 收到的用户消息必须先 append 为 `user/message`，不能只转发给 CLI；
- Claude 的 `tool_use` 需要转换为 DSH `tool-call` 结构，Claude `tool_use_id` 用作 DSH `callId`；
- `tool/result` 必须带正确的 surface intent 与 source event seq；
- 终态 usage 放在 `assistant/message`，成本没有对应的标准 Session 字段，首版只在外部诊断/状态中展示；
- `system/init` 的 session ID 已由共用 UUID 表示；工具清单只作为运行时信息，不能伪造未知持久事件；
- 通用 Claude 工具呈现器负责 Bash、Read、Edit 等活动。专属 DSH diff 卡需要各工具单独适配，不能由事件名自动获得。

## 6. 里程碑与验收

### M0 — 架构闸门（2–4 天）

1. 新包能生成并装载 Host/Client Typert Remote；浏览器可调用 `ccNative.createSession()`。
2. 用同一个 UUID 原子创建 Agent + Session 并附着 workspace；标准 `session.prompt` 命中 live `ClaudeDriverAgent`，不创建默认 loop。
3. 使用 fake CLI 覆盖文本、thinking、tool use、tool result、错误和取消；生成的日志能被 DSH 重放。
4. 实际 Claude CLI 采集一次无副作用流式会话，确认 stdin/out JSONL、partial、resume、interrupt 的真实字段。
5. 重启 Host：索引识别会话、在默认 resolver 前恢复自定义 Agent、`--resume <uuid>` 可继续。

**Go 条件：**五项全通过。任一失败，停止功能扩展，先解决 DSH driver registry / Remote 装配 / 启动顺序问题。

#### M0 已完成证据

- 新包 [`packages/dsh-agent-driver`](/Users/xujiping/AiProjects/dsh-plugins/packages/dsh-agent-driver/package.json) 提供 `ccNative.createSession(workspaceId)` 的 Host / Client 严格 descriptor；冒烟测试通过真实 `TypertGatewayService.invoke()` 调用，而非仅检查对象形状。
- 创建路径使用 `sessions.prepare → agent.ctx.sessions.enter → agents.enter → sessions.announce → agents.announce`；测试以真实 `SessionStore` 与 `AgentRegistry` 验证了该路径，未调用 `sessions.create()` 或 `agents.register()`。
- fake CLI 覆盖 nested partial stream、同一 Claude message 的拆分 `assistant`、tool use/result、result usage 和 driver sidecar；所有事件可由真实 Session Store 接受。
- 真实 Claude CLI 已完成 `--session-id` 首轮与 `--resume` 续接采样，确认同 UUID、输入 JSONL 和实际 stdout 外层事件形状。
- 发现并修复 MCP 白名单漏洞：仅 `--tools` 时仍加载用户 MCP；添加严格空 MCP 配置后实测 MCP 列表为空。
- `dsh plugin --profile web add link:.../dsh-agent-driver` 已安装本包；隔离 Web Host 实际加载 Client，`ctx.remote.$mount()` 成功，并显示“Claude Code（原生会话）”新会话菜单。
- 真实 `ccNative/createSession` 已创建并打开一个空会话；sidecar 只写入同 UUID、driver/version/securityProfile/时间戳。没有发送 Claude prompt。
- 用同一 profile 进程重启后，DSH 通过真实 `sessionPersistence.prepare()` 恢复该会话；UI 显示 `Claude Code（由本机配置决定）`，证实恢复的 Agent 已取代默认 loop。
- 恢复后的真实 UI 已发送“只回复 PONG，不要调用工具。”健康请求，返回 `PONG`，并显示一轮一步、耗时和 token 统计；验证覆盖 UI → Agent → Claude `stream-json` → DSH 回放，未调用任何工具。
- Host Typert descriptor 必须使用 zod v4；Client 模块表不提供 zod。因此 Host `./typert` 使用 DSH 的 zod，而浏览器 Client 使用等价的无依赖 `parse()` 严格 codec。两端仍共享同一 endpoint、wire 名与 type symbol。
- 已修复默认模型串路：原生创建不再调用会改写全局默认值的 `sessions.selectModel()`；Host 改为在 native Session 上预置 request header。默认 Harness 入口改用 `sessions.create()`，不再复用原生空会话；自定义 Agent 使用真正的 `createScope()`，其模型监听不会泄漏到标准 Agent。冒烟测试断言 header、入口调用与跨 Agent 事件隔离；这样“默认 DeepSeek Harness”不会再进入 native sentinel 的 `LlmRuntime.stream()` 拒绝分支。
- 隔离 Web Host 已做回归实测：先恢复一个 `Claude Code（原生会话）`，再从同一个“新会话”菜单创建默认 Harness 会话；新会话显示 `GLM 5.3 Flash`，发送“只回复 PONG，不要调用工具。”后在约 3 秒返回 `PONG`。持久事件的 request header 不再是 `claude-code-native`。

#### M0 仍未完成（阻塞 Go/No-go）

1. 正常 `web` profile 无覆盖层完成启动。当前阻塞点是 `web-ui-describe-image`：`@linxin666/dsh-tool-describe-image` 在启动时读取了未注入的 `tools` 服务；隔离验证使用临时 overlay 禁用该**无关**条目，未修改用户 profile。
2. 使用正常 profile 的实际桌面/Web 服务完成一次运行中取消，确认 SIGINT 宽限后整进程组终止且没有孤儿进程。真实 CLI 的 JSONL/`--resume` 已单独采样，fake CLI 已覆盖事件翻译和进程组取消，隔离 Web Host 已完成 UI 到 CLI 的正常完成链路。

### M1 — 安全可聊 MVP（4–6 天）

- 串行 turn 队列、完整用户/助手事件、文本和 reasoning 流、明确错误卡；
- 受限工作区工具策略与进程组取消；
- 通用 Claude 工具活动卡；
- 单元测试：JSONL → DSH 事件的表驱动测试，含 surface / callId / event order；
- 集成测试：fake CLI 与真实 session persistence。

**验收：**新建 Claude 会话能在刷新和 Host 重启后继续；用户取消不遗留子进程；默认 DeepSeek 会话无回归。

### M2 — 恢复、分叉与保真（4–6 天）

- 持久索引的版本迁移、损坏检测、未完成 turn 标记；
- 模型与配置变更记录；
- 中途 steer 的真实协议支持；`inject` 若无法保持 Claude 语义则明确不支持；
- 处理外部恢复造成的会话分叉：检测并阻断自动续接，而不是重建未知尾部。

### M3 — 体验增强（3–5 天）

- `--forward-subagent-text` 的父工具关联展示；
- Claude 任务工具到 DSH todo 的可选映射，先以实际 CLI 工具名为准，不假设仍叫 `TodoWrite`；
- 常见 Bash / Read / Edit 的专用展示增强；
- README、安装说明、兼容性矩阵与回归测试。

在 M0 通过后，完整到 M3 的合理预期是约 3–4 周，而不是原先 1.5–2 周。若不做冷恢复或通用工具卡，可将 M1 独立交付为受限 PoC。

## 7. 测试与发布门禁

- 单元：JSONL 解析、事件顺序、surface metadata、callId 配对、错误与取消、UUID 映射。
- 集成：fake CLI；真实 Claude CLI 的手工无副作用样本；重启恢复；CLI 缺失、登录失效、非零退出、超时和孤儿进程。
- 回归：`packages/dsh-new-session-route/test/smoke.mjs` 与 `packages/dsh-llm-agent-bridge/test/{smoke,integration}.mjs` 保持通过；当前两个包没有 npm `test` 脚本，新包必须提供标准测试脚本。
- 发布前人工验证：一轮 `Bash` 代码任务、一次取消、一次刷新、一次 Host 重启，以及一次权限拒绝/危险命令的策略验证。

## 8. 最终决策

推荐推进 M1，但采用以下默认决策：

1. 不启用 bypass permissions；工具面显式限定为受控的工作区开发工具集。
2. 同一 UUID 绑定 DSH 与 Claude 会话，禁止用户同时从终端恢复该 UUID；检测到分叉即停止自动续接。
3. subagent 首版仅展示为父会话活动，不创建 DSH 子会话。
4. 不以“默认 loop 冷恢复”为降级方案；无法恢复时宁可明确报错并保留只读历史。
5. M0 完整 Go 前不承诺无需 DSH 扩展；清除正常 profile 启动阻塞并验证取消后再冻结实现范围与工期。
