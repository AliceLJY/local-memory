# RecallNest 召回优化实施清单

> 2026-04-01 发现问题：高频信息（如"轮巡仓库"）召回失败
> 根因：短查询 vs 长文档 embedding 距离过大 + 无频率加权
> 与已有 P1-P5 互补，本清单聚焦**检索召回**环节

---

## P0: 短查询召回增强（优先级最高）

### P0.1 双层索引 — 原文 + 检索锚点

- [ ] `capture-engine.ts` / `ingest.ts`：存储时同时生成一句话摘要（≤80 chars），存入 `metadata.anchor`
- [ ] `search.ts`：检索时同时搜原文向量和 anchor 向量，取 max score
- [ ] 效果：短 query "轮巡仓库" 匹配短 anchor "每日轮巡4个win4r仓库"，距离大幅缩短
- **预估:** ~120 LOC
- **风险:** 低——不改原文存储，纯增量字段
- **依赖:** 无

### P0.2 高频 boost — 重复提及自动提权

- [ ] 新增 `frequency-tracker.ts`：记录 query→memory 的命中次数
- [ ] 评分公式：`final_score = base_score × (1 + log2(hit_count) × boost_factor)`
- [ ] hit_count ≥ 3 → peripheral 自动升为 core tier
- [ ] 持久化：写入 `data/frequency-stats.json`，跨 session 累积
- **预估:** ~100 LOC
- **风险:** 中——需要平衡 boost 幅度，避免旧高频记忆永远压过新记忆
- **依赖:** 无

### P0.3 短查询自动扩展

- [ ] `search.ts`：检测 query ≤ 6 字符时，调用 LLM 扩展为 3-5 个同义关键词
- [ ] 扩展结果缓存到 `data/query-expansion-cache.json`，相同 query 不重复调用
- [ ] 备选：不用 LLM，维护一个 `data/alias-map.json` 手动/自动映射（"轮巡" → "轮巡 仓库 patrol repo 每日检查"）
- **预估:** ~60 LOC（alias-map 方案）/ ~100 LOC（LLM 方案）
- **风险:** alias-map 低；LLM 方案增加延迟 ~200ms
- **依赖:** 无

---

## 高频 vs 查重 平衡机制（P0.2 的关键设计）

### 问题

高频 boost 和去重是一对矛盾：
- **boost 说**：提到 10 次的东西一定重要，提权！
- **dedup 说**：同一条信息存了 10 遍，应该合并！

### 设计方案：分层计数，不是分层存储

```
存储层：dedup 照做，相同内容只保留 1 条（现有 consolidation 逻辑不变）
计数层：新增 frequency-tracker，记录的是 **query 命中次数**，不是存储条数
```

**关键区分：**

| 维度 | 存储去重 | 召回加权 |
|------|---------|---------|
| 触发时机 | 写入时（store/ingest） | 检索时（search） |
| 操作对象 | 重复的 memory 条目 | query→memory 的命中频率 |
| 目标 | 数据库不膨胀 | 高频信息排前面 |
| 互相影响 | 不影响——去重后只剩 1 条，但那 1 条的 hit_count 持续累积 |

### 边界情况处理

1. **旧高频 vs 新相关**
   - 时间衰减：`effective_hits = hit_count × decay(days_since_last_hit)`
   - 30 天没被命中 → hit_count 等效减半，不会永远霸榜

2. **高频但已过时**
   - 用户说"轮巡仓库从4个变成3个了" → store_memory 更新
   - 旧条目被 consolidation 标记为 superseded → hit_count 不继承
   - 新条目从 0 开始计，但因为用户接下来会频繁触发，很快追上

3. **频率统计粒度**
   - 按 memory_id 计数，不按 query 文本
   - "轮巡" "轮巡仓库" "patrol repo" 命中同一条 memory → 同一个 counter +1
   - 避免同义词分散计数

---

## 与现有 P1-P5 的关系

| 现有项 | 关系 |
|--------|------|
| P1 摘要保真 | P0.1 的 anchor 生成需要 P1 的保真约束，但可并行开发 |
| P2 聚类摘要 | 互补——P2 解决注入时省 token，P0 解决检索时找得到 |
| P3 增量 ingest | P0.1 的 anchor 字段需要对已有数据 backfill，P3 的增量逻辑可复用 |
| P4 data-checkup | 可加一项检查：anchor 字段覆盖率（多少 memory 已有 anchor） |
| P5 大文件门控 | 无直接关系 |

---

## 验证标准

- [ ] `search_memory("轮巡")` → 返回轮巡仓库相关记忆，score ≥ 70%
- [ ] `search_memory("轮巡仓库")` → 返回结果，score ≥ 80%
- [ ] 高频记忆（命中 ≥5 次）自动出现在 `resume_context` 的 core 区
- [ ] 去重后数据库条目数不增长（frequency 只在 tracker 层累积）
