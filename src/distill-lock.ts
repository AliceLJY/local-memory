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
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import * as envConfig from "./env-config.js";

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
  lockPath: join(envConfig.dataDir(), "distill.lock"),
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
  mkdirSync(dirname(lockPath), { recursive: true });

  // Fast path: atomic exclusive create. On POSIX the O_EXCL ("wx") open wins the
  // cross-process race — only one of N processes creating the same lock succeeds.
  // This closes the check-then-write TOCTOU the previous existsSync+writeFileSync
  // form had (two processes could both see "no lock" then both write); the P0-1
  // store-write lock relies on acquisition being truly exclusive.
  if (tryExclusiveCreate(lockPath)) return true;

  // Lock file exists — decide whether it is reclaimable (dead holder or expired).
  let existingPid = NaN;
  let mtime = 0;
  try {
    existingPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    mtime = statSync(lockPath).mtimeMs;
  } catch {
    // Holder released between our failed create and this read — retry the create.
    return tryExclusiveCreate(lockPath);
  }
  const expired = Date.now() - mtime > expireMs;
  if (!isNaN(existingPid) && isPidAlive(existingPid) && !expired) {
    return false; // held by a live process, not expired
  }

  // Reclaim a stale lock: remove it, then re-create atomically. If a competing
  // process reclaims first, our O_EXCL create fails and we concede the race.
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone — fall through to the atomic create */
  }
  return tryExclusiveCreate(lockPath);
}

/** Atomic O_EXCL create of the lock file with the current PID. false on EEXIST. */
function tryExclusiveCreate(lockPath: string): boolean {
  try {
    writeFileSync(lockPath, String(process.pid), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === "EEXIST") return false;
    throw err;
  }
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

// ---------------------------------------------------------------------------
// P0-1: Named cross-process locks (store-write + maintenance families)
//
// distill-lock was dead code (0 src imports). P0-1 wires it up: one global
// `store-write` lock serializes every `memories`-table write across the 11
// mcp-server processes, and scope-keyed maintenance locks (dream/consolidate/
// distill) + a global gc lock stop redundant concurrent maintenance runs.
// ---------------------------------------------------------------------------

/** Base directory for named locks. Defaults to <dataDir>/locks; overridable in tests. */
export function locksDir(lockDir?: string): string {
  return lockDir ?? join(envConfig.dataDir(), "locks");
}

/**
 * Resolve a lock key (e.g. "store-write", "dream-<scope>", "gc-global") to a safe
 * lock-file path. The key is sanitized for the filesystem and suffixed with a short
 * hash of the raw key so distinct keys never collide after sanitization/truncation.
 */
export function lockPathForKey(key: string, lockDir?: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return join(locksDir(lockDir), `${safe}-${hash}.lock`);
}

export interface WithLockOptions {
  /** Stale-lock reclaim window in ms (default 600_000 = 10min). */
  expireMs?: number;
  /** Override the base lock directory (tests). */
  lockDir?: string;
  /** Behavior when another live process holds the lock (default "skip"). */
  onBusy?: "skip" | "wait";
  /** For onBusy="wait": total time budget before throwing (default 10_000). */
  waitTimeoutMs?: number;
  /** For onBusy="wait": poll interval in ms (default 50). */
  pollMs?: number;
}

export type WithLockOutcome<T> =
  | { ran: true; result: T }
  | { ran: false; reason: "locked_by_another_process" };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding a named cross-process lock, releasing it afterwards
 * (even on throw). Maintenance-type writes use onBusy:"skip" — for a personal
 * store, skipping a redundant dream/consolidate/gc run beats queueing it.
 */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: WithLockOptions = {},
): Promise<WithLockOutcome<T>> {
  const lockPath = lockPathForKey(key, opts.lockDir);
  const lockCfg = { lockPath, expireMs: opts.expireMs ?? 600_000 };

  if (!acquireLock(lockCfg)) {
    if ((opts.onBusy ?? "skip") === "skip") {
      return { ran: false, reason: "locked_by_another_process" };
    }
    // wait: poll until acquired or the budget is exhausted.
    const timeoutMs = opts.waitTimeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    const pollMs = opts.pollMs ?? 50;
    let acquired = false;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      if (acquireLock(lockCfg)) {
        acquired = true;
        break;
      }
    }
    if (!acquired) {
      throw new Error(`lock '${key}' timed out after ${timeoutMs}ms (held by another process)`);
    }
  }

  try {
    return { ran: true, result: await fn() };
  } finally {
    releaseLock(lockCfg);
  }
}

/**
 * Run `fn` under a named write lock, waiting for the lock rather than skipping —
 * losing a memory write would be data loss. Throws if the lock can't be acquired
 * within the timeout. Returns fn's result directly. Used by store.upsert/storeBatch
 * so all `memories`-table writes serialize across the 11 mcp-server processes.
 */
export async function withWriteLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: Omit<WithLockOptions, "onBusy"> = {},
): Promise<T> {
  const outcome = await withLock(key, fn, { ...opts, onBusy: "wait" });
  // onBusy:"wait" resolves to {ran:true} or throws; ran:false is unreachable here.
  if (!outcome.ran) {
    throw new Error(`write lock '${key}' unavailable`);
  }
  return outcome.result;
}

/**
 * Stamp a lock file's mtime to now without releasing it, marking "last completed".
 * gc (auto-gc.ts) uses this to persist a cross-process throttle timestamp in the
 * lock file's mtime (getLastDistillTime pattern) so the 24h throttle holds across
 * processes rather than each process tracking its own module-level timestamp.
 */
export function stampLock(cfg?: Partial<DistillLockConfig>): void {
  const { lockPath } = resolveConfig(cfg);
  if (!existsSync(lockPath)) return;
  const now = new Date();
  utimesSync(lockPath, now, now);
}
