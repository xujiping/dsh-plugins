# dsh-agent-terminal

DSH Web GUI 的智能体终端：新建会话时选择 `claude code`、`hermes` 等本机智能体 CLI，页面内直接呈现该智能体**自己的交互式 TUI**（xterm.js 渲染本地 PTY）——100% 保真，权限确认、文件 diff、斜杠命令、主题全部是智能体原生的。

与 [`dsh-llm-agent-bridge`](../dsh-llm-agent-bridge) 互补：bridge 把外部智能体接进 DSH 对话框（吃 DSH 的渲染与会话能力），本插件则把真实终端搬进 GUI（吃智能体自己的完整体验）。两者可同时安装。

## 工作原理

- **宿主侧**（`lib/index.js`）：`node-pty` 在宿主进程内 spawn 智能体 CLI（PATH 自动增强，解决 DSH 宿主 `/usr/bin:/bin` 找不到 `/opt/homebrew/bin/claude` 的问题）；会话注册表保留有界滚动缓冲（~512KB），**切页/关面板/断线后 PTY 继续运行，重连时回放**；`/api/dsh-agent-terminal/*` REST + WebSocket 路由全部带 loopback 信任栅栏（复用 dsh-ssh 的防护语义）。
- **浏览器侧**（`lib/client.js`，esbuild 打包、自带 xterm）：侧边栏注入「智能体」入口；中央面板顶部是智能体卡片（= 新建会话的选择入口），点击即新建一个终端标签页；标签页支持切换/关闭（关闭即 kill）。
- 零 npm 运行时依赖：`ws` 与 `node-pty` 在运行时从宿主/`~/.dsh/profiles/<profile>/node_modules` 解析（createRequire 回退链），native 模块天然匹配宿主 ABI（Electron），无需自行编译。

## 安装（手动 wiring，绕过 pnpm store 版本冲突）

```bash
# 1. 依赖声明：编辑 ~/.dsh/profiles/desktop/package.json
#    dependencies 增加 "dsh-agent-terminal": "link:~/AiProjects/dsh-plugins/packages/dsh-agent-terminal"
#    dsh.profile.bundles 数组末尾追加 "dsh-agent-terminal"
# 2. 软链
ln -s ~/AiProjects/dsh-plugins/packages/dsh-agent-terminal \
      ~/.dsh/profiles/desktop/node_modules/dsh-agent-terminal
# 3. 完全重启 DSH Desktop
```

## 配置（可选，`cordis.patch.yml`）

```yaml
- id: agent-terminal
  name: 'dsh-agent-terminal'
  config:
    agents:
      - id: claude-code        # 唯一 id
        label: Claude Code     # 显示名
        command: claude        # 命令（自动探测 PATH + 常见 bin 目录）
        args: []               # 附加参数
        # cwd: ~/work          # 工作目录（默认 ~）
      - id: hermes
        label: Hermes
        command: hermes
```

不配置时默认 `claude-code` + `hermes`。命令不存在的条目会显示为禁用卡片并提示。

## 使用

1. 侧边栏点「智能体」→ 中央面板顶部点 `+ Claude Code`。
2. 在终端里正常使用该智能体（claude 的 `/help`、权限确认、diff 全部原生可用）。
3. 切到别的 DSH 会话再切回来：面板重开、滚动缓冲回放，PTY 一直在跑。
4. 标签页 `✕` 结束会话（kill 进程）。

## 限制

- 会话与宿主进程同生命周期：DSH 退出即终止，不持久化（claude 侧可用 `--continue`/`--resume` 找回）。
- 并发上限 8 个会话（防失控护栏）。
- 仅 loopback 部署可访问（路由有 loopback 栅栏）。
- 智能体的工具执行不受 DSH 权限/沙箱管控——你在终端里怎么用它，这里就是怎么用它。

## 开发

```bash
npm install --no-save --no-package-lock @xterm/xterm @xterm/addon-fit esbuild   # 构建依赖
npm run build:client    # 打包 src/client.ts → lib/client.js（dsh client-module 格式）
npm test                # 12 项冒烟（含真实 node-pty 端到端 + client bundle 格式检查）
```

⚠️ 必须用 `npm run build:client`（即 `scripts/build-client.mjs`）打包：dsh 不以 ES module
加载插件 client，而是执行「经典脚本注册 factory」——`window.__ModuleLoader__.load({ id,
factory })`，物化时才执行模块体。直接用 `npx esbuild --format=esm` 打包会得到一个从不
注册的 ESM，DSH 启动即报 `loaded without registering "dsh-agent-terminal" via
__ModuleLoader__.load`（0.1.0 的回归，已修）。

`lib/client.js` 是提交的构建产物；改 `src/client.ts` 后需 `npm run build:client` 并完全
重启 GUI。
