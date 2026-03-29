# RecallNest 项目规则

## Git Push 规则（重要！）

- **所有 push 只推 origin**（`trihippo/recallnest`）
- **绝对不要 push 到 upstream**（`CortexReach/memory-lancedb-pro`）—— 那是上游公开仓库，推了等于暴露私有改造
- **绝对不要 push 到 public**（`AliceLJY/recallnest`）—— 除非用户明确要求
- 默认 `git push` 即可（默认推 origin）
- 需要给上游提 PR 时，走 fork + PR 流程，不直接 push

## Feature Flag

- `RECALLNEST_MULTI_VECTOR=true` — 多向量 L0/L1/L2 检索
- `RECALLNEST_KG_MODE=true` — KG 三元组提取 + 图遍历

## 测试

- 改完代码必须跑 `bun test`，全量通过才能 commit
- 当前基线：643 tests / 0 fail
