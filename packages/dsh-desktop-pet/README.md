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
| `eat` | 双击（喂食） | 咀嚼 + 🍪，吃完自动转 happy |
| `typing` | AI 正在输出（`data-chat-flow` 变化） | 前倾敲打 + ⌨️ |
| `work` | 工具调用执行中 | 敲锤子 + 🔧 |
| `dangle` | 拖拽中 | 被拎起来晃 |

## 架构（三层动作模型）

1. **动画层**：宠物是 `[data-action]` 属性驱动的纯 CSS 关键帧动画（身体/眼睛/脚/
   气泡各部位），零素材依赖。以后想换精灵图，只需给 `.dpet-pet` 换 sprite 背景。
2. **状态机层**：`ACTIONS` 表声明每个动作是否循环、时长区间、播完切到哪，
   `setAction()` 是唯一写入口。
3. **触发层**：自主节律定时器（wander）+ 用户交互（pointer 拖拽/单击/双击）+
   `MutationObserver` 盯 `[data-chat-flow]` 联动会话状态。

宠物节点挂在 `document.body` 下（React 树之外，`position: fixed`），热插拔卸载
自动移除节点与样式；位置记忆到 `localStorage`。

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

## 控制台调试

```js
window.__dshDesktopPet.setAction('eat')   // 手动切换动作
window.__dshDesktopPet.dispose()          // 手动卸载
window.__dshDesktopPet.lastNotice         // 最近收到的一条提醒
```
