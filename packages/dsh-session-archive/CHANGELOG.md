# Changelog

## 0.1.2 — 2026-10-04

- **兼容性证据扩充**：用临时目录安装的新版 DSH CLI 在一次性 Profile 中完成验收：`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1` 的安装/配置合成/启动（HTTP 200）/卸载全部通过，`dshReleases` 逐项改为 compatible 并回填 `dshOperations`。

## 0.1.1 — 2026-10-04

- **DSH-Store 上架适配**：`package.json` 新增 `dsh.compatibility`（`dsh` 版本范围 + `dshReleases` 对全部已发布 DSH 版本逐项声明，仅 `0.1.5-rc.2` = compatible，其余 = unknown）、`dshOperations`（`0.1.5-rc.2` 一次性 Profile 安装/启动/卸载全部通过）与 `engines.node`；版本号升至 0.1.1。纯 manifest 变更，无功能改动。

## 0.1.0 — 2026-09-14

- 首个版本：一键归档空闲会话。
  - 侧边栏项目（workspace）目录行悬停出现归档按钮。
  - 点击弹出二次确认框：显示将归档数量、会话标题预览，阈值可实时调整。
  - 走 DSH 原生 `workspace/archiveSession` RPC 归档（可恢复，非删除）。
  - 空闲判定：`updatedAt` 距今超过 N 天（默认 3 天，持久化到 localStorage）。
  - 安全筛选：跳过已归档 / 子代理 / 无活动时间记录的会话。
  - 纯 client DOM 注入（`inject: ['workspaces', 'sessions']`），MutationObserver 自愈，不改 DSH 源码。
