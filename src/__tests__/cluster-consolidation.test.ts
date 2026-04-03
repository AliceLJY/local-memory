import { describe, expect, it } from "bun:test";

import {
  clusterAndConsolidate,
  deduplicateByClusterInsight,
  type ClusterConsolidationResult,
} from "../consolidation-engine.js";
import type { MemoryEntry, MemoryStore } from "../store.js";
import type { LLMClient } from "../llm-client.js";
import type { Embedder } from "../embedder.js";
import { cosineSimilarity } from "../multi-vector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<MemoryEntry> & { id: string; text: string }): MemoryEntry {
  return {
    vector: [1, 0, 0],
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
        sourceMemories: [],
        validFrom: Date.now(),
        validUntil: null,
      },
    }),
    ...overrides,
  };
}

/** Create a mock store that tracks store() and update() calls */
function createMockStore() {
  const stored: MemoryEntry[] = [];
  const updates: Array<{ id: string; metadata: string }> = [];
  let storeCounter = 0;

  const store: Pick<MemoryStore, "store" | "update"> = {
    async store(entry) {
      const full: MemoryEntry = {
        ...entry,
        id: entry.id || `insight-${storeCounter++}`,
        timestamp: Date.now(),
        metadata: entry.metadata || "{}",
      };
      stored.push(full);
      return full;
    },
    async update(id, upd, _scopeFilter?) {
      if (upd.metadata) {
        updates.push({ id, metadata: upd.metadata });
      }
      return { id, text: "", vector: [], category: "events", scope: "project:test", importance: 0.5, timestamp: Date.now(), metadata: upd.metadata || "{}" } as MemoryEntry;
    },
  };

  return { store, stored, updates };
}

/** Create a mock LLM that returns a fixed insight string (or null to simulate failure) */
function createMockLLM(
  insightFn: (text: string) => string | null,
  patternFn?: (texts: string[]) => string | null,
): Pick<LLMClient, "generateL0" | "extractPattern"> {
  return {
    async generateL0(text: string) {
      return insightFn(text);
    },
    async extractPattern(texts: string[]) {
      return patternFn ? patternFn(texts) : null;
    },
  } as Pick<LLMClient, "generateL0" | "extractPattern">;
}

