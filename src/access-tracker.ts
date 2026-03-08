/**
 * Access Tracker — "用进废退" reinforcement for memory decay.
 *
 * Tracks how often memories are recalled and extends their effective
 * time-decay half-life accordingly. Frequently accessed memories
 * decay slower; rarely accessed ones decay at the base rate.
 *
 * Inspired by memory-lancedb-pro's access-tracker.ts.
 */

import type { MemoryStore } from "./store.js";

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
          console.warn("AccessTracker flush failed:", err);
        });
      }, this.config.flushIntervalMs);
    }
  }

  /**
   * Write accumulated access deltas to store metadata.
   */
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;

    // Snapshot and clear pending
    const batch = new Map(this.pending);
    this.pending.clear();

    const now = Date.now();

    for (const [id, delta] of batch) {
      try {
        const entry = await this.store.get(id);
        if (!entry) continue;

        const meta = safeParseMetadata(entry.metadata);
        const prevCount = typeof meta.accessCount === "number" ? meta.accessCount : 0;
        const updatedMeta = {
          ...meta,
          accessCount: prevCount + delta,
          lastAccessedAt: now,
        };

        await this.store.update(id, { metadata: JSON.stringify(updatedMeta) });
      } catch {
        // Re-queue failed entries for next flush
        this.pending.set(id, (this.pending.get(id) || 0) + delta);
      }
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

function safeParseMetadata(raw?: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
