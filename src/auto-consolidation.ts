/**
 * Auto Consolidation — Condition-driven consolidation trigger.
 *
 * Agent-First reasoning: manual consolidation is unsustainable. Trigger
 * automatically when enough new memories have accumulated AND enough time
 * has passed since the last run. Same dual-gate pattern as auto-gc.ts.
 *
 * Brain-science label: "NREM triple-coupling" — multiple conditions must
 * align before consolidation fires. The label is for branding; the real
 * reason is operational hygiene.
 */

import type { MemoryStore } from "./store.js";
import { ConsolidationEngine, type ConsolidationConfig, type ConsolidationResult, DEFAULT_CONSOLIDATION_CONFIG } from "./consolidation-engine.js";
import type { LLMClient } from "./llm-client.js";
import { isLLMConsolidationEnabled, evaluateCluster, executeMergeDecisions } from "./llm-consolidation.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AutoConsolidationConfig {
  /** Minimum new memories since last consolidation before triggering (default: 50) */
  minNewMemories: number;
  /** Minimum hours since last consolidation (default: 12) */
  minHoursSinceLastRun: number;
  /** Consolidation engine config (cluster/merge thresholds) */
  consolidation: ConsolidationConfig;
}

export const DEFAULT_AUTO_CONSOLIDATION_CONFIG: AutoConsolidationConfig = {
  minNewMemories: 50,
  minHoursSinceLastRun: 12,
  consolidation: DEFAULT_CONSOLIDATION_CONFIG,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastRunTimestamp = 0;
let lastRunMemoryCount = 0;

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export interface AutoConsolidationResult {
  triggered: boolean;
  reason?: string;
  consolidation?: ConsolidationResult;
}

/**
 * Check conditions and run consolidation if thresholds are met.
 * Returns immediately if conditions not met (no-op).
 */
export async function maybeConsolidate(
  store: MemoryStore,
  scope: string,
  config: AutoConsolidationConfig = DEFAULT_AUTO_CONSOLIDATION_CONFIG,
  /** Tier 3.7: Optional LLM client for semantic consolidation decisions */
  llm?: LLMClient | null,
): Promise<AutoConsolidationResult> {
  const stats = await store.stats([scope]);
  const currentCount = stats.total ?? 0;

  // Condition 1: enough new memories since last run
  const newSinceLastRun = currentCount - lastRunMemoryCount;
  if (newSinceLastRun < config.minNewMemories) {
    return { triggered: false, reason: "insufficient_new_memories" };
  }

  // Condition 2: enough time since last run
  const hoursSinceLastRun = (Date.now() - lastRunTimestamp) / 3_600_000;
  if (hoursSinceLastRun < config.minHoursSinceLastRun) {
    return { triggered: false, reason: "too_soon" };
  }

  // Both conditions met — run consolidation
  lastRunTimestamp = Date.now();
  lastRunMemoryCount = currentCount;

  const engine = new ConsolidationEngine(store, config.consolidation);
  const result = await engine.run(scope);

  // Tier 3.7: LLM post-processing of linked clusters.
  // When enabled, LLM evaluates "clustered_with" relations and may
  // upgrade them to version groups (merges) based on semantic judgment.
  if (isLLMConsolidationEnabled() && llm && result.relationsAdded > 0) {
    let llmMerges = 0;
    // Find entries with clustered_with that aren't already in version groups
    const allEntries = await store.list([scope], undefined, config.consolidation.maxEntriesPerRun ?? 500);
    const clusterMap = new Map<string, MemoryEntry[]>();

    for (const entry of allEntries) {
      try {
        const meta = JSON.parse(entry.metadata || "{}");
        const members = meta.cluster_members as string[] | undefined;
        if (Array.isArray(members) && members.length > 0 && !meta.version_group) {
          const cluster = [entry];
          for (const memberId of members) {
            const member = await store.getById(memberId);
            if (member) cluster.push(member);
          }
          if (cluster.length >= 2) {
            clusterMap.set(entry.id, cluster);
          }
        }
      } catch { /* skip */ }
    }

    for (const [, cluster] of clusterMap) {
      const decision = await evaluateCluster(llm, cluster);
      const merges = await executeMergeDecisions(store, cluster, decision, scope);
      llmMerges += merges;
    }

    if (llmMerges > 0) {
      result.mergedCount += llmMerges;
    }
  }

  return { triggered: true, consolidation: result };
}

/**
 * Reset state (for testing).
 */
export function resetConsolidationState(): void {
  lastRunTimestamp = 0;
  lastRunMemoryCount = 0;
}
