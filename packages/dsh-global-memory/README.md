# dsh-global-memory

> npm 包名即目录名；曾用名 `dsh-memory`（因 npm 重名改为 `dsh-global-memory`，host 路由仍为 `/api/dsh-memory/*`）。

DSH 全局记忆插件：在 dsh Web GUI 侧边栏加「全局记忆」入口，中心面板直接查看/编辑：

- `~/.dsh/AGENTS.md` —— 全局指令（每个会话自动注入）
- `~/.dsh/memory/*.md` —— 跨会话动态记忆（prefs / projects / decisions / facts / memory 等）

## 能力

- 文件列表：标题、路径、大小、修改时间；缺失文件显示「不存在（保存时创建）」。
- 编辑器：等宽字体 textarea，⌘/Ctrl+S 保存；未保存标记；切换前确认。
- 新建记忆文件：面板内 DOM 对话框输入文件名（自动加 `.md` 后缀，仅限
  `[A-Za-z0-9][A-Za-z0-9._-]*`，防目录穿越）；不用原生 `window.prompt/alert/confirm`
  （DSH Web GUI 环境下不可靠，会静默失败——曾导致「新建无反应」）。
- 操作条：刷新/新建/保存/关闭 位于面板**底部**（顶部只留标题，右侧留空——
  避免与其他插件固定在视口右上角的按钮重叠，如 dsh-better-sidebar）。
- 主题：全部配色引用 DSH 官方 `--dsw-alias-*` / `--dsw-specific-*` token，自动跟随
  DSH 亮/暗主题（`body[data-ds-dark-theme]`），无需手动切换。
- Host 路由 `/api/dsh-memory/files|file`（GET 列表/读取，PUT 写入），全部：
  - 回环信任围栏（socket 地址 + Host 头 + same-origin 标记）；
  - 文件 key 白名单解析，永远走不出 memory 目录；
  - 原子写入（temp + rename），内容上限 1 MiB，权限 0600。

## 文件

- `lib/index.js` —— host 半边（路由）
- `lib/client.js` —— 浏览器半边（侧边栏入口 + 面板）
- `test/smoke.mjs` —— host 路由冒烟测试（`node test/smoke.mjs`）

## 挂载

见仓库根 README。
