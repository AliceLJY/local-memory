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
import type { ScopeMatchMode } from "./scope-policy.js";
import { computeVersionGroupPatch, resolveGroupId } from "./version-manager.js";
import { isActiveMemory, parseEvolution, buildSupersedeMetadata, patchEvolutionOnMeta } from "./memory-evolution.js";
import { cosineSimilarity } from "./multi-vector.js";
import type { LLMClient } from "./llm-client.js";
import type { Embedder } from "./embedder.js";
import { logWarn } from "./stderr-log.js";
import { DURABLE_MEMORY_CATEGORIES, type DurableMemoryCategory } from "./memory-schema.js";
import { getConflictPolicyForCategory, type MemoryBoundaryMetadata } from "./memory-boundaries.js";
import type { SynthesisVerdict } from "./synthesis-contract.js";

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
  /**
   * scope 过滤模式（2026-08-16 加）。默认 "family" = store 历史语义（无冒号按前缀）。
   * dream 传 "exact"：它拿到的是一个具体 scope 名，前缀语义会把兄弟 scope
   * （`memory` → `memory:pivot`）卷进同一批候选与 vectorSearch 结果。
   */
  scopeMatch?: ScopeMatchMode;
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

/**
 * 合成契约版本号。写进每条派生物的 metadata，用来把「新契约的产物」和历史存量分开。
 *
 * 存在的理由是可评估性：两把确定性判据（结论连接词率 / 性向归因率）要在改动前后
 * 做对照，而库里 4,500+ 条老产物和新产物混在一张表里、`cluster_insight` 标记完全
 * 相同。没有这个标记，"改完之后的产物质量"这个问题就只能靠时间戳去猜。
 *
 * **提示词属于契约，改了就要推版本号**——否则前后两批产物混在同一个标记下，
 * 「这个数字是哪版代码跑出来的」又变成了猜。v2（2026-08-23 当日）= v1 加上
 * 「只输出一个 JSON 对象」的约束：v1 实测有 3.3% 的调用会一口气吐出多个 JSON
 * 对象、整条判 unparsable（finish_reason 全为 stop，与 token 截断无关），
 * 补这一句后同口径实测降到 0.0%。
 */
export const SYNTHESIS_CONTRACT_VERSION = 2;

/**
 * 派生物（cluster insight / cross-memory pattern）的边界声明。
 *
 * 为什么必须显式写（2026-08-22 查实）：4,749 条历史派生物**全部没有 boundary 字段**。
 * 检索侧 `retriever.ts` 的 `isEvidenceLayer` 在缺字段时回退到 `isTranscriptScope(scope)`，
 * 于是其中 96.4% 因为恰好落在 `cc:` / `codex:` scope 而被判成 evidence —— **靠 scope
 * 命名侥幸判对，不是靠设计**。剩下 173 条落在 `memory` / `project:*` 这类非 transcript
 * scope 上，静默拿到了 durable 权威：一句 LLM 复述，在检索里和手写结论平起平坐。
 *
 * 定成 evidence 而不是 durable：这是模型对既有记忆的再加工，不是从外部世界捕获的
 * 事实，也不是人拍板的结论。它可以作为线索被检索到，但不该压过它自己的源。
 * authority 取 `distillation`（它确实是提炼产物），与 layer 一起才说得全 ——
 * 「是什么来源」和「有多大权威」是两个问题。
 */
export function buildDerivedBoundary(category: string): MemoryBoundaryMetadata {
  const durable = toDurableCategory(category);
  return {
    layer: "evidence",
    authority: "distillation",
    conflictPolicy: getConflictPolicyForCategory(durable),
    originalCategory: durable,
    note: "Dream-synthesized derivative: a lead to its sources, never authority over them.",
  };
}

