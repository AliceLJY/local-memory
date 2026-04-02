/**
 * P0.2 — Frequency Tracker
 *
 * Tracks how often each memory_id gets retrieved (hit_count).
 * Used to boost frequently accessed memories in scoring.
 *
 * Key design decisions:
 * - Counts per memory_id, not per query text (avoids synonym fragmentation)
 * - Persists to JSON file, loaded on startup
 * - Time decay: 30 days without a hit → effective count halves
 * - Superseded entries do NOT inherit hit_count (fresh starts)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { logWarn } from "./stderr-log.js";

// ============================================================================
// Types
// ============================================================================

export interface FrequencyEntry {
  hitCount: number;
  lastHitAt: number; // ms since epoch
}

export interface FrequencyStats {
  [memoryId: string]: FrequencyEntry;
}

export interface FrequencyTrackerConfig {
  /** Path to persistence file. Default: data/frequency-stats.json */
  filePath: string;
  /** Boost factor per log2(hitCount). Default: 0.15 */
  boostFactor: number;
  /** Days without a hit before effective count halves. Default: 30 */
  decayHalfLifeDays: number;
  /** Minimum hits before boost kicks in. Default: 2 */
  minHitsForBoost: number;
  /** Hit count threshold for auto-promoting to core tier. Default: 3 */
  corePromotionThreshold: number;
  /** Debounce write interval (ms). Default: 10000 */
  flushIntervalMs: number;
}

export const DEFAULT_FREQUENCY_CONFIG: FrequencyTrackerConfig = {
  filePath: join(process.cwd(), "data", "frequency-stats.json"),
  boostFactor: 0.15,
  decayHalfLifeDays: 30,
  minHitsForBoost: 2,
  corePromotionThreshold: 3,
  flushIntervalMs: 10000,
};

// ============================================================================
// Frequency Tracker
// ============================================================================

export class FrequencyTracker {
  private stats: FrequencyStats = {};
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  readonly config: FrequencyTrackerConfig;

  constructor(config?: Partial<FrequencyTrackerConfig>) {
    this.config = { ...DEFAULT_FREQUENCY_CONFIG, ...config };
    this.load();
  }

  /** Record hits for a set of memory IDs (called after retrieval). */
  recordHits(memoryIds: string[]): void {
    const now = Date.now();
    for (const id of memoryIds) {
      const existing = this.stats[id];
      if (existing) {
        existing.hitCount += 1;
        existing.lastHitAt = now;
      } else {
        this.stats[id] = { hitCount: 1, lastHitAt: now };
      }
    }
    this.dirty = true;
    this.scheduleSave();
  }

  /**
   * Compute the frequency boost multiplier for a memory.
   * Returns 1.0 (no boost) if below threshold.
   * Formula: 1 + log2(effectiveHits) * boostFactor
   */
  getBoostMultiplier(memoryId: string): number {
    const entry = this.stats[memoryId];
    if (!entry || entry.hitCount < this.config.minHitsForBoost) return 1.0;

    const effectiveHits = this.effectiveHitCount(entry);
    if (effectiveHits < this.config.minHitsForBoost) return 1.0;

    return 1 + Math.log2(effectiveHits) * this.config.boostFactor;
  }

  /** Check if a memory should be auto-promoted to core tier. */
  shouldPromoteToCore(memoryId: string): boolean {
    const entry = this.stats[memoryId];
    if (!entry) return false;
    return this.effectiveHitCount(entry) >= this.config.corePromotionThreshold;
  }

  /** Get raw stats for a memory (for debugging/testing). */
  getStats(memoryId: string): FrequencyEntry | undefined {
    return this.stats[memoryId];
  }

  /** Total tracked entries. */
  get size(): number {
    return Object.keys(this.stats).length;
  }

  /** Force flush to disk (for testing or shutdown). */
  flush(): void {
    if (!this.dirty) return;
    this.save();
  }

  /** Clean up timer on shutdown. */
  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private effectiveHitCount(entry: FrequencyEntry): number {
    const daysSinceHit = (Date.now() - entry.lastHitAt) / 86_400_000;
    const decayFactor = Math.exp(
      (-daysSinceHit * Math.LN2) / this.config.decayHalfLifeDays,
    );
    return entry.hitCount * decayFactor;
  }

  private load(): void {
    try {
      if (existsSync(this.config.filePath)) {
        const raw = readFileSync(this.config.filePath, "utf-8");
        this.stats = JSON.parse(raw) as FrequencyStats;
      }
    } catch {
      logWarn("frequency-tracker: failed to load stats, starting fresh");
      this.stats = {};
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.config.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.config.filePath, JSON.stringify(this.stats, null, 2));
      this.dirty = false;
    } catch (err) {
      logWarn(`frequency-tracker: failed to save stats: ${err}`);
    }
  }

  private scheduleSave(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.save();
    }, this.config.flushIntervalMs);
  }
}
