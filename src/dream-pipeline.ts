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
  /** Wall-clock budget for one `dream --auto` sweep, ms (default: 6h).
   *  防跨天兜底闸,不是调度器。2026-07-24 那轮跑了 4 天 15 小时(见 cli.ts --auto 分支
   *  与 scripts/dream-consolidation.sh:57 的注释),期间堵死三天调度。
   *  已知天花板:超预算后剩余 scope 直接丢弃,而每轮都从列表头重来 → 靠后的 scope 会被
   *  系统性饿死。真解是 session scope TTL(只 dream 近 N 天活跃的),不是把预算调大——
   *  scope 数 07-10 是 133、07-29 是 475,只增不减,加预算追不上。 */
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
  autoRunBudgetMs: 6 * 60 * 60 * 1000,
  autoExcludeScopes: ["memory"],
  gc: DEFAULT_AUTO_GC_CONFIG,
};

export interface DreamPhaseResult {
  phase: "orient" | "gather" | "consolidate" | "prune";
  detail: string;
}

export interface DreamResult {
  ran: boolean;
  reason?: string;
  phases: DreamPhaseResult[];
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
    resetWriteCount(scope, statsCfg);
    return { ran: true, reason: "completed_early", phases, stats };
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

    // 3b: LLM-driven cluster consolidation (insights + patterns) — requires LLM
    if (llm) {
      // gather 走 store.list()，其性能优化恒返回 vector:[]（假空数组）——
      // clusterAndConsolidate 进门就按 vector?.length>0 过滤，不回填则 84/84 全被
      // 滤光、聚类空转（2026-07-23 生产实锤：门槛修对后 semantic 仍恒 0 的第二真凶；
      // promote_scan 同款坑 07-21 已修，dream 这条漏了）。
      const vectorMap = await store.getVectors(consolidatable.map(e => e.id));
      const withVectors = consolidatable.map(e => ({ ...e, vector: vectorMap.get(e.id) ?? [] }));
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

  // Reset activity counter after successful dream
  resetWriteCount();

  return { ran: true, phases, stats };
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
    },
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
    "Dream completed",
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
    `  Archived: ${result.stats.archivedCount}`,
  ];

  return lines.join("\n");
}
