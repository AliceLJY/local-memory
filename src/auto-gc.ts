/**
 * Auto Garbage Collection — Brain-inspired active forgetting.
 *
 * Condition-driven trigger (not cron): runs when memory count exceeds threshold
 * AND enough time has passed since last GC. Inspired by NREM triple-coupling:
 * multiple conditions must be satisfied before consolidation fires.
 *
 * B-2 upgrade: Uses evolution system's computeDecayScore + buildArchivedMetadata
 * instead of raw age/importance heuristics. Archive-first, delete-never.
 */

import type { MemoryStore } from "./store.js";
import {
  parseEvolution,
  computeDecayScore,
  buildArchivedMetadata,
  isActiveMemory,
} from "./memory-evolution.js";
import { loadRetentionPolicy, shouldArchiveByPolicy } from "./retention-policy.js";
import type { RetentionPolicy } from "./retention-policy.js";
import type { AuditLogger } from "./audit-log.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AutoGcConfig {
  /** Minimum memories before GC can trigger (default: 1000) */
  minMemoryCount: number;
  /** Minimum hours since last GC (default: 24) */
  minHoursSinceLastGc: number;
  /** Decay score below which memories are archive candidates (default: 0.15) */
  decayScoreThreshold: number;
  /** Max entries to archive per run (default: 100) */
  maxArchivePerRun: number;
  /** Minimum age in days before a memory can be archived (default: 30) */
  minAgeDays: number;
}

export const DEFAULT_AUTO_GC_CONFIG: AutoGcConfig = {
  minMemoryCount: 1000,
  minHoursSinceLastGc: 24,
  decayScoreThreshold: 0.15,
  maxArchivePerRun: 100,
  minAgeDays: 30,
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
 *
 * Archive criteria (B-2 evolution-aware):
 * - Memory must be "active" (not already superseded/archived/consolidated)
 * - Composite decay_score < threshold (default 0.15)
 * - Age > minAgeDays (default 30 days)
 * - Not pinned (importance >= 0.95 is considered pinned)
 */
export async function maybeRunGc(
  store: MemoryStore,
  config: AutoGcConfig = DEFAULT_AUTO_GC_CONFIG,
  retentionConfigDir?: string,
  auditLogger?: AuditLogger,
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

  const now = Date.now();
  let archivedCount = 0;
  let totalChecked = 0;

  // Scan memories by listing them
  const entries = await store.list({ limit: 5000 });
  totalChecked = entries.length;

  // Pre-compute per-scope active memory counts and cache retention policies.
  // This avoids repeated file reads inside the loop.
  const activeCounts = new Map<string, number>();
  const policyCache = new Map<string, RetentionPolicy>();
  const scopesSeen = new Set<string>();

  for (const entry of entries) {
    const scope = entry.scope ?? "";
    scopesSeen.add(scope);
    if (isActiveMemory(entry.metadata)) {
      activeCounts.set(scope, (activeCounts.get(scope) ?? 0) + 1);
    }
  }

  // Batch-load retention policies for all scopes (one file read per scope)
  for (const scope of scopesSeen) {
    policyCache.set(scope, loadRetentionPolicy(scope, retentionConfigDir));
  }

  for (const entry of entries) {
    if (archivedCount >= config.maxArchivePerRun) break;

    // Only archive active memories
    if (!isActiveMemory(entry.metadata)) continue;

    // Never archive pinned memories (importance >= 0.95)
    const importance = entry.importance ?? 0.5;
    if (importance >= 0.95) continue;

    // Check minimum age
    const ageDays = (now - entry.timestamp) / 86_400_000;

    // Decay-based archival (existing logic)
    let shouldArchive = false;
    if (ageDays >= config.minAgeDays) {
      const evo = parseEvolution(entry.metadata, entry.timestamp);
      const decayScore = computeDecayScore(evo, importance, now);
      if (decayScore < config.decayScoreThreshold) {
        shouldArchive = true;
      }
    }

    // Retention-policy-based archival (F-2): OR with decay-based
    if (!shouldArchive) {
      const scope = entry.scope ?? "";
      const policy = policyCache.get(scope) ?? loadRetentionPolicy(scope, retentionConfigDir);
      const activeCount = activeCounts.get(scope) ?? 0;
      const policyCheck = shouldArchiveByPolicy(policy, ageDays, activeCount);
      if (policyCheck.archive) {
        shouldArchive = true;
      }
    }

    if (shouldArchive) {
      const archivedMeta = buildArchivedMetadata(entry.metadata);
      await store.update(entry.id, { metadata: archivedMeta });
      archivedCount++;
      // F-1: Audit log — record archive operation (silent on failure)
      try {
        auditLogger?.log({
          operation: "archive",
          memoryId: entry.id,
          actor: "system",
          details: `auto-gc: age=${Math.floor(ageDays)}d`,
        });
      } catch { /* Audit must never block GC */ }
      // Decrement active count for the scope (memory is no longer active)
      const scope = entry.scope ?? "";
      const prev = activeCounts.get(scope) ?? 0;
      if (prev > 0) {
        activeCounts.set(scope, prev - 1);
      }
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
