import { describe, expect, it, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDream, formatDreamResult, type DreamResult } from "../dream-pipeline.js";
import { isDerivedInsight } from "../consolidation-engine.js";
import type { MemoryEntry, MemoryStore } from "../store.js";
import type { LLMClient } from "../llm-client.js";
import type { Embedder } from "../embedder.js";
import { resetWriteCount } from "../activity-counter.js";

// Isolate the activity-counter (default path = <dataDir>/activity-stats.json) to a temp
// dir so these tests never read/write the repo's data/activity-stats.json that the
// production dream scheduler uses.
let __origDataDir: string | undefined;
beforeAll(() => {
  __origDataDir = process.env.RECALLNEST_DATA_DIR;
  process.env.RECALLNEST_DATA_DIR = mkdtempSync(join(tmpdir(), "rn-dp-datadir-"));
});
afterAll(() => {
  if (__origDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
  else process.env.RECALLNEST_DATA_DIR = __origDataDir;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "test memory",
    vector: [1, 0, 0, 0, 0],
    category: "events",
    scope: "project:test",
    importance: 0.5,
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

function createMockStore(entries: MemoryEntry[]): MemoryStore {
  const stored: MemoryEntry[] = [...entries];
  let storeCounter = 0;

  return {
    async list() { return stored; },
    async stats() {
      return {
        totalCount: stored.length,
        scopeCounts: {},
        categoryCounts: {},
      };
    },
    async store(entry: Partial<MemoryEntry>) {
      const full = {
        id: entry.id || `dream-${storeCounter++}`,
        text: entry.text || "",
        vector: entry.vector || [],
        category: entry.category || "events",
        scope: entry.scope || "project:test",
        importance: entry.importance || 0.5,
        timestamp: Date.now(),
        metadata: entry.metadata || "{}",
      } as MemoryEntry;
      stored.push(full);
      return full;
    },
    async update(id: string, upd: Partial<MemoryEntry>) {
      const entry = stored.find(e => e.id === id);
      if (entry && upd.metadata) entry.metadata = upd.metadata;
      return entry || { id, text: "", vector: [], category: "events", scope: "project:test", importance: 0.5, timestamp: Date.now(), metadata: "{}" } as MemoryEntry;
    },
    async getById(id: string) {
      return stored.find(e => e.id === id) || null;
    },
    // 模拟 store.patchMetadata 单写通道:读最新 metadata → patchFn → 写回。
    async patchMetadata(
      id: string,
      patchFn: (meta: Record<string, unknown>, entry: MemoryEntry) => Record<string, unknown>,
      _scopeFilter?: string[],
    ) {
      const entry = stored.find(e => e.id === id);
      if (!entry) return null;
      let meta: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(entry.metadata || "{}");
        meta = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        meta = {};
      }
      entry.metadata = JSON.stringify(patchFn(meta, entry));
      return entry;
    },
    async vectorSearch(_vec: number[], limit: number, _threshold: number, _scopes?: string[]) {
      return stored.slice(0, limit).map(e => ({ entry: e, score: 0.85 }));
    },
  } as unknown as MemoryStore;
}

function createMockLLM(): LLMClient {
  return {
    async generateL0() { return "consolidated insight"; },
    async extractPattern() { return "discovered pattern"; },
  } as unknown as LLMClient;
}

function createMockEmbedder(): Pick<Embedder, "embedPassage"> {
  return {
    async embedPassage() { return [0.5, 0.5, 0, 0, 0]; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDream", () => {
  beforeEach(() => {
    // Reset the activity counter for the test scope between tests (per-scope API).
    resetWriteCount("project:test");
  });

  it("skips when write count is below threshold", async () => {
    const store = createMockStore([makeEntry({ id: "a" })]);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      config: { minWritesForDream: 10 },
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toContain("insufficient_writes");
    expect(result.phases.length).toBe(1);
    expect(result.phases[0].phase).toBe("orient");
  });

  it("persists usageStatus snapshots during gather (P0 B-1, flag on)", async () => {
    process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL = "true";
    try {
    const coldMeta = JSON.stringify({
      accessCount: 8, // injection >= 6, useCount 0 -> cold
      evolution: { status: "active", version: 1 },
    });
    const entries = [
      makeEntry({ id: "cold-1", metadata: coldMeta }),
      makeEntry({ id: "fresh-1" }), // unused 默认态:不写快照,防全库写放大
    ];
    const store = createMockStore(entries);

    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    const cold = await store.getById("cold-1");
    expect(JSON.parse(cold!.metadata!).usage.usageStatus).toBe("cold");
    const fresh = await store.getById("fresh-1");
    expect(JSON.parse(fresh!.metadata!).usage).toBeUndefined();
    const gather = result.phases.find(p => p.phase === "gather");
    expect(gather!.detail).toContain("usage snapshot: 1");
    } finally {
      delete process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL;
    }
  });

  it("skips usageStatus snapshots when use signal is inactive (flag off)", async () => {
    delete process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL;
    const coldMeta = JSON.stringify({
      accessCount: 8,
      evolution: { status: "active", version: 1 },
    });
    const store = createMockStore([makeEntry({ id: "cold-1", metadata: coldMeta })]);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });
    expect(result.ran).toBe(true);
    const cold = await store.getById("cold-1");
    expect(JSON.parse(cold!.metadata!).usage).toBeUndefined();
    const gather = result.phases.find(p => p.phase === "gather");
    expect(gather!.detail).not.toContain("usage snapshot");
  });

  it("runs when forced despite low write count", async () => {
    const entries = [
      makeEntry({ id: "a", vector: [0.9, 0.1, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [0.88, 0.12, 0, 0, 0] }),
      makeEntry({ id: "c", vector: [0.92, 0.08, 0, 0, 0] }),
    ];
    const store = createMockStore(entries);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    expect(result.phases.length).toBe(4);
    expect(result.phases.map(p => p.phase)).toEqual(["orient", "gather", "consolidate", "prune"]);
  });

  it("completes early with too few active entries", async () => {
    const store = createMockStore([
      makeEntry({ id: "a" }),
    ]);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
      config: { minClusterSize: 3 },
    });

    expect(result.ran).toBe(true);
    expect(result.reason).toBe("completed_early");
  });

  it("works without LLM (null) — only deterministic consolidation", async () => {
    const entries = [
      makeEntry({ id: "a", vector: [0.9, 0.1, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [0.88, 0.12, 0, 0, 0] }),
      makeEntry({ id: "c", vector: [0.92, 0.08, 0, 0, 0] }),
    ];
    const store = createMockStore(entries);
    const result = await runDream({
      store,
      llm: null,
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    expect(result.stats.insightsGenerated).toBe(0); // No LLM = no insights
    expect(result.stats.patternsExtracted).toBe(0);
  });

  it("reports correct stats structure", async () => {
    const entries = [
      makeEntry({ id: "a", vector: [0.9, 0.1, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [0.88, 0.12, 0, 0, 0] }),
      makeEntry({ id: "c", vector: [0.92, 0.08, 0, 0, 0] }),
    ];
    const store = createMockStore(entries);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.stats.totalMemories).toBeGreaterThanOrEqual(0);
    expect(result.stats.activeMemories).toBeGreaterThanOrEqual(0);
    expect(typeof result.stats.clustersFound).toBe("number");
    expect(typeof result.stats.insightsGenerated).toBe("number");
    expect(typeof result.stats.patternsExtracted).toBe("number");
    expect(typeof result.stats.mergedCount).toBe("number");
    expect(typeof result.stats.archivedCount).toBe("number");
  });

  it("excludes its own derivatives from the gather, so insights are not re-consolidated", async () => {
    const derivedMeta = (flag: "cluster_insight" | "cross_memory_pattern") => JSON.stringify({
      evolution: { status: "active", version: 1, sourceMemories: ["real-1", "real-2"] },
      [flag]: true,
    });

    const store = createMockStore([
      makeEntry({ id: "real-1" }),
      makeEntry({ id: "real-2" }),
      makeEntry({ id: "insight-1", metadata: derivedMeta("cluster_insight") }),
      makeEntry({ id: "pattern-1", metadata: derivedMeta("cross_memory_pattern") }),
    ]);

    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    // All four stay visible to stats and usage observation...
    expect(result.stats.activeMemories).toBe(4);
    // ...but the insight and the pattern are derivatives of the other two and
    // must not feed the next round of consolidation.
    const gather = result.phases.find(p => p.phase === "gather");
    expect(gather!.detail).toContain("4 active entries gathered from 4 total");
    expect(gather!.detail).toContain("2 derivatives held back from consolidation");
  });

  it("does not hold anything back when there are no derivatives", async () => {
    // Guard against the exclusion being too greedy: the metadata flags are what
    // matter, not the words. A memory that merely talks about insights stays in.
    const store = createMockStore([
      makeEntry({ id: "real-1", text: "a note about cluster_insight and patterns" }),
      makeEntry({ id: "real-2" }),
    ]);

    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.stats.activeMemories).toBe(2);
    const gather = result.phases.find(p => p.phase === "gather");
    expect(gather!.detail).not.toContain("held back");
  });
});

describe("isDerivedInsight", () => {
  it("flags cluster insights and cross-memory patterns", () => {
    expect(isDerivedInsight(JSON.stringify({ cluster_insight: true }))).toBe(true);
    expect(isDerivedInsight(JSON.stringify({ cross_memory_pattern: true }))).toBe(true);
  });

  it("leaves ordinary memories alone", () => {
    expect(isDerivedInsight(JSON.stringify({ evolution: { status: "active" } }))).toBe(false);
    expect(isDerivedInsight(JSON.stringify({ cluster_insight: false }))).toBe(false);
    expect(isDerivedInsight("{}")).toBe(false);
  });

  it("treats missing or malformed metadata as not derived", () => {
    expect(isDerivedInsight(undefined)).toBe(false);
    expect(isDerivedInsight("{ not json")).toBe(false);
  });
});

describe("formatDreamResult", () => {
  it("formats skipped dream", () => {
    const result: DreamResult = {
      ran: false,
      reason: "insufficient_writes (3/10)",
      phases: [{ phase: "orient", detail: "50 memories, 3 writes" }],
      stats: { totalMemories: 50, activeMemories: 0, writesSinceLastDream: 3, clustersFound: 0, insightsGenerated: 0, patternsExtracted: 0, mergedCount: 0, archivedCount: 0 },
    };
    const output = formatDreamResult(result);
    expect(output).toContain("skipped");
    expect(output).toContain("insufficient_writes");
  });

  it("formats completed dream with all phases", () => {
    const result: DreamResult = {
      ran: true,
      phases: [
        { phase: "orient", detail: "100 memories, 15 writes" },
        { phase: "gather", detail: "80 active entries" },
        { phase: "consolidate", detail: "3 clusters, 1 merged, 2 insights, 1 pattern" },
        { phase: "prune", detail: "5 entries archived" },
      ],
      stats: { totalMemories: 100, activeMemories: 80, writesSinceLastDream: 15, clustersFound: 3, insightsGenerated: 2, patternsExtracted: 1, mergedCount: 1, archivedCount: 5 },
    };
    const output = formatDreamResult(result);
    expect(output).toContain("Dream completed");
    expect(output).toContain("[orient]");
    expect(output).toContain("[consolidate]");
    expect(output).toContain("[prune]");
    expect(output).toContain("Patterns: 1");
  });
});
