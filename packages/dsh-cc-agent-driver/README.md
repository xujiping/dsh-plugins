# dsh-cc-agent-driver

DSH 的 Claude Code 原生会话驱动。每个会话使用同一个 UUID 作为 DSH Session ID 和 Claude Code `--session-id` / `--resume` ID；DSH 保存可回放事件，Claude Code 保存下一轮推理所需的本地会话。

当前实现完成了 M0 的驱动主链路：严格 Typert Remote descriptor、自定义 Agent/Session 原子发布、Web 新会话菜单、fake `stream-json` CLI 事件转换、整组子进程取消，以及不含密钥的 driver sidecar 索引。首轮/续接 JSONL 已按真实 Claude Code 采样；真实 DSH Web Host 已验证创建、重启恢复和一条无工具流式请求。

## 安装

```bash
dsh plugin --profile web add link:~/AiProjects/dsh-plugins/packages/dsh-cc-agent-driver
```

重启目标 DSH profile。侧边栏“新会话”会出现“Claude Code（原生会话）”；默认启用 Claude `--safe-mode`，并开放受限的工作区工具集：`Bash`、`Read`、`Glob`、`Grep`、`Edit`、`Write`。它足以完成常规代码任务；严格空 MCP 配置仍会隔离所有用户/项目 MCP，且绝不启用 `bypassPermissions`。

“默认 DeepSeek Harness”会显式创建标准 Harness 会话，而不会复用空的原生会话；原生路由也只记录在自己的 Session 中，不会修改你的全局默认模型。

工作区会话列表通过会话标题展示驱动 Agent：原生会话的自动标题生成后会被固定为 `Claude Code · <主题>`（以 user 来源 pin，后续自动标题不会覆盖）；你手动重命名的标题保持原文，不会被加前缀。冷重启恢复时，未加前缀的存量原生会话标题会自动回填前缀。

如果 profile 因其他插件无法启动，先修复该插件再启用本包。M0 验证中遇到过 `@linxin666/dsh-tool-describe-image` 缺少 `tools` 注入；该故障与本包无关，不能通过放宽 Claude 工具权限绕过。

## 验证

```bash
cd ~/AiProjects/dsh-plugins/packages/dsh-cc-agent-driver
npm test
```

## 配置

`cordis.patch.yml` 的插件 config 可选字段：`command`、`args`、`tools`、`indexPath`、`securityProfile`、`safeMode`。未配置 `tools` 时使用 `Bash,Read,Glob,Grep,Edit,Write`；如需只读会话，可显式设为 `['Read', 'Glob', 'Grep']`。`safeMode` 默认为 `true`；`args` 不能传 bypass 权限参数。`indexPath` 默认是 `~/.dsh/cc-agent-driver/sessions.json`，只保存 driver 标识、UUID、版本和安全配置，不保存 token 或 Claude 另一个 session ID。
