import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  acquireLock,
  releaseLock,
  rollbackLock,
  shouldDistill,
  getLastDistillTime,
  withLock,
  withWriteLock,
  lockPathForKey,
  stampLock,
  type DistillLockConfig,
} from "../distill-lock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let lockPath: string;

function cfg(overrides?: Partial<DistillLockConfig>): Partial<DistillLockConfig> {
  return { lockPath, ...overrides };
}

beforeEach(() => {
  tempDir = join(tmpdir(), `distill-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  lockPath = join(tempDir, "distill.lock");
});

afterEach(() => {
  // Clean up lock file if it exists
  if (existsSync(lockPath)) {
    try {
      const { unlinkSync } = require("node:fs");
      unlinkSync(lockPath);
    } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// acquireLock
// ---------------------------------------------------------------------------

describe("acquireLock", () => {
  it("creates lock file and returns true when no lock exists", () => {
    const result = acquireLock(cfg());
    expect(result).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("writes current PID into lock file", () => {
    acquireLock(cfg());
    const { readFileSync } = require("node:fs");
    const content = readFileSync(lockPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));
  });

  it("returns false when lock held by alive PID and not expired", () => {
    // Write current process PID (which is alive)
    writeFileSync(lockPath, String(process.pid), "utf-8");

    const result = acquireLock(cfg());
    expect(result).toBe(false);
  });

  it("overwrites lock when PID is dead", () => {
    // PID 999999 is almost certainly not running
    writeFileSync(lockPath, "999999", "utf-8");

    const result = acquireLock(cfg());
    expect(result).toBe(true);

    const { readFileSync } = require("node:fs");
    const content = readFileSync(lockPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));
  });

  it("overwrites lock when mtime is expired even if PID alive", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8");
    // Set mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    utimesSync(lockPath, twoHoursAgo, twoHoursAgo);

    const result = acquireLock(cfg({ expireMs: 3_600_000 }));
    expect(result).toBe(true);
  });

  it("creates parent directories if missing", () => {
    const deepPath = join(tempDir, "nested", "dir", "distill.lock");
    const result = acquireLock(cfg({ lockPath: deepPath }));
    expect(result).toBe(true);
    expect(existsSync(deepPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// releaseLock
// ---------------------------------------------------------------------------

describe("releaseLock", () => {
  it("deletes lock file", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8");
    expect(existsSync(lockPath)).toBe(true);

    releaseLock(cfg());
    expect(existsSync(lockPath)).toBe(false);
  });

  it("is a no-op when lock file does not exist", () => {
    expect(() => releaseLock(cfg())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// rollbackLock
// ---------------------------------------------------------------------------

describe("rollbackLock", () => {
  it("sets lock mtime to the given previous value", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8");
    const pastDate = new Date(Date.now() - 600_000); // 10 min ago

    rollbackLock(pastDate, cfg());

    const st = statSync(lockPath);
    // Allow 1 second tolerance for filesystem granularity
    expect(Math.abs(st.mtimeMs - pastDate.getTime())).toBeLessThan(1000);
  });

  it("is a no-op when lock file does not exist", () => {
    expect(() => rollbackLock(new Date(), cfg())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// shouldDistill
// ---------------------------------------------------------------------------

describe("shouldDistill", () => {
  it("returns true when checkpoint count >= minCheckpoints (default 3)", () => {
    expect(shouldDistill(3, cfg())).toBe(true);
    expect(shouldDistill(5, cfg())).toBe(true);
  });

  it("returns false when checkpoint count < minCheckpoints", () => {
    expect(shouldDistill(0, cfg())).toBe(false);
    expect(shouldDistill(1, cfg())).toBe(false);
    expect(shouldDistill(2, cfg())).toBe(false);
  });

  it("respects custom minCheckpoints", () => {
    expect(shouldDistill(4, cfg({ minCheckpoints: 5 }))).toBe(false);
    expect(shouldDistill(5, cfg({ minCheckpoints: 5 }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getLastDistillTime
// ---------------------------------------------------------------------------

describe("getLastDistillTime", () => {
  it("returns lock file mtime when lock exists", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8");
    const st = statSync(lockPath);

    const result = getLastDistillTime(cfg());
    expect(Math.abs(result - st.mtimeMs)).toBeLessThan(100);
  });

  it("returns 0 when lock file does not exist", () => {
    const result = getLastDistillTime(cfg());
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P0-1: acquireLock atomicity + named withLock / withWriteLock
// ---------------------------------------------------------------------------

describe("acquireLock atomicity (O_EXCL)", () => {
  it("is exclusive: second acquire on a live-held lock fails", () => {
    expect(acquireLock(cfg({ expireMs: 60_000 }))).toBe(true);
    expect(acquireLock(cfg({ expireMs: 60_000 }))).toBe(false);
  });
});

describe("withLock", () => {
  it("runs fn and releases the lock afterwards", async () => {
    const out = await withLock("wl-run", async () => 42, { lockDir: tempDir });
    expect(out.ran).toBe(true);
    if (out.ran) expect(out.result).toBe(42);
    expect(existsSync(lockPathForKey("wl-run", tempDir))).toBe(false);
  });

  it("skips (ran:false) when a live process already holds the lock", async () => {
    const p = lockPathForKey("wl-skip", tempDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(process.pid), "utf-8"); // current pid = alive
    let ran = false;
    const out = await withLock(
      "wl-skip",
      async () => { ran = true; return 1; },
      { lockDir: tempDir, expireMs: 60_000 },
    );
    expect(out.ran).toBe(false);
    if (!out.ran) expect(out.reason).toBe("locked_by_another_process");
    expect(ran).toBe(false);
  });

  it("does not block across different lock keys", async () => {
    const held = lockPathForKey("wl-keyA", tempDir);
    mkdirSync(dirname(held), { recursive: true });
    writeFileSync(held, String(process.pid), "utf-8");
    const out = await withLock("wl-keyB", async () => "ran", { lockDir: tempDir, expireMs: 60_000 });
    expect(out.ran).toBe(true);
  });

  it("releases the lock even when fn throws", async () => {
    await expect(
      withLock("wl-throw", async () => { throw new Error("boom"); }, { lockDir: tempDir }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPathForKey("wl-throw", tempDir))).toBe(false);
  });
});

describe("withWriteLock", () => {
  it("throws when a live holder never releases (timeout)", async () => {
    const p = lockPathForKey("ww-timeout", tempDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(process.pid), "utf-8"); // alive, never released
    await expect(
      withWriteLock("ww-timeout", async () => 1, {
        lockDir: tempDir,
        expireMs: 60_000,
        waitTimeoutMs: 150,
        pollMs: 20,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("reclaims an expired lock and runs", async () => {
    const p = lockPathForKey("ww-expired", tempDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(process.pid), "utf-8");
    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    utimesSync(p, twoHoursAgo, twoHoursAgo);
    const result = await withWriteLock("ww-expired", async () => "done", {
      lockDir: tempDir,
      expireMs: 3_600_000,
    });
    expect(result).toBe("done");
  });

  it("returns fn result directly on a free lock", async () => {
    const result = await withWriteLock("ww-free", async () => 7, { lockDir: tempDir });
    expect(result).toBe(7);
  });
});

describe("stampLock", () => {
  it("touches an existing lock file's mtime to now", () => {
    const p = lockPathForKey("stamp", tempDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(process.pid), "utf-8");
    utimesSync(p, new Date(Date.now() - 100_000), new Date(Date.now() - 100_000));
    stampLock({ lockPath: p });
    const st = statSync(p);
    expect(Math.abs(st.mtimeMs - Date.now())).toBeLessThan(2000);
  });

  it("is a no-op when the lock file does not exist", () => {
    expect(() => stampLock({ lockPath: lockPathForKey("stamp-absent", tempDir) })).not.toThrow();
  });
});
