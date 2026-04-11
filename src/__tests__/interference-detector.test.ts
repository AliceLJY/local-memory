/**
 * F2: Interference Detection + Active Forgetting Gate — tests for
 * cluster detection, density measurement, RIF enhancement, and checkup.
 */

import { describe, expect, test } from "bun:test";
import {
  detectInterference,
  measureInterferenceDensity,
  type InterferenceResult,
} from "../interference-detector.js";
import { filterInterference } from "../rif.js";
import type { MemoryEntry } from "../store.js";
import type { RetrievalResult } from "../retriever.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a memory entry with a specific vector for clustering. */
function makeMemory(id: string, vector: number[], importance = 0.7): MemoryEntry {
  return {
    id,
    text: `memory ${id}`,
    vector,
    category: "events",
    scope: "test",
    importance,
    timestamp: Date.now(),
    metadata: JSON.stringify({ confidence: 0.7 }),
  };
}

/** Create a unit vector in the given direction (for predictable cosine sim). */
function unitVec(direction: number[], dims = 4): number[] {
  const v = Array(dims).fill(0);
  for (let i = 0; i < direction.length && i < dims; i++) v[i] = direction[i];
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map(x => x / norm) : v;
}

function makeRetrievalResult(id: string, vector: number[], score: number): RetrievalResult {
  return {
    entry: makeMemory(id, vector),
    score,
    sources: {},
  };
}

// ---------------------------------------------------------------------------
// detectInterference
// ---------------------------------------------------------------------------

