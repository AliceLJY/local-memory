/**
 * Semantic Consolidation Engine
 *
 * Borrowed from UltraMemory's consolidation-engine.ts, adapted for RecallNest:
 * - Uses RecallNest's store.vectorSearch() + store.update() (no patchMetadata)
 * - Integrates with RecallNest's existing conflict-engine for conflict creation
 * - Uses RecallNest's metadata structure (boundary.layer, canonicalKey, etc.)
 *
 * Algorithm:
 * 1. List entries in scope, filter active ones, group by category
 * 2. For each category: cluster entries by vector similarity (>= clusterThreshold)
 * 3. Within each cluster:
 *    - Merge near-duplicates (>= mergeThreshold) → archive weaker entry
 *    - Link related entries (cluster but below merge) → add clustered_with
 *    - Detect contradictions via heuristic
 *
 * LLM-free — deterministic clustering and merge only.
 */

import type { MemoryEntry, MemorySearchResult, MemoryStore } from "./store.js";
import { createVersionGroup } from "./version-manager.js";
import { isActiveMemory, parseEvolution, buildSupersedeMetadata, buildConsolidatedMetadata, patchEvolution } from "./memory-evolution.js";
import { cosineSimilarity } from "./multi-vector.js";
import type { LLMClient } from "./llm-client.js";
import type { Embedder } from "./embedder.js";

// ---------------------------------------------------------------------------
// Config & Types
// ---------------------------------------------------------------------------

export interface ConsolidationConfig {
  /** Minimum cosine similarity to form a cluster (default 0.82) */
  clusterThreshold: number;
  /** Minimum cosine similarity to merge (archive the weaker entry) (default 0.92) */
  mergeThreshold: number;
  /** Maximum entries to scan per consolidation run (default 500) */
  maxEntriesPerRun: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  clusterThreshold: 0.82,
  mergeThreshold: 0.92,
  maxEntriesPerRun: 500,
};

export interface ConflictEvent {
  memoryA: string;
  memoryB: string;
  type: "heuristic_contradiction";
}

