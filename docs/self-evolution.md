# Self-Evolution: How RecallNest Memories Grow and Prune Themselves

> 自我进化原理：RecallNest 的记忆不只是存进去就不管了，它会自己整合、衰减、上浮、检测缺口。

## Overview

Traditional memory systems are append-only: store everything, search later, hope for the best. Over time, they bloat with duplicates, outdated entries, and noise.

RecallNest takes a different approach: **memories evolve**. They consolidate, decay, and surface based on usage — just like biological memory.

```
Store → Classify → Decay → Access → Consolidate → Promote/Demote
  │        │         │        │          │              │
  ▼        ▼         ▼        ▼          ▼              ▼
 New    6 types   Weibull   "Use it    Merge         Core ↔
memory  auto-     curve     or lose    similar       Working ↔
        assigned  over      it"        entries       Peripheral
                  time
```

---

## The Three-Tier Lifecycle

Every memory lives in one of three tiers:

| Tier | Description | Typical Size |
|------|-------------|--------------|
| **Core** | Essential knowledge, accessed frequently | ~5% of total |
| **Working** | Actively useful, moderate access | ~25% of total |
| **Peripheral** | Rarely accessed, candidates for archival | ~70% of total |

> 三层生命周期：核心层（常用的 5%）→ 工作层（中等频率 25%）→ 边缘层（低频 70%）

### Promotion and Demotion

Memories move between tiers based on access patterns:

- **Promotion** (peripheral → working → core): Memory accessed ≥ N times within a window
- **Demotion** (core → working → peripheral): Memory not accessed for extended period
- **Archival**: Peripheral memories with zero access beyond decay threshold get archived (not deleted)

---

## Weibull Decay

RecallNest uses the [Weibull distribution](https://en.wikipedia.org/wiki/Weibull_distribution) for time-based memory decay, inspired by human forgetting curves.

> Weibull 衰减模型比简单的线性衰减更符合人类遗忘曲线：开始衰减慢，后面加速。

### Why Weibull, not Exponential?

| Model | Behavior | Problem |
|-------|----------|---------|
| Linear | Constant decay rate | Too aggressive early on |
| Exponential | Fast initial decay | Important but old memories vanish too quickly |
| **Weibull** | Slow start, accelerating decay | Matches human memory: recent stays fresh, old fades naturally |

### Formula

```
decay(t) = exp(-(t / λ)^k)

where:
  t = days since last access
  λ = scale parameter (half-life, default: 120 days)
  k = shape parameter (default: 1.5, gives the "slow then fast" curve)
```

### Impact on Search

Decay factor multiplies the retrieval score:

```
final_score = relevance_score × decay(days_since_access)
```

A highly relevant but stale memory can still surface if the semantic match is strong enough.

---

## Memory Consolidation

Over time, you accumulate many memories about the same topic. Consolidation merges them.

> 记忆整合：找到主题相近的记忆簇，按策略合并或去重，保持记忆库精简。

### Merge vs. Append Strategies

| Category | Strategy | Why |
|----------|----------|-----|
| `profile` | **Merge** | User identity evolves; latest version wins |
| `preferences` | **Merge** | Preferences update; keep the newest |
| `entities` | **Merge** | Entity info accumulates; consolidate |
| `patterns` | **Merge** | Patterns refine over time |
| `events` | **Append** | Events are facts; dedup but keep distinct entries |
| `cases` | **Append** | Case studies are unique; dedup only exact matches |

### How It Works

1. For each category, compute pairwise cosine similarity
2. Cluster entries with similarity > threshold (default: 0.85)
3. For **merge** categories: LLM combines the cluster into one entry, archives originals
4. For **append** categories: remove exact duplicates, keep distinct entries
5. Update access counts (merged entry inherits the sum)

### Safety

- Default mode is **dry-run**: preview changes before applying
- Original entries are **archived**, never deleted
- Consolidation is triggered manually or via scheduled task, never automatic

---

## Gap Detection

RecallNest tracks what you search for and notices when searches consistently return poor results.

> 缺口检测：分析搜索日志，找出你经常问但记忆库覆盖不足的主题。

### How It Works

1. Log every search query and its top result score
2. Periodically analyze: which topics have avg score < threshold?
3. Cluster low-score queries by topic
4. Generate a gap report with suggestions

### Example Gap Report

```
Topic: "deployment pipeline"
  Searches: 8 in last 30 days
  Avg top score: 0.12
  Suggestion: Consider documenting your deployment workflow

Topic: "API rate limiting"
  Searches: 5 in last 30 days
  Avg top score: 0.18
  Suggestion: Store your rate limiting strategy and past incidents
```

---

## Access-Based Surfacing ("Use It or Lose It")

> 用进废退：经常被搜到的记忆权重上升，长期无人问津的权重下降。

The access tracker records every time a memory appears in search results. This creates a feedback loop:

```
Accessed often → higher tier → higher base score → more likely to surface
Never accessed → lower tier → lower base score → gradually fades
```

This is the "use it or lose it" principle applied to AI memory.

---

## Putting It All Together

A typical memory lifecycle:

1. **Day 0**: New memory stored → classified as `events` → tier: `peripheral`
2. **Day 1-30**: Searched 5 times → promoted to `working`
3. **Day 30-90**: Searched 15 more times → promoted to `core`
4. **Day 120**: Consolidated with 3 similar memories → single refined entry
5. **Day 180+**: Access drops to zero → demoted to `working`
6. **Day 365+**: Still no access → demoted to `peripheral`, Weibull decay significant
7. **Archival**: If importance < threshold after extended inactivity → archived

The result: your memory index stays lean, relevant, and self-maintaining.
