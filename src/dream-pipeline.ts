/**
 * AD-1: Unified Dream Pipeline
 *
 * Inspired by Claude Code's Auto Dream — a four-phase consolidation pipeline
 * that orchestrates existing RecallNest components into a coherent "dream" cycle.
 *
 * Phases:
 * 1. Orient  — scan memory state, get latest checkpoint, assess activity
 * 2. Gather  — collect recent signals (new writes since last dream)
 * 3. Consolidate — cluster, merge, extract patterns, generate insights
 * 4. Prune   — archive low-value memories, enforce storage hygiene
 *
 * Unlike Auto Dream's grep-only approach, RecallNest uses vector search +
 * LLM-driven consolidation for semantic-level maintenance.
 */

import type { MemoryStorePort } from "./memory-store-port.js";
import type { LLMClient } from "./llm-client.js";
import type { Embedder } from "./embedder.js";
import { ConsolidationEngine, clusterAndConsolidate, DEFAULT_CONSOLIDATION_CONFIG, isDerivedInsight, type ConsolidationKGSource } from "./consolidation-engine.js";
import { maybeRunGc, type GcResult, type AutoGcConfig, DEFAULT_AUTO_GC_CONFIG } from "./auto-gc.js";
import { getWriteCount, resetWriteCount } from "./activity-counter.js";
import { deriveUsageStatus, getUsageMetadata, isUsageSignalActive } from "./usage-tracker.js";
import { isActiveMemory } from "./memory-evolution.js";
import { withLock } from "./distill-lock.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DreamConfig {
  /** Minimum writes since last dream to justify running (default: 10) */
  minWritesForDream: number;
  /** Consolidation cluster threshold (default: 0.82) */
  clusterThreshold: number;
  /** 3b semantic clustering threshold (default: 0.68). 独立于 clusterThreshold——
   *  旧实现用魔法 offset（clusterThreshold - 0.07 = 0.75），2026-07-23 三 scope
   *  真实数据造影：相似度 p99 = 0.736/0.739/0.986，0.75 卡在 p99 之上，semantic
   *  簇恒 0、LLM 从未被调、2716 次运行零 insight。0.68 落在甜点区
   *  （实测每 scope 产 3~7 个 ≥3 簇）；产物质量由 synthesis uptake 指标观察。 */
  semanticClusterThreshold: number;
  /** Minimum cluster size for insight/pattern generation (default: 3) */
  minClusterSize: number;
  /** Enable cross-memory pattern extraction in consolidation (default: true) */
  extractPatterns: boolean;
  /** Max entries to scan per consolidation run (default: 500) */
  maxEntriesPerRun: number;
  /** Wall-clock budget for one `dream --auto` sweep, ms (default: 2h).
   *  防跨天兜底闸,不是调度器。2026-07-24 那轮跑了 4 天 15 小时(见 cli.ts --auto 分支
   *  与 scripts/dream-consolidation.sh:57 的注释),期间堵死三天调度。
   *  2026-08-14: 6h→2h。transcript scope 已整体出队(原文层不参与巩固,cli.ts --auto
   *  的 pruneWriteCounts(isTranscriptScope)),inline 队列只剩个位数 durable scope,
   *  典型轮次分钟级;2h 是纯兜底。单 scope 路径(weekly memory / MCP dream tool)不走
   *  本预算(budget/deadline 只存在于 cli.ts --auto 分支)。env 覆盖:
   *  RECALLNEST_DREAM_BUDGET_MS。 */
  autoRunBudgetMs: number;
  /** Scopes the `--auto` sweep hands off to a dedicated schedule instead of running inline.
   *  Exact match only — a prefix rule would silently swallow future `memory-*` scopes.
   *
   *  2026-07-30 实测的动机：那轮 6 小时只处理了 15/507 个 scope，而这 15 个的规模是
   *  118/37/15/190/3075/84/136/76/14/31/39/15/10/6/55 —— `memory` 一个 scope 独占
   *  3075 条（全部 3891 条的 79%），其余都是几十条的小 scope。配合上面那条「每轮都从
   *  列表头重来」，等于每天花掉整个预算巩固同一个巨型 scope，靠后的 492 个永远排不到。
   *  把它挪进 com.recallnest.dream-memory-weekly（周日 12:00，走 DREAM_SCOPE=memory）
   *  后，日常轮次的预算全部留给小 scope。
   *
   *  这是缓解不是根治：scope 只增不减仍在（07-10 是 133、07-29 是 475、07-30 是 507），
   *  真解仍是 session scope TTL —— 只 dream 近 N 天活跃的。 */
  autoExcludeScopes: readonly string[];
  /** GC config for prune phase */
  gc: AutoGcConfig;
}

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  minWritesForDream: 10,
  clusterThreshold: 0.82,
  semanticClusterThreshold: 0.68,
  minClusterSize: 3,
  extractPatterns: true,
  maxEntriesPerRun: 500,
  autoRunBudgetMs: 2 * 60 * 60 * 1000,
  autoExcludeScopes: ["memory"],
  gc: DEFAULT_AUTO_GC_CONFIG,
};

