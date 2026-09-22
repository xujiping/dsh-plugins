# dsh-desktop-pet

DSH Web GUI 桌面宠物：一只纯 CSS 小蓝宠住在页面里，会自己溜达、打瞌睡，也会跟着
会话状态做动作（AI 输出中打字、工具执行中敲锤子）。

## 动作一览

| 动作 | 触发 | 表现 |
|---|---|---|
| `idle` | 自主节律 | 呼吸起伏 + 周期眨眼 |
| `walk` | 自主节律 | 摇摆走路，屏幕内溜达，碰边掉头 |
| `sleep` | 空闲超时 / 夜间偏好 | 压扁 + 闭眼 + 💤 |
| `happy` | 单击 / 拖拽放下 | 蹦跳 + 💗 |
| `eat` | 双击（压缩上下文） | 咀嚼 + 🧹 气泡，吃完自动转 happy |
| `typing` | AI 正在输出（`data-chat-flow` 变化） | 前倾敲打 + ⌨️ |
| `work` | 工具调用执行中 | 敲锤子 + 🔧 |
| `dangle` | 拖拽中 | 被拎起来晃 |

## 架构（三层动作模型）

1. **动画层**：宠物是 `[data-action]` 属性驱动的纯 CSS 关键帧动画（身体/眼睛/脚/
   气泡各部位），零素材依赖。以后想换精灵图，只需给 `.dpet-pet` 换 sprite 背景。
2. **状态机层**：`ACTIONS` 表声明每个动作是否循环、时长区间、播完切到哪，
   `setAction()` 是唯一写入口。
3. **触发层**：自主节律定时器（wander）+ 用户交互（pointer 拖拽/单击/双击压缩）+
   `MutationObserver` 盯 `[data-chat-flow]` 联动会话状态。

宠物节点挂在 `document.body` 下（React 树之外，`position: fixed`），热插拔卸载
自动移除节点与样式；位置记忆到 `localStorage`。

## 双击压缩上下文（/compact）

双击宠物 = 对当前会话执行 `/compact`：宠物做咀嚼动画（把旧上下文“吃掉消化”），
气泡提示「🧹 压缩上下文…」，随后压缩结果/错误提示显示在会话消息流里。
右键菜单「⚡ 快捷操作 → 🧹 压缩上下文」等效。

实现方式：把命令文本注入 GUI 自己的输入框（`[data-composer-seat]` 内的 Lexical
编辑器根节点）并派发回车，完整复用官方斜杠命令管线——输入状态机裁定、
「agent 忙碌不可压缩」等官方守卫照常生效，不依赖 DSH 内部 API。安全边界：

- 仅当**输入框为空** 且**对话区空闲**时才执行压缩，避免误触：
  - 对话区忙碌（agent 正在生成/工具执行中，输入框出现停止按钮）→ 气泡
    「⏳ 对话生成中，稍后再压缩」，不注入；
  - 输入框里有草稿或挂着的 @文件/指令 chip → 气泡「✋ 输入框有草稿，先清空
    再压缩」，绝不覆盖未发送的内容；
  - 非会话页（没有输入框）气泡提示「💬 没找到输入框」；
- 双击节流 2s；真实拖拽结束后 0.5s 内的双击视为误触忽略；
- 注入文本失败（如会话忙碌锁定输入框）气泡提示「⚠️ 触发失败」，不会误发空消息。
  忙碌判定用「停止按钮」中英 aria-label + 停止图标结构双信号，不依赖界面语言。

## 停靠输入框上（workbuddy 风格）

默认开启：宠物趴在输入框（composer，`[data-composer-seat]`）右上方 10px / 6px 处，
并**每帧跟随输入框**——侧栏开合、窗口缩放、面板切换导致的位移都会同步跟上
（`requestAnimationFrame` 中读一次 `getBoundingClientRect`，位置未变则不写样式）。
输入框顶到视口上沿放不下时保持原位不跳动；会话界面未挂载（如设置页）时不抢位置。

- 关闭/开启：右键宠物 → 「停靠输入框上」；开关存 `localStorage`。
- 拖动宠物（位移 >4px）= 手动放置，会**自动解除停靠**（拖拽期间停靠同步让位给鼠标，
  松手不再弹回）；想重新趴回输入框，在右键菜单里把开关再打开。
