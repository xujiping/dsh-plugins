# dsh-web-sites

DSH Web 集中管理自己的网站系统：侧边栏「新会话」按钮下方、工作区上方注入一行
「🌐 我的网站系统」菜单，点击展开你的站点列表；点击某个站点，会在 DSH 主面板
区域（侧边栏右侧）以 iframe 面板打开它，带**刷新 / 新标签 / 管理 / 关闭**；面板
打开期间点击左侧任意会话即可收起面板回到会话页面。站点清单存于
`~/.dsh/sites.yaml`，支持在界面里可视化增删改。

适合：自己部署的多个 Web 系统（本地服务、内网后台、公网应用）想在一个地方
统一收录、一键打开。

## 效果

- **侧边栏菜单行**：「🌐 我的网站系统」注入在侧边栏「新会话」按钮下方、工作区
  列表上方，显示站点数量徽标；点击在按钮正下方展开站点列表。
- **站点列表**：下拉浮层对齐侧边栏宽度，每项显示图标 + 名称 + 地址；
  列表底部有「⚙ 管理站点」入口。
- **主面板打开**：点击某站点，从侧边栏右缘到视口右缘弹出一个全高 iframe 面板，
  顶部标题栏带按钮：**⟳ 刷新**（重载当前站点）、**↗ 新标签**（新标签页打开，
  内嵌受限或需登录时的兜底）、**⚙ 管理**、**✕ 关闭**。
- **点会话即收起**：网站面板打开期间，点击左侧任意工作区/会话行，面板自动收起、
  回到会话页面（再点菜单里的站点可随时切回网站）。
- **可视化管理**：管理弹窗里可新增/编辑/删除站点，保存后写回
  `~/.dsh/sites.yaml`。
- 随明暗主题自动适配（全部使用 DSH 官方 `--dsw-*` token，无硬编码颜色）。

## 安装

```bash
# 从本仓库本地 link 调试
dsh plugin --profile web add link:~/AiProjects/dsh-plugins/packages/dsh-web-sites
```

`--profile` 换成实际 profile 名（桌面 GUI 用 `desktop`）。装完重启 `dsh web`
（或重载 profile）生效。

> 手动接线（等价于 `link:`）：在 `~/.dsh/profiles/<profile>/package.json` 的
> `dependencies` 加 `"dsh-web-sites": "link:~/AiProjects/dsh-plugins/packages/dsh-web-sites"`、
> 在 profile 的 `cordis.patch.yml` 加
> `- insert:\n    - id: web-sites\n      name: 'dsh-web-sites'`，
> 并在 `node_modules` 下建软链。

## 配置

站点清单默认在 `~/.dsh/sites.yaml`（也可用环境变量 `DSH_WEB_SITES_CONFIG`
指到别处）：

```yaml
sites:
  - id: contract
    name: 合同管理系统
    url: http://localhost:8080
    icon: 📄
    tags: [办公]
  - id: knowledge
    name: 知识平台
    url: http://192.168.1.20:3000
    icon: 🧠
```

- `id` 可选；缺省时由 `name` 生成（中文保留）。
- `icon` 可选，1-2 个字符；缺省 `🌐`。
- `name` / `url` 必填，缺一则该条被忽略。

也可以在 DSH 界面里点「⚙ 管理站点」直接增删改，效果等同编辑该文件。

## 关于内嵌（iframe）的两点说明

1. **站点拒绝被嵌入**：如果站点响应带 `X-Frame-Options: DENY/SAMEORIGIN`
   或 CSP `frame-ancestors`，浏览器会阻止 iframe 显示。此时点面板标题栏的
   **「↗ 新标签」** 打开即可。若想让自己的站点支持内嵌，去掉该响应头或加上
   `frame-ancestors <你的 DSH origin>`（如 `http://localhost:3080`）。
2. **登录态**：同源或浏览器已记住 cookie 的站点，iframe 里能正常带上登录态；
   跨域站点受浏览器第三方 cookie 策略（SameSite）限制，登录态可能带不上，
   同样用「新标签」兜底。

## 原理

- **host 半边**（`lib/index.js`）注册回环信任围栏保护的路由：
  - `GET  /api/dsh-sites/list` —— 读配置返回 `{ sites: [...] }`；
  - `POST /api/dsh-sites/save` —— 全量写回（原子写：tmp + rename，GUI 管理弹窗用）；
  - `POST /api/dsh-sites/add` —— 单条新增 `{ name, url, icon?, tags?, id? }`
    （幂等：同 id 或同 url 已存在则视为更新）；
  - `POST /api/dsh-sites/update` —— 单条修改 `{ id, name?, url?, icon?, tags? }`
    （id 可传站点当前 name）；
  - `POST /api/dsh-sites/remove` —— 单条删除 `{ id }`；
  - `POST /api/dsh-sites/reorder` —— 重排 `{ ids: [id, ...] }`，未列出的站点追加在末尾。
  - 站点字段 `embed: false`（add / update / save 均可设置）：该站点不走 iframe
    内嵌（iframe 里的第三方 Cookie 会被浏览器拦截，影响登录），点击直接新标签打开。
  - yaml 解析/序列化从 DSH 依赖树解析，插件自身零依赖。
- **对话式管理**：细粒度 CRUD 路由供 AI 会话直接 `curl` 单条增删改，不必拉全量
  再写回。配套 skill 在 `~/.claude/skills/web-sites/`，对 AI 说
  「把 XX 加进我的网站系统」即可触发。
- **client 半边**（`lib/client.js`）纯 DOM 注入：
  - **侧边栏菜单行**作为 `[role="tree"]`（工作区/会话树）的兄弟节点插入其前方
    （即新会话按钮下方、工作区上方），不进入 React 管理的树内部；
    MutationObserver 在外壳重渲染后自动重插。
  - 列表 / iframe 面板 / 管理弹窗都 `position: fixed` 挂在 `document.body`
    （在 React 树之外）；ResizeObserver 自愈重锚。
  - 面板打开期间，document 级捕获阶段 click 委托监听：命中任意
    `[role="treeitem"]`（工作区/会话行）即收起面板。
  - 布局锚点不依赖 hashed class：DSH 外壳是三列 CSS grid
    （sidebar | center | rightbar，根元素带 `[data-sidebar-collapsed]`），
    直接解析 `gridTemplateColumns` 取侧边栏/右侧栏宽度，主题与宽度变化都能跟随。
  - 挂载失败只 `console.warn`，绝不影响 GUI 启动。
- 面板 iframe **故意不加 `sandbox`**：站点需要 cookie / JS 才能正常工作。

## 开发

- 改 `lib/client.js` 后刷新 Web GUI 即可看到效果（纯 DOM，自愈）。
- 跑测试：`npm test`（覆盖 host 半边的 trust fence / 配置读写 / 路由守卫）。

## License

MIT
