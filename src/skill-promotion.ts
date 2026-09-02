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
import { verifyDraft, type VerifyResult } from "./skill-verifier.js";

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
  /** A2: zero-LLM verifier verdict (pattern_to_skill only). 失败候选保留披露、排后、不静默丢。 */
  verification?: VerifyResult;
  /** Read-signal evidence aggregated from source entries（Artel 读驱动升华：被真实读过的候选提权）。 */
  readEvidence?: { totalAccess: number; distinctReaders: number };
  /** 这个候选覆盖了几个不同来源（episode）。1 = 同一次经历的重复，不是跨任务规律。 */
  distinctSources?: number;
}

/**
 * 被跨来源判据拒掉的簇 —— 「同一个坑踩了 N 次」。
 *
 * 这不是待晋升的规律，是反模式证据：`judgeDistinctSources` 判 `rejected` 时原本只
 * `rejectedSingleSource++` 然后 continue，信号变成一个数字后消失（同文件下方注释
 * 早就写着"走 failure-burst 反模式那条路"，而那条路一直不存在）。
 *
 * 字段借自 MemTensor/memmy-agent 的 `Memory/src/service/evolution/negative-experience-pipeline.ts`
 * （其 `NegativeExperienceSource` 枚举里字面就有 `tool_failure_burst`）。
 * **有意只借它列的证据字段**：memmy 那份 schema 还有 `preference`（该怎么做）与
 * `verification`（怎么确认没再犯），但那两格要的是判断不是统计 —— 扫描器编出来的
 * 「该怎么做」比没有更糟。它们列在 `needsJudgement` 里等人或 LLM 填。
 */
export interface AntiPatternCandidate {
  /** 目前只有一条来路；留成联合类型是为了将来接别的信号（如工具连续失败）时不改调用方。 */
  source: "single_source_burst";
  /** 撞上它的场景 —— 取簇种子的首行，和 candidates 的 suggestedName 同款提取。 */
  trigger: string;
  /** 反模式描述 —— 簇内多条的共性摘要。 */
  antiPattern: string;
  /** 同一个坑重复了几次。 */
  occurrences: number;
  /** 实际覆盖几个不同来源（判 rejected 说明它 < minDistinctSources）。 */
  distinctSources: number;
  /** 0-1。同一来源里重复越多越强，但不因此就变成"规律"。 */
  evidenceStrength: number;
  sourceEntries: Array<{ id: string; text: string }>;
  /** 扫描器有意不填的字段，等判断补上。写死成数组是为了让调用方能机械检查。 */
  needsJudgement: ReadonlyArray<"preference" | "verification">;
}

export interface PromotionScanResult {
  candidates: PromotionCandidate[];
  scannedCases: number;
  scannedPatterns: number;
  /** No-silent-caps 披露:被桶上限截断、未参与聚类的 case 数。 */
  truncatedCases: number;
  /** 向量回填失败(库中无向量)而被跳过的条目数。 */
  vectorlessSkipped: number;
  /** No-silent-caps 披露:条数够、但来源不够(同一个坑重复)而被拒的簇数。 */
  rejectedSingleSource: number;
  /** No-silent-caps 披露:拿不到来源指针、跨来源判据弃权放行的簇数。 */
  abstainedUnknownSource: number;
  /**
   * P4 反模式出口:被判 rejected 的簇的**内容**,不只是计数。
   * 注意与 abstainedUnknownSource 的区别 —— 弃权的簇不进这里:
   * 不知道来源就不能指控它是「同一个坑踩三次」。
   */
  antiPatterns?: AntiPatternCandidate[];
}

