import { describe, expect, it } from "bun:test";
import { runDataCheckup, formatCheckupReport, type CheckupReport } from "../data-checkup.js";
import type { MemoryEntry, MemoryStore } from "../store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
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
    ...overrides,
  };
}

function createMockStore(entries: MemoryEntry[]): Pick<MemoryStore, "list" | "stats" | "getVectors"> {
  return {
    // 复刻真实 store:list() 为性能不返回向量(vector: []),维度/干扰检查需经 getVectors 补回。
    // 旧 mock 直接返回带向量的 entry,与生产行为不符,曾掩盖维度检查在生产假报健康的 bug。
    async list() { return entries.map(e => ({ ...e, vector: [] })); },
    async stats() {
      return { totalCount: entries.length, scopeCounts: {}, categoryCounts: {} };
    },
    async getVectors(ids: string[]) {
      const map = new Map<string, number[]>();
      for (const e of entries) {
        if (ids.includes(e.id) && e.vector.length > 0) map.set(e.id, e.vector);
      }
      return map;
    },
  } as Pick<MemoryStore, "list" | "stats" | "getVectors">;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDataCheckup", () => {
  it("returns all-ok for healthy data", async () => {
    const entries = [
      makeEntry({ id: "a" }),
      makeEntry({ id: "b" }),
      makeEntry({ id: "c" }),
    ];

    const report = await runDataCheckup({
      store: createMockStore(entries),
      openConflictCount: 0,
    });

    expect(report.checks.length).toBe(8);
    expect(report.checks.every(c => c.status === "ok")).toBe(true);
    expect(report.totalEntries).toBe(3);
  });

  it("reports usage distribution with cold top list (P0 B-1)", async () => {
    const coldMeta = JSON.stringify({
      accessCount: 10, // injection >= 6, no usage.useCount -> cold
      evolution: { status: "active", version: 1 },
    });
    const entries = [
      makeEntry({ id: "cold-1", metadata: coldMeta }),
      makeEntry({ id: "ok-1" }),
      makeEntry({ id: "ok-2" }),
    ];

    const report = await runDataCheckup({
      store: createMockStore(entries),
      openConflictCount: 0,
    });

    const usage = report.checks.find(c => c.name === "usage_distribution");
    expect(usage).toBeTruthy();
    expect(usage!.detail).toContain("cold=1");
    expect(usage!.detail).toContain("cold-1".slice(0, 6)); // top list shows the id prefix
    // 1/3 = 33% cold > 10% -> warning
    expect(usage!.status).toBe("warning");
  });

  it("detects vector dimension inconsistency", async () => {
    const entries = [
      makeEntry({ id: "a", vector: [1, 0, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [1, 0, 0] }), // wrong dim
      makeEntry({ id: "c", vector: [1, 0, 0, 0, 0] }),
    ];

    const report = await runDataCheckup({
      store: createMockStore(entries),
      openConflictCount: 0,
    });

    const dimCheck = report.checks.find(c => c.name === "vector_dimensions")!;
    expect(dimCheck.status).toBe("error");
    expect(dimCheck.detail).toContain("1 entries have wrong dimension");
  });

  it("detects orphan memories with empty scope", async () => {
    const entries = [
      makeEntry({ id: "a", scope: "project:test" }),
      makeEntry({ id: "b", scope: "" }),
      makeEntry({ id: "c", scope: "__schema__" }),
    ];

    const report = await runDataCheckup({
      store: createMockStore(entries),
      openConflictCount: 0,
    });

    const orphanCheck = report.checks.find(c => c.name === "orphan_memories")!;
    expect(orphanCheck.status).toBe("warning");
    expect(orphanCheck.detail).toContain("2 memories");
  });

  it("warns about unhealthy tier distribution — too many core", async () => {
    // Make 501 core entries (tier resolved from metadata top-level importance >= 0.95)
    const entries = Array.from({ length: 501 }, (_, i) =>
      makeEntry({
        id: `core-${i}`,
        importance: 0.99,
        metadata: JSON.stringify({
          importance: 0.99,
          accessCount: 10,
          evolution: { status: "active", version: 1, accessCount: 10, lastAccessedAt: null, supersededBy: null, consolidatedInto: null, contributedToPattern: null, sourceMemories: [], validFrom: Date.now(), validUntil: null },
        }),
      })
    );

    const report = await runDataCheckup({
      store: createMockStore(entries),
      openConflictCount: 0,
    });

    const tierCheck = report.checks.find(c => c.name === "tier_distribution")!;
    expect(tierCheck.status).toBe("warning");
    expect(tierCheck.detail).toContain("core tier has 501");
  });

  it("reports conflict backlog levels", async () => {
    // 0 = ok
    const r0 = await runDataCheckup({ store: createMockStore([]), openConflictCount: 0 });
    expect(r0.checks.find(c => c.name === "conflict_backlog")!.status).toBe("ok");

    // 3 = still ok
    const r3 = await runDataCheckup({ store: createMockStore([]), openConflictCount: 3 });
    expect(r3.checks.find(c => c.name === "conflict_backlog")!.status).toBe("ok");

    // 10 = warning
    const r10 = await runDataCheckup({ store: createMockStore([]), openConflictCount: 10 });
    expect(r10.checks.find(c => c.name === "conflict_backlog")!.status).toBe("warning");

    // 25 = error
    const r25 = await runDataCheckup({ store: createMockStore([]), openConflictCount: 25 });
    expect(r25.checks.find(c => c.name === "conflict_backlog")!.status).toBe("error");
  });

  it("detects version group issues — single-member group", async () => {
    const entries = [
      makeEntry({
        id: "a",
        metadata: JSON.stringify({
          version_group: "vg-abc",
          version_rank: 2.5,
          evolution: { status: "active", version: 1, accessCount: 0, lastAccessedAt: null, supersededBy: null, consolidatedInto: null, contributedToPattern: null, sourceMemories: [], validFrom: Date.now(), validUntil: null },
        }),
      }),
      // vg-abc has only 1 member — suspicious
    ];

    const report = await runDataCheckup({
      store: createMockStore(entries),
      openConflictCount: 0,
    });

    const vgCheck = report.checks.find(c => c.name === "version_groups")!;
    expect(vgCheck.status).toBe("warning");
    expect(vgCheck.detail).toContain("only 1 member");
  });

  it("detects version group with missing rank", async () => {
    const entries = [
      makeEntry({
        id: "a",
        metadata: JSON.stringify({
          version_group: "vg-xyz",
          version_rank: 2.0,
          evolution: { status: "active", version: 1, accessCount: 0, lastAccessedAt: null, supersededBy: null, consolidatedInto: null, contributedToPattern: null, sourceMemories: [], validFrom: Date.now(), validUntil: null },
        }),
      }),
      makeEntry({
        id: "b",
        metadata: JSON.stringify({
          version_group: "vg-xyz",
          // version_rank missing
          evolution: { status: "active", version: 1, accessCount: 0, lastAccessedAt: null, supersededBy: null, consolidatedInto: null, contributedToPattern: null, sourceMemories: [], validFrom: Date.now(), validUntil: null },
        }),
      }),
    ];

    const report = await runDataCheckup({
      store: createMockStore(entries),
      openConflictCount: 0,
    });

    const vgCheck = report.checks.find(c => c.name === "version_groups")!;
    expect(vgCheck.status).toBe("warning");
    expect(vgCheck.detail).toContain("missing rank");
  });

  it("handles empty database", async () => {
    const report = await runDataCheckup({
      store: createMockStore([]),
      openConflictCount: 0,
    });

    expect(report.totalEntries).toBe(0);
    expect(report.checks.every(c => c.status === "ok")).toBe(true);
  });
});

describe("formatCheckupReport", () => {
  it("formats report with mix of statuses", () => {
    const report: CheckupReport = {
      checks: [
        { name: "check_a", status: "ok", detail: "all good" },
        { name: "check_b", status: "warning", detail: "minor issue" },
        { name: "check_c", status: "error", detail: "big problem" },
      ],
      totalEntries: 100,
      totalAvailable: 100,
      timestamp: "2026-04-03T12:00:00.000Z",
    };

    const output = formatCheckupReport(report);
    expect(output).toContain("[OK] check_a");
    expect(output).toContain("[WARN] check_b");
    expect(output).toContain("[ERR] check_c");
    expect(output).toContain("1 error(s), 1 warning(s), 1 ok");
    expect(output).toContain("Total entries scanned: 100");
  });
});
