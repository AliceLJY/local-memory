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

import type { MemoryStorePort } from "./memory-store-port.js";
import {
  parseEvolution,
  computeDecayScore,
  computeUsageAdjustedDecayScore,
  buildArchivedMetadata,
  isActiveMemory,
} from "./memory-evolution.js";
import { loadRetentionPolicy, shouldArchiveByPolicy } from "./retention-policy.js";
import type { RetentionPolicy } from "./retention-policy.js";
import type { AuditLogger } from "./audit-log.js";
import * as envConfig from "./env-config.js";
import { isUsageSignalActive } from "./usage-tracker.js";
import { acquireLock, releaseLock, getLastDistillTime, stampLock, lockPathForKey } from "./distill-lock.js";

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
  store: MemoryStorePort,
  config: AutoGcConfig = DEFAULT_AUTO_GC_CONFIG,
  retentionConfigDir?: string,
  auditLogger?: AuditLogger,
): Promise<GcResult> {
  const stats = await store.stats();
  const totalMemories = stats.totalCount ?? 0;

  // Condition 1: enough memories to warrant GC
  if (totalMemories < config.minMemoryCount) {
    return { triggered: false, reason: "below_memory_threshold", archivedCount: 0, totalChecked: 0 };
  }

  // Condition 2: enough time since last GC. P0-1: the throttle is cross-process now —
  // take the max of this process's in-memory timestamp and the shared gc-last stamp
  // file's mtime. The old module-level var alone let each of the 11 mcp-server
  // processes run gc on its own independent 24h clock.
  const gcStampPath = lockPathForKey("gc-last");
  const lastGc = Math.max(lastGcTimestamp, getLastDistillTime({ lockPath: gcStampPath }));
  const hoursSinceLastGc = (Date.now() - lastGc) / 3_600_000;
  if (hoursSinceLastGc < config.minHoursSinceLastGc) {
    return { triggered: false, reason: "too_soon", archivedCount: 0, totalChecked: 0 };
  }

  // Concurrency guard: only one process scans the full corpus at a time. A process that
  // passed the throttle in the same instant loses the O_EXCL race here and skips.
  const gcRunLock = { lockPath: lockPathForKey("gc-run"), expireMs: 30 * 60_000 };
  if (!acquireLock(gcRunLock)) {
    return { triggered: false, reason: "locked_by_another_process", archivedCount: 0, totalChecked: 0 };
  }

  // All conditions met — run GC
  lastGcTimestamp = Date.now(); // in-process immediate throttle

  try {
    const { archivedCount, totalChecked } = await runGcScan(store, config, retentionConfigDir, auditLogger);
    // Stamp completion into the shared throttle marker (create-or-touch → mtime = now)
    // so the other processes observe "last run" via getLastDistillTime.
    stampLock({ lockPath: gcStampPath });
    return { triggered: true, archivedCount, totalChecked };
  } finally {
    releaseLock(gcRunLock);
  }
}

/**
 * The full-corpus archive scan — the body of a triggered GC run. Extracted from
 * maybeRunGc so the P0-1 lock/throttle wiring stays readable; the scan logic itself
 * is unchanged.
 */
async function runGcScan(
  store: MemoryStorePort,
  config: AutoGcConfig,
  retentionConfigDir: string | undefined,
  auditLogger: AuditLogger | undefined,
): Promise<{ archivedCount: number; totalChecked: number }> {
  const now = Date.now();
  let archivedCount = 0;
  let totalChecked = 0;

  // Full-corpus scan, page by page. The previous implementation listed only
  // the newest 5000 rows (list() sorts by timestamp desc before slicing) —
  // old low-value memories, the very target of GC, never entered the scan
  // window on a 99K+ corpus. Two passes keep memory at one page instead of
  // the whole corpus; pass 2 mutates rows (archive), which may shift fragment
  // scan order — a row missed this run is caught by the next one.
  const GC_PAGE_SIZE = 2000;

  // Pass 1: per-scope active memory counts for retention policies.
  const activeCounts = new Map<string, number>();
  const policyCache = new Map<string, RetentionPolicy>();
  const scopesSeen = new Set<string>();

  for (let offset = 0; ; offset += GC_PAGE_SIZE) {
    const page = await store.listPage({ limit: GC_PAGE_SIZE, offset });
    for (const entry of page) {
      const scope = entry.scope ?? "";
      scopesSeen.add(scope);
      if (isActiveMemory(entry.metadata)) {
        activeCounts.set(scope, (activeCounts.get(scope) ?? 0) + 1);
      }
    }
    if (page.length < GC_PAGE_SIZE) break;
  }

  // Batch-load retention policies for all scopes (one file read per scope)
  for (const scope of scopesSeen) {
    policyCache.set(scope, loadRetentionPolicy(scope, retentionConfigDir));
  }

  // Pass 2: archive sweep.
  const useUsageAdjustedDecay = envConfig.usageDecay() && isUsageSignalActive();
  outer:
  for (let offset = 0; ; offset += GC_PAGE_SIZE) {
    const page = await store.listPage({ limit: GC_PAGE_SIZE, offset });
    totalChecked += page.length;

  for (const entry of page) {
    if (archivedCount >= config.maxArchivePerRun) break outer;

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
      let decayScore = useUsageAdjustedDecay
        ? computeUsageAdjustedDecayScore(evo, importance, now, entry.metadata)
        : computeDecayScore(evo, importance, now, entry.metadata);
      // F3: Expired memories (validUntil < now) get 2x decay acceleration
      if (evo.validUntil != null && evo.validUntil < now) {
        decayScore *= 0.5; // Halve the score → archives faster
      }
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

    if (page.length < GC_PAGE_SIZE) break;
  }

  return { archivedCount, totalChecked };
}

/**
 * Reset last GC timestamp (for testing). Clears both the in-memory timestamp and the
 * persisted cross-process throttle marker / run lock so tests start from a clean slate.
 */
export function resetGcTimestamp(): void {
  lastGcTimestamp = 0;
  try {
    releaseLock({ lockPath: lockPathForKey("gc-last") });
    releaseLock({ lockPath: lockPathForKey("gc-run") });
  } catch {
    /* ignore — nothing to clear */
  }
}
