/**
 * D-2: Case -> Strategy -> Skill Promotion Pipeline.
 *
 * Automatically detects promotion opportunities:
 * - Same scope has N+ similar cases (store_case called repeatedly) -> suggest workflow_pattern
 * - workflow_pattern with structured steps that correlates with multiple cases -> suggest skill
 *
 * Promotion suggestions are returned to the agent for review — never auto-executed,
 * to avoid low-quality skills entering the store.
 */

import type { MemoryEntry, MemoryStore } from "./store.js";
import { cosineSimilarity } from "./multi-vector.js";
import { isActiveMemory } from "./memory-evolution.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromotionCandidate {
  type: "case_to_pattern" | "pattern_to_skill";
  sourceEntries: Array<{ id: string; text: string; score: number }>;
  suggestedName: string;
  suggestedDescription: string;
  /** For pattern_to_skill: extracted implementation steps */
  suggestedImplementation?: string;
  confidence: number; // 0-1
}

export interface PromotionScanResult {
  candidates: PromotionCandidate[];
  scannedCases: number;
  scannedPatterns: number;
  /** No-silent-caps 披露:被桶上限截断、未参与聚类的 case 数。 */
  truncatedCases: number;
  /** 向量回填失败(库中无向量)而被跳过的条目数。 */
  vectorlessSkipped: number;
}

export interface PromotionConfig {
  /** Minimum similar cases to suggest pattern promotion (default: 3) */
  minCaseOccurrences: number;
  /** Similarity threshold for case clustering (default: 0.75) */
  caseSimilarityThreshold: number;
  /** Max candidates to return (default: 5) */
  maxCandidates: number;
  /** 全量扫描总上限(防 OOM,default: 20000)。超出部分不扫并计入披露。 */
  maxScanEntries: number;
  /** 单桶聚类上限(default: 2000)。桶内按 recency 保留,截断量计入 truncatedCases。 */
  maxBucketSize: number;
  /** listPage 翻页大小 (default: 1000)。 */
  pageSize: number;
}

