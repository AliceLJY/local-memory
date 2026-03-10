/**
 * Access Tracker — "用进废退" reinforcement for memory decay.
 *
 * Tracks how often memories are recalled and extends their effective
 * time-decay half-life accordingly. Frequently accessed memories
 * decay slower; rarely accessed ones decay at the base rate.
 *
 * v1.1: Added tier promotion/demotion on flush (borrowed from
 * memory-lancedb-pro v1.1.0 tier-manager).
 */

import type { MemoryStore } from "./store.js";
import { evaluateTierChange, resolveTier, type MemoryTier } from "./decay-engine.js";
import { logInfo, logWarn } from "./stderr-log.js";

// ============================================================================
// Configuration
// ============================================================================

export interface AccessTrackerConfig {
  /** Debounce interval for flushing access counts to store (ms). Default: 5000 */
  flushIntervalMs: number;
  /** Reinforcement factor: how much access extends half-life. Default: 0.5 */
  reinforcementFactor: number;
  /** Maximum multiplier for half-life extension. Default: 3.0 */
  maxMultiplier: number;
  /** Half-life for access count freshness decay (days). Default: 30 */
  accessFreshnessHalfLifeDays: number;
}

export const DEFAULT_ACCESS_TRACKER_CONFIG: AccessTrackerConfig = {
  flushIntervalMs: 5000,
  reinforcementFactor: 0.5,
  maxMultiplier: 3.0,
  accessFreshnessHalfLifeDays: 30,
};

// ============================================================================
// Core
// ============================================================================

export class AccessTracker {
  private pending = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private store: MemoryStore,
    private config: AccessTrackerConfig = DEFAULT_ACCESS_TRACKER_CONFIG,
  ) {}

  /**
   * Record that these memory IDs were returned in a search result.
   * Accumulates deltas in memory; flushed to store after debounce.
   */
  recordAccess(ids: string[]): void {
    if (ids.length === 0) return;

    for (const id of ids) {
      this.pending.set(id, (this.pending.get(id) || 0) + 1);
    }

    // Debounce: schedule flush if not already pending
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch(err => {
          logWarn("AccessTracker flush failed:", err);
        });
      }, this.config.flushIntervalMs);
    }
  }

  /**
   * Write accumulated access deltas to store metadata.
   * Also evaluates tier promotion/demotion based on access patterns.
   */
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;

    // Snapshot and clear pending
    const batch = new Map(this.pending);
    this.pending.clear();

    const now = Date.now();
    let promotions = 0;
    let demotions = 0;

    for (const [id, delta] of batch) {
      try {
        const entry = await this.store.get(id);
        if (!entry) continue;

        const meta = safeParseMetadata(entry.metadata);
        const prevCount = typeof meta.accessCount === "number" ? meta.accessCount : 0;
        const newCount = prevCount + delta;
        const importance = entry.importance ?? 0.6;
        const lastAccessedAt = now;

        // Evaluate tier change
        const currentTier = resolveTier(entry.metadata);
        const newTier = evaluateTierChange(
          currentTier,
          newCount,
          importance,
          lastAccessedAt,
        );

        const tierChanged = newTier !== currentTier;
        if (tierChanged) {
          if (TIER_ORDER[newTier] > TIER_ORDER[currentTier]) {
            promotions++;
            logInfo(`[INFO] Tier promotion: ${id.slice(0, 8)} ${currentTier} → ${newTier} (access=${newCount})`);
          } else {
            demotions++;
            logInfo(`[INFO] Tier demotion: ${id.slice(0, 8)} ${currentTier} → ${newTier}`);
          }
        }

        const updatedMeta = {
          ...meta,
          accessCount: newCount,
          lastAccessedAt,
          ...(tierChanged ? { tier: newTier } : {}),
        };

        await this.store.update(id, { metadata: JSON.stringify(updatedMeta) });
      } catch {
        // Re-queue failed entries for next flush
        this.pending.set(id, (this.pending.get(id) || 0) + delta);
      }
    }

    if (promotions + demotions > 0) {
      logInfo(`[INFO] Tier changes: ${promotions} promotions, ${demotions} demotions`);
    }
  }

  /**
   * Compute effective half-life for a memory entry based on access history.
   *
   * Formula:
   *   freshness = exp(-accessAgeDays / accessFreshnessHalfLife)
   *   effectiveCount = accessCount * freshness
   *   extension = baseHalfLife * reinforcementFactor * log1p(effectiveCount)
   *   effectiveHalfLife = min(baseHalfLife + extension, baseHalfLife * maxMultiplier)
   */
  computeEffectiveHalfLife(baseHalfLife: number, metadata?: string): number {
    if (baseHalfLife <= 0) return baseHalfLife;

    const meta = safeParseMetadata(metadata);
    const accessCount = typeof meta.accessCount === "number" ? meta.accessCount : 0;
    const lastAccessedAt = typeof meta.lastAccessedAt === "number" ? meta.lastAccessedAt : 0;

    if (accessCount <= 0 || lastAccessedAt <= 0) return baseHalfLife;

    const accessAgeDays = (Date.now() - lastAccessedAt) / 86_400_000;
    const freshness = Math.exp(-accessAgeDays / this.config.accessFreshnessHalfLifeDays);
    const effectiveCount = accessCount * freshness;

    const extension = baseHalfLife * this.config.reinforcementFactor * Math.log1p(effectiveCount);
    const maxHalfLife = baseHalfLife * this.config.maxMultiplier;

    return Math.min(baseHalfLife + extension, maxHalfLife);
  }

  /**
   * Clean up timers.
   */
  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

// ============================================================================
// Helpers
// ============================================================================

const TIER_ORDER: Record<MemoryTier, number> = {
  peripheral: 0,
  working: 1,
  core: 2,
};

function safeParseMetadata(raw?: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
