/**
 * HP-3: Activity-driven distill frequency.
 * Tracks write operations since last distill, exposes tier-based thresholds.
 * Complements CC-6 distill-lock: HP-3 decides "when to trigger", CC-6 decides "whether to allow".
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ActivityCounterConfig {
  /** Path to the stats file (default: data/activity-stats.json) */
  statsPath: string;
  /** Writes needed for light scoring/tagging pass */
  lightThreshold: number;
  /** Writes needed for standard distill */
  standardThreshold: number;
  /** Writes needed for deep checkpoint */
  deepThreshold: number;
}

export const DEFAULT_ACTIVITY_CONFIG: ActivityCounterConfig = {
  statsPath: join(
    process.env.RECALLNEST_DATA_DIR || "data",
    "activity-stats.json",
  ),
  lightThreshold: 15,
  standardThreshold: 50,
  deepThreshold: 200,
};

export type DistillTier = "none" | "light" | "standard" | "deep";

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

interface ActivityStats {
  writesSinceLastDistill: number;
  lastResetAt: number;
}

function resolveConfig(
  cfg?: Partial<ActivityCounterConfig>,
): ActivityCounterConfig {
  return { ...DEFAULT_ACTIVITY_CONFIG, ...cfg };
}

function readStats(statsPath: string): ActivityStats {
  if (!existsSync(statsPath)) {
    return { writesSinceLastDistill: 0, lastResetAt: Date.now() };
  }
  try {
    return JSON.parse(readFileSync(statsPath, "utf-8"));
  } catch {
    return { writesSinceLastDistill: 0, lastResetAt: Date.now() };
  }
}

function writeStats(statsPath: string, stats: ActivityStats): void {
  mkdirSync(dirname(statsPath), { recursive: true });
  writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Increment write counter by n (default 1). Returns new count. */
export function incrementWriteCount(
  n = 1,
  cfg?: Partial<ActivityCounterConfig>,
): number {
  const { statsPath } = resolveConfig(cfg);
  const stats = readStats(statsPath);
  stats.writesSinceLastDistill += n;
  writeStats(statsPath, stats);
  return stats.writesSinceLastDistill;
}

/** Read current write count without modifying. */
export function getWriteCount(cfg?: Partial<ActivityCounterConfig>): number {
  const { statsPath } = resolveConfig(cfg);
  return readStats(statsPath).writesSinceLastDistill;
}

/** Reset counter after successful distill. */
export function resetWriteCount(cfg?: Partial<ActivityCounterConfig>): void {
  const { statsPath } = resolveConfig(cfg);
  writeStats(statsPath, { writesSinceLastDistill: 0, lastResetAt: Date.now() });
}

/** Determine which distill tier the current write count warrants. */
export function getDistillTier(cfg?: Partial<ActivityCounterConfig>): DistillTier {
  const config = resolveConfig(cfg);
  const count = getWriteCount(cfg);
  if (count >= config.deepThreshold) return "deep";
  if (count >= config.standardThreshold) return "standard";
  if (count >= config.lightThreshold) return "light";
  return "none";
}
