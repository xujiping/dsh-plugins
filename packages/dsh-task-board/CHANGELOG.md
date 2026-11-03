# Changelog

## 0.1.1

修复首版上线后暴露的样式问题（用户截图反馈「样式错乱、按钮字体不见了」）：

- **主按钮黑底黑字**：`brand-primary` 在浅色主题下是近黑色（`#0f1115`），
  原先前景也用 `label-primary`（同为近黑），文字完全不可见。改为配对 token
  `label-primary-foreground`，并补 `button-primary-hover` 悬停态。
- **控件字体丢失**：`all: unset` 会把 `font-family` 重置为浏览器初始值，
  中文回退到默认字体。所有 `all: unset` 控件（搜索框、下拉框、按钮、列头 ＋、
  对话框输入框/文本域）统一补 `font-family: inherit`。
- **下拉箭头消失**：`all: unset` 清掉了原生 `select` 外观，显式恢复
  `appearance: auto` 并留出箭头内边距，避免箭头压住文字。
- **工具栏挤压错乱**：窄面板下控件被压成竖排，工具栏改为允许换行，
  标题/计数加 `white-space: nowrap`。
- **面板高度**：宿主 `main` 面板是 flex column 容器，`height: 100%` 不生效，
  改为 `flex: 1 1 auto` 撑满。
- 测试新增回归断言：主按钮前景必须是配对 token、每个 `all: unset` 块必须
  显式继承字体、`select` 必须恢复原生外观。

## 0.1.0

首个版本。

- 新增任务看板：侧边栏 `sidebar.panellist` 入口 + `main` 主面板五列泳道看板
  （待规划 / 待开始 / 进行中 / 待审核 / 已完成）。
- 卡片支持新建、编辑、删除，字段含标题、描述、状态、优先级、标签、截止日。
- 支持 HTML5 拖拽跨列移动，拖到卡片上精确插位（落盘按 `beforeId` 重排 `order`）。
- 顶部搜索（标题 / 描述 / 标签）+ 优先级筛选 + 手动刷新。
- Host 半边提供回环信任的 `/api/dsh-board/*` 路由，数据原子落盘
  `~/.dsh/board.yaml`（`DSH_BOARD_CONFIG` 可覆盖路径）。
- 主面板包 ErrorBoundary，看板渲染失败只降级本面板。
- 配色全部走 `--dsw-alias-*` token，跟随明暗主题；纯色无渐变。
