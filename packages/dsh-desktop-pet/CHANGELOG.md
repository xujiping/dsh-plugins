# Changelog

## 0.3.1 — 2026-10-04

- **DSH-Store 上架适配**：`package.json` 新增 `dsh.compatibility`（`dsh` 版本范围 + `dshReleases` 对全部已发布 DSH 版本逐项声明，仅 `0.1.5-rc.2` = compatible，其余 = unknown）、`dshOperations`（`0.1.5-rc.2` 一次性 Profile 安装/启动/卸载全部通过）与 `engines.node`；补 `scripts.test`；版本号升至 0.3.1。纯 manifest 变更，无功能改动。