export interface ConsolidationResult {
  originalCount: number;
  clustersFound: number;
  mergedCount: number;
  relationsAdded: number;
  conflictsDetected: ConflictEvent[];
  scope: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMetadata(entry: MemoryEntry): Record<string, unknown> {
  if (!entry.metadata) return {};
  try { return JSON.parse(entry.metadata); } catch { return {}; }
}

function isActive(entry: MemoryEntry): boolean {
  // Use evolution metadata if available (new system), fall back to legacy meta.state
  if (isActiveMemory(entry.metadata)) {
    const meta = parseMetadata(entry);
    return meta.state !== "archived" && meta.state !== "superseded";
  }
  return false;
}

function canonicalScore(entry: MemoryEntry): number {
  const evo = parseEvolution(entry.metadata, entry.timestamp);
  return entry.importance * (1 + Math.log(evo.accessCount + 1));
}

/** Simple heuristic contradiction: negation pattern check between two texts. */
function detectHeuristicContradiction(textA: string, textB: string): boolean {
  const a = textA.toLowerCase();
  const b = textB.toLowerCase();

  // Pattern: one says "X is Y" and the other says "X is not Y" (or vice versa)
  const negationPairs = [
    [/\bnot\b/, /\b(?:always|must|should|is|are|was|were)\b/],
    [/\bnever\b/, /\b(?:always|every|each)\b/],
    [/\bdisable/, /\benable/],
    [/不要|不用|别/, /必须|一定|总是/],
    [/从不/, /每次|总是|一直/],
  ];

  for (const [negRe, posRe] of negationPairs) {
    if ((negRe.test(a) && posRe.test(b)) || (negRe.test(b) && posRe.test(a))) {
      // Check they share at least one significant term (to avoid false positives)
      const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 3));
      const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 3));
      for (const w of wordsA) {
        if (wordsB.has(w)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Store interface (duck-typed to avoid hard dependency)
// ---------------------------------------------------------------------------

type ConsolidationStore = Pick<MemoryStore, "list" | "getById" | "vectorSearch" | "update">;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ConsolidationEngine {
  constructor(
    private store: ConsolidationStore,
    private config: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
  ) {}

  async run(scope: string): Promise<ConsolidationResult> {
    const { clusterThreshold, mergeThreshold, maxEntriesPerRun } = this.config;

    // 1. Fetch entries in scope
    const entries = await this.store.list([scope], undefined, maxEntriesPerRun, 0);
    const active = entries.filter(isActive);

    if (active.length === 0) {
      return { originalCount: 0, clustersFound: 0, mergedCount: 0, relationsAdded: 0, conflictsDetected: [], scope };
    }

    // 2. Group by category
    const byCategory = new Map<string, MemoryEntry[]>();
    for (const e of active) {
      const cat = e.category;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(e);
    }

    let clustersFound = 0;
    let mergedCount = 0;
    let relationsAdded = 0;
    const conflictsDetected: ConflictEvent[] = [];

    // 3. Cluster within each category
    for (const [, catEntries] of byCategory) {
      if (catEntries.length < 2) continue;

      const clustered = new Set<string>();
      const clusters = new Map<string, string[]>(); // seed ID → member IDs

      for (const entry of catEntries) {
        if (clustered.has(entry.id)) continue;

        const full = await this.store.getById(entry.id);
        if (!full?.vector?.length) continue;

        const similar = await this.store.vectorSearch(
          full.vector, 10, clusterThreshold, [scope],
        );

        const members = similar.filter(
          s => s.entry.id !== entry.id && !clustered.has(s.entry.id) && s.entry.category === entry.category,
        );

        if (members.length === 0) continue;

        const memberIds = [entry.id, ...members.map(s => s.entry.id)];
        clusters.set(entry.id, memberIds);
        for (const id of memberIds) clustered.add(id);
      }

      clustersFound += clusters.size;

      // 4. Process each cluster
      for (const [, memberIds] of clusters) {
        const memberEntries: MemoryEntry[] = [];
        for (const id of memberIds) {
          const full = await this.store.getById(id);
          if (full) memberEntries.push(full);
        }
        if (memberEntries.length < 2) continue;

        // Determine canonical: highest canonicalScore
        const sorted = [...memberEntries].sort((a, b) => canonicalScore(b) - canonicalScore(a));
        const canonical = sorted[0];

        if (!canonical.vector?.length) continue;

        // Get similarity scores relative to canonical
        const pairResults = await this.store.vectorSearch(
          canonical.vector, memberEntries.length + 5, clusterThreshold, [scope],
        );
        const scoreMap = new Map<string, number>();
        for (const r of pairResults) scoreMap.set(r.entry.id, r.score);

        for (const member of sorted.slice(1)) {
          const sim = scoreMap.get(member.id) ?? clusterThreshold;

          if (sim >= mergeThreshold) {
            // Tier 3.3: Version coexistence — both stay but grouped.
            await createVersionGroup(this.store, canonical, member, scope);
            // C-1: Also mark the weaker entry as consolidated via evolution metadata
            const consolidatedMeta = buildConsolidatedMetadata(member.metadata, canonical.id);
            await this.store.update(member.id, { metadata: consolidatedMeta }, [scope]);
            // Mark canonical as having source memories
            const canonEvo = parseEvolution(canonical.metadata, canonical.timestamp);
            if (!canonEvo.sourceMemories.includes(member.id)) {
              const updatedCanon = patchEvolution(canonical.metadata, {
                sourceMemories: [...canonEvo.sourceMemories, member.id],
              });
              await this.store.update(canonical.id, { metadata: updatedCanon }, [scope]);
            }
            mergedCount++;
          } else {
            // Link: add clustered_with relation
            const memberMeta = parseMetadata(member);
            memberMeta.clustered_with = canonical.id;
            await this.store.update(member.id, { metadata: JSON.stringify(memberMeta) }, [scope]);

            const canonMeta = parseMetadata(canonical);
            if (!Array.isArray(canonMeta.cluster_members)) canonMeta.cluster_members = [];
            if (!(canonMeta.cluster_members as string[]).includes(member.id)) {
              (canonMeta.cluster_members as string[]).push(member.id);
            }
            await this.store.update(canonical.id, { metadata: JSON.stringify(canonMeta) }, [scope]);
            relationsAdded++;
          }
        }

        // Conflict detection within cluster
        for (let i = 0; i < memberEntries.length; i++) {
          for (let j = i + 1; j < memberEntries.length; j++) {
            if (detectHeuristicContradiction(memberEntries[i].text, memberEntries[j].text)) {
              conflictsDetected.push({
                memoryA: memberEntries[i].id,
                memoryB: memberEntries[j].id,
                type: "heuristic_contradiction",
              });
            }
          }
        }
      }
    }

    return { originalCount: active.length, clustersFound, mergedCount, relationsAdded, conflictsDetected, scope };
  }
}

// ---------------------------------------------------------------------------
// C-2: Cluster Consolidation — group similar memories and generate insights
// ---------------------------------------------------------------------------

export interface ClusterConsolidationResult {
  clustersFound: number;
  clustersConsolidated: number;
  insightsGenerated: number;
  entriesLinked: number;
  /** CC-9: Set when consecutive low-yield rounds trigger early termination */
  earlyStop?: "diminishing_returns";
}

/**
 * C-2: Cluster consolidation — group similar memories and generate insights.
 *
 * Algorithm:
 * 1. Take active memories in a scope
 * 2. Cluster by embedding similarity (simple greedy clustering, not full K-means)
 * 3. For clusters with > minClusterSize members, generate a high-level insight via LLM
 * 4. Store insight as new memory, link source memories via evolution sourceMemories field
 * 5. Source memories marked consolidated_into but remain active (still individually searchable)
 */
export async function clusterAndConsolidate(params: {
  entries: MemoryEntry[];
  embedder: Pick<Embedder, "embedPassage">;
  llm: LLMClient;
  store: Pick<MemoryStore, "store" | "update">;
  scope: string;
  /** Minimum cluster size to trigger consolidation (default: 3) */
  minClusterSize?: number;
  /** Similarity threshold for clustering (default: 0.75) */
  clusterThreshold?: number;
  /** Max clusters to process per run (default: 5) */
  maxClusters?: number;
}): Promise<ClusterConsolidationResult> {
  const {
    entries,
    llm,
    store,
    scope,
    minClusterSize = 3,
    clusterThreshold = 0.75,
    maxClusters = 5,
  } = params;

  const result: ClusterConsolidationResult = {
    clustersFound: 0,
    clustersConsolidated: 0,
    insightsGenerated: 0,
    entriesLinked: 0,
  };

  // Filter to active entries with vectors
  const active = entries.filter(e => isActiveMemory(e.metadata) && e.vector?.length > 0);
  if (active.length === 0) return result;

  // Step 1: Greedy clustering by embedding similarity
  const clusters: MemoryEntry[][] = [];
  const centroids: number[][] = [];
  const assigned = new Set<string>();

  for (const entry of active) {
    if (assigned.has(entry.id)) continue;

    let bestClusterIdx = -1;
    let bestSim = -1;

    for (let ci = 0; ci < centroids.length; ci++) {
      const sim = cosineSimilarity(entry.vector, centroids[ci]);
      if (sim > clusterThreshold && sim > bestSim) {
        bestSim = sim;
        bestClusterIdx = ci;
      }
    }

    if (bestClusterIdx >= 0) {
      clusters[bestClusterIdx].push(entry);
      assigned.add(entry.id);
      // Update centroid as running average
      const members = clusters[bestClusterIdx];
      const dim = centroids[bestClusterIdx].length;
      const newCentroid = new Array<number>(dim);
      for (let d = 0; d < dim; d++) {
        let sum = 0;
        for (const m of members) sum += m.vector[d];
        newCentroid[d] = sum / members.length;
      }
      centroids[bestClusterIdx] = newCentroid;
    } else {
      // Start a new cluster
      clusters.push([entry]);
      centroids.push([...entry.vector]);
      assigned.add(entry.id);
    }
  }

  // Step 2: Filter to clusters meeting minClusterSize
  const qualifiedClusters = clusters.filter(c => c.length >= minClusterSize);
  result.clustersFound = qualifiedClusters.length;

  if (qualifiedClusters.length === 0) return result;

  // Step 3: Process up to maxClusters, with CC-9 diminishing returns detection
  const toProcess = qualifiedClusters.slice(0, maxClusters);
  let consecutiveLowYield = 0;

  for (const cluster of toProcess) {
    // CC-9: Check diminishing returns — 2 consecutive rounds with <= 1 insight
    if (consecutiveLowYield >= 2) {
      result.earlyStop = "diminishing_returns";
      break;
    }

    // Generate insight via LLM from cluster member texts
    const combinedText = cluster.map(m => m.text).join("\n---\n");
    const insight = await llm.generateL0(combinedText);

    if (!insight) {
      // CC-9: No insight produced — this is a zero-yield round
      consecutiveLowYield++;
      result.clustersConsolidated++;
      continue;
    }

    // Determine category (majority vote from cluster members)
    const catCounts = new Map<string, number>();
    for (const m of cluster) {
      catCounts.set(m.category, (catCounts.get(m.category) ?? 0) + 1);
    }
    let bestCat = cluster[0].category;
    let bestCount = 0;
    for (const [cat, count] of catCounts) {
      if (count > bestCount) {
        bestCat = cat as MemoryEntry["category"];
        bestCount = count;
      }
    }

    // Importance = max of cluster members
    const maxImportance = Math.max(...cluster.map(m => m.importance));

    // Embed the insight text
    const insightVector = await params.embedder.embedPassage(insight);

    // Store the insight as a new memory
    const insightEntry = await store.store({
      text: insight,
      vector: insightVector,
      category: bestCat,
      scope,
      importance: maxImportance,
      metadata: JSON.stringify({
        evolution: {
          status: "active",
          version: 1,
          accessCount: 0,
          lastAccessedAt: null,
          supersededBy: null,
          consolidatedInto: null,
          sourceMemories: cluster.map(m => m.id),
          validFrom: Date.now(),
          validUntil: null,
        },
        cluster_insight: true,
      }),
    });

    result.insightsGenerated++;

    // Mark source memories as consolidated_into (but keep them active)
    for (const member of cluster) {
      const patched = patchEvolution(member.metadata, {
        consolidatedInto: insightEntry.id,
        // Keep status active — still individually searchable
      });
      await store.update(member.id, { metadata: patched }, [scope]);
      result.entriesLinked++;
    }

    result.clustersConsolidated++;

    // CC-9: Successful insight generated — reset diminishing returns counter
    consecutiveLowYield = 0;
  }

  return result;
}

/** Format a ConsolidationResult for display. */
export function formatConsolidationResult(result: ConsolidationResult): string {
  const lines = [
    `Consolidation complete for scope: ${result.scope}`,
    `Scanned: ${result.originalCount} active entries`,
    `Clusters found: ${result.clustersFound}`,
    `Merged (versioned): ${result.mergedCount}`,
    `Relations added: ${result.relationsAdded}`,
    `Conflicts detected: ${result.conflictsDetected.length}`,
  ];
  if (result.conflictsDetected.length > 0) {
    lines.push("", "Conflicts:");
    for (const c of result.conflictsDetected) {
      lines.push(`  ${c.type}: ${c.memoryA.slice(0, 8)} ↔ ${c.memoryB.slice(0, 8)}`);
    }
  }
  return lines.join("\n");
}