/** Create a mock embedder that returns a fixed vector */
function createMockEmbedder(vector: number[] = [0.5, 0.5, 0.5]): Pick<Embedder, "embedPassage"> {
  return {
    async embedPassage(_text: string) {
      return vector;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("clusterAndConsolidate", () => {
  it("returns zeros for empty entries", async () => {
    const { store } = createMockStore();
    const llm = createMockLLM(() => "insight");
    const embedder = createMockEmbedder();

    const result = await clusterAndConsolidate({
      entries: [],
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
    });

    expect(result.clustersFound).toBe(0);
    expect(result.clustersConsolidated).toBe(0);
    expect(result.insightsGenerated).toBe(0);
    expect(result.entriesLinked).toBe(0);
  });

  it("returns 0 consolidated when all clusters are below minClusterSize", async () => {
    // 2 entries each with different enough vectors to not cluster
    const entries = [
      makeEntry({ id: "a", text: "TypeScript patterns", vector: [1, 0, 0] }),
      makeEntry({ id: "b", text: "Python patterns", vector: [0, 1, 0] }),
    ];

    const { store } = createMockStore();
    const llm = createMockLLM(() => "insight");
    const embedder = createMockEmbedder();

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
    });

    expect(result.clustersFound).toBe(0);
    expect(result.clustersConsolidated).toBe(0);
    expect(result.insightsGenerated).toBe(0);
  });

  it("clusters similar entries and generates insights", async () => {
    // 3 entries with very similar vectors — should form one cluster
    const entries = [
      makeEntry({ id: "a", text: "TypeScript is great for large projects", vector: [0.9, 0.1, 0], importance: 0.8 }),
      makeEntry({ id: "b", text: "TypeScript helps with code safety", vector: [0.88, 0.12, 0], importance: 0.7 }),
      makeEntry({ id: "c", text: "TypeScript improves developer experience", vector: [0.92, 0.08, 0], importance: 0.6 }),
    ];

    const { store, stored, updates } = createMockStore();
    const llm = createMockLLM(() => "TypeScript benefits for development");
    const embedder = createMockEmbedder([0.5, 0.5, 0]);

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
      clusterThreshold: 0.75,
    });

    expect(result.clustersFound).toBe(1);
    expect(result.clustersConsolidated).toBe(1);
    expect(result.insightsGenerated).toBe(1);
    expect(result.entriesLinked).toBe(3);

    // Verify insight was stored
    expect(stored.length).toBe(1);
    expect(stored[0].text).toBe("TypeScript benefits for development");
    expect(stored[0].importance).toBe(0.8); // max of cluster
    expect(stored[0].category).toBe("events"); // majority category

    // Verify insight metadata has sourceMemories
    const insightMeta = JSON.parse(stored[0].metadata!);
    expect(insightMeta.evolution.sourceMemories).toEqual(["a", "b", "c"]);
    expect(insightMeta.cluster_insight).toBe(true);

    // Verify source memories were marked with consolidatedInto
    expect(updates.length).toBe(3);
    for (const upd of updates) {
      const meta = JSON.parse(upd.metadata);
      expect(meta.evolution.consolidatedInto).toBe(stored[0].id);
      // Status should remain active (not changed)
      expect(meta.evolution.status).toBe("active");
    }
  });

  it("skips non-active entries", async () => {
    const entries = [
      makeEntry({ id: "a", text: "active memory", vector: [0.9, 0.1, 0] }),
      makeEntry({
        id: "b", text: "archived memory", vector: [0.88, 0.12, 0],
        metadata: JSON.stringify({ evolution: { status: "archived", version: 1, accessCount: 0, lastAccessedAt: null, supersededBy: null, consolidatedInto: null, sourceMemories: [], validFrom: Date.now(), validUntil: null } }),
      }),
      makeEntry({ id: "c", text: "another active", vector: [0.92, 0.08, 0] }),
    ];

    const { store } = createMockStore();
    const llm = createMockLLM(() => "insight");
    const embedder = createMockEmbedder();

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
    });

    // Only 2 active entries — not enough for a cluster of 3
    expect(result.clustersFound).toBe(0);
    expect(result.insightsGenerated).toBe(0);
  });

  it("handles LLM failure gracefully (returns null insight)", async () => {
    const entries = [
      makeEntry({ id: "a", text: "memory A", vector: [0.9, 0.1, 0] }),
      makeEntry({ id: "b", text: "memory B", vector: [0.88, 0.12, 0] }),
      makeEntry({ id: "c", text: "memory C", vector: [0.92, 0.08, 0] }),
    ];

    const { store, stored } = createMockStore();
    const llm = createMockLLM(() => null); // LLM fails
    const embedder = createMockEmbedder();

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
      clusterThreshold: 0.75,
    });

    expect(result.clustersFound).toBe(1);
    expect(result.clustersConsolidated).toBe(1); // Still counts as processed
    expect(result.insightsGenerated).toBe(0); // No insight generated
    expect(stored.length).toBe(0); // Nothing stored
  });

  it("respects maxClusters limit", async () => {
    // Create 2 distinct clusters, each with 3 members
    const entries = [
      // Cluster 1: similar vectors near [1, 0, 0]
      makeEntry({ id: "a1", text: "cluster 1 member A", vector: [0.95, 0.05, 0] }),
      makeEntry({ id: "a2", text: "cluster 1 member B", vector: [0.93, 0.07, 0] }),
      makeEntry({ id: "a3", text: "cluster 1 member C", vector: [0.97, 0.03, 0] }),
      // Cluster 2: similar vectors near [0, 1, 0]
      makeEntry({ id: "b1", text: "cluster 2 member A", vector: [0.05, 0.95, 0] }),
      makeEntry({ id: "b2", text: "cluster 2 member B", vector: [0.07, 0.93, 0] }),
      makeEntry({ id: "b3", text: "cluster 2 member C", vector: [0.03, 0.97, 0] }),
    ];

    const { store } = createMockStore();
    const llm = createMockLLM(() => "consolidated insight");
    const embedder = createMockEmbedder();

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
      clusterThreshold: 0.75,
      maxClusters: 1, // Only process 1 cluster
    });

    expect(result.clustersFound).toBe(2);
    expect(result.clustersConsolidated).toBe(1); // Only 1 processed
    expect(result.insightsGenerated).toBe(1);
  });

  it("uses majority vote for category selection", async () => {
    const entries = [
      makeEntry({ id: "a", text: "pattern A", vector: [0.9, 0.1, 0], category: "patterns" }),
      makeEntry({ id: "b", text: "pattern B", vector: [0.88, 0.12, 0], category: "patterns" }),
      makeEntry({ id: "c", text: "event C", vector: [0.92, 0.08, 0], category: "events" }),
    ];

    const { store, stored } = createMockStore();
    const llm = createMockLLM(() => "common pattern insight");
    const embedder = createMockEmbedder();

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
      clusterThreshold: 0.75,
    });

    expect(result.insightsGenerated).toBe(1);
    expect(stored[0].category).toBe("patterns"); // majority = patterns (2 vs 1)
  });

  // CC-9: Diminishing returns early stop
  it("triggers earlyStop after 2 consecutive low-yield rounds", async () => {
    // Create 4 clusters, each with 3 members. LLM returns null for all.
    const entries = [
      // Cluster 1
      makeEntry({ id: "a1", text: "c1a", vector: [0.95, 0.05, 0, 0] }),
      makeEntry({ id: "a2", text: "c1b", vector: [0.93, 0.07, 0, 0] }),
      makeEntry({ id: "a3", text: "c1c", vector: [0.97, 0.03, 0, 0] }),
      // Cluster 2
      makeEntry({ id: "b1", text: "c2a", vector: [0.05, 0.95, 0, 0] }),
      makeEntry({ id: "b2", text: "c2b", vector: [0.07, 0.93, 0, 0] }),
      makeEntry({ id: "b3", text: "c2c", vector: [0.03, 0.97, 0, 0] }),
      // Cluster 3
      makeEntry({ id: "c1", text: "c3a", vector: [0, 0.05, 0.95, 0] }),
      makeEntry({ id: "c2", text: "c3b", vector: [0, 0.07, 0.93, 0] }),
      makeEntry({ id: "c3", text: "c3c", vector: [0, 0.03, 0.97, 0] }),
      // Cluster 4
      makeEntry({ id: "d1", text: "c4a", vector: [0, 0, 0.05, 0.95] }),
      makeEntry({ id: "d2", text: "c4b", vector: [0, 0, 0.07, 0.93] }),
      makeEntry({ id: "d3", text: "c4c", vector: [0, 0, 0.03, 0.97] }),
    ];

    const { store } = createMockStore();
    // LLM always fails → 0 insights per round → consecutive low yield
    const llm = createMockLLM(() => null);
    const embedder = createMockEmbedder();

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
      clusterThreshold: 0.75,
      maxClusters: 10, // Allow many clusters
    });

    expect(result.clustersFound).toBe(4);
    // Should stop after 2 consecutive failures + then earlyStop on 3rd
    expect(result.clustersConsolidated).toBe(2);
    expect(result.earlyStop).toBe("diminishing_returns");
    expect(result.insightsGenerated).toBe(0);
  });

  it("does not trigger earlyStop when insights are consistently generated", async () => {
    // Create 3 clusters, LLM always succeeds
    const entries = [
      // Cluster 1
      makeEntry({ id: "a1", text: "c1a", vector: [0.95, 0.05, 0] }),
      makeEntry({ id: "a2", text: "c1b", vector: [0.93, 0.07, 0] }),
      makeEntry({ id: "a3", text: "c1c", vector: [0.97, 0.03, 0] }),
      // Cluster 2
      makeEntry({ id: "b1", text: "c2a", vector: [0.05, 0.95, 0] }),
      makeEntry({ id: "b2", text: "c2b", vector: [0.07, 0.93, 0] }),
      makeEntry({ id: "b3", text: "c2c", vector: [0.03, 0.97, 0] }),
      // Cluster 3
      makeEntry({ id: "c1", text: "c3a", vector: [0, 0.05, 0.95] }),
      makeEntry({ id: "c2", text: "c3b", vector: [0, 0.07, 0.93] }),
      makeEntry({ id: "c3", text: "c3c", vector: [0, 0.03, 0.97] }),
    ];

    const { store } = createMockStore();
    const llm = createMockLLM(() => "great insight");
    const embedder = createMockEmbedder();

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
      clusterThreshold: 0.75,
      maxClusters: 10,
    });

    expect(result.clustersFound).toBe(3);
    expect(result.clustersConsolidated).toBe(3);
    expect(result.insightsGenerated).toBe(3);
    expect(result.earlyStop).toBeUndefined();
  });

  it("resets consecutive low-yield counter when a good round occurs", async () => {
    // 3 clusters: first fails, second succeeds, third fails.
    // Counter resets after second cluster, so no earlyStop.
    let callCount = 0;
    const entries = [
      // Cluster 1
      makeEntry({ id: "a1", text: "c1a", vector: [0.95, 0.05, 0] }),
      makeEntry({ id: "a2", text: "c1b", vector: [0.93, 0.07, 0] }),
      makeEntry({ id: "a3", text: "c1c", vector: [0.97, 0.03, 0] }),
      // Cluster 2
      makeEntry({ id: "b1", text: "c2a", vector: [0.05, 0.95, 0] }),
      makeEntry({ id: "b2", text: "c2b", vector: [0.07, 0.93, 0] }),
      makeEntry({ id: "b3", text: "c2c", vector: [0.03, 0.97, 0] }),
      // Cluster 3
      makeEntry({ id: "c1", text: "c3a", vector: [0, 0.05, 0.95] }),
      makeEntry({ id: "c2", text: "c3b", vector: [0, 0.07, 0.93] }),
      makeEntry({ id: "c3", text: "c3c", vector: [0, 0.03, 0.97] }),
    ];

    const { store } = createMockStore();
    // Pattern: fail, succeed, fail — should NOT earlyStop (counter resets)
    const llm = createMockLLM(() => {
      callCount++;
      // Cluster ordering depends on greedy algorithm; 1st and 3rd fail, 2nd succeeds
      if (callCount === 2) return "good insight";
      return null;
    });
    const embedder = createMockEmbedder();

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
      clusterThreshold: 0.75,
      maxClusters: 10,
    });

    expect(result.clustersConsolidated).toBe(3); // All 3 processed
    expect(result.insightsGenerated).toBe(1);
    expect(result.earlyStop).toBeUndefined(); // No early stop
  });
});

