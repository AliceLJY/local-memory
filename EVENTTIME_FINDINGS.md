# eventTime 供数探索 — dry-run 证否记录

> 2026-07（worktree: temporal-probe）。**负结果留档**：从存量记忆文本用正则回填
> `eventTime` 不可行；同时留下可复用的纯函数 + 只读审计器 + 证据链。

## 背景

时间推理是 RecallNest 的召回短板（LongMemEval 时间推理 ~15.8%，约 62% 是检索失败）。
排查真码发现：F3 时间有效性过滤（`retriever.ts` 的 validity filter + `temporal-parser`）
逻辑健全、且默认接入检索管线，但它依赖的 `eventTime`（事件真实时间，区别于存储时间
`timestamp`）字段在写入侧从不填充。

## 填充率铁证

只读审计（`scripts/eventtime-extract-audit.ts`，采样 4 万条真实库）：

- `eventTime` 已填充：**0.00%**（字段建好、writer 从未供数）
- `validUntil` 已填充：**0.00%**
- 典型的「功能看似上线、实则半空转：reader 存在不等于 writer 生效」

## 为什么「正则回填」被否

尝试：复用 `temporal-parser` 的**绝对时间锚**（年 / 年-月，无 `Date.now()` 依赖，
相对词如「上周」会 mis-anchor 故跳过），从记忆文本抽 `eventTime`。dry-run 双否决：

1. **数量**：仅 **1.70%** 记忆含绝对时间锚（events 1.9% / cases 1.45% / entities 2.15%）。
2. **质量（致命）**：这 1.7% 里，绝对时间绝大多数是**记忆内容引用的时间**，而不是
   「这条记忆记录的事儿发生在何时」——例如「广歌自 2017 年实施艺衔制」（历史沿革）、
   「《都是龙袍惹的祸》2013 年首演」（剧目年份）、「2026 年 6 月前完成消防升级」（未来计划）。
   把这些写进 `eventTime` 是往检索里灌噪声。

## 结论与边界

- **不做存量正则回填**：绝对锚覆盖率低 + 内容时间 ≠ 事件时间，写库即污染。
- eventTime 供数本质是 **extraction 语义判断问题**（判断「哪个时间才是记忆主体事件的时间」），
  正则不可解；需 LLM 语义判断，撞 **2026-05-13「算法层暂缓、等 eval 说服力」决策**，
  不在无 eval 驱动时启动。
- **可行方向（未来）**：在新记忆摄入时由写入侧 agent 做语义判断来供 `eventTime`，
  而非事后对存量正则回填。

## 本次留下的可复用资产

- `extractEventTimeFromText(text)` — 绝对时间锚抽取纯函数（`src/temporal-parser.ts`），
  7 个单测全绿，将来限定场景供数可直接复用。
- `scripts/eventtime-extract-audit.ts` — 只读审计器，可随时复跑重新评估 temporal 供数可行性。

## 验证

改动全部无副作用（纯函数 + 只读脚本 + 测试，未改任何现有检索逻辑）。
全量 `bun test`：**1807 pass / 0 fail**。
