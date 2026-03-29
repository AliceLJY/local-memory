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

  return { triggered: true, consolidation: result };
}

/**
 * Reset state (for testing).
 */
export function resetConsolidationState(): void {
  lastRunTimestamp = 0;
  lastRunMemoryCount = 0;
}