export interface PromotionConfig {
  /** Minimum similar cases to suggest pattern promotion (default: 3) */
  minCaseOccurrences: number;
  /** Similarity threshold for case clustering (default: 0.75) */
  caseSimilarityThreshold: number;
  /** Max candidates to return (default: 5) */
  maxCandidates: number;
  /** 全量扫描上限(防 OOM,default: 20000)。cases/patterns 各自独立适用。 */
  maxScanEntries: number;
  /** 单桶聚类上限(default: 2000)。桶内按 recency 保留,截断量计入 truncatedCases。 */
  maxBucketSize: number;
  /** listPage 翻页大小 (default: 1000)。 */
  pageSize: number;
  /** pattern_to_skill 通道最多探测的 structured patterns 数(每个一次 vectorSearch,
   *  default: 1000,按 recency 优先)。 */
  maxPatternProbes: number;
  /**
   * 一个簇要来自几个**不同来源**才算规律(default: 2)。
   *
   * 借鉴 MemOS 的 L1→L2 判据:它数的是「几个不同 episode」,而这里原本数的是
   * 「几条相似 case」——差的是维度不是数字。**同一个坑踩三次**在旧口径下是 3 条
   * 相似 case、会被识别成一条规律;在 MemOS 那儿是 1 个 episode 重复,够不上 L2。
   * 而反复撞同一个坑本该走 failure-burst 生成「Avoid」反模式,跟「这类子任务该怎么做」
   * 是相反的两种东西,现在它们混在同一条通道里。
   *
   * 审计原文的要害:「两个完全不同的任务遇到同类子问题,才诱导出一条可迁移 L2」——
   * 最小值是 2,但要害在「跨任务」不在「2」。设 1 = 关闭该判据(旧行为,对照用)。
   */
  minDistinctSources: number;
}

