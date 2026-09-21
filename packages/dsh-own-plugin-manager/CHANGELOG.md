# Changelog

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
