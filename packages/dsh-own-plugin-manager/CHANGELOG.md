# Changelog

## 0.5.0 (2026-09-22)

- **关注仓库源（社区插件浏览 + 一键安装）**：社区插件无官方市场，在社区 Tab 顶部
  可添加关注的 GitHub 插件仓库（`owner/repo`、`https://github.com/…`、
  `github:…` 三种写法），自动发现其发布的插件并展示在社区列表。
  - 发现逻辑 `discoverRepoPlugins`：主模式拉 GitHub releases 解析 `<pkg>@vX.Y.Z`
    tag（monorepo，如 veildawn/dsh-plugins），tgz URL 按惯例拼装；无匹配回退
    默认分支根 package.json（单插件仓库）。网络失败记入 error，不抛异常。
  - 未安装的仓库插件以「仓库 + 未安装」卡片出现在社区 Tab，已安装的走常规卡片
    （更新检测覆盖）；`buildView` 附带 repos 快照并按包名关联已安装状态
    （跨 profile），client 零新增 state。
  - 一键安装/更新 `POST /api/dsh-opm/install`：host 侧 spawn
    `dsh plugin --profile <p> add <spec>`（monorepo 用 tgz URL、单插件仓库用
    `github:owner/repo`），成功自动 force 刷新检测；失败透出 pnpm stderr 尾部
    （如 allowBuilds 提示）。desktop profile 只给「复制安装命令」。
  - 仓库源 CRUD：`GET /api/dsh-opm/repos`、`POST repos/add|remove|refresh`；
    配置落盘 `~/.dsh/plugin-repos.json`（`DSH_OPM_REPOS` 可覆盖）；快照入
    `plugin-versions.json` 随后台定时轮询一起刷新（`DSH_OPM_CHECK_MAX_AGE_MIN`
    控制单仓库缓存）。
  - `resolveDshBin`：dsh 可执行文件按 PATH + 常见目录（/opt/homebrew/bin、
    /usr/local/bin、/opt/local/bin）探测，规避 Electron 窄 PATH。
- 测试：补仓库源 CRUD / discovery（monorepo tags + 单插件回退 + 网络失败）/
  refreshRepos 缓存 / buildView 已安装关联 / runInstall（fake spawn 成功失败）/
  新路由 handler / client 静态与运行时仓库源 UI 断言，全量通过。

## 0.4.0 (2026-09-22)

- **自有插件（link）也走网络检测远端最新版**：优先 GitHub release 标签
  （`<pkg>@vX.Y.Z`，按前缀过滤不做 releases/latest 兜底），无匹配回退默认分支
  `packages/<pkg>/package.json` 的 version；repo 从 link 目录 `git remote`
  自动推导（`DSH_OPM_OWN_REPO` 可覆盖），推导失败退化为纯本地指纹。
- **link 双信号，互不掩盖**：`remoteHasUpdate`（GitHub 有新版 → 卡片
  `v0.1.0 → v0.2.0`）与 `driftHasUpdate`（本地已 pull 未重启 → 「源码已更新」）
  分别展示；本地版本领先远端（开发中未 push）不误报；网络失败记入
  `remoteError` 不影响漂移信号。
- **卡片新增「复制更新命令」**：link = `git -C <monorepo> pull --ff-only`，
  npm = `dsh plugin --profile <p> add <pkg>@<latest>`（github/tarball 用源 spec）；
  剪贴板不可用时降级 toast 展示命令。
- `ackLink` 只清漂移、不清远端更新信号。
- 新增 `resolveGitRepo` / `repoSubpath`（`--show-prefix`，规避 macOS
  /var 符号链接差异）/ `checkLink`；测试补 6 组 link 网络检测用例。

## 0.3.0 (2026-09-22)

- **UI 重构：卡片式布局对齐第三方「插件管理」（dsh-plugin-manager）**——
  控制台卡片（profile 药丸过滤 + 自有/社区统计 + 检查更新 + 上次检测摘要）、
  下划线 Tab、分段状态筛选（全部/已启用/已停用/有更新）、搜索框（包名/描述/来源）、
  `minmax(300px,1fr)` 插件卡片网格。
- **自有 / 社区插件双 Tab 区分**：link 指 dsh-plugins monorepo 的包归「自有插件」
  （自研徽标 + 琥珀色调图标框），npm/GitHub/发布包来源归「社区插件」。
- 插件卡片：关键词图标（agent/terminal/archive/web/pet/scroll/puzzle 插头兜底）、
  来源徽标、版本行（`v1 → v2` / 「源码已更新」+「已生效」）、描述两行截断、
  「更新日志」外链、未接线标记。
- **跨 profile 聚合**：同名包聚合一张卡（profile 标签逐实例显示，停用实例
  划线置灰），开关逐 profile 带标签；「已生效」一次确认该包全部 link 更新。
- 布局全部走 `--dsw-alias-*` token（局部自定义属性引用），明暗主题自动跟随。
- 功能面不变：四条 API 路由 / 后台定时检测 / 行级 patch 启停；host 半边未动。

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