const DEFAULT_CONFIG: PromotionConfig = {
  minCaseOccurrences: 3,
  caseSimilarityThreshold: 0.75,
  maxCandidates: 5,
  maxScanEntries: 20_000,
  maxBucketSize: 2_000,
  pageSize: 1_000,
  maxPatternProbes: 1_000,
  minDistinctSources: 2,
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
  truncateTextTo?: number,
): Promise<MemoryEntry[]> {
  const out: MemoryEntry[] = [];
  for (let offset = 0; out.length < maxEntries; offset += pageSize) {
    const requested = Math.min(pageSize, maxEntries - out.length);
    const page = await store.listPage({
      scopeFilter: [scope],
      category,
      limit: requested,
      offset,
    });
    for (const e of page) {
      // 扫描只用 text 的头部(extractName 首行 / summarize 前 80 字 / 聚类靠向量),
      // bridge 对话 case 全文很长,2 万条常驻能到 GB 级——截断防内存膨胀。
      out.push(
        truncateTextTo !== undefined && e.text.length > truncateTextTo
          ? { ...e, text: e.text.slice(0, truncateTextTo) }
          : e,
      );
    }
    if (page.length < requested) break;
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
 * A2: 抽 entry 的工具名供 verifier tool-coverage 用。
 * metadata.{caseMemory|workflowPattern}.tools 优先；fallback 解析正文 `Tools: a, b, c` 行。
 */
function extractToolsFromEntry(entry: MemoryEntry): string[] {
  try {
    const parsed: unknown = JSON.parse(entry.metadata || "{}");
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      for (const key of ["caseMemory", "workflowPattern"]) {
        const sub = obj[key];
        if (sub !== null && typeof sub === "object") {
          const tools = (sub as Record<string, unknown>).tools;
          if (Array.isArray(tools)) {
            return tools.filter((t): t is string => typeof t === "string" && t.length > 0);
          }
        }
      }
    }
  } catch { /* fallthrough to text parse */ }
  const m = entry.text.match(/(?:^|\n)Tools:\s*(.+)/);
  if (m) return m[1].split(",").map(t => t.trim()).filter(Boolean);
  return [];
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
// Source identity (MemOS-style episode counting)
// ---------------------------------------------------------------------------

/**
 * 一条记录来自「哪一次」——跨来源去重的 key。
 *
 * 三级取值，越靠前越可靠：
 *   1. `metadata.evidenceMemories` —— dream 合成产物指向的簇内真实源（synthesis-contract
 *      2026-08-23 起写入，已验证互不重复且无悬空）。同一批源出来的两条派生物
 *      签名相同 → 算一个来源，不是两个。
 *   2. `tags` 里的 `src:<sessionId 前 8 位>` —— shared-behaviors §5.3 要求 pivot 写入必带。
 *      2026-08-23 实测：`memory:pivot` 池 1699 条覆盖率 99.8%，其中 cases 260 条 100% 覆盖。
 *      ⚠️ 但全库只有 2.3%、`category=cases` 全库仅 1.2% —— **这个判据只在 pivot 池成立**，
 *      别拿去当全库口径。
 *   3. 兜底 `day:<scope>:<YYYY-MM-DD>` —— 没有来源指针时退到「同一天同一 scope 算一次」。
 *      粗，但比把同一次经历数成 N 次强。
 */
export function extractSourceKey(entry: Pick<MemoryEntry, "metadata" | "scope" | "timestamp">): string {
  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(entry.metadata || "{}");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch { /* fall through to day bucket */ }

  const evidence = meta.evidenceMemories;
  if (Array.isArray(evidence) && evidence.length > 0) {
    const ids = evidence.filter((v): v is string => typeof v === "string").sort();
    if (ids.length > 0) return `ev:${ids.join("|")}`;
  }

  if (Array.isArray(meta.tags)) {
    const src = meta.tags.find((t): t is string => typeof t === "string" && t.startsWith("src:"));
    if (src) return src;
  }

  const day = Number.isFinite(entry.timestamp) && entry.timestamp > 0
    ? new Date(entry.timestamp).toISOString().slice(0, 10)
    : "unknown";
  return `${UNKNOWN_SOURCE_PREFIX}${entry.scope}:${day}`;
}

/** 兜底 key 的前缀。带这个前缀 = 我们其实不知道它来自哪一次。 */
export const UNKNOWN_SOURCE_PREFIX = "day:";

/** 一组记录覆盖了几个不同来源。1 = 全部来自同一次经历。 */
export function countDistinctSources(
  entries: ReadonlyArray<Pick<MemoryEntry, "metadata" | "scope" | "timestamp">>,
): number {
  return new Set(entries.map(extractSourceKey)).size;
}

export type SourceVerdict =
  | { status: "ok"; distinctSources: number }
  | { status: "rejected"; distinctSources: number }
  /** 没有可信的来源指针 —— 不知道就不判，放行。 */
  | { status: "abstained" };

/**
 * 判一个簇是否来自足够多的不同经历。**带弃权路径**。
 *
 * 为什么要弃权而不是一律判：兜底 key 是「同 scope 同一天算一次」，而一天内解决三个
 * 不同问题写三条 case 是完全正常的——那是 3 个 episode，兜底会把它们并成 1 个，
 * 于是一条真规律被当成「同一个坑踩三次」拒掉。**误伤的代价比漏判高**：漏判只是
 * 维持现状（旧行为），误伤是把本来能升华的东西堵死，而且堵得无声无息。
 *
 * 所以判据只在**拿得到真来源指针**时生效。实际效果就是它只在 `memory:pivot` 池成立
 * （2026-08-23 实测该池 cases 100% 带 `src:`，而全库 cases 只有 1.2%）——
 * 这恰好是本方案的适用范围，不是巧合：§5.3 要求 pivot 写入必带来源指针，
 * 那条规矩本来就是为了让「回原文核对」成为可能，跨来源计数是它的另一个消费者。
 */
export function judgeDistinctSources(
  entries: ReadonlyArray<Pick<MemoryEntry, "metadata" | "scope" | "timestamp">>,
  minDistinctSources: number,
): SourceVerdict {
  if (minDistinctSources <= 1) {
    return { status: "ok", distinctSources: countDistinctSources(entries) };
  }
  const keys = entries.map(extractSourceKey);
  const known = keys.filter((k) => !k.startsWith(UNKNOWN_SOURCE_PREFIX));
  if (known.length === 0) return { status: "abstained" };

  // 有真指针的按真指针数；没指针的每条各算一次未知来源——不能让「不知道」
  // 白白顶上一个来源，也不能因为混了几条没指针的就整簇弃权。
  const distinctSources = new Set(keys).size;
  return distinctSources >= minDistinctSources
    ? { status: "ok", distinctSources }
    : { status: "rejected", distinctSources };
}

// ---------------------------------------------------------------------------
// Read evidence (Artel-style read-driven promotion)
// ---------------------------------------------------------------------------

/** Max confidence boost from read evidence. Saturates at 4 distinct readers. */
const READ_BOOST_MAX = 0.15;

/**
 * Aggregate read signals (accessCount / readerIds / distinctReaderCount, written
 * by AccessTracker on retrieval) across a candidate's source entries.
 * distinctReaders = max(union of readerIds, per-entry saturated count) — the
 * union undercounts once READER_ID_CAP saturates, the per-entry count covers that.
 */
export function aggregateReadEvidence(
  entries: Array<{ metadata?: string }>,
): { totalAccess: number; distinctReaders: number } {
  let totalAccess = 0;
  const readers = new Set<string>();
  let saturatedMax = 0;
  for (const e of entries) {
    try {
      const meta = JSON.parse(e.metadata || "{}") as Record<string, unknown>;
      if (typeof meta.accessCount === "number") totalAccess += meta.accessCount;
      if (Array.isArray(meta.readerIds)) {
        for (const r of meta.readerIds) if (typeof r === "string") readers.add(r);
      }
      if (typeof meta.distinctReaderCount === "number") {
        saturatedMax = Math.max(saturatedMax, meta.distinctReaderCount);
      }
    } catch { /* broken metadata → contributes nothing */ }
  }
  return { totalAccess, distinctReaders: Math.max(readers.size, saturatedMax) };
}

/** Blend read evidence into base confidence: +0..READ_BOOST_MAX, capped at 0.99.
 *  提权不设门槛（observe-before-enforce：先积累读证据，硬门槛等有生产数据再定）。 */
export function applyReadBoost(base: number, distinctReaders: number): number {
  const boost = Math.min(1, distinctReaders / 4) * READ_BOOST_MAX;
  return Math.min(0.99, base + boost);
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
  // cases/patterns 各自独立预算——共享预算时大库的 cases 会把 patterns 饿死
  // (首次生产 dry-run 实测:20000 cases 拉满后 patterns scanned=0,
  // pattern_to_skill 通道整个没跑)。
  const rawCases = await listAllByCategory(store, scope, "cases", cfg.maxScanEntries, cfg.pageSize, 2_000);
  const rawPatterns = await listAllByCategory(store, scope, "patterns", cfg.maxScanEntries, cfg.pageSize);

  const cases = rawCases.filter(isActive);
  const patterns = rawPatterns.filter(isActive);

  const result: PromotionScanResult = {
    candidates: [],
    scannedCases: cases.length,
    scannedPatterns: patterns.length,
    truncatedCases: 0,
    vectorlessSkipped: 0,
    rejectedSingleSource: 0,
    abstainedUnknownSource: 0,
    antiPatterns: [],
  };

  // 2. Cluster cases bucket-by-bucket (topicTag, untagged fallback)。
  //    向量按桶回填、桶毕即释,全库向量绝不常驻;分桶同时把 greedyCluster 的
  //    最坏 O(n²) 限制在 maxBucketSize 内。
  //    配额 per-channel:case 通道最多产 maxCandidates 个,pattern 通道同;
  //    最后合并按 confidence 排序截断——否则 case 候选多的库会让
  //    pattern_to_skill 通道在全局 break 处永远轮空(首次生产 dry-run 实测)。
  let caseCandidates = 0;
  if (cases.length >= cfg.minCaseOccurrences) {
    const { buckets, truncated } = bucketByTopic(cases, cfg.maxBucketSize);
    result.truncatedCases = truncated;

    for (const bucket of buckets.values()) {
      if (bucket.length < cfg.minCaseOccurrences) continue;
      if (caseCandidates >= cfg.maxCandidates) break;

      const vectorMap = await store.getVectors(bucket.map(e => e.id));
      const withVectors = bucket
        .map(e => ({ ...e, vector: vectorMap.get(e.id) ?? [] }))
        .filter(e => e.vector.length > 0);
      result.vectorlessSkipped += bucket.length - withVectors.length;
      if (withVectors.length < cfg.minCaseOccurrences) continue;

      const clusters = greedyCluster(withVectors, cfg.caseSimilarityThreshold);

      for (const cluster of clusters) {
        if (cluster.members.length < cfg.minCaseOccurrences) continue;
        if (caseCandidates >= cfg.maxCandidates) break;

        // 跨来源判据：条数够不代表是规律。同一次经历重复 N 条走的是 failure-burst
        // 反模式那条路，不是「这类子任务该怎么做」这条。拿不到来源指针时弃权放行。
        const sourceVerdict = judgeDistinctSources(cluster.members, cfg.minDistinctSources);
        if (sourceVerdict.status === "rejected") {
          result.rejectedSingleSource++;
          // P4:不晋升,但也不让它无声消失 —— 同一个坑重复本身就是要记的东西。
          // 仍然 continue,晋升判据分毫未动。
          result.antiPatterns.push({
            source: "single_source_burst",
            trigger: extractName(cluster.seed.text),
            antiPattern: summarizeCluster(cluster.members),
            occurrences: cluster.members.length,
            distinctSources: sourceVerdict.distinctSources,
            // Bayesian smoothing,与 candidates 的 confidence 同款,饱和于 1。
            evidenceStrength: cluster.members.length / (cluster.members.length + 2),
            sourceEntries: cluster.members.map(m => ({ id: m.id, text: m.text })),
            needsJudgement: ["preference", "verification"],
          });
          continue;
        }
        if (sourceVerdict.status === "abstained") result.abstainedUnknownSource++;
        const distinctSources = sourceVerdict.status === "ok" ? sourceVerdict.distinctSources : undefined;

        // Compute average intra-cluster similarity for scoring
        const avgSim = computeAverageIntraClusterSimilarity(cluster.members);

        caseCandidates++;
        const caseReadEvidence = aggregateReadEvidence(cluster.members);
        result.candidates.push({
          type: "case_to_pattern",
          sourceEntries: cluster.members.map(m => ({
            id: m.id,
            text: m.text,
            score: avgSim,
          })),
          suggestedName: extractName(cluster.seed.text),
          suggestedDescription: summarizeCluster(cluster.members),
          confidence: applyReadBoost(
            cluster.members.length / (cluster.members.length + 2), // Bayesian smoothing
            caseReadEvidence.distinctReaders,
          ),
          readEvidence: caseReadEvidence,
          distinctSources,
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
  const structuredPatterns = patterns
    .filter(p => hasStructuredSteps(p.text))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, cfg.maxPatternProbes);
  const patternVectors = structuredPatterns.length > 0
    ? await store.getVectors(structuredPatterns.map(p => p.id))
    : new Map<string, number[]>();
  const minSearchScore = 1 / (2 - cfg.caseSimilarityThreshold);

  let patternCandidates = 0;
  for (const pattern of structuredPatterns) {
    if (patternCandidates >= cfg.maxCandidates) break;
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

    // 同一判据也管 pattern→skill：MemOS 的 L2/L3→Skill 门就是「N 个独立 episode」。
    // 支撑证据全来自同一次经历时，这条 skill 学的是那一次，不是那一类。
    const patternVerdict = judgeDistinctSources(similarCases.map(h => h.entry), cfg.minDistinctSources);
    if (patternVerdict.status === "rejected") {
      result.rejectedSingleSource++;
      continue;
    }
    if (patternVerdict.status === "abstained") result.abstainedUnknownSource++;
    const patternDistinctSources = patternVerdict.status === "ok" ? patternVerdict.distinctSources : undefined;

    // A2: zero-LLM verifier — pattern 当 draft，supporting cases 当 evidence。
    // steps 传 [] 不是漏传：pattern.text 已含完整 Steps 块，resonance 用整段文本即可；
    // extractSteps(pattern.text) 仅用于下面的 suggestedImplementation 字段。
    const verification = verifyDraft(
      { tools: extractToolsFromEntry(pattern), summary: pattern.text, steps: [] },
      similarCases.map(h => ({ text: h.entry.text, tools: extractToolsFromEntry(h.entry) })),
    );

    patternCandidates++;
    const patternReadEvidence = aggregateReadEvidence([pattern, ...similarCases.map(h => h.entry)]);
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
      confidence: applyReadBoost(
        similarCases.length / (similarCases.length + 2),
        patternReadEvidence.distinctReaders,
      ),
      verification,
      readEvidence: patternReadEvidence,
      distinctSources: patternDistinctSources,
    });
  }

  // Sort: A2 verifier-passed first, then confidence desc, then truncate.
  // 失败候选保留披露但排后；截断优先砍失败候选，通过的不被挤掉(Codex 验证补充)。
  result.candidates.sort((a, b) => {
    const aOk = a.verification?.ok ?? true;
    const bOk = b.verification?.ok ?? true;
    if (aOk !== bOk) return aOk ? -1 : 1;
    return b.confidence - a.confidence;
  });
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
  if (result.abstainedUnknownSource > 0) {
    lines.push(
      `ℹ️ ${result.abstainedUnknownSource} cluster(s) 没有可信来源指针，跨来源判据已弃权放行`
      + `（这些 scope 里的条目没带 src: tag，判了就是瞎判）。`,
    );
  }
  if (result.rejectedSingleSource > 0) {
    lines.push(
      `⚠️ ${result.rejectedSingleSource} cluster(s) had enough entries but too few distinct sources`
      + ` — 同一次经历的重复不算规律（不晋升，改走下面的反模式清单）。`,
    );
  }

  // P4:被拒的簇在这里落地。只显示计数等于让信号消失在一个数字里 ——
  // 消费者看到的是这段文本,不是 result 对象。
  // `?.` 不是防御性编程的装饰:PromotionScanResult 是导出接口,旧调用方构造的对象
  // 没有这个字段,运行时会是 undefined(TS 编译期拦不住外部构造)。
  if (result.antiPatterns?.length) {
    lines.push(`\n🔁 ${result.antiPatterns.length} anti-pattern(s) — 同一个坑重复出现，不是规律但要记：\n`);
    for (const [i, ap] of result.antiPatterns.entries()) {
      lines.push(`### A${i + 1}. ${ap.trigger}`);
      lines.push(`重复 ${ap.occurrences} 次，来自 ${ap.distinctSources} 个来源（证据强度 ${(ap.evidenceStrength * 100).toFixed(0)}%）`);
      lines.push(`共性: ${ap.antiPattern}`);
      lines.push(`待补判断: ${ap.needsJudgement.join(" / ")} — 扫描器只出证据，「该怎么做」和「怎么确认没再犯」要人或 LLM 填。`);
      lines.push("");
    }
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
    lines.push(
      `Sources: ${c.sourceEntries.length} entries`
      + (c.distinctSources !== undefined ? ` from ${c.distinctSources} distinct source(s)` : ""),
    );
    if (c.readEvidence) {
      lines.push(`Read evidence: ${c.readEvidence.totalAccess} total reads, ${c.readEvidence.distinctReaders} distinct reader(s)`);
    }
    if (c.verification) {
      const v = c.verification;
      if (v.ok) {
        lines.push(`Verifier: ✓ pass (coverage ${(v.coverage * 100).toFixed(0)}%, resonance ${(v.resonance * 100).toFixed(0)}%)`);
      } else {
        const unmapped = v.unmappedTools.length > 0 ? `; unmapped tools: ${v.unmappedTools.join(", ")}` : "";
        lines.push(`Verifier: ⚠️ FAILED — ${v.reason ?? "?"} (coverage ${(v.coverage * 100).toFixed(0)}%, resonance ${(v.resonance * 100).toFixed(0)}%${unmapped})`);
      }
    }
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
