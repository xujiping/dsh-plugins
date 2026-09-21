# dsh-own-plugin-manager

DSH 自研插件管家：集中管理各 profile 已装插件，并自动监测版本更新。

纯两半边架构（不改 DSH 源码）：

- **Host 半边**（`lib/index.js`）：注册回环信任的 HTTP 路由 + 后台定时版本检测；
- **Client 半边**（`lib/client.js`）：设置对话框中的「插件管家」独立分区
  （官方 `settings.section` slot，React 组件，带 ErrorBoundary 兜底），
  卡片式布局对齐第三方「插件管理」（dsh-plugin-manager）的视觉体系，
  **自有 / 社区插件双 Tab** 区分管理。

## 功能

### 插件全景

扫描 `~/.dsh/profiles/<name>`，跨 profile 按包名聚合：

- **自有插件 / 社区插件双 Tab**：link 指 dsh-plugins monorepo 的包归
  「自有插件」（自研徽标 + 琥珀色调图标框），npm / GitHub / tarball 来源归
  「社区插件」；同名包跨 profile 聚合为一张卡（profile 标签 + 逐 profile 开关）。
- 每张插件卡片：关键词图标、来源徽标（`npm` / `GitHub` / `本地` / `发布包`）、
  版本行（`v0.1.0 → v0.2.0` / 「源码已更新」）、描述两行截断、
  「更新日志」链接、link 更新「已生效」确认。
- 控制台卡片：profile 药丸过滤（全部 / web / desktop…）、自有/社区统计、
  「检查更新」、上次检测时间与可用更新摘要。
- 分段筛选（全部 / 已启用 / 已停用 / 有更新）+ 搜索框（包名 / 描述 / 来源）。
- 启停状态（读 profile `cordis.patch.yml` 的 `disabled` 条目）与
  bundled 状态（不在 `dsh.profile.bundles` 中标「未接线」）。

### 一键启停

行级 patch profile 的 `cordis.patch.yml`（`- id: <cordisId>` + `disabled: true/false`），
**保留用户手写注释，绝不整体重写**；条目不存在时自动追加。改动在 profile
重载或 GUI 重启后生效。

### 自动版本更新监测

四类来源全覆盖，**全部走网络对比远端最新版**：

| 来源 | 检测方式 | 更新判定 |
| --- | --- | --- |
| `npm` | registry.npmjs.org（回退 npmmirror）`dist-tags.latest` | semver 比较 > 当前 |
| `github:` | 仓库默认分支 `package.json` 的 version | semver 比较 |
| release `tgz` | GitHub API `releases/latest` 的 tag | semver 比较 |
| `link:`（自有） | **GitHub 远端**：优先 release 标签 `<pkg>@vX.Y.Z`，无匹配回退默认分支 `packages/<pkg>/package.json` 的 version；repo 从 link 目录 `git remote` 自动推导（`DSH_OPM_OWN_REPO` 覆盖） | semver 比较；另有本地漂移信号（见下） |

link 类为**双信号**，互不掩盖：

- **远端有新版**（`remoteHasUpdate`）：GitHub 版本 > 本地源码 → 卡片显示
  `v0.1.0 → v0.2.0` +「复制更新命令」（`git -C <monorepo> pull --ff-only`）；
  本地开发中（本地 > 远端）不误报。
- **本地漂移**（`driftHasUpdate`）：本地指纹（version + commit）与基线不一致
  （已 pull 未重启 / 本地改动）→「源码已更新」徽标持续提醒，ack 前保持基线。
- 网络失败不掩盖漂移信号（错误记入 `remoteError` 单独展示）。

- 后台定时轮询：每 `DSH_OPM_INTERVAL_MIN`（默认 360 分钟，0 关闭）自动刷新一轮；
  GUI 启动时仅当缓存过期才补跑（不打 registry/GitHub API）。
- 结果落盘 `~/.dsh/plugin-versions.json`（原子写），设置分区中控制台摘要、
  「有更新」筛选与卡片徽标实时显示可用更新数。
- GitHub API 无认证限流（60 次/小时）：默认间隔下每轮十几个请求，安全。

## 对话式管理（AI 会话可直接 curl）

所有路由仅限本机同源（回环信任围栏）：

