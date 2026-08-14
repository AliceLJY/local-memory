/**
 * HP-3: Activity-driven distill frequency.
 * Tracks write operations since last distill, exposes tier-based thresholds.
 * Complements CC-6 distill-lock: HP-3 decides "when to trigger", CC-6 decides "whether to allow".
 *
 * 2026-08-14 并发加固（dream 写爆库根治的一部分）：
 * - 写路径（increment/reset/resetBatch/prune）全部 async 化，进 `activity-stats` 跨进程锁 ——
 *   此前 increment（11 个 mcp-server + ingest）与 reset（dream 04:00）裸读改写同一文件，
 *   互踩窗口内的计数会静默丢失。
 * - writeStats 改临时文件 + 原子 rename：裸 writeFileSync 期间被并发读到半截 JSON 时，
 *   readStats 的 catch 会返回空表 —— 一次损坏放大成"整个队列清零"。原子替换后读方
 *   永远看到完整文件（旧版或新版）。
 * - 读路径（getWriteCount/listScopesAboveThreshold/getDistillTier）保持同步无锁：原子
 *   rename 保证读到的文件完整；读到旧一拍的计数对 best-effort 语义无害。
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import * as envConfig from "./env-config.js";
import { withLock } from "./distill-lock.js";

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
  // 原子替换：先写同目录临时文件再 rename。并发读方要么看到旧版要么看到新版，
  // 不会读到半截 JSON（那会被 readStats 的 catch 吞成空表，把整个队列清零）。
  const tmpPath = `${statsPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(stats, null, 2), "utf-8");
  renameSync(tmpPath, statsPath);
}

/** 写路径共用的锁参数：等待而非跳过（丢计数=丢 dream 触发信号），短超时防卡死写入方。 */
const ACTIVITY_LOCK_KEY = "activity-stats";
const ACTIVITY_LOCK_OPTS = { onBusy: "wait" as const, waitTimeoutMs: 2_000, expireMs: 30_000 };

async function withStatsLock<T>(fn: () => T): Promise<T> {
  const outcome = await withLock(ACTIVITY_LOCK_KEY, async () => fn(), ACTIVITY_LOCK_OPTS);
  // onBusy:"wait" resolves ran:true or throws on timeout; ran:false unreachable.
  if (!outcome.ran) throw new Error("activity-stats lock unavailable");
  return outcome.result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Increment a scope's write counter by n (default 1). Returns the scope's new count. */
export async function incrementWriteCount(
  scope: string,
  n = 1,
  cfg?: Partial<ActivityCounterConfig>,
): Promise<number> {
  const { statsPath } = resolveConfig(cfg);
  return withStatsLock(() => {
    const stats = readStats(statsPath);
    stats.scopes[scope] = (stats.scopes[scope] ?? 0) + n;
    writeStats(statsPath, stats);
    return stats.scopes[scope];
  });
}

/** Read a scope's current write count without modifying (0 if never written). */
export function getWriteCount(scope: string, cfg?: Partial<ActivityCounterConfig>): number {
  const { statsPath } = resolveConfig(cfg);
  return readStats(statsPath).scopes[scope] ?? 0;
}

/** Reset one scope's counter after its successful dream/distill (leaves other scopes untouched). */
export async function resetWriteCount(scope: string, cfg?: Partial<ActivityCounterConfig>): Promise<void> {
  const { statsPath } = resolveConfig(cfg);
  await withStatsLock(() => {
    const stats = readStats(statsPath);
    delete stats.scopes[scope];
    writeStats(statsPath, stats);
  });
}

/**
 * Remove every scope entry matching `predicate` in one read-modify-write (one lock
 * acquisition, one atomic file replace). Returns the removed scope names.
 *
 * dream --auto 用它把 transcript scope（原文层，不参与巩固——shared-behaviors §5.3）
 * 从计数文件里整体清扫，含未达标条目：listScopesAboveThreshold 只能看到达标的，
 * 而未达标的 transcript 条目会让 stats 文件无限膨胀（历史会话只增不减）。
 */
export async function pruneWriteCounts(
  predicate: (scope: string) => boolean,
  cfg?: Partial<ActivityCounterConfig>,
): Promise<string[]> {
  const { statsPath } = resolveConfig(cfg);
  return withStatsLock(() => {
    const stats = readStats(statsPath);
    const removed: string[] = [];
    for (const scope of Object.keys(stats.scopes)) {
      if (predicate(scope)) {
        delete stats.scopes[scope];
        removed.push(scope);
      }
    }
    if (removed.length > 0) writeStats(statsPath, stats);
    return removed;
  });
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
