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
import { ConsolidationEngine, clusterAndConsolidate, DEFAULT_CONSOLIDATION_CONFIG } from "./consolidation-engine.js";
import { maybeRunGc, type GcResult, type AutoGcConfig, DEFAULT_AUTO_GC_CONFIG } from "./auto-gc.js";
import { getWriteCount, resetWriteCount } from "./activity-counter.js";
import { deriveUsageStatus, getUsageMetadata, isUsageSignalActive } from "./usage-tracker.js";
import { isActiveMemory } from "./memory-evolution.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DreamConfig {
  /** Minimum writes since last dream to justify running (default: 10) */
  minWritesForDream: number;
  /** Consolidation cluster threshold (default: 0.82) */
  clusterThreshold: number;
  /** Minimum cluster size for insight/pattern generation (default: 3) */
  minClusterSize: number;
  /** Enable cross-memory pattern extraction in consolidation (default: true) */
  extractPatterns: boolean;
  /** Max entries to scan per consolidation run (default: 500) */
  maxEntriesPerRun: number;
  /** GC config for prune phase */
  gc: AutoGcConfig;
}

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  minWritesForDream: 10,
  clusterThreshold: 0.82,
  minClusterSize: 3,
  extractPatterns: true,
  maxEntriesPerRun: 500,
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
    clustersFound: number;
    insightsGenerated: number;
    patternsExtracted: number;
    mergedCount: number;
    archivedCount: number;
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runDream(params: {
  store: MemoryStorePort;
  llm: LLMClient | null;
  embedder: Pick<Embedder, "embedPassage">;
  scope: string;
  config?: Partial<DreamConfig>;
  /** Skip the minimum-writes gate (force run) */
  force?: boolean;
}): Promise<DreamResult> {
  const { store, llm, embedder, scope, force = false } = params;
  const config = { ...DEFAULT_DREAM_CONFIG, ...params.config };
  const phases: DreamPhaseResult[] = [];

  const stats = {
    totalMemories: 0,
    activeMemories: 0,
    writesSinceLastDream: 0,
    clustersFound: 0,
    insightsGenerated: 0,
    patternsExtracted: 0,
    mergedCount: 0,
    archivedCount: 0,
  };

  // =========================================================================
  // Phase 1: Orient — assess current memory state
  // =========================================================================
  const writeCount = getWriteCount();
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

  phases.push({
    phase: "gather",
    detail: `${active.length} active entries gathered from ${entries.length} total`
      + (usageSnapshots > 0 ? `; usage snapshot: ${usageSnapshots} statuses persisted` : ""),
  });

  if (active.length < config.minClusterSize) {
    phases.push({ phase: "consolidate", detail: "skipped — too few active entries" });
    phases.push({ phase: "prune", detail: "skipped — too few entries for GC" });
    resetWriteCount();
    return { ran: true, reason: "completed_early", phases, stats };
  }

  // =========================================================================
  // Phase 3: Consolidate — cluster, merge, generate insights + patterns
  // =========================================================================

  // 3a: Deterministic consolidation (merge near-duplicates, link clusters)
  const engine = new ConsolidationEngine(store, {
    ...DEFAULT_CONSOLIDATION_CONFIG,
    clusterThreshold: config.clusterThreshold,
    maxEntriesPerRun: config.maxEntriesPerRun,
  });
  const consolidation = await engine.run(scope);
  stats.clustersFound += consolidation.clustersFound;
  stats.mergedCount += consolidation.mergedCount;

  // 3b: LLM-driven cluster consolidation (insights + patterns) — requires LLM
  if (llm) {
    const clusterResult = await clusterAndConsolidate({
      entries: active,
      embedder,
      llm,
      store,
      scope,
      minClusterSize: config.minClusterSize,
      clusterThreshold: config.clusterThreshold - 0.07, // slightly lower for semantic clustering
      extractPatterns: config.extractPatterns,
    });
    stats.clustersFound += clusterResult.clustersFound;
    stats.insightsGenerated = clusterResult.insightsGenerated;
    stats.patternsExtracted = clusterResult.patternsExtracted;
  }

  phases.push({
    phase: "consolidate",
    detail: `${stats.clustersFound} clusters, ${stats.mergedCount} merged, ${stats.insightsGenerated} insights, ${stats.patternsExtracted} patterns`,
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
    `  Clusters: ${result.stats.clustersFound}`,
    `  Insights: ${result.stats.insightsGenerated}`,
    `  Patterns: ${result.stats.patternsExtracted}`,
    `  Merged: ${result.stats.mergedCount}`,
    `  Archived: ${result.stats.archivedCount}`,
  ];

  return lines.join("\n");
}
