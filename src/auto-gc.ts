/**
 * Auto Garbage Collection — Brain-inspired active forgetting.
 *
 * Condition-driven trigger (not cron): runs when memory count exceeds threshold
 * AND enough time has passed since last GC. Inspired by NREM triple-coupling:
 * multiple conditions must be satisfied before consolidation fires.
 *
 * Wraps existing cleanup scripts into a programmatic API.
 */

import type { MemoryStore } from "./store.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AutoGcConfig {
  /** Minimum memories before GC can trigger (default: 1000) */
  minMemoryCount: number;
  /** Minimum hours since last GC (default: 24) */
  minHoursSinceLastGc: number;
  /** Score below which memories are candidates for archival (default: 0.2) */
  staleScoreThreshold: number;
  /** Max entries to archive per run (default: 100) */
  maxArchivePerRun: number;
}

export const DEFAULT_AUTO_GC_CONFIG: AutoGcConfig = {
  minMemoryCount: 1000,
  minHoursSinceLastGc: 24,
  staleScoreThreshold: 0.2,
  maxArchivePerRun: 100,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastGcTimestamp = 0;

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export interface GcResult {
  triggered: boolean;
  reason?: string;
  archivedCount: number;
  totalChecked: number;
}

/**
 * Check conditions and run GC if all thresholds are met.
 * Returns immediately if conditions not met (no-op).
 */
export async function maybeRunGc(
  store: MemoryStore,
  config: AutoGcConfig = DEFAULT_AUTO_GC_CONFIG,
): Promise<GcResult> {
  const stats = await store.stats();
  const totalMemories = stats.total ?? 0;

  // Condition 1: enough memories to warrant GC
  if (totalMemories < config.minMemoryCount) {
    return { triggered: false, reason: "below_memory_threshold", archivedCount: 0, totalChecked: 0 };
  }

  // Condition 2: enough time since last GC
  const hoursSinceLastGc = (Date.now() - lastGcTimestamp) / 3_600_000;
  if (hoursSinceLastGc < config.minHoursSinceLastGc) {
    return { triggered: false, reason: "too_soon", archivedCount: 0, totalChecked: 0 };
  }

  // All conditions met — run GC
  lastGcTimestamp = Date.now();

  // Find stale peripheral memories with low importance and no recent access
  const cutoffMs = Date.now() - 60 * 86_400_000; // 60 days ago
  let archivedCount = 0;
  let totalChecked = 0;

  // Scan memories by listing them
  const entries = await store.list({ limit: 5000 });
  totalChecked = entries.length;

  for (const entry of entries) {
    if (archivedCount >= config.maxArchivePerRun) break;

    let meta: Record<string, any> = {};
    try { meta = JSON.parse(entry.metadata || "{}"); } catch { /* skip */ }

    const isArchived = meta.archived === true;
    if (isArchived) continue;

    const tier = meta.tier || "peripheral";
    const accessCount = meta.accessCount || 0;
    const importance = entry.importance ?? 0;
    const age = Date.now() - entry.timestamp;
    const ageDays = age / 86_400_000;

    // Archive criteria: peripheral + old + low importance + rarely accessed
    if (
      tier === "peripheral" &&
      ageDays > 60 &&
      importance < config.staleScoreThreshold &&
      accessCount < 2
    ) {
      meta.archived = true;
      meta.archivedAt = new Date().toISOString();
      meta.archivedReason = "auto-gc:stale-peripheral";
      await store.update(entry.id, { metadata: JSON.stringify(meta) });
      archivedCount++;
    }
  }

  return { triggered: true, archivedCount, totalChecked };
}

/**
 * Reset last GC timestamp (for testing).
 */
export function resetGcTimestamp(): void {
  lastGcTimestamp = 0;
}