export interface DreamPhaseResult {
  phase: "orient" | "gather" | "consolidate" | "prune";
  detail: string;
}

/**
 * 一轮 dream 的产出归类（2026-08-12 加）。
 *
 * 存在的理由：在此之前 dream 只报 `status=ok`，而 ok 只证明「没崩」，不证明
 * 「产出了东西」。后台阶段的失败形态是「什么都没发生」，它和「跑完了但确实没
 * 东西可做」在日志里长得一模一样 —— 2026-07-23 查出的语义阈值卡在 p99 之上，
 * 就是这样静默跑了 2716 次零 insight 而无人察觉。
 *
 * 刻意**不**做的事：不设「insight 数 ≥ N」这类闸门。数据真不成簇时零产出是
 * 合法的，给它设下限等于造第三个阈值陷阱（前两个是 0.75 语义阈值和 0.35
 * novelty 门，都因为阈值落在真实数据分布之外而静默归零）。这里只区分
 * 「确有副作用」和「合法空转」，两者都不需要任何可调参数。
 */
export type DreamOutputKind =
  /** 至少写入了一个真实的生命周期副作用（合并/关联/insight/pattern/归档） */
  | "produced"
  /** 四阶段完整跑过，但确实没有值得写入的结果 —— 合法状态，不是失败 */
  | "noop"
  /** 必经阶段没跑（如 consolidate 锁被占），本轮结论不完整 */
  | "partial"
  /** 压根没进管线（写计数不足 / dream 锁被占） */
  | "skipped";

export interface DreamOutput {
  kind: DreamOutputKind;
  /** 为什么不是 produced；produced 时省略 */
  reason?: string;
  /** 本轮真实写入的副作用总数。硬不变量：kind === "produced" <=> effectsWritten > 0 */
  effectsWritten: number;
  /**
   * 结构性健康降级 —— **与 kind 正交，不要合并**。
   *
   * 2026-08-12 实测教训：3a 确定性去重不需要向量，3b 语义聚类需要。向量管线整段
   * 断裂时 3a 照样合并、照样产出副作用，于是 effects > 0 把 kind 顶成了 produced，
   * **一条路径的产出掩盖了另一条路径的完全断裂**。这是"跑完了 ≠ 做成了"的变体：
   * 部分做成了，比全都没做更容易蒙混过关。
   *
   * 所以健康必须单列：produced 也可以是 degraded 的。
   */
  degraded?: "no_llm_configured" | "vector_pipeline_empty";
}

