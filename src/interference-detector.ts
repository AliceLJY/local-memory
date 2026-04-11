/**
 * F2: Interference Detector — detects semantic interference clusters
 * and measures interference density within a scope.
 *
 * Brain-science basis: proactive interference (PI) occurs when
 * semantically similar memories compete during retrieval, degrading
 * signal-to-noise. This module identifies interference clusters and
 * ranks members so the weakest can be deprioritized.
 */

import type { MemoryEntry } from "./store.js";
import { parseEvolution } from "./memory-evolution.js";
import { getConfidence } from "./confidence-tracker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InterferenceRisk = "high" | "medium" | "low";

export interface InterferenceResult {
  entryId: string;
  clusterId: number;
  clusterRank: number; // 0 = strongest in cluster
  interferenceRisk: InterferenceRisk;
  clusterSize: number;
}

export interface InterferenceDensity {
  totalMemories: number;
  clusterCount: number;
  avgClusterSize: number;
  highRiskCount: number;
}

// ---------------------------------------------------------------------------
// Cosine Similarity (shared with rif.ts — keep inline to avoid circular dep)
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ---------------------------------------------------------------------------
// Composite score for cluster ranking
// ---------------------------------------------------------------------------

function compositeScore(entry: MemoryEntry, now: number): number {
  const evo = parseEvolution(entry.metadata, entry.timestamp);
  const confidence = getConfidence(entry);
  const importance = entry.importance ?? 0.5;
  // Recency: exponential decay with 60-day half-life
  const daysSince = Math.max(0, (now - entry.timestamp) / 86_400_000);
  const recency = Math.pow(0.5, daysSince / 60);
  return confidence * importance * recency;
}

// ---------------------------------------------------------------------------
// Cluster detection via greedy single-linkage
// ---------------------------------------------------------------------------

/**
 * Detect interference clusters within a set of memories.
 * Uses greedy single-linkage: if sim(A,B) > threshold, they join the same cluster.
 *
 * @param memories - Memory entries with vectors
 * @param similarityThreshold - Cosine sim threshold for "same cluster" (default: 0.80)
 */
export function detectInterference(
  memories: MemoryEntry[],
  similarityThreshold = 0.80,
): InterferenceResult[] {
  if (memories.length === 0) return [];

  const now = Date.now();
  // Union-Find for cluster assignment
  const parent = memories.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Pairwise similarity check
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const sim = cosineSimilarity(memories[i].vector, memories[j].vector);
      if (sim > similarityThreshold) {
        union(i, j);
      }
    }
  }

  // Group by cluster root
  const clusters = new Map<number, number[]>(); // root → indices
  for (let i = 0; i < memories.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(i);
  }

  const results: InterferenceResult[] = [];
  let clusterId = 0;

  for (const members of clusters.values()) {
    if (members.length < 2) {
      // Singleton — no interference
      results.push({
        entryId: memories[members[0]].id,
        clusterId,
        clusterRank: 0,
        interferenceRisk: "low",
        clusterSize: 1,
      });
      clusterId++;
      continue;
    }

    // Rank within cluster by composite score
    const ranked = members
      .map(idx => ({ idx, score: compositeScore(memories[idx], now) }))
      .sort((a, b) => b.score - a.score);

    for (let rank = 0; rank < ranked.length; rank++) {
      const risk: InterferenceRisk =
        rank === 0 ? "low" :
        rank <= 2 ? "medium" : "high";

      results.push({
        entryId: memories[ranked[rank].idx].id,
        clusterId,
        clusterRank: rank,
        interferenceRisk: risk,
        clusterSize: ranked.length,
      });
    }
    clusterId++;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Density measurement
// ---------------------------------------------------------------------------

/**
 * Measure interference density: how clustered are the memories?
 */
export function measureInterferenceDensity(
  memories: MemoryEntry[],
  similarityThreshold = 0.80,
): InterferenceDensity {
  const results = detectInterference(memories, similarityThreshold);
  const multiMemberClusters = new Map<number, number>();

  for (const r of results) {
    if (r.clusterSize >= 2) {
      multiMemberClusters.set(r.clusterId, r.clusterSize);
    }
  }

  const clusterSizes = [...multiMemberClusters.values()];
  const clusterCount = clusterSizes.length;
  const avgClusterSize = clusterCount > 0
    ? clusterSizes.reduce((a, b) => a + b, 0) / clusterCount
    : 0;
  const highRiskCount = results.filter(r => r.interferenceRisk === "high").length;

  return {
    totalMemories: memories.length,
    clusterCount,
    avgClusterSize,
    highRiskCount,
  };
}
