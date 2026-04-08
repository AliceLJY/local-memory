import { describe, expect, it } from "bun:test";
import { runMemoryLint, formatMemoryLintReport, computeHealthScore, type MemoryLintReport } from "../memory-lint.js";
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
        supersedes: null,
        evolutionNote: null,
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

function createMockStore(entries: MemoryEntry[]): Pick<MemoryStore, "list"> {
  return {
    async list() { return entries; },
  } as Pick<MemoryStore, "list">;
}

// ---------------------------------------------------------------------------
// runMemoryLint
// ---------------------------------------------------------------------------

describe("runMemoryLint", () => {
  it("returns all-clear for healthy data", async () => {
    const entries = [
      makeEntry({ id: "a1", text: "User prefers dark mode", category: "preferences", vector: [1, 0, 0, 0, 0] }),
      makeEntry({ id: "a2", text: "Project uses Bun runtime", category: "entities", vector: [0, 1, 0, 0, 0] }),
    ];
    const store = createMockStore(entries);
    const report = await runMemoryLint({ store });

    expect(report.healthScore).toBe(100);
    expect(report.findings).toHaveLength(0);
    expect(report.summary.contradictions).toBe(0);
    expect(report.summary.duplicates).toBe(0);
    expect(report.totalScanned).toBe(2);
  });

  it("detects contradictions in same scope+category", async () => {
    const entries = [
      makeEntry({ id: "c1", text: "Always use Bun for scripts", scope: "project:x", category: "patterns" }),
      makeEntry({ id: "c2", text: "Never use Bun for scripts", scope: "project:x", category: "patterns" }),
    ];
    const store = createMockStore(entries);
    const report = await runMemoryLint({ store });

    expect(report.summary.contradictions).toBeGreaterThanOrEqual(1);
    const finding = report.findings.find(f => f.check === "contradiction");
    expect(finding).toBeDefined();
    expect(finding!.memoryIds).toContain("c1");
    expect(finding!.memoryIds).toContain("c2");
  });

  it("detects duplicates by vector similarity", async () => {
    const vec = [0.5, 0.5, 0.5, 0.5, 0.5];
    const entries = [
      makeEntry({ id: "d1", text: "Docker port is 4318", vector: vec, scope: "project:x", category: "entities" }),
      makeEntry({ id: "d2", text: "Docker port is 4318 config", vector: vec, scope: "project:x", category: "entities" }),
    ];
    const store = createMockStore(entries);
    const report = await runMemoryLint({ store });

    expect(report.summary.duplicates).toBeGreaterThanOrEqual(1);
    const finding = report.findings.find(f => f.check === "duplicate");
    expect(finding).toBeDefined();
  });

  it("detects stale memories (old, never accessed)", async () => {
    const oldTimestamp = Date.now() - 120 * 24 * 60 * 60 * 1000; // 120 days ago
    const entries = [
      makeEntry({
        id: "s1",
        text: "Some old fact",
        timestamp: oldTimestamp,
        metadata: JSON.stringify({
          evolution: {
            status: "active",
            version: 1,
            accessCount: 0,
            lastAccessedAt: null,
            supersededBy: null,
            supersedes: null,
            evolutionNote: null,
            consolidatedInto: null,
            contributedToPattern: null,
            sourceMemories: [],
            validFrom: oldTimestamp,
            validUntil: null,
          },
        }),
      }),
    ];
    const store = createMockStore(entries);
    const report = await runMemoryLint({ store });

    expect(report.summary.staleMemories).toBe(1);
    const finding = report.findings.find(f => f.check === "stale");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
  });

  it("detects orphans with missing scope", async () => {
    const entries = [
      makeEntry({ id: "o1", text: "Orphan memory", scope: "" }),
      makeEntry({ id: "o2", text: "Schema entry", scope: "__schema__" }),
    ];
    const store = createMockStore(entries);
    const report = await runMemoryLint({ store });

    expect(report.summary.orphans).toBe(2);
  });

  it("detects broken consolidation links", async () => {
    const entries = [
      makeEntry({
        id: "b1",
        text: "Points to deleted",
        metadata: JSON.stringify({
          evolution: {
            status: "active",
            version: 1,
            accessCount: 5,
            lastAccessedAt: Date.now(),
            supersededBy: null,
            supersedes: null,
            evolutionNote: null,
            consolidatedInto: "nonexistent-id-12345",
            contributedToPattern: null,
            sourceMemories: [],
            validFrom: Date.now(),
            validUntil: null,
          },
        }),
      }),
    ];
    const store = createMockStore(entries);
    const report = await runMemoryLint({ store });

    expect(report.summary.orphans).toBe(1);
    const finding = report.findings.find(f => f.check === "orphan" && f.severity === "warning");
    expect(finding).toBeDefined();
  });

  it("skips non-active entries", async () => {
    const entries = [
      makeEntry({
        id: "arc1",
        text: "Archived memory",
        scope: "",
        metadata: JSON.stringify({
          evolution: {
            status: "archived",
            version: 1,
            accessCount: 0,
            lastAccessedAt: null,
            supersededBy: null,
            supersedes: null,
            evolutionNote: null,
            consolidatedInto: null,
            contributedToPattern: null,
            sourceMemories: [],
            validFrom: Date.now(),
            validUntil: null,
          },
        }),
      }),
    ];
    const store = createMockStore(entries);
    const report = await runMemoryLint({ store });

    // Archived entry should be skipped, so no orphan finding
    expect(report.totalScanned).toBe(0);
    expect(report.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeHealthScore
// ---------------------------------------------------------------------------

describe("computeHealthScore", () => {
  it("returns 100 when no issues", () => {
    expect(computeHealthScore({ contradictions: 0, duplicates: 0, staleMemories: 0, orphans: 0 }, 100)).toBe(100);
  });

  it("deducts correctly for mixed findings", () => {
    // 1 contradiction (-10) + 2 duplicates (-10) + 4 stale (-2) + 1 orphan (-3) = -25 → 75
    expect(computeHealthScore({ contradictions: 1, duplicates: 2, staleMemories: 4, orphans: 1 }, 100)).toBe(75);
  });

  it("clamps to 0", () => {
    expect(computeHealthScore({ contradictions: 20, duplicates: 0, staleMemories: 0, orphans: 0 }, 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatMemoryLintReport
// ---------------------------------------------------------------------------

describe("formatMemoryLintReport", () => {
  it("shows all-clear when no findings", () => {
    const report: MemoryLintReport = {
      findings: [],
      healthScore: 100,
      totalScanned: 50,
      timestamp: "2026-04-08T12:00:00Z",
      summary: { contradictions: 0, duplicates: 0, staleMemories: 0, orphans: 0 },
    };
    const output = formatMemoryLintReport(report);
    expect(output).toContain("All Clear");
    expect(output).toContain("100/100");
  });

  it("includes findings when present", () => {
    const report: MemoryLintReport = {
      findings: [
        { check: "contradiction", severity: "warning", detail: '"A" vs "B"', memoryIds: ["id1", "id2"] },
      ],
      healthScore: 90,
      totalScanned: 100,
      timestamp: "2026-04-08T12:00:00Z",
      summary: { contradictions: 1, duplicates: 0, staleMemories: 0, orphans: 0 },
    };
    const output = formatMemoryLintReport(report);
    expect(output).toContain("Contradictions (1)");
    expect(output).toContain("90/100");
  });

  it("summarizes stale when count > 5", () => {
    const staleFindings = Array.from({ length: 10 }, (_, i) => ({
      check: "stale" as const,
      severity: "info" as const,
      detail: `${100 + i}d old`,
      memoryIds: [`stale${i}`],
    }));
    const report: MemoryLintReport = {
      findings: staleFindings,
      healthScore: 95,
      totalScanned: 200,
      timestamp: "2026-04-08T12:00:00Z",
      summary: { contradictions: 0, duplicates: 0, staleMemories: 10, orphans: 0 },
    };
    const output = formatMemoryLintReport(report);
    expect(output).toContain("Stale (10)");
    expect(output).toContain("10 memories not accessed");
  });
});