describe("F2: detectInterference", () => {
  test("empty input returns empty array", () => {
    expect(detectInterference([])).toEqual([]);
  });

  test("singleton memories have low risk", () => {
    const m1 = makeMemory("a", unitVec([1, 0, 0, 0]));
    const m2 = makeMemory("b", unitVec([0, 1, 0, 0])); // orthogonal — different cluster
    const results = detectInterference([m1, m2]);
    expect(results.length).toBe(2);
    expect(results.every(r => r.interferenceRisk === "low")).toBe(true);
  });

  test("similar vectors form a cluster", () => {
    const base = [1, 0.1, 0, 0];
    const similar = [1, 0.15, 0, 0]; // very similar to base
    const m1 = makeMemory("a", unitVec(base));
    const m2 = makeMemory("b", unitVec(similar));
    const m3 = makeMemory("c", unitVec([0, 0, 1, 0])); // different cluster
    const results = detectInterference([m1, m2, m3]);
    // m1 and m2 should be in same cluster, m3 alone
    const clusterIds = new Set(results.map(r => r.clusterId));
    expect(clusterIds.size).toBe(2); // 2 clusters
  });

  test("cluster rank 0 has low risk, rank 3+ has high risk", () => {
    const v = unitVec([1, 0, 0, 0]);
    const memories = [
      makeMemory("a", v, 0.9),
      makeMemory("b", v, 0.8),
      makeMemory("c", v, 0.7),
      makeMemory("d", v, 0.3), // weakest — should be high risk
    ];
    const results = detectInterference(memories);
    // All in one cluster
    const clusterIds = new Set(results.map(r => r.clusterId));
    expect(clusterIds.size).toBe(1);
    // Rank 0 is low risk
    const topRanked = results.find(r => r.clusterRank === 0);
    expect(topRanked?.interferenceRisk).toBe("low");
    // Rank 3 is high risk
    const bottomRanked = results.find(r => r.clusterRank === 3);
    expect(bottomRanked?.interferenceRisk).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// measureInterferenceDensity
// ---------------------------------------------------------------------------

describe("F2: measureInterferenceDensity", () => {
  test("no clusters → zero density", () => {
    const memories = [
      makeMemory("a", unitVec([1, 0, 0, 0])),
      makeMemory("b", unitVec([0, 1, 0, 0])),
      makeMemory("c", unitVec([0, 0, 1, 0])),
    ];
    const density = measureInterferenceDensity(memories);
    expect(density.clusterCount).toBe(0);
    expect(density.highRiskCount).toBe(0);
    expect(density.avgClusterSize).toBe(0);
  });

  test("one cluster → density reflects cluster size", () => {
    const v = unitVec([1, 0, 0, 0]);
    const memories = [
      makeMemory("a", v, 0.9),
      makeMemory("b", v, 0.7),
      makeMemory("c", v, 0.5),
      makeMemory("d", v, 0.3),
    ];
    const density = measureInterferenceDensity(memories);
    expect(density.clusterCount).toBe(1);
    expect(density.avgClusterSize).toBe(4);
    expect(density.highRiskCount).toBe(1); // rank 3 = high
  });
});

// ---------------------------------------------------------------------------
// Enhanced RIF (cluster top-K)
// ---------------------------------------------------------------------------

describe("F2: Enhanced RIF with cluster top-K", () => {
  test("cluster within top-K not demoted", () => {
    const v = unitVec([1, 0, 0, 0]);
    const results = [
      makeRetrievalResult("a", v, 0.9),
      makeRetrievalResult("b", v, 0.85),
      makeRetrievalResult("c", v, 0.80),
    ];
    const filtered = filterInterference(results, 0.85, 0.80, 3);
    // All 3 should be kept (within top-K=3)
    expect(filtered.length).toBe(3);
    expect(filtered[0].entry.id).toBe("a");
  });

  test("4th cluster member gets 50% score demotion", () => {
    const v = unitVec([1, 0, 0, 0]);
    const results = [
      makeRetrievalResult("a", v, 0.9),
      makeRetrievalResult("b", v, 0.85),
      makeRetrievalResult("c", v, 0.80),
      makeRetrievalResult("d", v, 0.75), // 4th member
    ];
    const filtered = filterInterference(results, 0.85, 0.80, 3);
    // d should be at the end with 50% score
    const d = filtered.find(r => r.entry.id === "d");
    expect(d).toBeDefined();
    expect(d!.score).toBeCloseTo(0.375, 2); // 0.75 * 0.5
  });

  test("diverse results unaffected by cluster top-K", () => {
    const results = [
      makeRetrievalResult("a", unitVec([1, 0, 0, 0]), 0.9),
      makeRetrievalResult("b", unitVec([0, 1, 0, 0]), 0.85),
      makeRetrievalResult("c", unitVec([0, 0, 1, 0]), 0.80),
      makeRetrievalResult("d", unitVec([0, 0, 0, 1]), 0.75),
    ];
    const filtered = filterInterference(results, 0.85, 0.80, 3);
    // All diverse — no demotion
    expect(filtered.length).toBe(4);
    expect(filtered.map(r => r.entry.id)).toEqual(["a", "b", "c", "d"]);
  });
});

// ---------------------------------------------------------------------------
// data-checkup integration
// ---------------------------------------------------------------------------

describe("F2: data-checkup interference check", () => {
  // We test the check function indirectly through measureInterferenceDensity
  test("healthy density has low high-risk ratio", () => {
    const memories = [
      makeMemory("a", unitVec([1, 0, 0, 0])),
      makeMemory("b", unitVec([0, 1, 0, 0])),
      makeMemory("c", unitVec([0, 0, 1, 0])),
    ];
    const density = measureInterferenceDensity(memories);
    // high-risk should be < 20% of total
    expect(density.highRiskCount / density.totalMemories).toBeLessThan(0.2);
  });

  test("unhealthy density detected in identical vectors", () => {
    const v = unitVec([1, 0, 0, 0]);
    const memories = Array.from({ length: 10 }, (_, i) => makeMemory(`m${i}`, v, 0.5 - i * 0.01));
    const density = measureInterferenceDensity(memories);
    expect(density.clusterCount).toBe(1);
    expect(density.highRiskCount).toBeGreaterThan(0);
  });
});
