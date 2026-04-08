# RecallNest 架构迭代 Plan

**目标**：提升 RecallNest 架构能力（不刷分，关注真实场景）
**推送**：全部推河马仓(origin)，实用的推公开仓(public)

---

## 已完成

### Step 1: 隐式偏好检测 (preference-slots.ts)
- `ImplicitUsagePreferenceSlot` + 8 种中英文模式 | `6db35d08`

### Step 2: Source Diversity (retriever.ts)
- `sourceDiversity` config, round-robin 跨 scope | `6db35d08`

### Step 3: Adaptive Candidate Pool (retriever.ts)
- `adaptivePoolMultiplier` config, 聚合 query 自动扩池 | `6db35d08`

### Step 4: 隐式偏好双写 (capture-engine.ts)
- 非 preference 记忆自动派生 preference 副本 | `778cd906`

### Step 5: Multi-hop 两轮检索 (retriever.ts)
- 实体驱动的两轮检索 + 并行 follow-up | `86a4f0a3`

---

## 待做：架构改进（借鉴 memL + 自身短板）

### Step 7: Recall Governor — auto-recall 治理层 [高优先级]

**问题**：当前 auto-recall 路径只有 `shouldSkipRetrieval()` (gating) 和 `noise-filter` (事后过滤)。缺少中间治理层：
- 无字符预算控制，注入过多记忆浪费 token
- 无会话去重，同一轮对话里同一条记忆可能被多次注入
- 无状态过滤二次确认（retriever 有 evolution filter 但 auto-recall 路径没有兜底）

**方案**：新增 `recall-governor.ts`，在 auto-recall.ts 的 retrieve 后、返回前插入 6 层治理：
1. Gating — 已有 `shouldSkipRetrieval()`，保持
2. Query 截断 — 超长 query 截断到 1000 chars（省 embedding 成本）
3. 检索 — 已有 HybridRetriever，保持
4. 状态过滤 — 排除 archived/superseded, tier=peripheral
5. 预算控制 — 总字符预算 + 条目数上限（可配置）
6. 会话去重 — 维护本轮已注入 ID set，不重复注入

**文件**：`src/recall-governor.ts`(新增), `src/auto-recall.ts`(接入)
**工作量**：约 120 行 + 测试

---

### Step 8: Admission Control — 写入准入控制 [高优先级]

**问题**：当前记忆写入只有 noise-filter（检索时才过滤）和 write-verifier（写后验证），没有写前门控。低质量记忆进库再过滤不如一开始就拦。

**方案**：新增 `admission-control.ts`，在 capture-engine.ts 的 persistMemory 入口加准入检查：
- 最短文本长度（< 10 chars 拒绝）
- noise-filter 前置（写入前就过滤）
- importance 下限（< 0.2 拒绝或标记 pending_review）
- 重复检测（向量相似度 > 0.95 近似重复直接跳过）
- 每 scope 写入频率限制（防 flood）

**文件**：`src/admission-control.ts`(新增), `src/capture-engine.ts`(接入)
**工作量**：约 80 行 + 测试

---

### Step 9: LLM 降级策略 — dream-pipeline + capture 容错 [中优先级]

**问题**：dream-pipeline 和 LLM importance assessment 依赖外部 LLM。LLM 挂了：
- dream-pipeline 直接失败
- importance 静默跳过（fallback 默认 0.7，还行）
- capture-heuristic 是纯 regex 备选但不在同一链路

**方案**：借鉴 memL 三层降级：
- Level 1: 正常 LLM 调用
- Level 2: 降级 prompt（更短，更高成功率）
- Level 3: 确定性 fallback（零 LLM）
  - dream consolidation: 跳过本轮下次再试
  - importance: heuristic 规则（文本长度 + category 权重）
  - capture: capture-heuristic.ts 的 regex 提取

**文件**：`src/llm-client.ts`(加 degradation wrapper)
**工作量**：约 60 行 + 测试

---

### Step 10: Metadata 显式字段 — 去 JSON bag [中优先级，大工作量]

**问题**：85 处 `JSON.parse(metadata)`。metadata 是 JSON string，塞了 evolution/boundary/anchor/preferenceSlot/pii/tags 等所有东西。每次读都要 parse，LanceDB filter 不能直接用内部字段。

**方案**：高频字段提升为 MemoryEntry 顶级字段：
```
新增：anchor, evolution_status, confidence, access_count,
     last_accessed_at, supersedes, superseded_by, tier
保留 metadata：低频扩展字段仍用 JSON string
```

**风险**：LanceDB schema 变更需重建表，需 migration 脚本。
**工作量**：约 300 行 + migration + 大量测试更新
**建议**：单独一个完整 session，不混其他改动

---

### Step 11: 两段式捕获 — message buffer + batch persist [低优先级]

**问题**：capture-engine 单条同步写入。高频对话产生碎片记忆。

**方案**：借鉴 memL 两段式：
- Stage 1: message_received -> 缓存到内存 buffer
- Stage 2: agent_end（或 buffer 满/超时）-> 批量合并后写入

**价值**：减少碎片，LLM 看到更完整上下文提高提取质量
**工作量**：约 150 行 + event bus 集成
**依赖**：host adapter 需提供 message_received / agent_end 事件

---

## 停车场（不做）

| 方案 | 原因 |
|------|------|
| Extraction prompt 加偏好示例 | 针对题型优化 = 刷分 |
| Reader 升级 | 不是 RecallNest 自身能力 |
| L1 Context Engine | memL 的差异化，RecallNest 定位是 L2 记忆引擎 |
| Embedding 模型更换 | 当前够用 |

---

## 优先级排序

```
高优先级（下一个窗口做）
  Step 7: Recall Governor          ~120 行  <- 生产环境最需要
  Step 8: Admission Control         ~80 行  <- 防垃圾记忆入库

中优先级（之后做）
  Step 9: LLM 降级策略              ~60 行  <- 生产容错
  Step 10: Metadata 显式字段       ~300 行  <- 大重构，单独 session

低优先级（有空再做）
  Step 11: 两段式捕获              ~150 行  <- 需 host adapter 配合
```