const DEFAULT_CONFIG: PromotionConfig = {
  minCaseOccurrences: 3,
  caseSimilarityThreshold: 0.75,
  maxCandidates: 5,
  maxScanEntries: 20_000,
  maxBucketSize: 2_000,
  pageSize: 1_000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PromotionStore = Pick<MemoryStore, "listPage" | "getVectors" | "vectorSearch">;

function isActive(entry: MemoryEntry): boolean {
  return isActiveMemory(entry.metadata);
}

/**
 * 翻页拉取一个 category 的全部条目(轻列,不含向量)。
 * listPage 在 DB 层下推 where/limit/offset,不会像 list() 那样每页全表拉取。
 */
async function listAllByCategory(
  store: PromotionStore,
  scope: string,
  category: string,
  maxEntries: number,
  pageSize: number,
): Promise<MemoryEntry[]> {
  const out: MemoryEntry[] = [];
  for (let offset = 0; out.length < maxEntries; offset += pageSize) {
    const page = await store.listPage({
      scopeFilter: [scope],
      category,
      limit: Math.min(pageSize, maxEntries - out.length),
      offset,
    });
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

/** 从 metadata JSON 读 topicTag(缺失/解析失败 → undefined)。 */
function readTopicTag(entry: MemoryEntry): string | undefined {
  try {
    const parsed: unknown = JSON.parse(entry.metadata || "{}");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const tag = (parsed as Record<string, unknown>).topicTag;
      return typeof tag === "string" && tag.length > 0 ? tag : undefined;
    }
  } catch { /* fallthrough */ }
  return undefined;
}

/**
 * 按 topicTag 分桶(无 tag → "untagged" 桶),桶内按 recency 保留 maxBucketSize 条。
 * 分桶把 greedyCluster 的 O(n²) 最坏复杂度限制在桶内,同时避免全库向量常驻。
 */
function bucketByTopic(
  entries: MemoryEntry[],
  maxBucketSize: number,
): { buckets: Map<string, MemoryEntry[]>; truncated: number } {
  const buckets = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const key = readTopicTag(e) ?? "untagged";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(e);
  }
  let truncated = 0;
  for (const [key, bucket] of buckets) {
    if (bucket.length > maxBucketSize) {
      bucket.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      truncated += bucket.length - maxBucketSize;
      buckets.set(key, bucket.slice(0, maxBucketSize));
    }
  }
  return { buckets, truncated };
}

/** Extract a short name from the first case's text (first line or first ~60 chars). */
function extractName(text: string): string {
  const firstLine = text.split("\n")[0].trim();
  return firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
}

/** Summarize a cluster into a description from member texts. */
function summarizeCluster(members: MemoryEntry[]): string {
  const snippets = members.slice(0, 3).map(m => {
    const first = m.text.split("\n")[0].trim();
    return first.length > 80 ? first.slice(0, 77) + "..." : first;
  });
  return `Recurring pattern across ${members.length} cases: ${snippets.join("; ")}`;
}

/** Check if text contains structured steps (numbered list or "Steps:" header). */
function hasStructuredSteps(text: string): boolean {
  return /(?:^|\n)\s*(?:Steps?:|##?\s*Steps?)/i.test(text)
    || /(?:^|\n)\s*[1-9]\.\s+\S/.test(text);
}

/** Extract the steps section from a pattern's text. */
function extractSteps(text: string): string {
  // Try to find content after "Steps:" header
  const stepsMatch = text.match(/(?:^|\n)\s*(?:Steps?:|##?\s*Steps?)\s*\n([\s\S]+)/i);
  if (stepsMatch) return stepsMatch[1].trim();

  // Fall back: extract all numbered list items
  const lines = text.split("\n");
  const numbered = lines.filter(l => /^\s*[1-9]\d*\.\s+\S/.test(l));
  return numbered.length > 0 ? numbered.join("\n") : text;
}

// ---------------------------------------------------------------------------
// Greedy Clustering (same approach as consolidation-engine's C-2)
// ---------------------------------------------------------------------------

export interface Cluster {
  seed: MemoryEntry;
  members: MemoryEntry[];
}

export function greedyCluster(
  entries: MemoryEntry[],
  threshold: number,
): Cluster[] {
  const clusters: Cluster[] = [];
  const centroids: number[][] = [];
  const assigned = new Set<string>();

  for (const entry of entries) {
    if (assigned.has(entry.id) || !entry.vector?.length) continue;

    let bestIdx = -1;
    let bestSim = -1;

    for (let ci = 0; ci < centroids.length; ci++) {
      const sim = cosineSimilarity(entry.vector, centroids[ci]);
      if (sim > threshold && sim > bestSim) {
        bestSim = sim;
        bestIdx = ci;
      }
    }

    if (bestIdx >= 0) {
      clusters[bestIdx].members.push(entry);
      assigned.add(entry.id);
      // Update centroid as running average
      const members = clusters[bestIdx].members;
      const dim = centroids[bestIdx].length;
      const newCentroid = new Array<number>(dim);
      for (let d = 0; d < dim; d++) {
        let sum = 0;
        for (const m of members) sum += m.vector[d];
        newCentroid[d] = sum / members.length;
      }
      centroids[bestIdx] = newCentroid;
    } else {
      clusters.push({ seed: entry, members: [entry] });
      centroids.push([...entry.vector]);
      assigned.add(entry.id);
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

/**
 * Scan for promotion candidates in a given scope.
 *
 * Algorithm:
 * 1. Load all active entries in scope, split into cases and patterns
 * 2. Cluster cases by embedding similarity (greedy clustering)
 * 3. Clusters with >= minCaseOccurrences members -> case_to_pattern candidate
 * 4. Patterns with structured steps that are similar to >= 2 cases -> pattern_to_skill candidate
 */
export async function scanForPromotions(
  store: PromotionStore,
  scope: string,
  config?: Partial<PromotionConfig>,
): Promise<PromotionScanResult> {
  const cfg: PromotionConfig = { ...DEFAULT_CONFIG, ...config };

  // 1. Paged full scan, category pushed down to the DB layer.
  //    旧实现 store.list([scope], undefined, 500, 0) 双重失效:① limit=500 在
  //    34K+ 库上覆盖率 ~1.4%;② list() 性能优化恒返回 vector:[],聚类全部跳过,
  //    管线产出恒为零(单测 mock 带向量所以从未暴露)。
  const rawCases = await listAllByCategory(store, scope, "cases", cfg.maxScanEntries, cfg.pageSize);
  const patternBudget = Math.max(0, cfg.maxScanEntries - rawCases.length);
  const rawPatterns = await listAllByCategory(store, scope, "patterns", patternBudget, cfg.pageSize);

  const cases = rawCases.filter(isActive);
  const patterns = rawPatterns.filter(isActive);

  const result: PromotionScanResult = {
    candidates: [],
    scannedCases: cases.length,
    scannedPatterns: patterns.length,
    truncatedCases: 0,
    vectorlessSkipped: 0,
  };

  // 2. Cluster cases bucket-by-bucket (topicTag, untagged fallback)。
  //    向量按桶回填、桶毕即释,全库向量绝不常驻;分桶同时把 greedyCluster 的
  //    最坏 O(n²) 限制在 maxBucketSize 内。
  if (cases.length >= cfg.minCaseOccurrences) {
    const { buckets, truncated } = bucketByTopic(cases, cfg.maxBucketSize);
    result.truncatedCases = truncated;

    for (const bucket of buckets.values()) {
      if (bucket.length < cfg.minCaseOccurrences) continue;
      if (result.candidates.length >= cfg.maxCandidates) break;

      const vectorMap = await store.getVectors(bucket.map(e => e.id));
      const withVectors = bucket
        .map(e => ({ ...e, vector: vectorMap.get(e.id) ?? [] }))
        .filter(e => e.vector.length > 0);
      result.vectorlessSkipped += bucket.length - withVectors.length;
      if (withVectors.length < cfg.minCaseOccurrences) continue;

      const clusters = greedyCluster(withVectors, cfg.caseSimilarityThreshold);

      for (const cluster of clusters) {
        if (cluster.members.length < cfg.minCaseOccurrences) continue;
        if (result.candidates.length >= cfg.maxCandidates) break;

        // Compute average intra-cluster similarity for scoring
        const avgSim = computeAverageIntraClusterSimilarity(cluster.members);

        result.candidates.push({
          type: "case_to_pattern",
          sourceEntries: cluster.members.map(m => ({
            id: m.id,
            text: m.text,
            score: avgSim,
          })),
          suggestedName: extractName(cluster.seed.text),
          suggestedDescription: summarizeCluster(cluster.members),
          confidence: cluster.members.length / (cluster.members.length + 2), // Bayesian smoothing
        });
      }
    }
  }

  // 3. Detect pattern_to_skill candidates — similarity search pushed down to the
  //    vector index (one vectorSearch per structured pattern) instead of pairwise
  //    cosine against the full in-memory case corpus.
  //    vectorSearch score = 1/(1+cosineDistance) = 1/(2-cosineSim) is monotonic in
  //    cosineSim, so minScore = 1/(2-threshold) filters EXACTLY the same set as
  //    `cosineSim >= threshold`; per-hit cosine 反算 = 2 - 1/score.
  const structuredPatterns = patterns.filter(p => hasStructuredSteps(p.text));
  const patternVectors = structuredPatterns.length > 0
    ? await store.getVectors(structuredPatterns.map(p => p.id))
    : new Map<string, number[]>();
  const minSearchScore = 1 / (2 - cfg.caseSimilarityThreshold);

  for (const pattern of structuredPatterns) {
    if (result.candidates.length >= cfg.maxCandidates) break;
    const vec = patternVectors.get(pattern.id);
    if (!vec || vec.length === 0) {
      result.vectorlessSkipped++;
      continue;
    }

    const hits = await store.vectorSearch(vec, 20, minSearchScore, [scope]);
    const similarCases = hits.filter(
      h => h.entry.category === "cases" && h.entry.id !== pattern.id && isActive(h.entry),
    );

    if (similarCases.length < 2) continue;

    result.candidates.push({
      type: "pattern_to_skill",
      sourceEntries: [
        { id: pattern.id, text: pattern.text, score: 1.0 },
        ...similarCases.map(h => ({
          id: h.entry.id,
          text: h.entry.text,
          score: 2 - 1 / h.score, // back-convert to cosine similarity
        })),
      ],
      suggestedName: extractName(pattern.text),
      suggestedDescription: `Skill derived from pattern with ${similarCases.length} supporting cases`,
      suggestedImplementation: extractSteps(pattern.text),
      confidence: similarCases.length / (similarCases.length + 2),
    });
  }

  // Sort by confidence descending, then truncate
  result.candidates.sort((a, b) => b.confidence - a.confidence);
  result.candidates = result.candidates.slice(0, cfg.maxCandidates);

  return result;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format scan results for MCP tool output. */
export function formatPromotionResult(result: PromotionScanResult): string {
  const lines = [
    `Promotion scan: ${result.scannedCases} cases, ${result.scannedPatterns} patterns scanned.`,
  ];

  // No-silent-caps:截断与向量缺失必须可见,否则"0 候选"会被误读成"扫全了没东西"。
  if (result.truncatedCases > 0) {
    lines.push(`⚠️ ${result.truncatedCases} cases truncated by bucket cap (kept most recent per topic bucket).`);
  }
  if (result.vectorlessSkipped > 0) {
    lines.push(`⚠️ ${result.vectorlessSkipped} entries skipped (no vector in store).`);
  }

  if (result.candidates.length === 0) {
    lines.push("No promotion candidates found.");
    return lines.join("\n");
  }

  lines.push(`Found ${result.candidates.length} candidate(s):\n`);

  for (const [i, c] of result.candidates.entries()) {
    lines.push(`### ${i + 1}. [${c.type}] ${c.suggestedName}`);
    lines.push(`Confidence: ${(c.confidence * 100).toFixed(1)}%`);
    lines.push(`Description: ${c.suggestedDescription}`);
    lines.push(`Sources: ${c.sourceEntries.length} entries`);
    if (c.suggestedImplementation) {
      lines.push(`Implementation:\n\`\`\`\n${c.suggestedImplementation}\n\`\`\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeAverageIntraClusterSimilarity(members: MemoryEntry[]): number {
  if (members.length < 2) return 1.0;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (members[i].vector?.length && members[j].vector?.length) {
        total += cosineSimilarity(members[i].vector, members[j].vector);
        pairs++;
      }
    }
  }
  return pairs > 0 ? total / pairs : 0;
}
