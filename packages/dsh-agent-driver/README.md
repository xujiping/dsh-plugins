# dsh-agent-driver

DSH 的原生智能体会话驱动（原 `dsh-cc-agent-driver`，为后续接入 Hermes、OpenClaw 等智能体改为通用命名）。当前实现驱动 Claude Code：每个会话使用同一个 UUID 作为 DSH Session ID 和 Claude Code `--session-id` / `--resume` ID；DSH 保存可回放事件，Claude Code 保存下一轮推理所需的本地会话。默认索引路径随改名迁移到 `~/.dsh/agent-driver/sessions.json`，启动时自动从旧路径 `~/.dsh/cc-agent-driver/sessions.json` 迁移存量会话（旧文件保留）。

当前实现完成了 M0 的驱动主链路：严格 Typert Remote descriptor、自定义 Agent/Session 原子发布、Web 新会话菜单、fake `stream-json` CLI 事件转换、整组子进程取消，以及不含密钥的 driver sidecar 索引。首轮/续接 JSONL 已按真实 Claude Code 采样；真实 DSH Web Host 已验证创建、重启恢复和一条无工具流式请求。

## 安装

```bash
dsh plugin --profile web add link:~/AiProjects/dsh-plugins/packages/dsh-agent-driver
```

重启目标 DSH profile。侧边栏“新会话”会出现“Claude Code（原生会话）”；默认启用 Claude `--safe-mode`，并开放受限的工作区工具集：`Bash`、`Read`、`Glob`、`Grep`、`Edit`、`Write`。它足以完成常规代码任务；严格空 MCP 配置仍会隔离所有用户/项目 MCP，且绝不启用 `bypassPermissions`。

“默认 DeepSeek Harness”会显式创建标准 Harness 会话，而不会复用空的原生会话；原生路由也只记录在自己的 Session 中，不会修改你的全局默认模型。

工作区会话列表通过会话标题展示驱动 Agent：原生会话的自动标题生成后会被固定为 `Claude Code · <主题>`（以 user 来源 pin，后续自动标题不会覆盖）；你手动重命名的标题保持原文，不会被加前缀。冷重启恢复时，未加前缀的存量原生会话标题会自动回填前缀。

如果 profile 因其他插件无法启动，先修复该插件再启用本包。M0 验证中遇到过 `@linxin666/dsh-tool-describe-image` 缺少 `tools` 注入；该故障与本包无关，不能通过放宽 Claude 工具权限绕过。

## Claude Code 权限

打开 Claude Code 原生会话时，输入框左下角显示的是 Claude Code 的权限，而非 DSH 的沙箱权限：

| 选项 | CLI 模式 | 含义 |
|---|---|---|
| 计划 | `plan` | 读取和分析；不会修改工作区。 |
| 自动编辑 | `acceptEdits` | 自动允许工作区文件修改和常见文件操作；Git 提交、推送等仍可能被拒绝。 |
| 自动 | `auto` | 由 Claude 的安全分类器判断是否执行。 |

新会话默认是“计划”。选择会保存到 `sessions.json`，首轮和每次 `--resume` 都会明确传入 `--permission-mode`；CLI 初始化事件报告的实际生效模式会一并保存。正在运行的 turn 不能切换权限，等其结束后再修改。

`manual`、`dontAsk` 和 `bypassPermissions` 不在界面中提供：当前非交互 `claude -p` 无法将 `manual` 的审批请求转换为 DSH 审批卡，`dontAsk` 需要独立的工具白名单，而 `bypassPermissions` 在没有额外 OS 隔离时不安全。

DSH `0.1.0-rc.6` 尚未提供 provider 专属 access-mode 插槽。本包通过官方 `conversation.input.left` 插槽渲染 Claude 控件，并仅在原生会话时隐藏 DSH 的全局 access 控件；升级 DSH 时应做一次界面回归，确认其无障碍标签仍包含“访问模式”或“Access mode”。

## 验证

```bash
cd ~/AiProjects/dsh-plugins/packages/dsh-agent-driver
npm test
```

## 配置

`cordis.patch.yml` 的插件 config 可选字段：`command`、`args`、`tools`、`indexPath`、`securityProfile`、`safeMode`。未配置 `tools` 时使用 `Bash,Read,Glob,Grep,Edit,Write`；如需只读会话，可显式设为 `['Read', 'Glob', 'Grep']`。`safeMode` 默认为 `true`；`args` 不能传 bypass 权限参数，也不能传 `--permission-mode`（它由会话控件管理）。`indexPath` 默认是 `~/.dsh/cc-agent-driver/sessions.json`，只保存 driver 标识、UUID、版本、安全配置和权限模式，不保存 token 或 Claude 另一个 session ID。
