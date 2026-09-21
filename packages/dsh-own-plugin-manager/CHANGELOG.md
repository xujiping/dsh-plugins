# Changelog

## 0.2.0 (2026-09-22)

- **入口迁入设置**：移除侧边栏悬浮菜单 + 悬浮面板，改为注册官方
  `settings.section` slot —— 设置对话框导航新增「插件管家」独立分区
  （order 34，插头图标，紧邻第三方「插件管理」）。
- 管理页重写为 React 组件（经典脚本内 `require('react')`），挂载生命周期
  交给 slot 系统：删除 MutationObserver 自愈、fixed 定位与 dsh-web-sites
  菜单让位逻辑。
- 分区外层 ErrorBoundary：渲染崩溃只降级本分区，不再可能 blank 整个 GUI。
- `dsh.client.inject` 声明 `@deepseek-ai/dsh-client-ui-slots`（slots 服务提供方）。
- 功能不变：profile chips 过滤 / 启停开关 / 更新徽标 / 检查更新 / 基线 ack /
  四条 API 路由 / 后台定时检测。

## 0.1.0 (2026-09-22)

首个版本。

- 插件全景：扫描 `~/.dsh/profiles/*`，聚合包名/版本/描述/来源/启停/自研★/bundled 状态。
- 一键启停：行级 patch profile `cordis.patch.yml`（保留注释，条目不存在自动追加）。
- 版本更新监测：
  - npm registry（npmjs → npmmirror 回退）`dist-tags.latest`；
  - GitHub 仓库默认分支 `package.json` version；
  - GitHub release tgz `releases/latest` tag；
  - link 本地源码 version + git commit 快照对比，基线保持直到 ack。
- 后台定时自动检测（默认 6h，`DSH_OPM_INTERVAL_MIN` 可调），结果原子落盘
  `~/.dsh/plugin-versions.json`。
- Web GUI：侧边栏「🔌 插件管理」入口（更新数徽标、与 dsh-web-sites 菜单共存让位）
  + 悬浮管理面板（profile chips 过滤 / 启停开关 / 更新徽标 / 检查更新 / 基线 ack）。
- 对话式管理路由：`GET /api/dsh-opm/state`、`POST refresh|toggle|ack`（回环信任围栏）。
