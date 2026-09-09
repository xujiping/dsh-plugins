# dsh-agent-driver

DSH 的原生智能体会话驱动（原 `dsh-cc-agent-driver`，为后续接入 Hermes、OpenClaw 等智能体改为通用命名）。当前驱动 Claude Code 与本地 Hermes 两个 CLI：每个会话使用同一个 UUID 作为 DSH Session ID 和 CLI 会话 ID（Claude Code 用 `--session-id` / `--resume`；Hermes 自生成会话 id，首轮捕获后持久化到 sidecar）。DSH 保存可回放事件，CLI 保存下一轮推理所需的本地会话。默认索引路径随改名迁移到 `~/.dsh/agent-driver/sessions.json`，启动时自动从旧路径 `~/.dsh/cc-agent-driver/sessions.json` 迁移存量会话（旧文件保留）。

## 多智能体架构

代码分为两层：

- `lib/driver-core.js` —— 通用 CLI 驱动核心：Agent 生命周期（串行 turn、进程组取消）、会话原子发布/冷恢复、driver sidecar 索引、权限状态持久化、标题前缀、哨兵 LLM adapter。全部通过 `profile` 描述对象参数化。
- `lib/index.js` —— Claude Code profile（`CLAUDE_PROFILE`）+ 兼容出口 + 双驱动 `apply`。
- `lib/hermes.js` —— Hermes profile（`HERMES_PROFILE`）：基于 `hermes chat -q <query> -Q --source tool` 的每轮独立进程 + `--resume` 串联；`session_id:` 标记从 stderr 捕获，stdout 整段作为最终回复。

接入新智能体（如 Codex、OpenClaw）：新建入口文件定义自己的 profile（约百行），用 `createDriverApply(profiles)` 组装 `apply` 即可（支持数组一次注册多个），通用机制零复制。`consumeClaudeJsonl` 的 provider/model 取自 `agent.options`，兼容 Anthropic stream-json 格式的 CLI 可直接复用；提示词不走 stdin 的 CLI 用 `promptInput` 钩子改为 argv 传递。

当前实现完成了 M0 的驱动主链路：严格 Typert Remote descriptor、自定义 Agent/Session 原子发布、Web 新会话菜单、fake `stream-json` CLI 事件转换、整组子进程取消，以及不含密钥的 driver sidecar 索引。首轮/续接 JSONL 已按真实 Claude Code 采样；真实 DSH Web Host 已验证创建、重启恢复和一条无工具流式请求。

## 安装

```bash
dsh plugin --profile web add link:~/AiProjects/dsh-plugins/packages/dsh-agent-driver
```

重启目标 DSH profile。侧边栏“新会话”会出现“Claude Code（原生会话）”；默认启用 Claude `--safe-mode`，并开放受限的工作区工具集：`Bash`、`Read`、`Glob`、`Grep`、`Edit`、`Write`。它足以完成常规代码任务；严格空 MCP 配置仍会隔离所有用户/项目 MCP，且绝不启用 `bypassPermissions`。

“默认 DeepSeek Harness”会显式创建标准 Harness 会话，而不会复用空的原生会话；原生路由也只记录在自己的 Session 中，不会修改你的全局默认模型。

工作区项目行右侧的“+”默认也会显式创建该工作区的标准 DSH 会话，不会复用空白原生会话。

工作区会话列表通过会话标题展示驱动 Agent：原生会话的自动标题生成后会被固定为 `Claude Code · <主题>`（以 user 来源 pin，后续自动标题不会覆盖）；你手动重命名的标题保持原文，不会被加前缀。冷重启恢复时，未加前缀的存量原生会话标题会自动回填前缀。

如果 profile 因其他插件无法启动，先修复该插件再启用本包。M0 验证中遇到过 `@linxin666/dsh-tool-describe-image` 缺少 `tools` 注入；该故障与本包无关，不能通过放宽 Claude 工具权限绕过。

## Claude Code 权限

打开 Claude Code 原生会话时，输入框左下角显示的是 Claude Code 的权限，而非 DSH 的沙箱权限：

| 选项 | CLI 模式 | 含义 |
|---|---|---|
| 计划 | `plan` | 读取和分析；不会修改工作区。 |
| 自动编辑 | `acceptEdits` | 自动允许工作区文件修改和常见文件操作；Git 提交、推送等仍可能被拒绝。 |
| 自动 | `auto` | 由 Claude 的安全分类器判断是否执行。 |

新会话默认是“计划”。选择会保存到 `sessions.json`，首轮和每次 `--resume` 都会明确传入 `--permission-mode`；CLI 初始化事件报告的实际生效模式会一并保存。运行中也可以切换：当前 CLI 回合保持原模式，新的选择从下一轮开始生效。

在“自动编辑”下，文件编辑和常见文件操作会直接执行；`git`、测试、安装依赖等仍需确认。此类请求会接管 DSH 输入框并展示一次性的“允许／拒绝”审批面板；允许后 Claude Code 的同一轮会继续执行。该桥接只监听本轮随机令牌保护的本机回环端口，不会向其他会话或外部网络暴露审批能力。

`manual`、`dontAsk` 和 `bypassPermissions` 不在界面中提供：当前非交互 `claude -p` 无法将 `manual` 的审批请求转换为 DSH 审批卡，`dontAsk` 需要独立的工具白名单，而 `bypassPermissions` 在没有额外 OS 隔离时不安全。

## Hermes

新会话菜单提供「Hermes（原生会话）」，走本机 `hermes` CLI（`~/.local/bin/hermes`）的 **ACP 模式**（`hermes acp`，编辑器集成同款 JSON-RPC 通道）。与 Claude Code 驱动的差异：

