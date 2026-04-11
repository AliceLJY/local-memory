import { describe, expect, it } from "bun:test";

import { ConsolidationEngine, DEFAULT_CONSOLIDATION_CONFIG, formatConsolidationResult, type ConsolidationResult } from "../consolidation-engine.js";
import type { MemoryEntry, MemorySearchResult } from "../store.js";

function makeEntry(overrides: Partial<MemoryEntry> & { id: string; text: string }): MemoryEntry {
  return {
    vector: [1, 0, 0],
    category: "events",
    scope: "project:test",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: "{}",
    ...overrides,
  };
}

function createMockStore(entries: MemoryEntry[], similarityMap: Map<string, Map<string, number>> = new Map()) {
  const data = new Map(entries.map(e => [e.id, { ...e }]));
  const updates: Array<{ id: string; metadata: string }> = [];

  return {
    updates,
    store: {
      async list(scopeFilter?: string[], _category?: string, limit = 500, _offset = 0) {
        return [...data.values()]
          .filter(e => !scopeFilter || scopeFilter.some(s => e.scope === s))
          .slice(0, limit);
      },
      async getById(id: string) {
        return data.get(id) ?? null;
      },
      async vectorSearch(vector: number[], limit = 5, minScore = 0.3, scopeFilter?: string[]) {
        // Use the similarity map to compute fake scores
        const sourceEntry = [...data.values()].find(e =>
          e.vector.length === vector.length && e.vector.every((v, i) => v === vector[i])
        );
        if (!sourceEntry) return [];

        const sourceMap = similarityMap.get(sourceEntry.id);
        if (!sourceMap) return [];

        const results: MemorySearchResult[] = [];
        for (const [targetId, score] of sourceMap) {
          if (score < minScore) continue;
          const target = data.get(targetId);
          if (!target) continue;
          if (scopeFilter && !scopeFilter.some(s => target.scope === s)) continue;
          results.push({ entry: target, score });
        }
        return results.sort((a, b) => b.score - a.score).slice(0, limit);
      },
      async update(id: string, upd: { metadata?: string }) {
        const entry = data.get(id);
        if (!entry) return null;
        if (upd.metadata) {
          entry.metadata = upd.metadata;
          updates.push({ id, metadata: upd.metadata });
        }
        return entry;
      },
    },
  };
}

describe("ConsolidationEngine", () => {
  it("returns empty result for empty scope", async () => {
    const { store } = createMockStore([]);
    const engine = new ConsolidationEngine(store);
    const result = await engine.run("project:test");
    expect(result.originalCount).toBe(0);
    expect(result.clustersFound).toBe(0);
  });

  it("skips single-entry categories", async () => {
    const entries = [makeEntry({ id: "a", text: "only one" })];
    const { store } = createMockStore(entries);
    const engine = new ConsolidationEngine(store);
    const result = await engine.run("project:test");
    expect(result.originalCount).toBe(1);
    expect(result.clustersFound).toBe(0);
  });

  it("merges near-duplicates above mergeThreshold", async () => {
    const entryA = makeEntry({ id: "a", text: "I prefer TypeScript", vector: [1, 0, 0], importance: 0.9 });
    const entryB = makeEntry({ id: "b", text: "I prefer TypeScript language", vector: [0.99, 0.1, 0], importance: 0.5 });

    const simMap = new Map([
      ["a", new Map([["b", 0.95]])],
      ["b", new Map([["a", 0.95]])],
    ]);

    const { store, updates } = createMockStore([entryA, entryB], simMap);
    const engine = new ConsolidationEngine(store, { ...DEFAULT_CONSOLIDATION_CONFIG, mergeThreshold: 0.92 });
    const result = await engine.run("project:test");

    expect(result.clustersFound).toBe(1);
    expect(result.mergedCount).toBe(1);
    // Tier 3.3: Both entries now coexist in a version group instead of archiving.
    // Both A and B should have version_group metadata.
    const updateA = updates.find(u => u.id === "a");
    const updateB = updates.find(u => u.id === "b");
    expect(updateA).toBeTruthy();
    expect(updateB).toBeTruthy();
    const metaA = JSON.parse(updateA!.metadata);
    const metaB = JSON.parse(updateB!.metadata);
    expect(metaA.version_group).toBeTruthy();
    expect(metaB.version_group).toBe(metaA.version_group);
    // Canonical (A, higher importance) should have higher rank
    expect(metaA.version_rank).toBeGreaterThan(metaB.version_rank);
  });

  it("links related entries below mergeThreshold but above clusterThreshold", async () => {
    const entryA = makeEntry({ id: "a", text: "TypeScript config", vector: [1, 0, 0] });
    const entryB = makeEntry({ id: "b", text: "TypeScript setup", vector: [0.9, 0.1, 0] });

    const simMap = new Map([
      ["a", new Map([["b", 0.85]])],
      ["b", new Map([["a", 0.85]])],
    ]);

    const { store, updates } = createMockStore([entryA, entryB], simMap);
    const engine = new ConsolidationEngine(store, { ...DEFAULT_CONSOLIDATION_CONFIG, clusterThreshold: 0.82, mergeThreshold: 0.92 });
    const result = await engine.run("project:test");

    expect(result.clustersFound).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(result.relationsAdded).toBe(1);
    // Both should have clustering metadata
    const linkUpdate = updates.find(u => u.id === "b");
    expect(linkUpdate).toBeTruthy();
    const meta = JSON.parse(linkUpdate!.metadata);
    expect(meta.clustered_with).toBe("a");
  });

  it("detects heuristic contradictions", async () => {
    const entryA = makeEntry({ id: "a", text: "Always use strict mode in TypeScript projects", vector: [1, 0, 0] });
    const entryB = makeEntry({ id: "b", text: "Never use strict mode in TypeScript projects", vector: [0.98, 0.1, 0] });

    const simMap = new Map([
      ["a", new Map([["b", 0.95]])],
      ["b", new Map([["a", 0.95]])],
    ]);

    const { store } = createMockStore([entryA, entryB], simMap);
    const engine = new ConsolidationEngine(store, DEFAULT_CONSOLIDATION_CONFIG);
    const result = await engine.run("project:test");

    expect(result.conflictsDetected.length).toBe(1);
    expect(result.conflictsDetected[0].type).toBe("heuristic_contradiction");
  });

  it("skips archived entries", async () => {
    const entryA = makeEntry({ id: "a", text: "active entry here", vector: [1, 0, 0] });
    const entryB = makeEntry({ id: "b", text: "archived entry here", vector: [0.95, 0.1, 0], metadata: JSON.stringify({ evolution: { status: "archived" } }) });

    const { store } = createMockStore([entryA, entryB]);
    const engine = new ConsolidationEngine(store);
    const result = await engine.run("project:test");

    expect(result.originalCount).toBe(1); // only active
  });
});

describe("formatConsolidationResult", () => {
  it("formats a result with conflicts", () => {
    const result: ConsolidationResult = {
      originalCount: 100,
      clustersFound: 5,
      mergedCount: 3,
      relationsAdded: 7,
      conflictsDetected: [{ memoryA: "aaaa-bbbb", memoryB: "cccc-dddd", type: "heuristic_contradiction" }],
      scope: "project:test",
    };
    const text = formatConsolidationResult(result);
    expect(text).toContain("Scanned: 100");
    expect(text).toContain("Clusters found: 5");
    expect(text).toContain("Merged (versioned): 3");
    expect(text).toContain("Conflicts:");
  });
});