```bash
# 插件全景（含检测缓存）；?profile=web,desktop 可过滤
curl -s http://127.0.0.1:3080/api/dsh-opm/state | jq

# 强制刷新版本检测（增量刷新去掉 force 即可）
curl -s -X POST http://127.0.0.1:3080/api/dsh-opm/refresh \
  -H 'content-type: application/json' -d '{"force":true}' | jq '.view.updateCount'

# 停用/启用插件（plugin 接受包名或 cordis id）
curl -s -X POST http://127.0.0.1:3080/api/dsh-opm/toggle \
  -H 'content-type: application/json' \
  -d '{"profile":"web","plugin":"dsh-better-sidebar","disabled":true}'

# link 插件基线对齐（重启生效后清除「源码已更新」提醒）
curl -s -X POST http://127.0.0.1:3080/api/dsh-opm/ack \
  -H 'content-type: application/json' -d '{"profile":"web","plugin":"dsh-web-sites"}'
```

## 安装

```bash
# 本地 link（monorepo 内开发）
dsh plugin --profile <name> add link:~/AiProjects/dsh-plugins/packages/dsh-own-plugin-manager

# npm（发布后）
dsh plugin --profile <name> add dsh-own-plugin-manager
```

desktop profile（Electron 独占管理，CLI 拒绝操作）用手动接线：见仓库根 README
「安装方式」注释 —— package.json dependencies + bundles 数组 + node_modules 软链。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_OPM_INTERVAL_MIN` | `360` | 后台自动检测间隔（分钟），0 关闭 |
| `DSH_OPM_CHECK_MAX_AGE_MIN` | `360` | 单插件检测缓存有效期（分钟） |
| `DSH_OPM_OWN_REPO` | link 目录 `git remote` 自动推导 | link（自有）插件远端检测的 GitHub 仓库（owner/repo） |
| `DSH_OPM_STATE` | `~/.dsh/plugin-versions.json` | 状态文件路径 |
| `DSH_OPM_HOME` | `~/.dsh` | DSH 根目录（测试隔离用） |

## 设计说明

- **设置分区而非自绘悬浮层**：client 半边注册官方 `settings.section` slot
  （`ctx.slots.inject`，返回插件声明 `inject: ['slots']`，`package.json` 的
  `dsh.client.inject` 声明 `@deepseek-ai/dsh-client-ui-slots`），挂载生命周期
  交给 slot 系统——无需 MutationObserver 自愈 / fixed 定位 / 与其他侧边栏
  插件的让位协调；分区外层包 ErrorBoundary，渲染崩溃只降级本分区。
  经典 `__ModuleLoader__` 脚本内 `require('react')` 取模块表种子（dshmarket /
  dsh-plugin-manager 同款模式）。
- **卡片式 UI 对齐 dsh-plugin-manager**：控制台卡片 + 下划线 Tab + 分段筛选 +
  搜索框 + `minmax(300px,1fr)` 卡片网格，配色经局部自定义属性引用
  `--dsw-alias-*` token（明暗主题自动跟随）；自有/社区以 Tab + 徽标 +
  图标色调三重区分；跨 profile 同名包聚合一卡，开关逐 profile 带标签。
- **行级 patch 而非整文件重写**：profile 的 `cordis.patch.yml` 含大量用户注释
  （兼容性隔离说明等），启停操作只改目标条目的行，其余内容与注释逐字保留。
- **link 基线语义**：link 安装的版本永远等于源码当前值，"更新"定义为
  「与上次检测基线相比发生变化」；发现变化不立即重置基线，徽标持续提醒直到
  用户确认重启生效（ack），避免提醒一闪而过。
- **desktop profile 只读检测**：Electron 独占管理只挡 CLI 写操作，本插件对
  desktop 的启停/检测走文件层（读写 `~/.dsh/profiles/desktop/*`），完全可用。
- **零依赖**：host 半边只用 Node 内置模块；网络走全局 `fetch`（undici），
  超时 8s；测试可注入 `fetchFn` / `now` 全量离线跑。

## 测试

```bash
node test/smoke.mjs
```

覆盖：来源解析、semver 比较、patchYml 行级启停（注释保留/幂等/追加）、
profile 扫描（fixture）、四类检测器（注入 fake fetch）、状态读写原子性、
路由围栏与各 handler、client 静态断言（settings.section 注册 / token 配色 /
无渐变 / 自有社区双 Tab / 无旧侧边栏残留）、client 运行时冒烟（stub react +
document，有状态渲染：Tab 切换 / 状态筛选 / profile 过滤 / 空态）。

```bash
node test/smoke.mjs
node test/client-smoke.mjs
node test/client-runtime.mjs
```
