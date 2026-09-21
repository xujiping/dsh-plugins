# dsh-own-plugin-manager

DSH 自研插件管家：集中管理各 profile 已装插件，并自动监测版本更新。

纯两半边架构（不改 DSH 源码）：

- **Host 半边**（`lib/index.js`）：注册回环信任的 HTTP 路由 + 后台定时版本检测；
- **Client 半边**（`lib/client.js`）：侧边栏「🔌 插件管理」入口 + 悬浮管理面板。

## 功能

### 插件全景

扫描 `~/.dsh/profiles/<name>`，聚合每个 profile 的已装插件：

- 包名 / 当前版本 / 描述
- 来源类型：`npm`（registry 版本号）、`GitHub`（github: 仓库）、`本地`（link: 本地目录）、`发布包`（GitHub release tgz）
- 启停状态（读 profile `cordis.patch.yml` 的 `disabled` 条目）
- **自研标记 ★**：link 指向 dsh-plugins monorepo 的包
- bundled 状态（是否在 profile `dsh.profile.bundles` 中）

### 一键启停

行级 patch profile 的 `cordis.patch.yml`（`- id: <cordisId>` + `disabled: true/false`），
**保留用户手写注释，绝不整体重写**；条目不存在时自动追加。改动在 profile
重载或 GUI 重启后生效。

### 自动版本更新监测

四类来源全覆盖：

| 来源 | 检测方式 | 更新判定 |
| --- | --- | --- |
| `npm` | registry.npmjs.org（回退 npmmirror）`dist-tags.latest` | semver 比较 > 当前 |
| `github:` | 仓库默认分支 `package.json` 的 version | semver 比较 |
| release `tgz` | GitHub API `releases/latest` 的 tag | semver 比较 |
| `link:` | 源目录 package.json version + `git rev-parse --short HEAD` | 与上次基线快照对比 |

- 后台定时轮询：每 `DSH_OPM_INTERVAL_MIN`（默认 360 分钟，0 关闭）自动刷新一轮；
  GUI 启动时仅当缓存过期才补跑（不打 registry/GitHub API）。
- 结果落盘 `~/.dsh/plugin-versions.json`（原子写），GUI 侧边栏入口徽标实时显示可用更新数。
- link 类源码变化后**保持基线**，徽标持续提醒「源码已更新 · 重启生效」，
  点「已生效」重新对齐基线。
- GitHub API 无认证限流（60 次/小时）：默认间隔下每轮最多十几个请求，安全。

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
| `DSH_OPM_STATE` | `~/.dsh/plugin-versions.json` | 状态文件路径 |
| `DSH_OPM_HOME` | `~/.dsh` | DSH 根目录（测试隔离用） |

## 设计说明

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
路由围栏与各 handler、client 隔离断言（body 挂载 / token 配色 / 无渐变）。
