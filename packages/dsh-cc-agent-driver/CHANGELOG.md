# Changelog

## 未发布

- 会话列表展示 Agent 名称：原生会话的自动标题（first-prompt fallback）落地后，Host 侧自动补写固定标题 `Claude Code · <主题>`（source=user pin，后续自动标题不再覆盖）；用户手动命名的标题保持原文。冷恢复发布时对未加前缀的存量标题做一次回填。

## 0.1.0

- M0：原生 Claude Code 会话驱动架构验证、Web 新会话入口、真实 Remote 创建和 Host 重启恢复。
- Host `./typert` 使用 zod v4 严格 schema；浏览器 Client 使用无外部依赖的严格 parse codec，以适配 DSH client module table。
