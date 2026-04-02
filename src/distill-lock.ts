/**
 * CC-6: Distill gate — PID-based lock file + session gate.
 * Lock file mtime serves as lastDistillAt timestamp (no separate field).
 *
 * - acquireLock(): write current PID, check existing lock PID liveness + mtime expiry
 * - releaseLock(): delete lock file (mtime naturally updates to now on success)
 * - rollbackLock(previousMtime): on failure, rewind lock mtime so next run retries
 * - shouldDistill(checkpointCount): session gate — checkpoint count < 3 → skip
 * - getLastDistillTime(): read lock file mtime, return 0 if absent
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  statSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DistillLockConfig {
  /** Path to the lock file (default: data/distill.lock) */
  lockPath: string;
  /** Lock expiry in ms (default: 3600000 = 1h) */
  expireMs: number;
  /** Minimum checkpoint count before distill is allowed (default: 3) */
  minCheckpoints: number;
}

export const DEFAULT_DISTILL_LOCK_CONFIG: DistillLockConfig = {
  lockPath: join(process.env.RECALLNEST_DATA_DIR || "data", "distill.lock"),
  expireMs: 3_600_000,
  minCheckpoints: 3,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveConfig(cfg?: Partial<DistillLockConfig>): DistillLockConfig {
  return { ...DEFAULT_DISTILL_LOCK_CONFIG, ...cfg };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to acquire the distill lock.
 * Returns true if lock was acquired, false if another live process holds it.
 */
export function acquireLock(cfg?: Partial<DistillLockConfig>): boolean {
  const { lockPath, expireMs } = resolveConfig(cfg);

  if (existsSync(lockPath)) {
    const existingPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    const mtime = statSync(lockPath).mtimeMs;
    const expired = Date.now() - mtime > expireMs;

    if (!isNaN(existingPid) && isPidAlive(existingPid) && !expired) {
      return false;
    }
    // PID dead or lock expired — overwrite
  }

  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, String(process.pid), "utf-8");
  return true;
}

/** Release the distill lock by removing the lock file. */
export function releaseLock(cfg?: Partial<DistillLockConfig>): void {
  const { lockPath } = resolveConfig(cfg);
  if (existsSync(lockPath)) {
    unlinkSync(lockPath);
  }
}

/**
 * Roll back lock mtime to a previous value so the next run retries sooner.
 * Used when distill fails and we want to preserve the "last success" timestamp.
 */
export function rollbackLock(
  previousMtime: Date,
  cfg?: Partial<DistillLockConfig>,
): void {
  const { lockPath } = resolveConfig(cfg);
  if (existsSync(lockPath)) {
    utimesSync(lockPath, previousMtime, previousMtime);
  }
}

/** Session gate: returns true when enough checkpoints have accumulated. */
export function shouldDistill(
  checkpointCountSinceLastDistill: number,
  cfg?: Partial<DistillLockConfig>,
): boolean {
  const { minCheckpoints } = resolveConfig(cfg);
  return checkpointCountSinceLastDistill >= minCheckpoints;
}

/** Read lock file mtime as the last-distill timestamp. Returns 0 if absent. */
export function getLastDistillTime(cfg?: Partial<DistillLockConfig>): number {
  const { lockPath } = resolveConfig(cfg);
  if (!existsSync(lockPath)) return 0;
  return statSync(lockPath).mtimeMs;
}
