# Changelog

## 0.1.1 — 2026-08-21

- 修复 DSH 启动报错 `bundle /plugins/dsh-agent-terminal/client.js loaded without
  registering "dsh-agent-terminal" via __ModuleLoader__.load`：client bundle 之前用
  `esbuild --format=esm` 打成纯 ESM（只 `export`，从不注册）；dsh 的 client-module
  协议要求执行 bundle 时仅以经典脚本调用 `window.__ModuleLoader__.load({ id, factory })`
  注册 factory，物化时才执行模块体。现改为 CJS 打包 + 注册包裹（对齐
  `@deepseek-ai/dsh-client-ui-*` 官方包与 dsh-memory 的格式）。
- 新增 `scripts/build-client.mjs`（`npm run build:client`），固化正确打包方式；
  `npm test` 现在包含 client bundle 格式回归检查（第 12 项）。

## 0.1.0 — 2026-08-21

- 初始版本：宿主侧 node-pty 会话注册表（spawn / attach / 有界滚动缓冲回放 / resize / kill / 并发上限），loopback 栅栏的 REST + WebSocket 路由。
- 浏览器侧：侧边栏「智能体」入口 + 中央面板（智能体卡片新建会话、终端标签页、断线重连覆盖层），与任务看板/SSH 面板遵循同一互斥激活协议。
- `ws` / `node-pty` 运行时从宿主与 profile node_modules 解析，零 npm 依赖、零 native 编译。
- 冒烟测试 11 项（fake pty 全路径 + 真实 node-pty `cat` 端到端 + apply 接线）。
