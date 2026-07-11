# 开源 Tiptap Agent Editor 迁移设计

## 目标

在不使用 Tiptap 付费 AI Toolkit 或 Tracked Changes 的前提下，将 Top Writer 升级为 Tiptap 3 驱动的 Agent Editor：AI 在文档内提出可逐项审阅的变更，用户可前后导航、单项接受/拒绝、全部接受/拒绝；既有语音改写流程继续工作。

## 范围

- 升级所有 `@tiptap/*` 依赖到兼容的 Tiptap 3 版本，并移除对 `node_modules/@tiptap/core/src/style` 的源码导入。
- 保留现有 Lit 容器、语音副驾、模型服务、编辑器桥和 Vercel 部署。
- 新增开源的 Agent 协议、上下文选择、流式会话、审阅建议扩展、顶部格式工具栏和底部审阅浮条。
- 不引入付费 Tiptap 私有 registry 包、Tiptap Cloud、协同编辑或持久化评论。

## 架构

`AgentSessionController` 只编排 AI 会话：读取上下文、调用现有 `TextGenerationService`、将结构化操作交给 `AgentSuggestionExtension`。扩展以 ProseMirror Decorations 保存尚未确认的 Suggestions；建议不修改真实文档。用户的接受/拒绝操作经过 Tiptap transaction 产生真实、可撤回的编辑。

```
语音 / 工具栏 / Agent 输入
  → AgentSessionController
  → TextGenerationService
  → 结构化 edit 操作
  → AgentSuggestionExtension（预览 Decoration）
  → 审阅浮条（上/下/接受/拒绝/全部）
  → Tiptap transaction + EditorBridge 历史
```

## Agent 工具协议

- `readSelection`、`readCurrentBlock`、`readDocumentOutline`：将最小必要文本暴露给模型。
- `replaceRange`、`insertAfterRange`、`deleteRange`：模型只能输出经客户端验证的结构化操作。
- 每项操作包含 stable id、原始 revision、范围、原文哈希、替换文本和可选理由。
- 流式阶段只累积候选操作，取消、revision 变化或范围哈希不匹配时丢弃会话。

## 审阅 UX

- 顶部工具栏：撤回/重做、缩放、块类型、列表、行内格式、对齐、表格、AI 入口。
- 文内绿色插入 / 红色删除 Decoration；当前项有明确焦点样式。
- 底部浮条：Reject all、Accept all、上一项、计数、下一项、Reject、Accept、关闭。
- 接受一个建议只应用该操作；拒绝只移除该 Decoration；全部操作原子地按当前 revision 处理。
- 语音改写仍可生成兼容 Suggestion，保留现有“预览后确认”安全边界。

## 安全与验收

- 模型不获得全文，除非用户显式选择全文任务；上下文选择必须可测试。
- 未确认建议不改编辑器 JSON；过期建议不能应用。
- 单元测试覆盖协议校验、流式取消、建议导航、单项/批量接受拒绝与 undo。
- Chromium E2E 覆盖顶部工具栏、流式模拟、文内 Diff、键盘审阅和移动端底部浮条。
- Tiptap 3 升级后 100% 保持既有语音和移动端验证通过。
