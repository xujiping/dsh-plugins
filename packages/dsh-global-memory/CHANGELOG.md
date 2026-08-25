# Changelog

本仓库各插件包的变更记录。版本遵循 [Semantic Versioning](https://semver.org/)。

## [dsh-memory / dsh-global-memory]

### 0.1.0 — 2026-08-20

首个发布版本。

- 侧边栏「全局记忆」入口 + 中心面板：文件列表（标题/路径/大小/修改时间）
- 编辑器：等宽字体 textarea，⌘/Ctrl+S 保存、未保存标记、切换前确认
- 新建记忆文件：DOM 内联对话框（自动加 .md 后缀、文件名校验、防目录穿越）
- 暗色模式：全部配色走 DSH 官方 `--dsw-alias-*` token，自动跟随明暗主题
- 操作条位于面板底部，避让视口右上角其他插件的固定按钮
- Host 路由 `/api/dsh-memory/files|file`：回环信任围栏、key 白名单、
  原子写入（temp + rename）、1 MiB 上限、0600 权限
- 发布要素：`dsh.bundle.patch`（cordis.patch.yml）+ `dsh.client`（web 平台）

### 0.1.1 — 2026-08-25

- 修复 client 模块 id：`'dsh-memory'` → `'dsh-global-memory'`，与包名一致；
  0.1.0 通过 npm 安装时 client 半边因 id 不匹配无法加载，本版本修复该问题。
- 目录改名：`packages/dsh-memory` → `packages/dsh-global-memory`，与 npm 包名对齐；
  host 路由 `/api/dsh-memory/*` 与 CSS 前缀 `.dshm-` 保持不变（内部契约）。
