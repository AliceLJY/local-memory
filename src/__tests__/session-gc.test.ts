import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSessionCheckpointRecord } from "../session-engine.js";
import { SessionCheckpointStore, classifyCheckpointQuality } from "../session-store.js";

const FALLBACK_SUMMARY = "Checkpoint captured current task state without repo-state details.";
const NOW = new Date("2026-04-01T00:00:00.000Z");

function daysBeforeNow(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function makeRichCheckpoint(overrides: Record<string, unknown> = {}) {
  return buildSessionCheckpointRecord({
    sessionId: overrides.sessionId ?? crypto.randomUUID(),
    scope: overrides.scope ?? "project:test",
    summary: overrides.summary ?? "Rich checkpoint with real content about the project status.",
    decisions: overrides.decisions ?? ["decision-a"],
    openLoops: overrides.openLoops ?? ["loop-a"],
    nextActions: overrides.nextActions ?? ["action-a"],
    entities: [],
    files: [],
    updatedAt: overrides.updatedAt ?? daysBeforeNow(1),
  });
}

function makeMinimalCheckpoint(overrides: Record<string, unknown> = {}) {
  return buildSessionCheckpointRecord({
    sessionId: overrides.sessionId ?? crypto.randomUUID(),
    scope: overrides.scope ?? "project:test",
    summary: FALLBACK_SUMMARY,
    decisions: [],
    openLoops: [],
    nextActions: [],
    entities: [],
    files: [],
    updatedAt: overrides.updatedAt ?? daysBeforeNow(1),
  });
}

function createTempStore(): { store: SessionCheckpointStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rn-gc-test-"));
  const checkpointDir = join(dir, "session-checkpoints");
  mkdirSync(checkpointDir, { recursive: true });
  const store = new SessionCheckpointStore(checkpointDir);
  return {
    store,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("checkpoint gc - retention rules", () => {
  it("keeps latest N rich checkpoints per scope and archives older ones", async () => {
    const { store, cleanup } = createTempStore();
    try {
      // 7 rich checkpoints for same scope, spread across 5-50 days
      const ages = [5, 10, 15, 25, 35, 42, 50];
      for (const age of ages) {
        await store.save(makeRichCheckpoint({ updatedAt: daysBeforeNow(age) }));
      }

      const result = store.gc({ now: NOW, keepPerScope: 5, archiveAfterDays: 30 });
      expect(result.kept).toBe(5);
      expect(result.archived).toBe(2); // 42d and 50d
      expect(result.deleted).toBe(0);
      expect(result.errors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("keeps latest checkpoint per session if within 48 hours", async () => {
    const { store, cleanup } = createTempStore();
    try {
      const sessionA = crypto.randomUUID();
      const sessionB = crypto.randomUUID();

      // sessionA: 1 hour old minimal — should be protected by session TTL
      await store.save(makeMinimalCheckpoint({ sessionId: sessionA, updatedAt: daysBeforeNow(0.04) }));
      // sessionB: 10 days old minimal — no session TTL protection, >7 days → delete
      await store.save(makeMinimalCheckpoint({ sessionId: sessionB, updatedAt: daysBeforeNow(10) }));

      const result = store.gc({ now: NOW, sessionTtlHours: 48, minimalTtlDays: 7 });
      expect(result.kept).toBe(1);  // sessionA protected
      expect(result.deleted).toBe(1); // sessionB expired minimal
    } finally {
      cleanup();
    }
  });

  it("deletes minimal checkpoints older than 7 days", async () => {
    const { store, cleanup } = createTempStore();
    try {
      await store.save(makeMinimalCheckpoint({ updatedAt: daysBeforeNow(3) }));
      await store.save(makeMinimalCheckpoint({ updatedAt: daysBeforeNow(8) }));
      await store.save(makeMinimalCheckpoint({ updatedAt: daysBeforeNow(15) }));

      const result = store.gc({ now: NOW, minimalTtlDays: 7 });
      expect(result.kept).toBe(1);   // 3d old
      expect(result.deleted).toBe(2); // 8d and 15d old
    } finally {
      cleanup();
    }
  });

  it("archives rich checkpoints older than 30 days not in latest-per-scope", async () => {
    const { store, dir, cleanup } = createTempStore();
    try {
      const ages = [5, 10, 20, 35, 40, 50];
      for (const age of ages) {
        await store.save(makeRichCheckpoint({ updatedAt: daysBeforeNow(age) }));
      }

      const result = store.gc({ now: NOW, keepPerScope: 3, archiveAfterDays: 30 });
      expect(result.kept).toBe(3);     // 5d, 10d, 20d
      expect(result.archived).toBe(3); // 35d, 40d, 50d

      // Verify files actually moved to archive
      const archiveDir = join(dir, "archive", "session-checkpoints");
      expect(existsSync(archiveDir)).toBe(true);
      expect(readdirSync(archiveDir).filter((f) => f.endsWith(".json"))).toHaveLength(3);
    } finally {
      cleanup();
    }
  });

  it("hard-deletes archived files older than 90 days", async () => {
    const { store, dir, cleanup } = createTempStore();
    try {
      // Manually place 2 files in archive directory
      const archiveDir = join(dir, "archive", "session-checkpoints");
      mkdirSync(archiveDir, { recursive: true });

      const file60d = join(archiveDir, "old-60d-file.json");
      const file100d = join(archiveDir, "old-100d-file.json");
      writeFileSync(file60d, "{}");
      writeFileSync(file100d, "{}");

      // Backdate mtimes
      const mtime60 = new Date(NOW.getTime() - 60 * 86_400_000);
      const mtime100 = new Date(NOW.getTime() - 100 * 86_400_000);
      utimesSync(file60d, mtime60, mtime60);
      utimesSync(file100d, mtime100, mtime100);

      const result = store.gc({ now: NOW, archiveTtlDays: 90 });
      expect(existsSync(file60d)).toBe(true);   // 60d < 90d, survives
      expect(existsSync(file100d)).toBe(false);  // 100d > 90d, deleted
      expect(result.deleted).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("checkpoint gc - priority and edge cases", () => {
  it("session TTL protection overrides minimal delete rule", async () => {
    const { store, cleanup } = createTempStore();
    try {
      const sessionId = crypto.randomUUID();
      // 2 hours old minimal — minimalTtlDays=0 would delete, but session TTL protects
      await store.save(makeMinimalCheckpoint({ sessionId, updatedAt: daysBeforeNow(0.08) }));

      const result = store.gc({ now: NOW, sessionTtlHours: 48, minimalTtlDays: 0 });
      expect(result.kept).toBe(1);
      expect(result.deleted).toBe(0);

      const keepAction = result.actions.find((a) => a.action === "keep");
      expect(keepAction?.reason).toContain("session");
    } finally {
      cleanup();
    }
  });

  it("dry run does not modify any files", async () => {
    const { store, dir, cleanup } = createTempStore();
    try {
      // 1 to delete (minimal, 10d), 1 to archive (rich, 35d), 1 to keep (rich, 2d)
      await store.save(makeMinimalCheckpoint({ updatedAt: daysBeforeNow(10) }));
      await store.save(makeRichCheckpoint({ updatedAt: daysBeforeNow(35) }));
      await store.save(makeRichCheckpoint({ updatedAt: daysBeforeNow(2) }));

      const checkpointDir = join(dir, "session-checkpoints");
      const beforeCount = readdirSync(checkpointDir).filter((f) => f.endsWith(".json")).length;

      const result = store.gc({ now: NOW, dryRun: true, keepPerScope: 1, archiveAfterDays: 30, minimalTtlDays: 7 });
      expect(result.archived).toBeGreaterThan(0);
      expect(result.deleted).toBeGreaterThan(0);

      // Files are still there
      const afterCount = readdirSync(checkpointDir).filter((f) => f.endsWith(".json")).length;
      expect(afterCount).toBe(beforeCount);
    } finally {
      cleanup();
    }
  });
});

describe("checkpoint gc - structural", () => {
  it("handles empty directory gracefully", () => {
    const { store, cleanup } = createTempStore();
    try {
      const result = store.gc({ now: NOW });
      expect(result.kept).toBe(0);
      expect(result.archived).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.errors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
