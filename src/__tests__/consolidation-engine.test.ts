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
      // 2026-08-14: 忠实模拟生产语义 —— 以 mock 存储的最新行起底应用 patchFn、按序执行、
      // 就地落库。批量写同样进 updates 数组，既有的 updates.find() 断言无需改动。
      async patchMetadataBatch(
        patches: Array<{ id: string; patchFn: (meta: Record<string, unknown>, entry: MemoryEntry) => Record<string, unknown> }>,
        _scopeFilter?: string[],
      ) {
        let written = 0;
        for (const { id, patchFn } of patches) {
          const entry = data.get(id);
          if (!entry) continue;
          let meta: Record<string, unknown>;
          try { meta = JSON.parse(entry.metadata || "{}") as Record<string, unknown>; } catch { meta = {}; }
          const patched = patchFn(meta, entry);
          entry.metadata = JSON.stringify(patched);
          updates.push({ id, metadata: entry.metadata });
          written++;
        }
        return written;
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

  // 2026-08-14 Bug-1 回归：旧逐条写路径里 cluster 循环基于从不刷新的旧内存串 patch，
  // member 的 consolidatedMeta 写与 canonical 的 sourceMemories 写会把 createVersionGroup
  // 刚落库的 version_group 抹掉（2 成员 cluster 同样全丢），下一个 member 还会新造 groupId。
  // 断言口径是**最终存储态**（getById 终值）——旧测试用 updates.find() 只看首写，恰好
  // 看不见覆盖（互审 C3 指出的断言形态缺陷）。
  it("Bug-1 回归：2 成员 merge 后双方 version_group 同组共存，sourceMemories/consolidatedInto 齐全", async () => {
    const entryA = makeEntry({ id: "a", text: "canonical fact", vector: [1, 0, 0], importance: 0.9 });
    const entryB = makeEntry({ id: "b", text: "duplicate fact", vector: [0.99, 0.1, 0], importance: 0.5 });
    const simMap = new Map([
      ["a", new Map([["b", 0.95]])],
      ["b", new Map([["a", 0.95]])],
    ]);
    const { store } = createMockStore([entryA, entryB], simMap);
    const engine = new ConsolidationEngine(store, { ...DEFAULT_CONSOLIDATION_CONFIG, mergeThreshold: 0.92 });
    await engine.run("project:test");

    const finalA = JSON.parse((await store.getById("a"))!.metadata!) as Record<string, any>;
    const finalB = JSON.parse((await store.getById("b"))!.metadata!) as Record<string, any>;
    expect(typeof finalA.version_group).toBe("string");
    expect(finalB.version_group).toBe(finalA.version_group); // 同组，且都没被后续写抹掉
    expect(typeof finalA.version_rank).toBe("number");
    expect(typeof finalB.version_rank).toBe("number");
    expect(finalA.evolution.sourceMemories).toContain("b");
    expect(finalB.evolution.status).toBe("consolidated");
    expect(finalB.evolution.consolidatedInto).toBe("a");
  });

  it("Bug-1 回归：多 member merge 共享同一个 groupId，canonical 的 sourceMemories 不丢前面的 member", async () => {
    const entryA = makeEntry({ id: "a", text: "fact v1", vector: [1, 0, 0], importance: 0.9 });
    const entryB = makeEntry({ id: "b", text: "fact v2", vector: [0.99, 0.1, 0], importance: 0.5 });
    const entryC = makeEntry({ id: "c", text: "fact v3", vector: [0.98, 0.15, 0], importance: 0.4 });
    const simMap = new Map([
      ["a", new Map([["b", 0.95], ["c", 0.94]])],
      ["b", new Map([["a", 0.95], ["c", 0.93]])],
      ["c", new Map([["a", 0.94], ["b", 0.93]])],
    ]);
    const { store } = createMockStore([entryA, entryB, entryC], simMap);
    const engine = new ConsolidationEngine(store, { ...DEFAULT_CONSOLIDATION_CONFIG, mergeThreshold: 0.92 });
    await engine.run("project:test");

    const finalA = JSON.parse((await store.getById("a"))!.metadata!) as Record<string, any>;
    const finalB = JSON.parse((await store.getById("b"))!.metadata!) as Record<string, any>;
    const finalC = JSON.parse((await store.getById("c"))!.metadata!) as Record<string, any>;
    expect(typeof finalA.version_group).toBe("string");
    expect(finalB.version_group).toBe(finalA.version_group); // 旧路径这里各是一个新组
    expect(finalC.version_group).toBe(finalA.version_group);
    expect(finalA.evolution.sourceMemories).toEqual(expect.arrayContaining(["b", "c"])); // 旧路径只剩最后一个
  });

  it("link 分支回归：多 member 时 canonical 的 cluster_members 累积全部（不再只剩最后一个）", async () => {
    const entryA = makeEntry({ id: "a", text: "topic center", vector: [1, 0, 0], importance: 0.9 });
    const entryB = makeEntry({ id: "b", text: "related one", vector: [0.9, 0.3, 0], importance: 0.5 });
    const entryC = makeEntry({ id: "c", text: "related two", vector: [0.88, 0.35, 0], importance: 0.4 });
    // 0.85 落在 clusterThreshold(0.82) 与 mergeThreshold(0.92) 之间 → link 分支
    const simMap = new Map([
      ["a", new Map([["b", 0.85], ["c", 0.85]])],
      ["b", new Map([["a", 0.85], ["c", 0.84]])],
      ["c", new Map([["a", 0.85], ["b", 0.84]])],
    ]);
    const { store } = createMockStore([entryA, entryB, entryC], simMap);
    const engine = new ConsolidationEngine(store, { ...DEFAULT_CONSOLIDATION_CONFIG, clusterThreshold: 0.82, mergeThreshold: 0.92 });
    await engine.run("project:test");

    const finalA = JSON.parse((await store.getById("a"))!.metadata!) as Record<string, any>;
    const finalB = JSON.parse((await store.getById("b"))!.metadata!) as Record<string, any>;
    const finalC = JSON.parse((await store.getById("c"))!.metadata!) as Record<string, any>;
    expect(finalA.cluster_members).toEqual(expect.arrayContaining(["b", "c"]));
    expect(finalB.clustered_with).toBe("a");
    expect(finalC.clustered_with).toBe("a");
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

// ---------------------------------------------------------------------------
// computeSynthesisUptake (Artel synthesis_uptake_rate 对应物)
// ---------------------------------------------------------------------------

import { computeSynthesisUptake } from "../consolidation-engine.js";
import type { MemoryEntry as UptakeEntry } from "../store.js";

function uptakeEntry(id: string, metadata: Record<string, unknown>): UptakeEntry {
  return {
    id,
    text: `t-${id}`,
    vector: [],
    category: "patterns",
    scope: "project:test",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: JSON.stringify(metadata),
  } as UptakeEntry;
}

function pagedStore(all: UptakeEntry[]) {
  return {
    async listPage({ limit = 1000, offset = 0 }: { limit?: number; offset?: number; includeVector?: boolean }) {
      return all.slice(offset, offset + limit);
    },
  };
}

describe("computeSynthesisUptake", () => {
  it("computes uptake over derived insights only", async () => {
    const store = pagedStore([
      uptakeEntry("d1", { cluster_insight: true, accessCount: 2 }),   // derived, read
      uptakeEntry("d2", { cross_memory_pattern: true }),              // derived, unread
      uptakeEntry("n1", { accessCount: 5 }),                          // not derived
    ]);
    const s = await computeSynthesisUptake(store, 20_000, 2);
    expect(s.scanned).toBe(3);
    expect(s.derivedTotal).toBe(2);
    expect(s.derivedRead).toBe(1);
    expect(s.uptakeRate).toBeCloseTo(0.5, 5);
    expect(s.truncated).toBe(false);
  });

  it("returns null rate when no derived insights exist", async () => {
    const s = await computeSynthesisUptake(pagedStore([uptakeEntry("n1", {})]));
    expect(s.derivedTotal).toBe(0);
    expect(s.uptakeRate).toBeNull();
  });

  it("respects scan cap and reports truncation", async () => {
    const all = Array.from({ length: 10 }, (_, i) => uptakeEntry(`e${i}`, { cluster_insight: true, accessCount: 1 }));
    const s = await computeSynthesisUptake(pagedStore(all), 4, 2);
    expect(s.scanned).toBe(4);
    expect(s.truncated).toBe(true);
    expect(s.derivedTotal).toBe(4);
  });
});