- 原地点击（没有拖动）**不会**解除停靠，照常触发 `happy`。
- 停靠时不漫游（只在原地做 `idle`/`typing`/`work` 等动作），也不记忆坐标。

停靠链路的回归测试（零依赖，自带 DOM stub）：

```bash
node test/dock.mjs
```

## 安装

```bash
dsh plugin --profile web add link:~/AiProjects/dsh-plugins/packages/dsh-desktop-pet
```

装完重启 `dsh web` 生效。开发期 `pnpm run dev:web` 下的 client HMR 会即时生效。

## 重启 Web 服务

右键宠物，选择「重启 DSH Web」，确认后会中断当前任务并重启服务。插件沿用当前
CLI 参数、工作目录和环境变量；等待旧进程退出后启动新进程，页面在服务恢复后自动刷新。
仅支持标准 `dsh` CLI 启动的固定端口服务，不支持 Electron 托管进程或 `--port 0`。
重新启动的进程在后台运行，输出写入 `~/.dsh/logs/desktop-pet-restart.log`。
新增了 Host 接口，已有安装需要先手动重启一次 DSH Web 才能使用此功能。

接口仅接受本机回环连接；重启请求还校验同源信息及操作标识。验证命令：

```bash
node test/smoke.mjs
```

## 提醒通道（SSE + 版本检查）

Host 半边注册 `GET /api/dsh-desktop-pet/events` 的 SSE 长连接（仅本机同源），客户端
`EventSource` 订阅；收到提醒时宠物切 `happy` 并在气泡显示标题 8 秒。已看过的提醒 id
记在 `localStorage`（`dpet.seen-notices`），刷新/重连不重复打扰；断线由 `EventSource`
自动重连，重连后服务端回放最近 20 条历史（客户端按 seen 过滤）。

内置检查器：**DSH 新版本**——启动 15 秒后首查，此后每 12 小时复查 npm dist-tags
（registry 依次尝试 npmjs / npmmirror，可用环境变量 `DSH_PET_NPM_REGISTRY` 覆盖），
发现比当前版本新即推送 `dsh-update:<version>` 提醒。当前版本优先从依赖树解析
`@deepseek-ai/dsh/package.json`，回退到 `process.argv[1]`（bin.js）旁的 package.json。

后续可按同一 `notifier.publish({ id, kind, icon, title, body })` 契约扩展插件更新、
模型额度等检查器。接口仅接受本机回环连接（同 restart 路由的信任围栏）。

## 悬停余额卡片

鼠标悬停宠物弹出「💰 模型余额」卡片，展示 `~/.dsh/settings.yaml` 中
`llm-pi-ai.providers` 已配置的各模型提供商及其余额/余量。Host 半边注册
`GET /api/dsh-desktop-pet/balance`（本机同源围栏，结果内存缓存 55 秒，
`?force=1` 强刷）：

| 提供商 | 查询方式 | 展示 |
| --- | --- | --- |
| DeepSeek 官方 | `GET api.deepseek.com/user/balance` | CNY 余额 |
| 火山方舟 Agent Plan | `arkcli usage balance --type plan`（子进程） | 5h / 周 / 月剩余百分比 |
| 智谱开放平台 | 官方余额接口已下线（404） | 标记「平台未提供余额接口」 |
| MiniMax / 内网网关 | 无公开余额接口 | 标记「无公开余额接口」 |

API Key 优先取 `apiKeyEnv` 对应的进程环境变量，缺失时回退读
`~/.dsh/.credentials.yaml`（扁平 KEY: value，逐行正则取值）；响应只含展示
文本，绝不回传凭证。客户端后台每 1 分钟轮询刷新，悬停时直接展示缓存、
零等待；悬停中若数据刷新则卡片就地更新。yaml 解析从 dsh 依赖树
解析（插件保持零依赖）。

## 控制台调试

```js
window.__dshDesktopPet.setAction('eat')   // 手动切换动作
window.__dshDesktopPet.dispose()          // 手动卸载
window.__dshDesktopPet.lastNotice         // 最近收到的一条提醒
```