// ---------------------------------------------------------------------------
// HP-5: Cross-Memory Pattern Extraction
// ---------------------------------------------------------------------------

describe("clusterAndConsolidate — pattern extraction (HP-5)", () => {
  it("extracts pattern when extractPatterns=true and LLM returns pattern", async () => {
    const entries = [
      makeEntry({ id: "a", text: "用户喜欢吃寿司", vector: [0.9, 0.1, 0], importance: 0.8 }),
      makeEntry({ id: "b", text: "用户经常去日料店", vector: [0.88, 0.12, 0], importance: 0.7 }),
      makeEntry({ id: "c", text: "用户提到最近学做天妇罗", vector: [0.92, 0.08, 0], importance: 0.6 }),
    ];

    const { store, stored, updates } = createMockStore();
    const llm = createMockLLM(
      () => "用户对日本料理有广泛兴趣",
      () => "用户反复提及日料相关话题，暗示对日本饮食文化有持久偏好",
    );
    const embedder = createMockEmbedder([0.5, 0.5, 0]);

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
      clusterThreshold: 0.75,
      extractPatterns: true,
    });

    expect(result.patternsExtracted).toBe(1);
    expect(result.insightsGenerated).toBe(1);

    // Should have stored 2 entries: 1 insight + 1 pattern
    expect(stored.length).toBe(2);

    const patternEntry = stored.find(s => {
      const meta = JSON.parse(s.metadata!);
      return meta.cross_memory_pattern === true;
    });
    expect(patternEntry).toBeDefined();
    expect(patternEntry!.text).toContain("日料");
    expect(patternEntry!.category).toBe("patterns");
    expect(patternEntry!.importance).toBeCloseTo(0.9, 5); // max(0.8) + 0.1

    const patternMeta = JSON.parse(patternEntry!.metadata!);
    expect(patternMeta.source_cluster_size).toBe(3);
    expect(patternMeta.evolution.sourceMemories).toEqual(["a", "b", "c"]);

    // Source memories should have contributedToPattern set
    const patternUpdates = updates.filter(u => {
      const meta = JSON.parse(u.metadata);
      return meta.evolution?.contributedToPattern === patternEntry!.id;
    });
    expect(patternUpdates.length).toBe(3);
  });

  it("does not extract patterns when extractPatterns=false (default)", async () => {
    const entries = [
      makeEntry({ id: "a", text: "memory A", vector: [0.9, 0.1, 0], importance: 0.8 }),
      makeEntry({ id: "b", text: "memory B", vector: [0.88, 0.12, 0], importance: 0.7 }),
      makeEntry({ id: "c", text: "memory C", vector: [0.92, 0.08, 0], importance: 0.6 }),
    ];

    const { store, stored } = createMockStore();
    const llm = createMockLLM(
      () => "insight text",
      () => "should not appear",
    );
    const embedder = createMockEmbedder();

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
      clusterThreshold: 0.75,
      // extractPatterns defaults to false
    });

    expect(result.patternsExtracted).toBe(0);
    expect(stored.length).toBe(1); // Only the insight, no pattern
  });

  it("handles pattern extraction failure gracefully", async () => {
    const entries = [
      makeEntry({ id: "a", text: "memory A", vector: [0.9, 0.1, 0] }),
      makeEntry({ id: "b", text: "memory B", vector: [0.88, 0.12, 0] }),
      makeEntry({ id: "c", text: "memory C", vector: [0.92, 0.08, 0] }),
    ];

    const { store, stored } = createMockStore();
    const llm = createMockLLM(
      () => "insight text",
      () => null, // pattern extraction fails
    );
    const embedder = createMockEmbedder();

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
      clusterThreshold: 0.75,
      extractPatterns: true,
    });

    expect(result.patternsExtracted).toBe(0);
    expect(result.insightsGenerated).toBe(1);
    expect(stored.length).toBe(1); // Only insight stored
  });

  it("caps pattern importance at 1.0", async () => {
    const entries = [
      makeEntry({ id: "a", text: "high importance A", vector: [0.9, 0.1, 0], importance: 0.95 }),
      makeEntry({ id: "b", text: "high importance B", vector: [0.88, 0.12, 0], importance: 0.98 }),
      makeEntry({ id: "c", text: "high importance C", vector: [0.92, 0.08, 0], importance: 0.93 }),
    ];

    const { store, stored } = createMockStore();
    const llm = createMockLLM(
      () => "insight",
      () => "discovered pattern",
    );
    const embedder = createMockEmbedder();

    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: llm as unknown as LLMClient,
      store,
      scope: "project:test",
      minClusterSize: 3,
      clusterThreshold: 0.75,
      extractPatterns: true,
    });

    expect(result.patternsExtracted).toBe(1);
    const patternEntry = stored.find(s => JSON.parse(s.metadata!).cross_memory_pattern);
    // max(0.98) + 0.1 = 1.08 → capped at 1.0
    expect(patternEntry!.importance).toBe(1.0);
  });
});

