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

import type { MemoryEntry, MemorySearchResult } from "./store.js";
import { deterministicId } from "./store.js";
import type { MemoryStorePort } from "./memory-store-port.js";
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
  /**
   * KG evidence: triple-set Jaccard at/above this merges a grey-zone pair
   * (vector sim between clusterThreshold and mergeThreshold). Default 0.5 —
   * provisional until calibrated on production data (plan Q3).
   */
  tripleJaccardThreshold?: number;
  /** KG evidence: both sides need at least this many triples to qualify (default 2) */
  minTriplesForEvidence?: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  clusterThreshold: 0.82,
  mergeThreshold: 0.92,
  maxEntriesPerRun: 500,
  tripleJaccardThreshold: 0.5,
  minTriplesForEvidence: 2,
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
  /** Of mergedCount, how many were below mergeThreshold and merged on KG triple evidence */
  tripleEvidenceMerges: number;
  conflictsDetected: ConflictEvent[];
  scope: string;
}

// ---------------------------------------------------------------------------
// KG evidence source (duck-typed subset of KGStore)
// ---------------------------------------------------------------------------

/** The two triple fields consolidation needs — structurally satisfied by KGTriple. */
export interface ConsolidationTripleEvidence {
  id: string;
  mention_count: number;
}

export interface ConsolidationKGSource {
  getTriplesBySourceMemories(memoryIds: string[]): Promise<Map<string, ConsolidationTripleEvidence[]>>;
}

/**
 * Jaccard overlap of two triple-id sets. Below `minSize` on either side the
 * evidence is considered too weak and 0 is returned (a single shared triple
 * must not merge two memories on its own).
 */
