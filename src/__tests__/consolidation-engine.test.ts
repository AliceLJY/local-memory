import { describe, expect, it } from "bun:test";

import { ConsolidationEngine, DEFAULT_CONSOLIDATION_CONFIG, formatConsolidationResult, tripleJaccard, type ConsolidationResult, type ConsolidationTripleEvidence } from "../consolidation-engine.js";
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

  it("never clusters a live entry with its own superseded belief-history row", async () => {
    // A rephrased belief sits far above mergeThreshold from its archived version, and
    // canonicalScore (importance × access count, no recency) ties them exactly — the
    // history row inherits both. Losing that coin flip would mark the LIVE entry
    // consolidated, dropping the current belief out of default retrieval while the
    // abandoned wording stands in as canonical.
    const live = makeEntry({
      id: "live",
      text: "User prefers concise, code-first replies",
      vector: [1, 0, 0],
    });
    // Clustering is skipped outright when a category holds fewer than two ACTIVE entries,
    // so an unrelated second live entry is what makes this scenario reachable at all.
    const unrelated = makeEntry({
      id: "other",
      text: "Project uses Bun as the runtime",
      vector: [0, 0, 1],
    });
    const history = makeEntry({
      id: "hist",
      text: "User prefers concise, direct replies",
      vector: [0, 1, 0],
      metadata: JSON.stringify({
        evolution: { status: "superseded", validUntil: Date.now(), supersededBy: "live" },
      }),
    });

    const simMap = new Map([["live", new Map([["hist", 0.98]])]]);

    const { store, updates } = createMockStore([live, unrelated, history], simMap);
    const engine = new ConsolidationEngine(store, { ...DEFAULT_CONSOLIDATION_CONFIG, mergeThreshold: 0.92 });
    const result = await engine.run("project:test");

    expect(result.clustersFound).toBe(0);
    expect(result.mergedCount).toBe(0);
    // Above all: the live entry must not have been touched.
    expect(updates.find(u => u.id === "live")).toBeUndefined();
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

  describe("KG triple evidence (second merge-evidence source)", () => {
    function createMockKGSource(byMemory: Record<string, ConsolidationTripleEvidence[]>) {
      return {
        async getTriplesBySourceMemories(memoryIds: string[]) {
          const result = new Map<string, ConsolidationTripleEvidence[]>();
          for (const id of memoryIds) {
            if (byMemory[id]) result.set(id, byMemory[id]);
          }
          return result;
        },
      };
    }
    const t = (id: string, mention = 1): ConsolidationTripleEvidence => ({ id, mention_count: mention });

    function greyZonePair() {
      const entryA = makeEntry({ id: "a", text: "Alice's main machine is the MacBook", vector: [1, 0, 0], importance: 0.9 });
      const entryB = makeEntry({ id: "b", text: "Alice uses a MacBook as her primary computer", vector: [0.9, 0.1, 0], importance: 0.5 });
      const simMap = new Map([
        ["a", new Map([["b", 0.85]])], // grey zone: above cluster 0.82, below merge 0.92
        ["b", new Map([["a", 0.85]])],
      ]);
      return { entryA, entryB, simMap };
    }

    it("merges a grey-zone pair when triple sets overlap", async () => {
      const { entryA, entryB, simMap } = greyZonePair();
      const kg = createMockKGSource({
        a: [t("t1"), t("t2")],
        b: [t("t1"), t("t2")], // Jaccard 1.0
      });
      const { store, updates } = createMockStore([entryA, entryB], simMap);
      const engine = new ConsolidationEngine(store, DEFAULT_CONSOLIDATION_CONFIG, kg);
      const result = await engine.run("project:test");

      expect(result.mergedCount).toBe(1);
      expect(result.tripleEvidenceMerges).toBe(1);
      expect(result.relationsAdded).toBe(0);
      const metaB = JSON.parse(updates.find(u => u.id === "b")!.metadata);
      expect(metaB.version_group).toBeTruthy();
    });

    it("does not merge a grey-zone pair when triple sets are disjoint", async () => {
      const { entryA, entryB, simMap } = greyZonePair();
      const kg = createMockKGSource({
        a: [t("t1"), t("t2")],
        b: [t("t3"), t("t4")], // Jaccard 0
      });
      const { store } = createMockStore([entryA, entryB], simMap);
      const engine = new ConsolidationEngine(store, DEFAULT_CONSOLIDATION_CONFIG, kg);
      const result = await engine.run("project:test");

      expect(result.mergedCount).toBe(0);
      expect(result.tripleEvidenceMerges).toBe(0);
      expect(result.relationsAdded).toBe(1); // falls back to link, current behavior
    });

    it("requires minTriplesForEvidence on both sides — a single shared triple is too weak", async () => {
      const { entryA, entryB, simMap } = greyZonePair();
      const kg = createMockKGSource({
        a: [t("t1")],
        b: [t("t1")], // overlap 1.0 but only one triple each — below default minTriplesForEvidence 2
      });
      const { store } = createMockStore([entryA, entryB], simMap);
      const engine = new ConsolidationEngine(store, DEFAULT_CONSOLIDATION_CONFIG, kg);
      const result = await engine.run("project:test");

      expect(result.mergedCount).toBe(0);
      expect(result.relationsAdded).toBe(1);
    });

    it("without a kgSource the grey zone links exactly as before", async () => {
      const { entryA, entryB, simMap } = greyZonePair();
      const { store } = createMockStore([entryA, entryB], simMap);
      const engine = new ConsolidationEngine(store, DEFAULT_CONSOLIDATION_CONFIG);
      const result = await engine.run("project:test");

      expect(result.mergedCount).toBe(0);
      expect(result.tripleEvidenceMerges).toBe(0);
      expect(result.relationsAdded).toBe(1);
    });

    it("mention frequency boosts canonical selection", async () => {
      // Same importance — the mention boost must be what flips the canonical
      const entryA = makeEntry({ id: "a", text: "fact mentioned once", vector: [1, 0, 0], importance: 0.7 });
      const entryB = makeEntry({ id: "b", text: "fact mentioned many times", vector: [0.99, 0.1, 0], importance: 0.7 });
      const simMap = new Map([
        ["a", new Map([["b", 0.95]])], // merge zone
        ["b", new Map([["a", 0.95]])],
      ]);
      const kg = createMockKGSource({
        a: [t("ta", 1), t("tx", 1)],
        b: [t("tb", 9), t("ty", 1)], // b carries a fact mentioned 9 times → higher canonical score
      });
      const { store, updates } = createMockStore([entryA, entryB], simMap);
      const engine = new ConsolidationEngine(store, DEFAULT_CONSOLIDATION_CONFIG, kg);
      const result = await engine.run("project:test");

      expect(result.mergedCount).toBe(1);
      // B is canonical (the boost flipped the tie): A is the member, marked
      // consolidatedInto B. version_rank can't witness this — computeVersionRank
      // ignores the engine's canonical pick when importance ties.
      const finalMetaA = JSON.parse(updates.filter(u => u.id === "a").at(-1)!.metadata);
      expect(finalMetaA.evolution?.consolidatedInto).toBe("b");
      // And B was never marked consolidated into anything
      const bUpdates = updates.filter(u => u.id === "b").map(u => JSON.parse(u.metadata));
      expect(bUpdates.every(m => !m.evolution?.consolidatedInto)).toBe(true);
    });

    it("mention boost must NOT override a clear importance gap (tie-breaker only)", async () => {
      // A is substantially more important; B carries an extremely frequent triple.
      // The capped boost (≤1.1) must not demote A to consolidated status.
      const entryA = makeEntry({ id: "a", text: "the important synthesis", vector: [1, 0, 0], importance: 0.9 });
      const entryB = makeEntry({ id: "b", text: "minor note repeating a hot fact", vector: [0.99, 0.1, 0], importance: 0.5 });
      const simMap = new Map([
        ["a", new Map([["b", 0.95]])],
        ["b", new Map([["a", 0.95]])],
      ]);
      const kg = createMockKGSource({
        a: [],
        b: [t("hot", 500), t("tb", 1)], // absurdly frequent fact on the weak side
      });
      const { store, updates } = createMockStore([entryA, entryB], simMap);
      const engine = new ConsolidationEngine(store, DEFAULT_CONSOLIDATION_CONFIG, kg);
      const result = await engine.run("project:test");

      expect(result.mergedCount).toBe(1);
      // A stays canonical: B is the one marked consolidatedInto A
      const finalMetaB = JSON.parse(updates.filter(u => u.id === "b").at(-1)!.metadata);
      expect(finalMetaB.evolution?.consolidatedInto).toBe("a");
      const aUpdates = updates.filter(u => u.id === "a").map(u => JSON.parse(u.metadata));
      expect(aUpdates.every(m => !m.evolution?.consolidatedInto)).toBe(true);
    });
  });
});

describe("tripleJaccard", () => {
  const set = (...ids: string[]) => new Set(ids);

  it("computes intersection over union", () => {
    expect(tripleJaccard(set("a", "b"), set("a", "b"))).toBe(1);
    expect(tripleJaccard(set("a", "b"), set("b", "c"))).toBeCloseTo(1 / 3);
    expect(tripleJaccard(set("a", "b"), set("c", "d"))).toBe(0);
  });

  it("returns 0 below the min-size floor (either side)", () => {
    expect(tripleJaccard(set("a"), set("a"))).toBe(0); // default minSize 2
    expect(tripleJaccard(set("a"), set("a"), 1)).toBe(1);
    expect(tripleJaccard(undefined, set("a", "b"))).toBe(0);
    expect(tripleJaccard(set("a", "b"), undefined)).toBe(0);
  });
});

describe("formatConsolidationResult", () => {
  it("formats a result with conflicts", () => {
    const result: ConsolidationResult = {
      originalCount: 100,
      clustersFound: 5,
      mergedCount: 3,
      relationsAdded: 7,
      tripleEvidenceMerges: 1,
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