describe("cosineSimilarity (used by cluster consolidation)", () => {
  it("returns 1.0 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 5);
  });

  it("returns -1.0 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0, 5);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched dimensions", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it("correctly computes similarity for non-trivial vectors", () => {
    // [1, 1] and [1, 0] -> cos = 1 / sqrt(2) ≈ 0.7071
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(1 / Math.sqrt(2), 5);
  });
});

// ---------------------------------------------------------------------------
// LC-P2: Cluster-aware deduplication
// ---------------------------------------------------------------------------

describe("deduplicateByClusterInsight (LC-P2)", () => {
  function makeResult(id: string, text: string, meta?: Record<string, unknown>) {
    return {
      entry: {
        id,
        text,
        vector: [1, 0, 0],
        category: "events" as const,
        scope: "project:test",
        importance: 0.7,
        timestamp: Date.now(),
        metadata: meta ? JSON.stringify(meta) : "{}",
      },
      score: 0.8,
    };
  }

  it("removes source memories when cluster insight is present", () => {
    const results = [
      makeResult("insight-1", "cluster summary about TypeScript", {
        cluster_insight: true,
        evolution: { sourceMemories: ["src-a", "src-b", "src-c"] },
      }),
      makeResult("src-a", "TypeScript is great"),
      makeResult("src-b", "TypeScript helps safety"),
      makeResult("other", "unrelated memory"),
    ];

    const deduped = deduplicateByClusterInsight(results);
    expect(deduped.length).toBe(2);
    expect(deduped.map(r => r.entry.id)).toEqual(["insight-1", "other"]);
  });

  it("also deduplicates cross_memory_pattern source memories", () => {
    const results = [
      makeResult("pattern-1", "user likes Japanese food", {
        cross_memory_pattern: true,
        evolution: { sourceMemories: ["m1", "m2", "m3"] },
      }),
      makeResult("m1", "user eats sushi"),
      makeResult("m2", "user visits ramen shop"),
      makeResult("unrelated", "something else"),
    ];

    const deduped = deduplicateByClusterInsight(results);
    expect(deduped.length).toBe(2);
    expect(deduped.map(r => r.entry.id)).toEqual(["pattern-1", "unrelated"]);
  });

  it("passes through all results when no cluster insights exist", () => {
    const results = [
      makeResult("a", "memory A"),
      makeResult("b", "memory B"),
      makeResult("c", "memory C"),
    ];

    const deduped = deduplicateByClusterInsight(results);
    expect(deduped.length).toBe(3);
  });

  it("handles empty results", () => {
    expect(deduplicateByClusterInsight([])).toEqual([]);
  });

  it("keeps source memories that are NOT in the result set", () => {
    // Insight references src-a, src-b, src-c but only src-a is in results
    const results = [
      makeResult("insight-1", "summary", {
        cluster_insight: true,
        evolution: { sourceMemories: ["src-a", "src-b", "src-c"] },
      }),
      makeResult("src-a", "one source"),
      makeResult("independent", "not a source"),
    ];

    const deduped = deduplicateByClusterInsight(results);
    expect(deduped.length).toBe(2);
    expect(deduped.map(r => r.entry.id)).toEqual(["insight-1", "independent"]);
  });

  it("handles malformed metadata gracefully", () => {
    const results = [
      {
        entry: {
          id: "bad",
          text: "bad metadata",
          vector: [1, 0, 0],
          category: "events" as const,
          scope: "test",
          importance: 0.5,
          timestamp: Date.now(),
          metadata: "not-json{{{",
        },
        score: 0.5,
      },
      makeResult("normal", "normal memory"),
    ];

    const deduped = deduplicateByClusterInsight(results);
    expect(deduped.length).toBe(2); // Both pass through
  });
});
