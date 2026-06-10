import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readHeartbeats,
  writeHeartbeat,
  checkSourceStaleness,
  formatAge,
  type HeartbeatFile,
} from "../source-heartbeat.js";
import { runDataCheckup } from "../data-checkup.js";
import type { MemoryEntry, MemoryStore } from "../store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpHeartbeatPath(): string {
  const dir = join(tmpdir(), `recallnest-test-heartbeat-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "source-heartbeat.json");
}

function makeEntry(id: string): MemoryEntry {
  return {
    id,
    text: "test memory",
    vector: [1, 0, 0, 0, 0],
    category: "events",
    scope: "project:test",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: JSON.stringify({
      evolution: {
        status: "active",
        version: 1,
        accessCount: 0,
        lastAccessedAt: null,
        supersededBy: null,
        consolidatedInto: null,
        contributedToPattern: null,
        sourceMemories: [],
        validFrom: Date.now(),
        validUntil: null,
      },
    }),
  };
}

function createMockStore(entries: MemoryEntry[]): Pick<MemoryStore, "list" | "stats" | "getVectors"> {
  return {
    // 复刻真实 store:list() 为性能不返回向量,诊断检查经 getVectors 补回。
    async list() { return entries.map(e => ({ ...e, vector: [] })); },
    async stats() {
      return { totalCount: entries.length, scopeCounts: {}, categoryCounts: {} };
    },
    async getVectors(ids: string[]) {
      const map = new Map<string, number[]>();
      for (const e of entries) {
        if (ids.includes(e.id) && e.vector && e.vector.length > 0) map.set(e.id, e.vector);
      }
      return map;
    },
  } as Pick<MemoryStore, "list" | "stats" | "getVectors">;
}

// ---------------------------------------------------------------------------
// Tests: readHeartbeats / writeHeartbeat
// ---------------------------------------------------------------------------

describe("source-heartbeat", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = tmpHeartbeatPath();
  });

  afterEach(() => {
    try {
      const dir = join(tmpPath, "..");
      rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("returns empty object when file does not exist", () => {
    const result = readHeartbeats(tmpPath);
    expect(result).toEqual({});
  });

  it("writes and reads back a heartbeat", () => {
    writeHeartbeat("obsidian", 42, [], tmpPath);

    const heartbeats = readHeartbeats(tmpPath);
    expect(Object.keys(heartbeats)).toEqual(["obsidian"]);
    expect(heartbeats.obsidian.source).toBe("obsidian");
    expect(heartbeats.obsidian.recordsIngested).toBe(42);
    expect(heartbeats.obsidian.errors).toEqual([]);
    expect(heartbeats.obsidian.lastIngest).toBeTruthy();
  });

  it("updates existing source without losing other sources", () => {
    writeHeartbeat("obsidian", 10, [], tmpPath);
    writeHeartbeat("email", 5, ["timeout"], tmpPath);
    writeHeartbeat("obsidian", 20, [], tmpPath); // update

    const heartbeats = readHeartbeats(tmpPath);
    expect(Object.keys(heartbeats).sort()).toEqual(["email", "obsidian"]);
    expect(heartbeats.obsidian.recordsIngested).toBe(20);
    expect(heartbeats.email.recordsIngested).toBe(5);
    expect(heartbeats.email.errors).toEqual(["timeout"]);
  });

  it("caps stored errors to 10", () => {
    const manyErrors = Array.from({ length: 15 }, (_, i) => `error-${i}`);
    writeHeartbeat("broken", 0, manyErrors, tmpPath);

    const heartbeats = readHeartbeats(tmpPath);
    expect(heartbeats.broken.errors.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Tests: checkSourceStaleness
// ---------------------------------------------------------------------------

describe("checkSourceStaleness", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = tmpHeartbeatPath();
  });

  afterEach(() => {
    try {
      rmSync(join(tmpPath, ".."), { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("returns empty for fresh sources", () => {
    writeHeartbeat("obsidian", 10, [], tmpPath);
    const stale = checkSourceStaleness(7, tmpPath);
    expect(stale).toEqual([]);
  });

  it("detects stale sources", () => {
    // Manually write a stale heartbeat
    const staleDate = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const heartbeats: HeartbeatFile = {
      old_source: {
        source: "old_source",
        lastIngest: staleDate,
        recordsIngested: 5,
        errors: [],
      },
    };
    const { writeFileSync } = require("node:fs");
    writeFileSync(tmpPath, JSON.stringify(heartbeats));

    const stale = checkSourceStaleness(7, tmpPath);
    expect(stale.length).toBe(1);
    expect(stale[0].source).toBe("old_source");
    expect(stale[0].daysSince).toBeGreaterThanOrEqual(9);
  });

  it("returns empty for missing file", () => {
    const stale = checkSourceStaleness(7, "/tmp/nonexistent-path.json");
    expect(stale).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: formatAge
// ---------------------------------------------------------------------------

describe("formatAge", () => {
  it("returns 'just now' for recent timestamps", () => {
    expect(formatAge(new Date().toISOString())).toBe("just now");
  });

  it("returns hours for <24h", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(formatAge(twoHoursAgo)).toBe("2h ago");
  });

  it("returns days for >=24h", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(formatAge(threeDaysAgo)).toBe("3d ago");
  });
});

// ---------------------------------------------------------------------------
// Tests: data_checkup integration
// ---------------------------------------------------------------------------

describe("data_checkup with source_health", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = tmpHeartbeatPath();
  });

  afterEach(() => {
    try {
      rmSync(join(tmpPath, ".."), { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("includes source_health check (8 checks total)", async () => {
    const entries = [makeEntry("a"), makeEntry("b")];
    const report = await runDataCheckup({
      store: createMockStore(entries),
      openConflictCount: 0,
      heartbeatPath: tmpPath,
    });

    expect(report.checks.length).toBe(8);
    const sourceCheck = report.checks.find((c) => c.name === "source_health");
    expect(sourceCheck).toBeTruthy();
    expect(sourceCheck!.status).toBe("ok");
    expect(sourceCheck!.detail).toContain("No connector sources tracked yet");
  });

  it("reports warning for stale sources", async () => {
    // Write a stale heartbeat
    const staleDate = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const heartbeats: HeartbeatFile = {
      email: {
        source: "email",
        lastIngest: staleDate,
        recordsIngested: 5,
        errors: [],
      },
    };
    const { writeFileSync } = require("node:fs");
    writeFileSync(tmpPath, JSON.stringify(heartbeats));

    const entries = [makeEntry("a")];
    const report = await runDataCheckup({
      store: createMockStore(entries),
      openConflictCount: 0,
      heartbeatPath: tmpPath,
    });

    const sourceCheck = report.checks.find((c) => c.name === "source_health");
    expect(sourceCheck).toBeTruthy();
    expect(sourceCheck!.status).toBe("warning");
    expect(sourceCheck!.detail).toContain("stale");
  });
});
