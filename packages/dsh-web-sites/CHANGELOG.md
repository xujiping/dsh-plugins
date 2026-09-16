# Changelog

## 0.1.0 (2026-09-16)

- 首个可用版本：DSH Web 左侧「🌐 网站」触发条 + 站点列表。
- 点击站点在主面板区域以 iframe 面板打开，带刷新 / 新标签 / 管理 / 关闭。
- host 半边提供 `GET /api/dsh-sites/list` 与 `POST /api/dsh-sites/save`
  （回环信任围栏 + 原子写），配置存 `~/.dsh/sites.yaml`
  （可用 `DSH_WEB_SITES_CONFIG` 覆盖路径）。
- 支持界面可视化管理站点（增删改），写回配置文件。
- 布局锚定 DSH 三列 grid（解析 `gridTemplateColumns`），跟随明暗主题，
  纯 DOM 注入 + MutationObserver / ResizeObserver 自愈。
