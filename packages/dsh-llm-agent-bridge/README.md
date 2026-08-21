# dsh-llm-agent-bridge

DSH 插件：把对话框（会话）的模型路由接到**本机外部智能体 CLI**，在原来的 DSH 对话框里直接与
Claude Code、Hermes 等 agent 对话。

原理：这是标准的 DSH LLM 适配器插件（同 `dsh-llm-deepseek` / `dsh-llm-pi-ai` 的模式）。它把每个
配置的外部 agent 注册成一个 LLM `provider` 路由；对话框里选中该 provider 后，适配器 spawn 对应的
CLI，把对话历史拍平后作为 prompt 喂进去，再把 CLI 流式输出映射回 DSH 的 StreamChunk 协议
（`block-start` / `text-delta` / `reasoning-delta` / `block-end` / `usage` / `finish`），原对话框的
打字机、轨迹视图都能正常工作。

外部 agent 保留自己的工具：CLI 里的 tool 活动以文本块形式展示（`⚙ Bash {...}`、`↳ tool result …`），
每轮以 `finish { kind: 'stop' }` 结束，所以 DSH 的 agent loop 不会去调度 CLI 自己的工具。

## 安装

```bash
# 从本仓库 link 安装（推荐，可热改代码）
dsh plugin --profile web add link:~/AiProjects/dsh-plugins/packages/dsh-llm-agent-bridge

# 重启 dsh web 生效
```

安装后，对话框的模型选择器里会出现两个新 provider：

| provider | 说明 |
|---|---|
| `claude-code` | 调用本机 `claude -p --output-format stream-json --verbose` |
| `hermes` | 调用本机 `hermes -z <prompt>` |

前提：`claude` / `hermes` 已在 PATH（或用 `command` 指定绝对路径）且已登录各自的账号。

## 配置

默认无需配置即可用。要改 agent 或新增 agent，在
`~/.dsh/profiles/<profile>/cordis.patch.yml` 里加：

```yaml
- insert:
    - id: llm-agent-bridge
      name: 'dsh-llm-agent-bridge'
      config:
        agents:
          - id: claude-code
            label: Claude Code
            protocol: claude-code
            command: /opt/homebrew/bin/claude
            cwd: ~/AiProjects
            contextWindow: 200000
          - id: hermes
            label: Hermes
            protocol: plain
            command: /opt/homebrew/bin/hermes
            promptVia: arg
            extraArgs: ['-z']
          - id: my-custom
            label: 我的 CLI
            protocol: plain
            command: /path/to/agent
            promptVia: arg
```

### 每个 agent 的配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `id` | —（必填） | provider 路由名，唯一 |
| `label` | = id | 界面显示名 |
| `protocol` | `plain` | `claude-code`（stream-json JSONL）或 `plain`（stdout 原文即答案） |
| `command` | —（必填） | 可执行文件路径 |
| `args` | `[]` | 固定参数 |
| `extraArgs` | `[]` | 附加参数（如 hermes 的 `['-z']`） |
| `promptVia` | claude-code→`stdin`，plain→`arg` | `stdin`（prompt 写 stdin）或 `arg`（prompt 作为最后一个参数） |
| `cwd` | 继承 host | CLI 工作目录（支持 `~`） |
| `modelId` | `default` | 该 provider 下的模型 id |
| `contextWindow` | 200000 | 展示用的上下文窗口 |
| `idleTimeoutMs` | 600000 | CLI 无输出多久后强杀（防止挂起拖死对话） |
| `showTools` | `false` | 是否在对话框里展示外部 agent 的工具活动（`claude-code` 协议）：`false` 只看最终回答（推荐）；`true` 显示精简单行摘要 |

## 兼容性

- **Claude Code**：走 `stream-json`，最终回答的 markdown 会被 DSH 正常渲染；thinking 会显示为
  推理块。工具活动默认隐藏（claude 自己执行工具），`showTools: true` 时以精简单行摘要展示。
  要求 `claude` 支持 `-p --output-format stream-json --verbose`（v1.0+ 均可）。
- **Hermes**：用 `-z`（oneshot，只输出最终文本）。Hermes 不支持细粒度流式事件，所以只有最终回答，
  没有 thinking / 工具过程展示。若要更多过程信息可改用 `hermes chat -q …`，但 v1 保持简单。
- 任意「stdin/argv 收 prompt、stdout 出答案」的 CLI 都能用 `plain` 协议接入。

## 已知限制

- 每轮请求都把整个历史拍平后发给 CLI（无 resume），所以 CLI 侧的会话记忆不跨 DSH 轮次持久化。
- 外部 agent 的工具调用在 DSH 侧只是文本展示，不参与 DSH 的权限/沙箱/审批（工具在子进程里执行）。
- DSH 传给适配器的 `system` 提示词被忽略（外部 agent 用自己那套 system prompt）。

## 显示格式（工具活动默认隐藏）

v0.1.2 起，`claude-code` 协议默认**不再把工具活动灌进消息流**——之前 `⚙ Bash {完整 JSON 命令}` 和
`↳ 整段工具输出` 会以无格式的原始文本刷屏，和 DSH 渲染不搭。现在默认只显示最终回答（markdown 正常
渲染）；需要看工具过程时设 `showTools: true`，会得到精简单行摘要（换行折叠、截断），而不是原始转储。

## PATH 处理（ENOENT 已修复）

DSH Desktop 宿主进程的 PATH 很窄（不含 `/opt/homebrew/bin`、`/usr/local/bin`），直接用
`command: claude` spawn 会报 `Error: spawn claude ENOENT`。本插件现在：

1. **自动补 PATH**：子进程环境在 `PATH` 前加上 `/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`
   等常见安装目录；
2. **命令解析**：`command` 不是绝对路径时，按「父 PATH → 常见目录」顺序探测到可执行文件，用绝对路径
   spawn；探测不到才按原命令名 spawn，并给出清晰的 SPAWN_FAILED 错误；
3. **优雅报错**：`spawn` 的 ENOENT 是异步 `error` 事件，已监听并转成 `finish { kind: 'error' }`，
   不再以 Uncaught Exception 冒泡崩溃宿主。

如果自动解析仍找不到，可在 agent 配置里直接写绝对路径：`command: /opt/homebrew/bin/claude`。

## 开发

```bash
node test/smoke.mjs   # 冒烟测试：fake claude-code + plain + 非零退出 + 命令不存在
node test/integration.mjs  # 集成测试：真实 cordis + dsh-llm 运行时组装
```

## License

MIT
