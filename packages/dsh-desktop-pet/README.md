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

## 控制台调试

```js
window.__dshDesktopPet.setAction('eat')   // 手动切换动作
window.__dshDesktopPet.dispose()          // 手动卸载
```