- 流式输出：每个 DSH turn 独立 spawn 一个 `hermes acp`，`agent_thought_chunk`（思考）/ `agent_message_chunk`（正文）/ `tool_call`（工具调用）实时转发为 DSH 事件，turn 结束附 usage 统计。
- 会话串联：ACP 会话 id（`session/new` 返回）写入独立 sidecar（`~/.dsh/hermes-agent-driver/sessions.json`，`acpSessionId` 字段），后续轮次 `session/load` 续接（历史 replay 通知被丢弃，DSH 自己有可回放事件）；冷重启后可继续。注意：v1 静默模式时代的旧会话无法续接（id 体系不同），会从新 ACP 会话开始。
- 权限档位两档：`安全`（默认，`session/request_permission` 一律拒绝，fail-closed）与 `自动`（应答 `allow_once`，谨慎使用）。
- 模型显示：取自 `session/new`/`session/load` 响应的 `models.currentModelId`（去掉 provider 前缀）。
- turn 完成后驱动主动终止 ACP 服务器进程组（profile 声明 `tolerateUncleanExit`，退出码不作数）。
- 标题前缀 `Hermes · <主题>`，与 Claude Code 会话在列表中可区分。

DSH `0.1.0-rc.6` 尚未提供 provider 专属 access-mode 插槽。本包通过官方 `conversation.input.left` 插槽渲染 Claude 控件，并仅在原生会话时隐藏 DSH 的全局 access 控件；升级 DSH 时应做一次界面回归，确认其无障碍标签仍包含“访问模式”或“Access mode”。

## 模型显示

原生会话中官方模型切换器被隐藏（使用当前 agent 的独立模型选择），取而代之在输入框右下角、发送按钮前显示一个只读模型名：

- Claude Code：来自 stream-json `system/init` 事件的 `model` 字段，首轮后出现。
- Hermes：来自 ACP `session/new` / `session/load` 响应的 `models.currentModelId`（去掉 `provider:` 前缀）。
- 模型名持久化在各 driver sidecar（展示性字段），随 `getPermission` 一并返回。输入 `/model` 打开当前 agent 的模型选择面板；支持搜索、键盘选择和取消。Claude 模型列表来自初始化协议；Hermes 模型目录复用本机终端 `/model` 的 `hermes_cli.inventory.build_models_payload`，先按提供商分组并显示数量，再进入组内选择，支持返回和取消。选择写入当前会话 sidecar，后续消息使用该模型，不修改全局默认配置。

## 会话斜杠命令

在输入框输入 `/`，原生会话会显示对应 CLI 实际公布的命令目录；选择后可补充参数，按 Enter 交给当前会话的 agent 执行。普通 Harness 会话仍使用原有命令。原生 `/model` 展示 agent 自身模型列表，`/compact` 使用 agent 自身压缩处理器，支持 Claude 插件的 `插件名:命令名`。

目录按会话隔离、首次加载后缓存：Claude 通过 stream-json 的 `initialize` 控制请求发现（保留当前工具、安全模式和工作目录，禁用探测会话持久化）；Hermes 通过临时 ACP 会话的 `available_commands_update` 发现。发现阶段不发送模型提示词，15 秒超时；失败后可重试，卸载会取消探测进程。只展示当前非交互通道公布的命令，可能少于交互终端中的完整列表。

命令及回复通过原有会话事件流记录；运行中的 agent 拒绝新命令。Hermes 的斜杠输入不追加格式提示。一般命令由 CLI 决定行为及持久化范围。`/model`（包括带模型 ID 的形式）由插件保存会话选择：Claude 每轮传入 `--model`，Hermes 在每轮 ACP 会话载入后调用 `session/set_model`。运行期间拒绝切换；模型列表加载失败可在面板重试。其他命令的终端专属交互尚未逐一适配。

DSH rc.6 没有 provider 专属命令分发接口：Host 适配公开的 `commands.list/execute`，Client 适配 `commandUi` 的候选和选择入口，原生会话跳过全局客户端贡献及装饰器。卸载恢复原入口；升级 DSH 后需回归 `/` 菜单及键盘选择。

本次包含 Host 修改，安装为本地 link 的 profile 需要重启 DSH，再刷新 GUI。

Hermes 模型目录通过配置的 `hermes` 启动文件解析其 Python 环境，保留 CLI 参数（包括 profile）、工作目录和 dotenv 初始化；不读取 ACP 的单提供商精选列表。目录加载沿用 Hermes 的缓存和模型发现逻辑，最长等待 60 秒。`command` 应指向 Python 版 Hermes 启动文件；不支持的 shell 包装器会明确报错。Hermes 升级后需要回归其 inventory 接口。只将模型和提供商展示字段传到 GUI；自定义提供商选择编码为 ACP 可识别的 `custom:name:model`，不会将密钥传给前端。

## 验证

```bash
cd ~/AiProjects/dsh-plugins/packages/dsh-agent-driver
npm test
```

## 配置

`cordis.patch.yml` 的插件 config 可选字段：`command`、`args`、`tools`、`indexPath`、`securityProfile`、`safeMode`。未配置 `tools` 时使用 `Bash,Read,Glob,Grep,Edit,Write`；如需只读会话，可显式设为 `['Read', 'Glob', 'Grep']`。`safeMode` 默认为 `true`；`args` 不能传 bypass 权限参数，也不能传 `--permission-mode`（它由会话控件管理）。`indexPath` 默认是 `~/.dsh/agent-driver/sessions.json`（旧版 `~/.dsh/cc-agent-driver/sessions.json` 会在启动时自动迁移，旧文件保留），只保存 driver 标识、UUID、版本、安全配置和权限模式，不保存 token 或 Claude 另一个 session ID。