/** 簇的多数票类目可能落在 legacy 值上；边界字段只认 durable 六类，兜底到 events。 */
function toDurableCategory(category: string): DurableMemoryCategory {
  return (DURABLE_MEMORY_CATEGORIES as readonly string[]).includes(category)
    ? category as DurableMemoryCategory
    : "events";
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

type ConsolidationStore = Pick<MemoryStorePort, "list" | "getById" | "vectorSearch" | "update" | "patchMetadataBatch">;

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
      scopeMatch = "family",
    } = this.config;

    // 1. Fetch entries in scope
    const entries = await this.store.list([scope], undefined, maxEntriesPerRun, 0, scopeMatch);
    // 派生 insight 不参与去重（2026-08-16 加，与 dream gather 的既有排除对齐）。
    // 此前只有 gather（dream-pipeline.ts）排除派生物，3a 自己重新取数时不排除 ——
    // 实测后果：`memory:pivot` 里 3 条手写原件被 3a 合并进 LLM 复述、复述当了 canonical
    // （双方 importance 0.7 / accessCount 0，canonicalScore 打平时任取其一），
    // 其中两条带 canonicalKey 与来源 tag，赢家是零来源的短复述。
    // 派生物既不做 seed 也不做 member —— 摘要不该有资格顶掉它自己的原文。
    const active = entries.filter(e => isActive(e) && !isDerivedInsight(e.metadata));

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
          full.vector, 10, clusterThreshold, [scope], scopeMatch,
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
            && isActive(s.entry)
            // vectorSearch 只按 scope 过滤，派生 insight 会从这里回到候选集里 ——
            // seed 侧已在上面滤掉，member 侧必须同样滤（2026-08-16）。
            && !isDerivedInsight(s.entry.metadata),
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
          canonical.vector, memberEntries.length + 5, clusterThreshold, [scope], scopeMatch,
        );
        const scoreMap = new Map<string, number>();
        for (const r of pairResults) scoreMap.set(r.entry.id, r.score);

        // 2026-08-14 批量化重构（dream 写爆库根治 + Bug-1 修复）：
        //
        // 旧路径对每个 member 逐条写库 2-4 次（merge: createVersionGroup 2 + member 1
        // + canonical 1；link: 2），一个 cluster 写 canonical N 遍 —— 且每次 patch 都
        // 基于循环里从不刷新的旧内存串，后写的把先写的键抹掉：member1 经
        // createVersionGroup 落库的 version_group 被随后的 sourceMemories 更新（旧串
        // 起底）覆盖，member2 又因读到无组的旧串新造一个 groupId。最终态是 canonical
        // 与全部 member 通常都不带组、sourceMemories 只剩最后一个 member（2 成员的
        // cluster 同样全丢）。
        //
        // 新路径：先纯计算把 member 分进 merge/link 两组，cluster 末尾一次
        // patchMetadataBatch —— patchFn 在锁内以库中最新 meta 为底座应用，canonical
        // 只写一次（version-group 键 + sourceMemories 累积 + cluster_members 累积），
        // groupId 在 cluster 级决策一次全组共享。每 cluster 1 个 commit（原 2-4×N）。
        const mergeMembers: MemoryEntry[] = [];
        const linkMembers: MemoryEntry[] = [];
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
            mergeMembers.push(member);
            mergedCount++;
            if (sim < mergeThreshold) tripleEvidenceMerges++;
          } else {
            linkMembers.push(member);
            relationsAdded++;
          }
        }

        if (mergeMembers.length > 0 || linkMembers.length > 0) {
          // groupId 决策：canonical 已有组沿用，否则 cluster 级新生成一次。
          // 决策基于本 cluster 开头刚 getById 的 canonical（毫秒级新鲜）；组字段只有
          // dream 自己写、且本 scope 有 per-scope dream 锁，锁外决策的竞态面趋零。
          const groupId = mergeMembers.length > 0 ? resolveGroupId(canonical) : null;
          const nowIso = new Date().toISOString();
          const mergeIds = mergeMembers.map(m => m.id);
          const linkIds = linkMembers.map(m => m.id);

          const patches: Array<{
            id: string;
            patchFn: (meta: Record<string, unknown>, entry: MemoryEntry) => Record<string, unknown>;
          }> = [];

          patches.push({
            id: canonical.id,
            patchFn: (meta, entry) => {
              if (groupId) computeVersionGroupPatch(meta, entry, groupId, true, nowIso);
              if (mergeIds.length > 0) {
                const evo = meta.evolution !== null && typeof meta.evolution === "object" && !Array.isArray(meta.evolution)
                  ? (meta.evolution as Record<string, unknown>)
                  : {};
                const existing = Array.isArray(evo.sourceMemories) ? (evo.sourceMemories as string[]) : [];
                const accumulated = [...existing];
                for (const id of mergeIds) if (!accumulated.includes(id)) accumulated.push(id);
                patchEvolutionOnMeta(meta, { sourceMemories: accumulated });
              }
              if (linkIds.length > 0) {
                const members = Array.isArray(meta.cluster_members) ? (meta.cluster_members as string[]) : [];
                for (const id of linkIds) if (!members.includes(id)) members.push(id);
                meta.cluster_members = members;
              }
              return meta;
            },
          });

          for (const member of mergeMembers) {
            patches.push({
              id: member.id,
              patchFn: (meta, entry) => {
                // Tier 3.3 version coexistence + C-1 consolidated 标记，一次写齐
                computeVersionGroupPatch(meta, entry, groupId as string, false, nowIso);
                return patchEvolutionOnMeta(meta, {
                  status: "consolidated",
                  consolidatedInto: canonical.id,
                });
              },
            });
          }

          for (const member of linkMembers) {
            patches.push({
              id: member.id,
              patchFn: (meta) => {
                meta.clustered_with = canonical.id;
                return meta;
              },
            });
          }

          await this.store.patchMetadataBatch(patches, [scope]);
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
  /**
   * 本轮被吸收的 LLM 调用失败数（超时 / 网络 / 熔断抛出）。
   *
   * 计出来是为了让「吸收」不等于「静默」：吸收前，单个 cluster 撞 15s 超时会把整个
   * scope 的 dream 炸掉（2026-08-09 memory 轮次连挂两次的根因）；吸收后若不计数，
   * 「LLM 全程不可用」和「今天没料可炼」会长得一模一样。
   */
  llmFailures: number;
  /**
   * 模型自己判定「这簇没有可提炼结论」的次数（insight + pattern 合计）。
   *
   * 2026-08-23 加。在此之前**这个数按构造只能是 0** —— 老 `generateL0` 没有弃权路径，
   * 每个合格簇必写一条。所以它不是锦上添花的计量，而是新契约是否真在生效的直接读数：
   * 长期为 0 意味着模型又在硬凑了。诊断实测同批簇上一个合格提示词弃权约 22.5%。
   */
  synthesisAbstained: number;
  /**
   * 写库前校验拦下的次数（提示词回声 / evidence 不合法 / 长度越界 / JSON 解析不出）。
   *
   * 与 `llmFailures` 分开：那个是「没拿到回复」，这个是「拿到了但不合契约」。
   * 老路径两者都不计 —— 于是 28 条系统提示词原文安静地进了库。
   */
  synthesisRejected: number;
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
  store: Pick<MemoryStorePort, "store" | "update" | "patchMetadataBatch">;
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
    llmFailures: 0,
    synthesisAbstained: 0,
    synthesisRejected: 0,
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

    // 每簇共用的三个量，2026-08-23 从 insight 分支里提上来。
    // 提上来是 pattern 解耦的前置条件：以前 bestCat / maxImportance / sortedSourceIds
    // 都算在 `if (!insight) continue` 之后，pattern 想独立跑就拿不到它们。
    const memberTexts = cluster.map(m => m.text);
    const sortedSourceIds = cluster.map(m => m.id).slice().sort();

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

    /**
     * 一次合成调用的统一入口：吸收异常、把三种结局（产出 / 弃权 / 校验不过）分别计数。
     *
     * 单个 cluster 的 LLM 失败不该炸掉整个 scope。llm-client 的 chat() 在 catch 里是
     * `throw err`（记完熔断计数后原样抛），所以 AbortController 超时会一路冒到
     * runDream 之外 —— 2026-08-09 memory 轮次连挂两次正是这条路径：memory 是最大
     * scope、cluster 最多，撞上一次超时的概率接近 1，且两次挂的位置不同（不是某对
     * 内容有毒，是这一阶段本来就没有防护）。
     *
     * 吸收成 `abstained` 而不是新开一条分支：调用方对「本簇这一侧没有产出」的处理
     * 本来就一样。失败另计 llmFailures、校验不过另计 synthesisRejected，避免吸收变静默。
     */
    const runSynthesis = async (
      label: string,
      call: () => Promise<SynthesisVerdict>,
    ): Promise<SynthesisVerdict> => {
      let verdict: SynthesisVerdict;
      try {
        verdict = await call();
      } catch (err) {
        result.llmFailures++;
        logWarn(`[WARN] ${label} LLM 调用失败，本簇跳过: ${err instanceof Error ? err.message : String(err)}`);
        return { status: "abstained" };
      }
      if (verdict.status === "abstained") {
        result.synthesisAbstained++;
      } else if (verdict.status === "rejected") {
        result.synthesisRejected++;
        // 打出来的是**原因**不是「失败了」：`prompt-echo` 说明模型在回声提示词，
        // `evidence-out-of-range` 说明它在编造编号，两者要采取的动作完全不同。
        logWarn(`[WARN] ${label} 输出未通过写库前校验（${verdict.reason}），本簇该侧不写库`);
      }
      return verdict;
    };

    /** 派生物统一的边界声明。见下方 buildDerivedBoundary 的注释。 */
    const derivedBoundary = buildDerivedBoundary(bestCat);

    let effectsThisCluster = 0;

    // ---- cluster insight ---------------------------------------------------
    const insightVerdict = await runSynthesis("cluster insight", () =>
      llm.synthesizeClusterInsight(memberTexts));

    if (insightVerdict.status === "ok") {
      const { text: insight, evidence } = insightVerdict.output;

      // Embed the insight text
      const insightVector = await params.embedder.embedPassage(insight);

      // Store the insight as a new memory. P0-2/P1-2: derive a deterministic id from the
      // (sorted) source member ids so re-running dream/consolidate on the same cluster
      // upserts the same insight row instead of appending a near-duplicate each run
      // (the highest-frequency dup-id source). Cross-run stable because sourceIds are stable.
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
          boundary: derivedBoundary,
          synthesis_contract: SYNTHESIS_CONTRACT_VERSION,
          /** 模型自己指认的支撑源（sourceMemories 的子集）。空集进不来——校验挡在前面。 */
          evidenceMemories: evidence.map(i => cluster[i - 1]?.id).filter((id): id is string => Boolean(id)),
        }),
      });

      result.insightsGenerated++;
      effectsThisCluster++;

      // Mark source memories as consolidated_into (but keep them active).
      // 2026-08-14 批量化：N 次逐条 update → 1 次 patchMetadataBatch。patchFn 在锁内
      // 以最新 meta 为底座，pattern 段随后的 contributedToPattern 批不会再把这里写的
      // consolidatedInto 抹掉（旧路径的 Bug-2：两段都从同一个旧内存串起底 patch）。
      // 本批独立于 pattern 批提交：pattern 路径失败时 insight 的源链接已落库（保持
      // 旧异常语义 —— insight 源链接从来不等 pattern）。
      result.entriesLinked += await store.patchMetadataBatch(
        cluster.map(member => ({
          id: member.id,
          patchFn: (meta: Record<string, unknown>) => patchEvolutionOnMeta(meta, {
            consolidatedInto: insightEntry.id,
            // Keep status active — still individually searchable
          }),
        })),
        [scope],
      );
    }

    result.clustersConsolidated++;

    // ---- HP-5: Cross-memory pattern extraction ------------------------------
    //
    // 2026-08-23 解耦：这一段不再挂在 insight 成功之后。原路径是
    // `if (!insight) { ...; continue; }`，于是 insight 一旦弃权或失败，pattern 抽取
    // 根本不执行 —— 两个目标概念不同的合成被绑成一条命。改后两者独立失败、独立弃权：
    // 「这簇没有单条结论」和「这簇没有跨条目模式」是两个判断，没有理由互相代表。
    if (extractPatterns && cluster.length >= 3) {
      const patternVerdict = await runSynthesis("cross-memory pattern", () =>
        llm.synthesizeClusterPattern(memberTexts));

      if (patternVerdict.status === "ok") {
        const { text: patternText, evidence } = patternVerdict.output;
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
            // pattern 恒为 patterns 类目，边界单独构造，不跟 insight 的多数票类目走。
            boundary: buildDerivedBoundary("patterns"),
            synthesis_contract: SYNTHESIS_CONTRACT_VERSION,
            evidenceMemories: evidence.map(i => cluster[i - 1]?.id).filter((id): id is string => Boolean(id)),
          }),
        });

        // Mark source memories with contributedToPattern（同上：一批提交，锁内最新
        // meta 起底 —— 与 insight 批叠加而非互抹）
        await store.patchMetadataBatch(
          cluster.map(member => ({
            id: member.id,
            patchFn: (meta: Record<string, unknown>) => patchEvolutionOnMeta(meta, {
              contributedToPattern: patternEntry.id,
            }),
          })),
          [scope],
        );

        result.patternsExtracted++;
        effectsThisCluster++;
      }
    }

    // CC-9: 本簇两侧都没写出东西才算零产出轮次。
    // 判据从「insight 有没有」换成「这一簇有没有任何副作用」—— 解耦之后 insight 弃权
    // 而 pattern 产出是合法结局，把它算成零产出会让早停提前触发、白扔掉后面的簇。
    if (effectsThisCluster === 0) {
      consecutiveLowYield++;
    } else {
      consecutiveLowYield = 0;
    }
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
 * collapse a derivative with its sources, the dream gather uses it to keep
 * derivatives from being re-consolidated as if they were raw material, and
 * (2026-08-16) 3a uses it on both the seed side and the member side — a summary
 * must never be eligible to become the canonical row over its own source.
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
  /** Derived insights with accessCount > 0 — touched by at least one retrieval.
   *  ⚠️ Inflatable: the MCP search path does not pass `source`, so every search hit
   *  increments accessCount (retriever.ts reinforcement gate is `source !== "auto-recall"`).
   *  One person running ~300 queries can move this from 3.7% to 7%+ with the store unchanged
   *  (2026-08-22 measured: a single 16-query audit moved it 177→186/4749). */
  derivedRead: number;
  /** derivedRead / derivedTotal; null when no derived insights exist. Read as "touched", not "useful". */
  uptakeRate: number | null;
  /** Derived insights read by ≥2 distinct readers (metadata.distinctReaderCount, maintained by
   *  access-tracker with reader-id dedup + novelty gating). A single reader's repeated searches
   *  cannot push an entry past 1, so this is the harder-to-inflate uptake signal. */
  derivedReadByMultiple: number;
  /** derivedReadByMultiple / derivedTotal; null when no derived insights exist. */
  multiReaderRate: number | null;
  /** True when the scan hit the cap before exhausting the store. */
  truncated: boolean;
}

/**
 * Measure how many consolidation/dream products were ever read back.
 * 把"升华产物没人用"从体感变成能报警的数字——uptake 长期为 0 说明
 * 升华管线在产出无人消费的内容（或读打点断链）。
 *
 * 两个口径（2026-09-09 加第二个，open-loops「召回可达性抽测」③）：
 * - uptakeRate：accessCount>0。**只增不减、可被检索廉价刷高**（见字段注释），
 *   只能读成「被碰过」，不能当「合成产物有用/没用」的证据。保留它是为了历史可比。
 * - multiReaderRate：distinctReaderCount≥2。一个人反复搜刷不高，是更难被扰动的口径。
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
  let derivedReadByMultiple = 0;
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
        if (typeof meta.distinctReaderCount === "number" && meta.distinctReaderCount >= 2) derivedReadByMultiple++;
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
    derivedReadByMultiple,
    multiReaderRate: derivedTotal > 0 ? derivedReadByMultiple / derivedTotal : null,
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
