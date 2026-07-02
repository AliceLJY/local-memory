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
import * as envConfig from "./env-config.js";

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
    envConfig.dataDir(),
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
  /** Per-scope write counts since that scope's last dream/distill reset. */
  scopes: Record<string, number>;
}

function resolveConfig(
  cfg?: Partial<ActivityCounterConfig>,
): ActivityCounterConfig {
  return { ...DEFAULT_ACTIVITY_CONFIG, ...cfg };
}

function readStats(statsPath: string): ActivityStats {
  if (!existsSync(statsPath)) {
    return { scopes: {} };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(statsPath, "utf-8"));
    // Robust against the legacy global format ({writesSinceLastDistill}) — no migration,
    // just treat anything without a `scopes` map as empty (counts restart per scope).
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "scopes" in parsed &&
      typeof (parsed as { scopes?: unknown }).scopes === "object" &&
      (parsed as { scopes?: unknown }).scopes !== null
    ) {
      return { scopes: (parsed as { scopes: Record<string, number> }).scopes };
    }
    return { scopes: {} };
  } catch {
    return { scopes: {} };
  }
}

function writeStats(statsPath: string, stats: ActivityStats): void {
  mkdirSync(dirname(statsPath), { recursive: true });
  writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Increment a scope's write counter by n (default 1). Returns the scope's new count. */
export function incrementWriteCount(
  scope: string,
  n = 1,
  cfg?: Partial<ActivityCounterConfig>,
): number {
  const { statsPath } = resolveConfig(cfg);
  const stats = readStats(statsPath);
  stats.scopes[scope] = (stats.scopes[scope] ?? 0) + n;
  writeStats(statsPath, stats);
  return stats.scopes[scope];
}

/** Read a scope's current write count without modifying (0 if never written). */
export function getWriteCount(scope: string, cfg?: Partial<ActivityCounterConfig>): number {
  const { statsPath } = resolveConfig(cfg);
  return readStats(statsPath).scopes[scope] ?? 0;
}

/** Reset one scope's counter after its successful dream/distill (leaves other scopes untouched). */
export function resetWriteCount(scope: string, cfg?: Partial<ActivityCounterConfig>): void {
  const { statsPath } = resolveConfig(cfg);
  const stats = readStats(statsPath);
  delete stats.scopes[scope];
  writeStats(statsPath, stats);
}

/** Scopes whose write count is at or above `threshold` — the dream scheduler's work list. */
export function listScopesAboveThreshold(
  threshold: number,
  cfg?: Partial<ActivityCounterConfig>,
): string[] {
  const { statsPath } = resolveConfig(cfg);
  const stats = readStats(statsPath);
  return Object.entries(stats.scopes)
    .filter(([, count]) => count >= threshold)
    .map(([scope]) => scope);
}

/** Determine which distill tier a scope's write count warrants. */
export function getDistillTier(scope: string, cfg?: Partial<ActivityCounterConfig>): DistillTier {
  const config = resolveConfig(cfg);
  const count = getWriteCount(scope, cfg);
  if (count >= config.deepThreshold) return "deep";
  if (count >= config.standardThreshold) return "standard";
  if (count >= config.lightThreshold) return "light";
  return "none";
}
