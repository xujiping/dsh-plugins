# Changelog

## 0.1.0 — 2026-09-14

- 首个版本：一键归档空闲会话。
  - 侧边栏项目（workspace）目录行悬停出现归档按钮。
  - 点击弹出二次确认框：显示将归档数量、会话标题预览，阈值可实时调整。
  - 走 DSH 原生 `workspace/archiveSession` RPC 归档（可恢复，非删除）。
  - 空闲判定：`updatedAt` 距今超过 N 天（默认 3 天，持久化到 localStorage）。
  - 安全筛选：跳过已归档 / 子代理 / 无活动时间记录的会话。
  - 纯 client DOM 注入（`inject: ['workspaces', 'sessions']`），MutationObserver 自愈，不改 DSH 源码。
