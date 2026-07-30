# Continuity Seed Cases

这组 case 用来回答一个更具体的问题：

`开新窗口以后，RecallNest 是否还能把稳定背景带回来？`

## 设计原则

- 优先测稳定上下文，不测“机械续上一个话题”
- 问法尽量贴近真实工作，而不是关键词堆砌
- 允许先暴露 gap，再逐步补齐 durable memory 和 checkpoint

## 当前覆盖

1. 写作风格连续性
   检查口语化、不端着、可自嘲这类稳定偏好是否会被带回
2. 视觉风格连续性
   检查手绘涂鸦、高对比撞色等审美方向是否会被带回
3. 项目背景连续性
   检查 `RecallNest` 这类当前项目背景是否可见
4. 工作流模式缺口检查
   检查 `search_memory` / `resume_context` / `checkpoint` 是否已经足够稳定地进入 pattern recall

## 如何新增 case

新增 continuity case 时，优先填写这些字段：

- `task`
- `profile`
- `expectStableAny`
- `expectPatternsAny`
- `expectCasesAny`
- `scope` 或 `sessionId`（只有当你明确想测 scoped continuity 时才加）

示例：

```json
{
  "name": "recallnest_checkpoint_resume",
  "task": "继续推进 RecallNest 的连续性层",
  "profile": "default",
  "scope": "agent:codex",
  "sessionId": "codex-2026-03-16-001",
  "expectStableAny": ["RecallNest", "Claude Code", "Codex", "Gemini CLI"],
  "expectCheckpointAny": ["resume_context", "continuity", "checkpoint"]
}
```

## 解释结果

- `stableContext` 命中高，说明稳定背景已经能被新窗口带回
- `relevantPatterns` 命中低，通常说明高价值 workflow 还没有被结构化存够
- `recentCases` 命中低，通常说明历史解决方案还停留在 transcript，而没被提升成 case memory
- `latestCheckpoint` 缺失，不一定是 bug，也可能只是当前没有为该 `scope` / `sessionId` 写入 checkpoint