export interface DreamResult {
  ran: boolean;
  reason?: string;
  phases: DreamPhaseResult[];
  /** 本轮到底产出了什么（2026-08-12 加，见 DreamOutputKind 注释） */
  output: DreamOutput;
  stats: {
    totalMemories: number;
    activeMemories: number;
    writesSinceLastDream: number;
    /** 两条聚类路径的总和，保持向后兼容；排障要看下面拆开的两个。 */
    clustersFound: number;
    /** 3a 确定性去重找到的簇（不需要 LLM）。 */
    dedupeClustersFound: number;
    /** 3b 语义聚类里达到 minClusterSize 的簇——只有这些会去调 LLM 生成 insight。 */
    semanticClustersFound: number;
    insightsGenerated: number;
    patternsExtracted: number;
    mergedCount: number;
    archivedCount: number;
    /** 3a 去重路径新建的关联数。此前引擎返回了但被 dream 丢弃，导致「只加了关联」
     *  的一轮会被误判成零产出。 */
    relationsAdded: number;
    /** gather 之后可参与合并的条目数（已排除 dream 自己的派生 insight）。 */
    consolidatableCount: number;
    /** 真正带着非空向量喂进 3b 语义聚类的条目数。
     *  它与 consolidatableCount 的落差就是向量管线的健康读数：
     *  consolidatable > 0 而 vectorFed === 0 是结构性故障、不可能是合法的
     *  ——2026-07-23 那次 store.list() 恒返回假空向量、84/84 全被滤光，就是这个形状。 */
    semanticVectorFed: number;
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function runDreamInner(params: {
  store: MemoryStorePort;
  llm: LLMClient | null;
  embedder: Pick<Embedder, "embedPassage">;
  scope: string;
  config?: Partial<DreamConfig>;
  /** Skip the minimum-writes gate (force run) */
  force?: boolean;
  /** Override the activity-counter stats file (defaults to <dataDir>/activity-stats.json). */
  activityStatsPath?: string;
  /** Optional KG evidence source for triple-overlap merging (null/absent = vector-only) */
  kgStore?: ConsolidationKGSource | null;
}): Promise<DreamResult> {
  const { store, llm, embedder, scope, force = false } = params;
  const config = { ...DEFAULT_DREAM_CONFIG, ...params.config };
  const statsCfg = params.activityStatsPath ? { statsPath: params.activityStatsPath } : undefined;
  const phases: DreamPhaseResult[] = [];

  const stats = {
    totalMemories: 0,
    activeMemories: 0,
    writesSinceLastDream: 0,
    clustersFound: 0,
    dedupeClustersFound: 0,
    semanticClustersFound: 0,
    insightsGenerated: 0,
    patternsExtracted: 0,
    mergedCount: 0,
    archivedCount: 0,
    relationsAdded: 0,
    consolidatableCount: 0,
    semanticVectorFed: 0,
  };

  // =========================================================================
  // Phase 1: Orient — assess current memory state
  // =========================================================================
  const writeCount = getWriteCount(scope, statsCfg);
  stats.writesSinceLastDream = writeCount;

  const storeStats = await store.stats([scope]);
  stats.totalMemories = storeStats.totalCount ?? 0;

  if (!force && writeCount < config.minWritesForDream) {
    return {
      ran: false,
      reason: `insufficient_writes (${writeCount}/${config.minWritesForDream})`,
      output: { kind: "skipped", reason: "insufficient_writes", effectsWritten: 0 },
      phases: [{
        phase: "orient",
        detail: `${stats.totalMemories} memories, ${writeCount} writes since last dream — below threshold`,
      }],
      stats,
    };
  }

  phases.push({
    phase: "orient",
    detail: `${stats.totalMemories} memories, ${writeCount} writes since last dream`,
  });

  // =========================================================================
  // Phase 2: Gather — collect active entries for consolidation
  // =========================================================================
  const entries = await store.list([scope], undefined, config.maxEntriesPerRun, 0);
  const active = entries.filter(e => isActiveMemory(e.metadata));
  stats.activeMemories = active.length;

  // Consolidation derivatives are kept out of the *input* to the next round.
  // A cluster insight is written by the LLM from other entries, so feeding it
  // back as raw material means the next run summarises a summary, and each
  // generation drifts further from what was actually captured with nothing
  // anchoring it back. Their sources stay eligible, so real material still gets
  // re-consolidated as it accumulates.
  //
  // They stay in `active` on purpose: stats and the usage snapshot below are
  // observational, and derivatives are exactly what we want more visibility
  // into, not less. Only consolidation skips them.
  const consolidatable = active.filter(e => !isDerivedInsight(e.metadata));

  // P0 B-1 观察:离线持久化 usageStatus 快照。写入路径不写 status(写入时
  // useCount 必 >0,永远写不出 cold),所以 cold 只能由离线批量 derive 产生。
  // 持久化值仅供 data_checkup/RIF 等观察视图——任何决策路径必须现场
  // deriveUsageStatus(快照会 stale:之后 useCount/accessCount 继续变化)。
  // best-effort:走 patchMetadata 单写通道,失败不阻断 dream。
  // use 信号未采集时整段跳过——否则持久化的全是假 cold(useCount 恒零)。
  let usageSnapshots = 0;
  for (const entry of isUsageSignalActive() ? active : []) {
    const status = deriveUsageStatus(entry);
    const current = getUsageMetadata(entry).usageStatus;
    if (status === current) continue;
    // 默认态(unused 且从无 usage 对象)不写,避免给全库无谓写放大
    if (status === "unused" && current === undefined) continue;
    try {
      await store.patchMetadata(entry.id, meta => {
        const usage = meta.usage && typeof meta.usage === "object" && !Array.isArray(meta.usage)
          ? (meta.usage as Record<string, unknown>)
          : {};
        meta.usage = { ...usage, usageStatus: status };
        return meta;
      });
      usageSnapshots++;
    } catch { /* observation snapshot must never block dream */ }
  }

  stats.consolidatableCount = consolidatable.length;
  const derivedCount = active.length - consolidatable.length;
  phases.push({
    phase: "gather",
    detail: `${active.length} active entries gathered from ${entries.length} total`
      + (derivedCount > 0 ? `; ${derivedCount} derivatives held back from consolidation` : "")
      + (usageSnapshots > 0 ? `; usage snapshot: ${usageSnapshots} statuses persisted` : ""),
  });

  if (consolidatable.length < config.minClusterSize) {
    phases.push({ phase: "consolidate", detail: "skipped — too few active entries" });
    phases.push({ phase: "prune", detail: "skipped — too few entries for GC" });
    await resetWriteCount(scope, statsCfg);
    return {
      ran: true,
      reason: "completed_early",
      // 素材不足是合法的空转，不是失败 —— 这正是「不设 insight 数下限」的理由所在。
      output: { kind: "noop", reason: "too_few_active_entries", effectsWritten: 0 },
      phases,
      stats,
    };
  }

  // =========================================================================
  // Phase 3: Consolidate — cluster, merge, generate insights + patterns
  // =========================================================================

  // P2 (codex): run the consolidation phase under the scope's consolidate lock so a
  // standalone consolidate_memories on the same scope can't run concurrently with the
  // dream's own consolidation. Nested inside the dream lock (dream → consolidate →
  // store-write), consistent with the one-way lock order.
  const consolidateOutcome = await withLock(`consolidate-${scope}`, async () => {
    // 3a: Deterministic consolidation (merge near-duplicates, link clusters)
    const engine = new ConsolidationEngine(store, {
      ...DEFAULT_CONSOLIDATION_CONFIG,
      clusterThreshold: config.clusterThreshold,
      maxEntriesPerRun: config.maxEntriesPerRun,
    }, params.kgStore ?? null);
    const consolidation = await engine.run(scope);
    stats.dedupeClustersFound += consolidation.clustersFound;
    stats.clustersFound += consolidation.clustersFound;
    stats.mergedCount += consolidation.mergedCount;
    stats.relationsAdded += consolidation.relationsAdded;

    // 3b: LLM-driven cluster consolidation (insights + patterns) — requires LLM
    if (llm) {
      // gather 走 store.list()，其性能优化恒返回 vector:[]（假空数组）——
      // clusterAndConsolidate 进门就按 vector?.length>0 过滤，不回填则 84/84 全被
      // 滤光、聚类空转（2026-07-23 生产实锤：门槛修对后 semantic 仍恒 0 的第二真凶；
      // promote_scan 同款坑 07-21 已修，dream 这条漏了）。
      const vectorMap = await store.getVectors(consolidatable.map(e => e.id));
      const withVectors = consolidatable.map(e => ({ ...e, vector: vectorMap.get(e.id) ?? [] }));
      // 回填之后仍为空 = 向量管线断了（见 semanticVectorFed 字段注释）。这里只记数，
      // 判定留给 assertDreamSweepHealth，保持本函数无分支。
      stats.semanticVectorFed = withVectors.filter(e => e.vector.length > 0).length;
      const clusterResult = await clusterAndConsolidate({
        entries: withVectors,
        embedder,
        llm,
        store,
        scope,
        minClusterSize: config.minClusterSize,
        clusterThreshold: config.semanticClusterThreshold,
        extractPatterns: config.extractPatterns,
      });
      stats.semanticClustersFound += clusterResult.clustersFound;
      stats.clustersFound += clusterResult.clustersFound;
      stats.insightsGenerated = clusterResult.insightsGenerated;
      stats.patternsExtracted = clusterResult.patternsExtracted;
    }
  }, { onBusy: "skip", expireMs: 600_000 });

  phases.push({
    phase: "consolidate",
    detail: consolidateOutcome.ran
      // 两条路径分开报：dedupe 那条不需要 LLM，semantic 那条才会去调 LLM 生成 insight。
      // 合成一个数字的话，「semantic 一个合格簇都没凑出来」和「凑出来了但 LLM 没产出」
      // 长得一模一样——2026-07 排查时正是被这个加总带偏的。
      ? `${stats.dedupeClustersFound} dedupe-clusters (${stats.mergedCount} merged), `
        + `${stats.semanticClustersFound} semantic-clusters -> `
        + `${stats.insightsGenerated} insights, ${stats.patternsExtracted} patterns`
      : `skipped — another process holds the consolidate lock for scope ${scope}`,
  });

  // =========================================================================
  // Phase 4: Prune — archive low-value memories
  // =========================================================================
  const gcResult = await maybeRunGc(store, config.gc);
  stats.archivedCount = gcResult.archivedCount;

  phases.push({
    phase: "prune",
    detail: gcResult.triggered
      ? `${gcResult.archivedCount} entries archived`
      : `skipped — ${gcResult.reason}`,
  });

  // Reset activity counter after successful dream.
  //
  // 只在 consolidate 真跑过时才清：锁被占时（onBusy: "skip"）这个 scope 并没有被真正
  // 处理完，计数必须留着等下一轮，否则它会被当成"已处理"而丢掉本轮积累的写入。
  //
  // 2026-08-12 修复：此处原为无参 `resetWriteCount()`，而签名 (activity-counter.ts:110)
  // 要求 scope 必填 —— 运行时不报错，只是静默执行 `delete stats.scopes[undefined]`，
  // 目标 scope 的计数纹丝不动。后果：成功处理的 scope 永远不出队，达标数只增不减
  // （生产实测 85 → 107 → 135 → 563 → 572），每轮从队首重扫同一批最老的 scope，
  // 6h 预算耗尽后排在后面的永远轮不到（日志：已处理 167/563，剩余 396 本轮跳过）。
  // 早退路径 (:226) 一直是对的。源于 d269159（2026-07-02 per-scope 写计数重构）漏改一处，
  // 该 commit message 自己写着「reset 在末尾清该 scope（含 dream 自写→防永动）」——
  // 意图正确、实现漏了一个参数，活了 41 天。codex + kimi 双路独立冷读同时查出。
  //
  // 注意：清对之后，listScopesAboveThreshold 的 FIFO 自组织才真正开始工作 ——
  // 处理完的 scope 被 delete、下次攒够写入重新插入时排到队尾，被跳过的带原计数留在
  // 队首下轮优先。所以这里不需要额外的游标 / checkpoint 文件。
  if (consolidateOutcome.ran) await resetWriteCount(scope, statsCfg);

  const health = assertDreamSweepHealth({
    llmPresent: llm != null,
    consolidatable: stats.consolidatableCount,
    vectorFed: stats.semanticVectorFed,
  });
  const output = classifyDreamOutput({
    consolidateRan: consolidateOutcome.ran,
    effects: countDreamEffects(stats),
    health,
  });

  return { ran: true, output, phases, stats };
}

/**
 * P0-1: run dream under a per-scope cross-process lock. Dream internally does
 * consolidation + gc, so the lock sits at this outermost entry — no nested maintenance
 * locks. If another of the 11 mcp-server processes holds the scope's dream lock, skip
 * rather than queue: a redundant dream on a personal store is pure waste, and the next
 * writer's dream picks up whatever this run skipped.
 */
export async function runDream(params: {
  store: MemoryStorePort;
  llm: LLMClient | null;
  embedder: Pick<Embedder, "embedPassage">;
  scope: string;
  config?: Partial<DreamConfig>;
  /** Skip the minimum-writes gate (force run) */
  force?: boolean;
  /** Override the activity-counter stats file (defaults to <dataDir>/activity-stats.json). */
  activityStatsPath?: string;
  /** Optional KG evidence source for triple-overlap merging (null/absent = vector-only) */
  kgStore?: ConsolidationKGSource | null;
}): Promise<DreamResult> {
  const outcome = await withLock(
    `dream-${params.scope}`,
    () => runDreamInner(params),
    { onBusy: "skip", expireMs: 600_000 },
  );
  if (outcome.ran) return outcome.result;
  return {
    ran: false,
    reason: "locked_by_another_process",
    output: { kind: "skipped", reason: "dream_lock_held", effectsWritten: 0 },
    phases: [{ phase: "orient", detail: `another process holds the dream lock for scope ${params.scope}` }],
    stats: {
      totalMemories: 0,
      activeMemories: 0,
      writesSinceLastDream: 0,
      clustersFound: 0,
      dedupeClustersFound: 0,
      semanticClustersFound: 0,
      insightsGenerated: 0,
      patternsExtracted: 0,
      mergedCount: 0,
      archivedCount: 0,
      relationsAdded: 0,
      consolidatableCount: 0,
      semanticVectorFed: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Output classification (2026-08-12)
// ---------------------------------------------------------------------------

export interface DreamHealthVerdict {
  healthy: boolean;
  /** 不健康时的机器可读原因；健康时省略 */
  reason?: "no_llm_configured" | "vector_pipeline_empty";
}

/**
 * 结构性健康断言 —— **只认两种确定性零值**，零歧义、免调参、误伤面≈0。
 *
 * 为什么是这两个而不是「insight 数 < N」：这个库已经被阈值坑过两次
 * （0.75 语义聚类阈值卡在真实 p99 之上；0.35 novelty 门把最相关的命中全排除），
 * 共同形状都是**断言条件依赖数据分布**，分布一偏就静默归零。下面两条都不依赖
 * 任何分布，它们描述的是结构断裂，不是数据稀疏：
 *
 * 1. `llmPresent === false` —— 没配 LLM 时 3b 整段不跑，insight 恒为 0。
 *    这是确定性的配置缺陷，不是「今天数据不成簇」。
 * 2. `consolidatable > 0 但 vectorFed === 0` —— 有素材可聚，却一条带向量的都没有。
 *    dream 在调用前刚做完 getVectors 回填，回填后还全空只有一种解释：向量管线断了。
 *    这正是 2026-07-23 第二真凶（store.list() 恒返回假空向量）的复发通道。
 *
 * 刻意留在门外的：`maxPairSim < threshold`（能结构性判定「阈值又落在分布之上」）
 * 只适合当观察字段，不适合当闸门 —— 数据真分散时它会天天告警，而告警疲劳比没有
 * 告警更糟。
 */
export function assertDreamSweepHealth(input: {
  llmPresent: boolean;
  consolidatable: number;
  vectorFed: number;
}): DreamHealthVerdict {
  if (!input.llmPresent) return { healthy: false, reason: "no_llm_configured" };
  if (input.consolidatable > 0 && input.vectorFed === 0) {
    return { healthy: false, reason: "vector_pipeline_empty" };
  }
  return { healthy: true };
}

/** 本轮真实写入的生命周期副作用总数。五项都是「库里确实多/少了东西」，
 *  不含任何只读统计 —— 这是 produced/noop 之分的唯一依据。 */
export function countDreamEffects(stats: DreamResult["stats"]): number {
  return stats.mergedCount
    + stats.relationsAdded
    + stats.insightsGenerated
    + stats.patternsExtracted
    + stats.archivedCount;
}

/**
 * 产出计量行的唯一格式来源。
 *
 * 抽出来是因为它有一个**进程外的消费者**：`dream-consolidation.sh` 的存在性闸靠
 * 字面量 `[[DREAM_METRICS]]` 匹配，报了 ok 却没有这行就判整轮失败。两条 CLI 路径
 * （`--auto` 与单 scope）各写一份格式，迟早漂；漂了的那条会被闸当成"断言缺失"误杀。
 *
 * 2026-08-13 补单 scope 路径时发现：`--scope memory` 分支**从来没打过这行**，
 * 而闸是 08-12 加的 —— 也就是说 08-16 周日的 memory 轮次即使跑成功也会被判失败。
 * 这是那道闸的第一个真实误伤（它自称"误伤面≈0"，成立的前提是所有 ok 路径都打这行）。
 */
export function formatDreamMetrics(input: {
  tally: Record<DreamOutputKind, number>;
  degraded: number;
  effects: number;
  processed: number;
  total: number;
}): string {
  return `[[DREAM_METRICS]] produced=${input.tally.produced} noop=${input.tally.noop} `
    + `partial=${input.tally.partial} skipped=${input.tally.skipped} `
    + `degraded=${input.degraded} effects=${input.effects} `
    + `processed=${input.processed}/${input.total}`;
}

/** 把一轮 dream 归类。硬不变量：`kind === "produced"` <=> `effectsWritten > 0`。 */
export function classifyDreamOutput(input: {
  consolidateRan: boolean;
  effects: number;
  health: DreamHealthVerdict;
}): DreamOutput {
  // 必经阶段没跑完，本轮结论不完整 —— 不能算 noop（那会掩盖「没跑」和「跑了没东西」的区别），
  // 也不能算 produced。partial 同时是「不要清写计数」的信号。
  // degraded 独立于 kind 计算：结构断裂不该被另一条路径的产出掩盖（见 DreamOutput.degraded）。
  const degraded = input.health.healthy ? undefined : input.health.reason;

  if (!input.consolidateRan) {
    return { kind: "partial", reason: "consolidate_lock_held", effectsWritten: input.effects, degraded };
  }
  if (input.effects > 0) return { kind: "produced", effectsWritten: input.effects, degraded };
  return {
    kind: "noop",
    // 健康的零产出叫 no_qualified_work（合法）；不健康的零产出直接把故障原因摆在 reason 上。
    reason: degraded ?? "no_qualified_work",
    effectsWritten: 0,
    degraded,
  };
}

// ---------------------------------------------------------------------------
// Failure triage (--auto sweep)
// ---------------------------------------------------------------------------

export type DreamFailureKind = "transient" | "fatal";

/** 已知的环境性失败——重跑同一轮救不了,也不代表代码/数据有缺陷。
 *  故意用精确 pattern 而非宽泛关键词:分类错成 transient 会静默真 bug,
 *  错成 fatal 只是多一次告警。拿不准就让它落到 fatal。 */
const TRANSIENT_FAILURE_PATTERNS: readonly RegExp[] = [
  /lock '[^']*' timed out/i,      // distill-lock.ts 跨进程 store-write 锁竞争
  /request was aborted/i,          // llm-client.ts:757 的 15s AbortController 超时
  /econnreset|etimedout|socket hang up|fetch failed/i, // 网络层
];

/**
 * 把单个 scope 的 dream 失败分成「环境性瞬态」和「代码/数据缺陷」。
 *
 * 2026-07-29 生产分诊依据(dream-consolidation-launchd.log):
 *   fatal     — `TypeError: Array.from requires an array-like object`(store.ts 病行,d1a2a9c 已修)
 *   transient — `lock 'store-write' timed out after 10000ms (held by another process)`
 *   transient — `Error: Request was aborted.`
 */
export function classifyDreamFailure(message: string): DreamFailureKind {
  return TRANSIENT_FAILURE_PATTERNS.some(re => re.test(message)) ? "transient" : "fatal";
}

/** transient 失败占比超过这个比例仍判整轮失败——否则"475 个全被锁挡住"会假绿。 */
export const DREAM_TRANSIENT_BLOCK_RATIO = 0.2;

/**
 * 一轮 `dream --auto` 是否该判 blocked。
 *
 * 旧语义是「任意一个 scope 抛异常即 blocked」,在 475 个 scope 的规模下等于
 * 「有一个撞上锁就整轮红」,而红了会让 shell 脚本走重试 → 重跑全量。
 * 新语义:代码/数据缺陷一票否决;环境性失败要成规模才算整轮失败。
 */
export function shouldBlockDreamRun(params: {
  totalScopes: number;
  fatalFailures: number;
  transientFailures: number;
}): boolean {
  if (params.fatalFailures > 0) return true;
  if (params.totalScopes <= 0) return false;
  return params.transientFailures / params.totalScopes > DREAM_TRANSIENT_BLOCK_RATIO;
}

/**
 * 把 `--auto` 的达标 scope 列表拆成「本轮跑」和「交给专用 schedule」两份。
 *
 * 精确匹配,不做前缀——前缀规则会连带吞掉将来可能出现的 `memory-*`。
 * 保持原顺序:调用方靠列表顺序决定谁先跑,排序策略的改动不该藏进这个函数。
 *
 * 用处见 DreamConfig.autoExcludeScopes 的注释:2026-07-30 实测 `memory` 一个 scope
 * 独占 79% 的记忆条数,把它挪走后日常轮次的 6h 预算才轮得到靠后的小 scope。
 */
export function partitionAutoDreamScopes(
  scopes: readonly string[],
  excluded: readonly string[],
): { run: string[]; deferred: string[] } {
  const excludeSet = new Set(excluded);
  const run: string[] = [];
  const deferred: string[] = [];
  for (const scope of scopes) {
    (excludeSet.has(scope) ? deferred : run).push(scope);
  }
  return { run, deferred };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatDreamResult(result: DreamResult): string {
  if (!result.ran) {
    return `Dream skipped: ${result.reason}\n${result.phases[0]?.detail ?? ""}`;
  }

  const lines = [
    // 只有真写入了副作用才说 completed；合法空转说 noop，必经阶段没跑说 partial。
    // 「跑完了」和「做成了」从这里开始就不再是同一句话。
    result.output.kind === "produced" ? "Dream completed" : `Dream ${result.output.kind}`,
    "",
    ...result.phases.map(p => `[${p.phase}] ${p.detail}`),
    "",
    "Stats:",
    `  Total memories: ${result.stats.totalMemories}`,
    `  Active: ${result.stats.activeMemories}`,
    `  Clusters: ${result.stats.clustersFound} (dedupe ${result.stats.dedupeClustersFound} + semantic ${result.stats.semanticClustersFound})`,
    `  Insights: ${result.stats.insightsGenerated}`,
    `  Patterns: ${result.stats.patternsExtracted}`,
    `  Merged: ${result.stats.mergedCount}`,
    `  Relations: ${result.stats.relationsAdded}`,
    `  Archived: ${result.stats.archivedCount}`,
    // 漏斗读数：consolidatable → vector-fed → semantic 簇 → insight。
    // 哪一级掉到 0，断在哪一级就一目了然，不用再去猜。
    `  Funnel: ${result.stats.consolidatableCount} consolidatable -> `
      + `${result.stats.semanticVectorFed} vector-fed -> `
      + `${result.stats.semanticClustersFound} semantic-clusters -> `
      + `${result.stats.insightsGenerated} insights`,
    `  Output: ${result.output.kind}`
      + (result.output.reason ? ` (${result.output.reason})` : "")
      + ` — ${result.output.effectsWritten} effects written`,
    ...(result.output.degraded
      ? [`  ⚠ DEGRADED: ${result.output.degraded} — 有产出不代表没断，见上面的 Funnel`]
      : []),
  ];

  return lines.join("\n");
}
