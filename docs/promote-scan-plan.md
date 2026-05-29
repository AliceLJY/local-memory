# Promote-Scan 自动晋升管线 — 实现 Plan

> capture 治本第二批(B)。目标:让高频出现的 downgraded transcript evidence(原 profile/preferences)**自动**晋升回 durable,不再依赖 CC 手动 `promote_memory`。
> 根因:production 库 preferences 仅 140 / profile 84 / skills 3——transcript ingest 把抽出的偏好/身份降级成 events 后,没有自动晋升路径(`memory-boundaries.ts:165`)。
> 状态:**待实现**(建议 fresh session + Codex 二审 plan,因为改入库逻辑)。

## 地基(已就绪,无需再做)

- ✅ 降级标记:transcript ingest 把 profile/preferences 降级成 events,metadata 标 `boundary.downgradedFrom`(memory-boundaries.ts:165-176)
- ✅ 晋升工具:`promoteMemory`(capture-engine.ts:1182)+ `promote_memory` MCP tool,默认升回 `originalCategory`/`downgradedFrom`
- ✅ 批量取向量:`store.getVectors`(已加分批,v2.5.3 第1步)
- ✅ canonicalKey 正确性:#1/#6 已修(本轮),晋升出的 preferences key 不互撞 → dedup 幂等可靠

## 设计:新文件 `src/memory-promotion.ts`

```
scanMemoryPromotions(deps, scope, config?): Promise<PromoteScanResult>
```

1. `store.list([scope], "events", LIMIT=2000, 0)` 取 events
2. filter:`boundary.downgradedFrom ∈ {profile, preferences}` && active && 未晋升(metadata 无 `promotedTo` 标记)
3. `store.getVectors(ids)` 补向量(list 返回空向量)
4. 按 `downgradedFrom` 分两组(profile / preferences,目标 category 不同)
5. 每组向量贪心聚类(cosineSimilarity ≥ clusterThreshold;复用/导出 skill-promotion 的 `greedyCluster`,或 consolidation-engine 的聚类)
6. 晋升候选:`cluster.members.length ≥ minOccurrences` && 平均 importance ≥ `minImportance`
7. 对每个候选 cluster 的 seed(importance 最高),调 `promoteMemory({ memoryId: seed.id, category: downgradedFrom, scope, importance })`
8. 去重:`promoteMemory` 内部 `writeDurableEntry` 按 canonicalKey dedup 幂等(#1/#6 修好后可靠);可选给 source evidence 标 `promotedTo` 避免重复扫(注意 store.update 的 #19 非原子,优先依赖 dedup 幂等)
9. 返回 `{ promoted: [...], scannedEvidence, clusters, dryRun }`

## 阈值(Alice 2026-05-29 认可的默认,可调)

- `minOccurrences = 3`(同一偏好/身份在 transcript 聚类出现 ≥3 次才晋升,防随口一说进 durable)
- `minImportance = 0.6`
- `clusterThreshold = 0.82`(参考 consolidation/skill-promotion)

## 暴露

- MCP tool:`promote_scan(scope, dryRun?)`——仿 `scan_skill_promotions`。**默认 dryRun=true**(先看候选不实际写,安全)
- CLI:`bun run src/cli.ts promote-scan [--scope] [--apply]`(默认 dry-run,--apply 才真晋升)

## 测试(新功能必配,mock 复刻真实)

- mock store:`list` 返回 downgraded events(空向量,复刻真实)+ `getVectors` 补向量 + `get`/`update`(promoteMemory 需要)
- 用例:≥3 次同义聚类才晋升 / <3 不晋升 / importance 阈值 / 晋升 category=downgradedFrom / 幂等(重复扫不重复晋升)/ dryRun 不写

## 验证(临床终点,不是单测绿)

1. `promote-scan --scope ... `(dry-run)看 production 能晋升出多少 preferences/profile 候选 + 质量抽查
2. `--apply` 后 `memory_stats` 看 preferences/profile 真涨了
3. 重跑 `bun run eval:continuity`,看写作风格类(之前 0–37%)召回是否提升(偏好/身份进 durable 后)
4. 调 1–2 轮阈值平衡"晋升够多" vs "不进噪声"

## 风险/取舍

- 太松 → 噪声进 durable;太严 → 还是稀疏。靠 dry-run + eval 调阈值。
- 晋升后与现有 durable 的冲突:`promoteMemory` 已走 writeDurableEntry 的 conflict 检测(canonicalKey 冲突 → conflict candidate),沿用即可。

## 依赖顺序

1. ✅ #1/#6 canonicalKey 修复(v2.5.x,本轮)
2. ✅ getVectors 分批(v2.5.3 第1步)
3. ⬜ `memory-promotion.ts` + 测试
4. ⬜ MCP/CLI 暴露(默认 dry-run)
5. ⬜ dry-run 看 production 候选质量 → eval 验证 → 阈值调优 → 开 --apply
6. ⬜ 整体 capture 治本完成后 release(v2.5.4 或 v2.6.0)+ CHANGELOG

## 备注

- 本 plan 由 2026-05-29 临床评估 + Codex trio 二审产出(综合报告:`~/Desktop/recallnest-clinical-synthesis-2026-05-29.md`)。
- 与 A(distill profile 维度,本轮已做)互补:A 让 distill 主动提炼身份;B 让 transcript 高频偏好自动沉淀——两条路一起填 preferences/profile 稀疏。
