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
  /** Novelty threshold: only reinforce when query-result distance > this (default: 0.35).
   *  Higher = stricter, fewer reinforcements. 0 = disabled (always reinforce). */
  noveltyThreshold: number;
  /** Cooldown period per entry ID in ms. Same entry won't be reinforced twice within this window (default: 300000 = 5 min). */
  cooldownMs: number;
}

export const DEFAULT_ACCESS_TRACKER_CONFIG: AccessTrackerConfig = {
  flushIntervalMs: 5000,
  reinforcementFactor: 0.5,
  maxMultiplier: 3.0,
  accessFreshnessHalfLifeDays: 30,
  noveltyThreshold: 0.35,
  cooldownMs: 300_000, // 5 minutes
};

// ============================================================================
// Core
// ============================================================================

export class AccessTracker {
  private pending = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  /** Cooldown map: entryId → last reinforced timestamp */
  private cooldownMap = new Map<string, number>();

  constructor(
    private store: MemoryStore,
    private config: AccessTrackerConfig = DEFAULT_ACCESS_TRACKER_CONFIG,
  ) {}

  /**
   * Determine whether a retrieval result should trigger access reinforcement.
   * Gated by two conditions:
   *   1. Novelty: the result's similarity score must indicate sufficient distance
   *      (score ≤ 1 - noveltyThreshold) — i.e. not a near-exact repeat of the query.
   *      Lower similarity = higher novelty = worth reinforcing.
   *   2. Cooldown: the same entry ID must not have been reinforced within cooldownMs.
   *
   * @param entryId  The memory entry ID
   * @param similarityScore  Cosine similarity between query and result (0-1)
   * @returns true if this entry should be reinforced
   */
  shouldReinforce(entryId: string, similarityScore: number): boolean {
    const { noveltyThreshold, cooldownMs } = this.config;

    // Gate 1: Novelty — only reinforce if the retrieval is "surprising" enough.
    // A very high similarity means the user is asking nearly the same thing as
    // what's stored, so there's no new learning signal.
    if (noveltyThreshold > 0) {
      const novelty = 1 - similarityScore;
      if (novelty < noveltyThreshold) return false;
    }

    // Gate 2: Cooldown — prevent same entry from being reinforced too frequently
    if (cooldownMs > 0) {
      const lastReinforced = this.cooldownMap.get(entryId);
      if (lastReinforced && Date.now() - lastReinforced < cooldownMs) return false;
    }

    return true;
  }

  /**
   * Record that these memory IDs were returned in a search result.
   * Accumulates deltas in memory; flushed to store after debounce.
   *
   * @param ids  Memory entry IDs to record access for
   * @param scores  Optional parallel array of raw similarity scores for novelty gating.
   *                Entries with an undefined score skip novelty gating.
   *                When provided, only entries passing shouldReinforce() are recorded.
   */
  recordAccess(ids: string[], scores?: Array<number | undefined>): void {
    if (ids.length === 0) return;

    const now = Date.now();

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const score = scores?.[i];

      // If scores provided, apply novelty + cooldown gating
      if (score !== undefined && !this.shouldReinforce(id, score)) {
        continue;
      }

      this.pending.set(id, (this.pending.get(id) || 0) + 1);
      this.cooldownMap.set(id, now);
    }

    // Nothing passed the gate → skip flush scheduling
    if (this.pending.size === 0) return;

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
   * Concurrent flush protection: prevents data corruption from overlapping flushes.
   */
  async flush(): Promise<void> {
    if (this.flushPromise) {
      await this.flushPromise;
      if (this.pending.size > 0) return this.flush();
      return;
    }
    if (this.pending.size === 0) return;

    this.flushPromise = this.doFlush();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  private async doFlush(): Promise<void> {
    // Snapshot and clear pending
    const batch = new Map(this.pending);
    this.pending.clear();

    const now = Date.now();
    let promotions = 0;
    let demotions = 0;

    for (const [id, delta] of batch) {
      try {
        const entry = await this.store.getById(id);
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
   * Clean up timers and cooldown state.
   */
  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.cooldownMap.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

// ============================================================================
// Hotness Score
// ============================================================================

/**
 * Compute a hotness score (0-1) for a memory entry.
 *
 * Combines access frequency (sigmoid of log1p) with recency of last access
 * (exponential decay). Inspired by OpenViking memory_lifecycle.py.
 *
 * @param accessCount  Number of times this memory was recalled
 * @param lastAccessMs Timestamp (ms) of last access
 * @param decayRate    Decay rate (default 0.1 ≈ 7-day half-life)
 * @returns 0-1 score. High = frequently + recently accessed.
 */
export function computeHotnessScore(
  accessCount: number,
  lastAccessMs: number,
  decayRate = 0.1,
): number {
  if (accessCount <= 0) return 0;

  // Frequency component: sigmoid of log1p(count) → 0.5..1.0
  const freq = 1 / (1 + Math.exp(-Math.log1p(accessCount)));

  // Recency component: exponential decay from last access
  const ageDays = Math.max(0, (Date.now() - lastAccessMs) / 86_400_000);
  const recency = Math.exp(-decayRate * ageDays);

  return freq * recency;
}

/**
 * Parse access metadata from a raw metadata string.
 */
export function parseAccessMetadata(raw?: string): { accessCount: number; lastAccessedAt: number } {
  const meta = safeParseMetadata(raw);
  return {
    accessCount: typeof meta.accessCount === "number" ? meta.accessCount : 0,
    lastAccessedAt: typeof meta.lastAccessedAt === "number" ? meta.lastAccessedAt : 0,
  };
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