export function tripleJaccard(
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string> | undefined,
  minSize = 2,
): number {
  if (!a || !b || a.size < minSize || b.size < minSize) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Mention-frequency boost in canonical selection: tie-breaker ONLY, never an
 * override of a clear canonicalScore gap (an entry with one hot triple must
 * not demote a substantially more important memory to consolidated status).
 * α=0.06 keeps the boost differentiating (m=1 → 1.042, m=9 → 1.138) while the
 * 1.1 cap bounds the maximum flip at ~10% of the base score — effectively ties.
 */
const MENTION_ALPHA = 0.06;
const MENTION_BOOST_CAP = 1.1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMetadata(entry: MemoryEntry): Record<string, unknown> {
  if (!entry.metadata) return {};
  try { return JSON.parse(entry.metadata); } catch { return {}; }
}

function isActive(entry: MemoryEntry): boolean {
  // Unified lifecycle check via evolution.status (no legacy meta.state fallback)
  return isActiveMemory(entry.metadata);
}

function canonicalScore(entry: MemoryEntry): number {
  const evo = parseEvolution(entry.metadata, entry.timestamp);
  return entry.importance * (1 + Math.log(evo.accessCount + 1));
}

/** Simple heuristic contradiction: negation pattern check between two texts. */
export function detectHeuristicContradiction(textA: string, textB: string): boolean {
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

type ConsolidationStore = Pick<MemoryStorePort, "list" | "getById" | "vectorSearch" | "update">;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ConsolidationEngine {
  constructor(
    private store: ConsolidationStore,
    private config: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
    /** Optional KG evidence source — absent = pure vector behavior, unchanged */
    private kgSource: ConsolidationKGSource | null = null,
  ) {}

  async run(scope: string): Promise<ConsolidationResult> {
    const {
      clusterThreshold,
      mergeThreshold,
      maxEntriesPerRun,
      tripleJaccardThreshold = 0.5,
      minTriplesForEvidence = 2,
    } = this.config;

    // 1. Fetch entries in scope
    const entries = await this.store.list([scope], undefined, maxEntriesPerRun, 0);
    const active = entries.filter(isActive);

    if (active.length === 0) {
      return { originalCount: 0, clustersFound: 0, mergedCount: 0, relationsAdded: 0, tripleEvidenceMerges: 0, conflictsDetected: [], scope };
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
    let tripleEvidenceMerges = 0;
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

        // Seeds are active-only (above), but vectorSearch filters by scope alone, so
        // superseded belief-history rows surface here too. A rephrased belief sits well
        // above mergeThreshold from its own archived version, and canonicalScore has no
        // recency term — importance × access count are both inherited by the history row,
        // so the two tie and the "weaker" one is picked arbitrarily. Lose that coin flip
        // and the live belief gets marked consolidated, dropping out of default retrieval
        // while the abandoned version stands in as canonical.
        const members = similar.filter(
          s => s.entry.id !== entry.id
            && !clustered.has(s.entry.id)
            && s.entry.category === entry.category
            && isActive(s.entry),
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

        // KG triple evidence for this cluster (single batch query; best-effort —
        // on failure consolidation proceeds vector-only)
        const tripleIdsByMember = new Map<string, Set<string>>();
        const maxMentionByMember = new Map<string, number>();
        if (this.kgSource) {
          try {
            const triplesByMember = await this.kgSource.getTriplesBySourceMemories(memberEntries.map(e => e.id));
            for (const [mid, triples] of triplesByMember) {
              tripleIdsByMember.set(mid, new Set(triples.map(t => t.id)));
              maxMentionByMember.set(mid, triples.reduce((m, t) => Math.max(m, t.mention_count), 0));
            }
          } catch { /* KG evidence is best-effort */ }
        }

        // Determine canonical: highest canonicalScore, frequency-boosted when
        // KG evidence exists (memories carrying often-mentioned facts win ties)
        const mentionBoost = (e: MemoryEntry) =>
          Math.min(MENTION_BOOST_CAP, 1 + MENTION_ALPHA * Math.log((maxMentionByMember.get(e.id) ?? 0) + 1));
        const sorted = [...memberEntries].sort(
          (a, b) => canonicalScore(b) * mentionBoost(b) - canonicalScore(a) * mentionBoost(a),
        );
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

          // Second evidence source: two memories whose extracted fact sets
          // overlap heavily are duplicates even when vector sim sits in the
          // grey zone (the "pairwise near-duplicates" the 0.92 bar misses).
          const jaccard = tripleJaccard(
            tripleIdsByMember.get(canonical.id),
            tripleIdsByMember.get(member.id),
            minTriplesForEvidence,
          );

          if (sim >= mergeThreshold || jaccard >= tripleJaccardThreshold) {
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
            if (sim < mergeThreshold) tripleEvidenceMerges++;
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

    return { originalCount: active.length, clustersFound, mergedCount, relationsAdded, tripleEvidenceMerges, conflictsDetected, scope };
  }
}

// ---------------------------------------------------------------------------
// C-2: Cluster Consolidation — group similar memories and generate insights
// ---------------------------------------------------------------------------

export interface ClusterConsolidationResult {
  clustersFound: number;
  clustersConsolidated: number;
  insightsGenerated: number;
  /** HP-5: Number of cross-memory patterns discovered */
  patternsExtracted: number;
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
  store: Pick<MemoryStorePort, "store" | "update">;
  scope: string;
  /** Minimum cluster size to trigger consolidation (default: 3) */
  minClusterSize?: number;
  /** Similarity threshold for clustering (default: 0.75) */
  clusterThreshold?: number;
  /** Max clusters to process per run (default: 5) */
  maxClusters?: number;
  /** HP-5: Enable cross-memory pattern extraction after insight generation (default: false) */
  extractPatterns?: boolean;
}): Promise<ClusterConsolidationResult> {
  const {
    entries,
    llm,
    store,
    scope,
    minClusterSize = 3,
    clusterThreshold = 0.75,
    maxClusters = 5,
    extractPatterns = false,
  } = params;

  const result: ClusterConsolidationResult = {
    clustersFound: 0,
    clustersConsolidated: 0,
    insightsGenerated: 0,
    patternsExtracted: 0,
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

    // Store the insight as a new memory. P0-2/P1-2: derive a deterministic id from the
    // (sorted) source member ids so re-running dream/consolidate on the same cluster
    // upserts the same insight row instead of appending a near-duplicate each run
    // (the highest-frequency dup-id source). Cross-run stable because sourceIds are stable.
    const sortedSourceIds = cluster.map(m => m.id).slice().sort();
    const insightEntry = await store.store({
      id: deterministicId(scope, `cluster-insight:${sortedSourceIds.join(",")}`),
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

    // HP-5: Cross-memory pattern extraction
    if (extractPatterns && cluster.length >= 3) {
      const patternText = await llm.extractPattern(cluster.map(m => m.text));
      if (patternText) {
        // 与同函数上方的 cluster insight 取同一个值：派生物继承源里最高的 importance，
        // 不额外加成。原本这里是 maxImportance + 0.1，会让 LLM 抽出的 pattern 比它的
        // 任何一条源记忆都重要——而 importance >= 0.95 在本仓库里是「人工 pin」的专用
        // 语义（cli.ts pin 操作把值抬到 0.95；auto-gc 视其为永不归档、decay-engine 视其
        // 为永不衰减）。于是任何一条源 >= 0.85 的 cluster，其派生 pattern 都会自动跨进
        // 人类锚点频段。加成想表达的「pattern 比源更有价值」若要保留，应走独立通道
        // （检索 boost / 独立 tier / 显式 flag），不该占用这个频段。
        const patternImportance = maxImportance;
        const patternVector = await params.embedder.embedPassage(patternText);
        const patternEntry = await store.store({
          id: deterministicId(scope, `cluster-pattern:${sortedSourceIds.join(",")}`),
          text: patternText,
          vector: patternVector,
          category: "patterns",
          scope,
          importance: patternImportance,
          metadata: JSON.stringify({
            evolution: {
              status: "active",
              version: 1,
              accessCount: 0,
              lastAccessedAt: null,
              supersededBy: null,
              consolidatedInto: null,
              contributedToPattern: null,
              sourceMemories: cluster.map(m => m.id),
              validFrom: Date.now(),
              validUntil: null,
            },
            cross_memory_pattern: true,
            source_cluster_size: cluster.length,
          }),
        });

        // Mark source memories with contributedToPattern
        for (const member of cluster) {
          const patched = patchEvolution(member.metadata, {
            contributedToPattern: patternEntry.id,
          });
          await store.update(member.id, { metadata: patched }, [scope]);
        }

        result.patternsExtracted++;
      }
    }

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
    `Merged (versioned): ${result.mergedCount}${result.tripleEvidenceMerges > 0 ? ` (${result.tripleEvidenceMerges} on triple evidence)` : ""}`,
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

// ---------------------------------------------------------------------------
// LC-P2: Cluster-aware deduplication for retrieval results
// ---------------------------------------------------------------------------

/**
 * Whether an entry is a consolidation derivative — a cluster insight or a
 * cross-memory pattern the LLM wrote from other entries, rather than something
 * captured from the outside world.
 *
 * Single source of truth for the two metadata flags: retrieval uses it to
 * collapse a derivative with its sources, and the dream gather uses it to keep
 * derivatives from being re-consolidated as if they were raw material.
 */
export function isDerivedInsight(metadata: string | undefined): boolean {
  if (!metadata) return false;
  try {
    const meta = JSON.parse(metadata) as Record<string, unknown>;
    return meta.cluster_insight === true || meta.cross_memory_pattern === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Synthesis uptake (Artel archivist_metrics.synthesis_uptake_rate 的对应物)
// ---------------------------------------------------------------------------

export interface SynthesisUptakeStats {
  /** Entries scanned across the store (may be capped). */
  scanned: number;
  /** Derived insights found (cluster_insight / cross_memory_pattern). */
  derivedTotal: number;
  /** Derived insights with accessCount > 0 — actually read after synthesis. */
  derivedRead: number;
  /** derivedRead / derivedTotal; null when no derived insights exist. */
  uptakeRate: number | null;
  /** True when the scan hit the cap before exhausting the store. */
  truncated: boolean;
}

/**
 * Measure how many consolidation/dream products were ever read back.
 * 把"升华产物没人用"从体感变成能报警的数字——uptake 长期为 0 说明
 * 升华管线在产出无人消费的内容（或读打点断链）。
 */
export async function computeSynthesisUptake(
  store: { listPage(opts: { limit?: number; offset?: number; includeVector?: boolean }): Promise<MemoryEntry[]> },
  // 50K 覆盖当前 ~34K 生产库全量（2026-07-23 实测 cap 20K 只扫 57%，truncated 结论不完整）；
  // metadata-only 分页扫描秒级，memory_stats 是低频人工工具，扫全比抽样值钱。
  scanCap = 50_000,
  pageSize = 1_000,
): Promise<SynthesisUptakeStats> {
  let scanned = 0;
  let derivedTotal = 0;
  let derivedRead = 0;
  let offset = 0;
  let truncated = false;

  for (;;) {
    const page = await store.listPage({ limit: pageSize, offset, includeVector: false });
    if (page.length === 0) break;
    for (const e of page) {
      scanned++;
      if (!isDerivedInsight(e.metadata)) continue;
      derivedTotal++;
      try {
        const meta = JSON.parse(e.metadata || "{}") as Record<string, unknown>;
        if (typeof meta.accessCount === "number" && meta.accessCount > 0) derivedRead++;
      } catch { /* broken metadata → counts as unread */ }
    }
    offset += page.length;
    if (page.length < pageSize) break;
    if (offset >= scanCap) {
      truncated = true;
      break;
    }
  }

  return {
    scanned,
    derivedTotal,
    derivedRead,
    uptakeRate: derivedTotal > 0 ? derivedRead / derivedTotal : null,
    truncated,
  };
}

/**
 * LC-P2: When a cluster insight and its source memories both appear in
 * retrieval results, keep only the cluster insight (it subsumes the
 * individual entries). This saves token budget during context injection.
 *
 * Works with any result shape that has { entry: MemoryEntry; score: number }.
 */
export function deduplicateByClusterInsight<T extends { entry: MemoryEntry; score: number }>(
  results: T[],
): T[] {
  // Collect source memory IDs covered by cluster insights in this result set
  const coveredByInsight = new Set<string>();

  for (const r of results) {
    if (!isDerivedInsight(r.entry.metadata)) continue;
    try {
      const meta = JSON.parse(r.entry.metadata as string);
      const sources: unknown[] = meta.evolution?.sourceMemories;
      if (Array.isArray(sources)) {
        for (const id of sources) {
          if (typeof id === "string") coveredByInsight.add(id);
        }
      }
    } catch { /* skip unparseable */ }
  }

  if (coveredByInsight.size === 0) return results;

  // Filter out source memories that are subsumed by an insight
  return results.filter(r => !coveredByInsight.has(r.entry.id));
}
