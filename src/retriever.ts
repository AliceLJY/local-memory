/**
 * Hybrid Retrieval System
 * Combines vector search + BM25 full-text search with RRF fusion
 */

import type { MemoryStore, MemorySearchResult } from "./store.js";
import type { Embedder } from "./embedder.js";
import { filterNoise } from "./noise-filter.js";
import { shouldSkipRetrieval } from "./adaptive-retrieval.js";
import { expandQuery } from "./query-expander.js";
import { type AccessTracker, computeHotnessScore, parseAccessMetadata } from "./access-tracker.js";
import { weibullDecay, resolveTier, isDecayExempt } from "./decay-engine.js";
import { logWarn } from "./stderr-log.js";
import { extractBoundaryMetadata, isDurableMemoryScope, isTranscriptScope } from "./memory-boundaries.js";
import type { TraceCollector } from "./retrieval-trace.js";
import { filterInterference } from "./rif.js";
import { FrequencyTracker } from "./frequency-tracker.js";
import { applyConfidenceWeight } from "./confidence-tracker.js";
import { deduplicateByVersionGroup } from "./version-manager.js";
import { isActiveMemory, recordAccess as recordEvolutionAccess, parseEvolution, computeDecayScore } from "./memory-evolution.js";
import {
  isMultiVectorEnabled,
  extractMultiVectorText,
  textOverlapScore,
  blendMultiVectorScores,
  adaptiveBlendConfig,
  tokenize,
} from "./multi-vector.js";
import { parseTemporalQuery, matchesTemporalConstraint, type TemporalConstraint } from "./temporal-parser.js";
import type { KGStore } from "./kg-store.js";
import { isKGModeEnabled } from "./kg-extractor.js";
import { detectEntities } from "./query-entity-detector.js";
import { buildGraph, pprTraverse } from "./ppr-traversal.js";
import { logInfo } from "./stderr-log.js";
import type { AuditLogger } from "./audit-log.js";

// ============================================================================
// Types & Configuration
// ============================================================================

export interface RetrievalConfig {
  mode: "hybrid" | "vector";
  vectorWeight: number;
  bm25Weight: number;
  minScore: number;
  rerank: "cross-encoder" | "lightweight" | "none";
  candidatePoolSize: number;
  /** Recency boost half-life in days (default: 14). Set 0 to disable. */
  recencyHalfLifeDays: number;
  /** Max recency boost factor (default: 0.10) */
  recencyWeight: number;
  /** Filter noise from results (default: true) */
  filterNoise: boolean;
  /** Reranker API key (enables cross-encoder reranking) */
  rerankApiKey?: string;
  /** Reranker model (default: jina-reranker-v3) */
  rerankModel?: string;
  /** Reranker API endpoint (default: https://api.jina.ai/v1/rerank). */
  rerankEndpoint?: string;
  /** Reranker provider format. Determines request/response shape and auth header.
   *  - "jina" (default): Authorization: Bearer, string[] documents, results[].relevance_score
   *  - "siliconflow": same format as jina (alias, for clarity)
   *  - "voyage": Authorization: Bearer, string[] documents, data[].relevance_score
   *  - "pinecone": Api-Key header, {text}[] documents, data[].score */
  rerankProvider?: "jina" | "siliconflow" | "voyage" | "pinecone" | "vllm";
  /**
   * Length normalization: penalize long entries that dominate via sheer keyword
   * density. Formula: score *= 1 / (1 + log2(charLen / anchor)).
   * anchor = reference length (default: 500 chars). Entries shorter than anchor
   * get a slight boost; longer entries get penalized progressively.
   * Set 0 to disable. (default: 300)
   */
  lengthNormAnchor: number;
  /**
   * Hard cutoff after rerank: discard results below this score.
   * Applied after all scoring stages (rerank, recency, importance, length norm).
   * Higher = fewer but more relevant results. (default: 0.35)
   */
  hardMinScore: number;
  /**
   * Time decay half-life in days. Entries older than this lose score.
   * Different from recencyBoost (additive bonus for new entries):
   * this is a multiplicative penalty for old entries.
   * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
   * At halfLife days: ~0.68x. At 2*halfLife: ~0.59x. At 4*halfLife: ~0.52x.
   * Set 0 to disable. (default: 60)
   */
  timeDecayHalfLifeDays: number;
  /**
   * Hotness blend weight. Blends access-frequency hotness into final score.
   * Formula: final = score * (1-alpha) + hotness * alpha.
   * 0 = disabled (default), 0.15 = recommended.
   */
  hotnessWeight: number;
  /**
   * Per-category score thresholds. When a result's category matches a key,
   * that threshold is used instead of hardMinScore. Categories not listed
   * fall back to hardMinScore. (default: see DEFAULT_CATEGORY_MIN_SCORES)
   */
  categoryMinScores?: Record<string, number>;
  /** Enable Retrieval Interference Filter (RIF) — demotes near-duplicate weak results. Default: false. */
  enableRIF?: boolean;
  /** RIF cosine similarity threshold for "near-duplicate" (default: 0.85). */
  rifThreshold?: number;
  /** RIF score ratio: demote if score < ratio * stronger result's score (default: 0.80). */
  rifScoreRatio?: number;
}

export interface RetrievalContext {
  query: string;
  limit: number;
  scopeFilter?: string[];
  category?: string;
  /** Origin of retrieval call. Access reinforcement is only applied for "manual"
   *  calls to prevent auto-recall from strengthening noise memories.
   *  Defaults to "manual" when unset (backward-compatible). */
  source?: "manual" | "auto-recall" | "cli";
  /** When false (default), archived records are excluded from results. */
  includeArchived?: boolean;
  /** Optional trace collector for per-stage pipeline observability. */
  trace?: TraceCollector;
  /** Enable KG graph traversal (PPR) as an additional retrieval signal. */
  graph?: boolean;
}

export interface RetrievalResult extends MemorySearchResult {
  sources: {
    vector?: { score: number; rank: number };
    bm25?: { score: number; rank: number };
    graph?: { score: number; rank: number };
    fused?: { score: number };
    reranked?: { score: number };
  };
}

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Per-category minimum scores. Lower threshold = easier to recall.
 * profile/preferences: low bar because identity & preferences are almost always relevant.
 * cases/patterns: higher bar because they are more specific and noisy matches are costly.
 */
export const DEFAULT_CATEGORY_MIN_SCORES: Record<string, number> = {
  profile: 0.25,
  preferences: 0.25,
  entities: 0.30,
  events: 0.35,
  cases: 0.40,
  patterns: 0.45,
};

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  mode: "hybrid",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  minScore: 0.3,
  rerank: "cross-encoder",
  candidatePoolSize: 20,
  recencyHalfLifeDays: 14,
  recencyWeight: 0.10,
  filterNoise: true,
  rerankModel: "jina-reranker-v3",
  rerankEndpoint: "https://api.jina.ai/v1/rerank",
  lengthNormAnchor: 500,
  hardMinScore: 0.35,
  timeDecayHalfLifeDays: 60,
  hotnessWeight: 0,
};

// ============================================================================
// Utility Functions
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 0;
  return Math.min(1, Math.max(0, value));
}

/** P0.1: Short query detection — ≤ 4 tokens (CJK chars count as 1 token each). */
const SHORT_QUERY_TOKEN_THRESHOLD = 4;

function isShortQuery(query: string): boolean {
  return tokenize(query).length <= SHORT_QUERY_TOKEN_THRESHOLD;
}

/** P0.1: Minimum score discount for short queries to widen the candidate pool. */
const SHORT_QUERY_MIN_SCORE_FACTOR = 0.6;

/** P0.1: Anchor boost factor — how much a perfect anchor match boosts score. */
const ANCHOR_BOOST_MAX = 0.25;

/**
 * P0.1: Boost scores for candidates whose metadata.anchor matches the query.
 * Uses textOverlapScore (token coverage + density) — same as multi-vector blend.
 * Short queries benefit most because anchor text is also short (≤80 chars).
 */
function applyAnchorBoost(results: RetrievalResult[], query: string): RetrievalResult[] {
  if (results.length === 0) return results;
  return results.map(r => {
    const meta = parseMetadata(r.entry.metadata);
    const anchor = meta.anchor;
    if (typeof anchor !== "string" || !anchor) return r;
    const overlap = textOverlapScore(query, anchor);
    if (overlap <= 0) return r;
    // Boost proportional to overlap quality, capped at ANCHOR_BOOST_MAX
    const boost = 1 + overlap * ANCHOR_BOOST_MAX;
    return { ...r, score: r.score * boost };
  });
}

function parseMetadata(raw?: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ============================================================================
// Rerank Provider Adapters
// ============================================================================

type RerankProvider = "jina" | "siliconflow" | "voyage" | "pinecone" | "vllm";

interface RerankItem { index: number; score: number }

/** Build provider-specific request headers and body */
function buildRerankRequest(
  provider: RerankProvider,
  apiKey: string,
  model: string,
  query: string,
  documents: string[],
  topN: number,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  switch (provider) {
    case "pinecone":
      return {
        headers: {
          "Content-Type": "application/json",
          "Api-Key": apiKey,
          "X-Pinecone-API-Version": "2024-10",
        },
        body: {
          model,
          query,
          documents: documents.map(text => ({ text })),
          top_n: topN,
          rank_fields: ["text"],
        },
      };
    case "voyage":
      return {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents,
          // Voyage uses top_k (not top_n) to limit reranked outputs.
          top_k: topN,
        },
      };
    case "vllm":
      // Docker Model Runner / vLLM: no auth required, runs locally
      return {
        headers: {
          "Content-Type": "application/json",
        },
        body: {
          model,
          query,
          documents,
          top_n: topN,
        },
      };
    case "siliconflow":
    case "jina":
    default:
      return {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents,
          top_n: topN,
        },
      };
  }
}

/** Parse provider-specific response into unified format */
function parseRerankResponse(
  provider: RerankProvider,
  data: Record<string, unknown>,
): RerankItem[] | null {
  const parseItems = (
    items: unknown,
    scoreKeys: Array<"score" | "relevance_score">,
  ): RerankItem[] | null => {
    if (!Array.isArray(items)) return null;
    const parsed: RerankItem[] = [];
    for (const raw of items as Array<Record<string, unknown>>) {
      const index = typeof raw?.index === "number" ? raw.index : Number(raw?.index);
      if (!Number.isFinite(index)) continue;
      let score: number | null = null;
      for (const key of scoreKeys) {
        const value = raw?.[key];
        const n = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(n)) {
          score = n;
          break;
        }
      }
      if (score === null) continue;
      parsed.push({ index, score });
    }
    return parsed.length > 0 ? parsed : null;
  };

  switch (provider) {
    case "pinecone": {
      // Pinecone: usually { data: [{ index, score, ... }] }
      // Also tolerate results[] with score/relevance_score for robustness.
      return (
        parseItems(data.data, ["score", "relevance_score"]) ??
        parseItems(data.results, ["score", "relevance_score"])
      );
    }
    case "voyage": {
      // Voyage: usually { data: [{ index, relevance_score }] }
      // Also tolerate results[] for compatibility across gateways.
      return (
        parseItems(data.data, ["relevance_score", "score"]) ??
        parseItems(data.results, ["relevance_score", "score"])
      );
    }
    case "vllm":
    case "siliconflow":
    case "jina":
    default: {
      // Jina / SiliconFlow / vLLM: usually { results: [{ index, relevance_score }] }
      // Also tolerate data[] for compatibility across gateways.
      return (
        parseItems(data.results, ["relevance_score", "score"]) ??
        parseItems(data.data, ["relevance_score", "score"])
      );
    }
  }
}

// Cosine similarity for reranking fallback
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vector dimensions must match for cosine similarity");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const norm = Math.sqrt(normA) * Math.sqrt(normB);
  return norm === 0 ? 0 : dotProduct / norm;
}

// ============================================================================
// Memory Retriever
// ============================================================================

export class MemoryRetriever {
  private accessTracker?: AccessTracker;
  private kgStore?: KGStore;
  private frequencyTracker?: FrequencyTracker;
  private auditLogger?: AuditLogger;
  /**
   * Session-scoped suppression list (dopamine-inspired "do not disturb").
   * IDs in this set get a score penalty during retrieval but are NOT deleted.
   * Call clearSessionSuppression() to reset (e.g. at session end).
   */
  private sessionSuppressed = new Set<string>();

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG
  ) {}

  /** Attach an AccessTracker to enable reinforcement-based decay. */
  setAccessTracker(tracker: AccessTracker): void {
    this.accessTracker = tracker;
  }

  /** Attach a KGStore to enable graph-based retrieval (PPR). */
  setKGStore(kgStore: KGStore): void {
    this.kgStore = kgStore;
  }

  /** P0.2: Attach a FrequencyTracker for hit-count based boosting. */
  setFrequencyTracker(tracker: FrequencyTracker): void {
    this.frequencyTracker = tracker;
  }

  /** F-1: Attach an AuditLogger for recording retrieve operations. */
  setAuditLogger(logger: AuditLogger): void {
    this.auditLogger = logger;
  }

  /** Suppress a memory ID for the current session (score × 0.3). */
  suppressForSession(id: string): void {
    this.sessionSuppressed.add(id);
  }

  /** Clear all session suppressions. */
  clearSessionSuppression(): void {
    this.sessionSuppressed.clear();
  }

  /** Resolve the minimum score for a given category, falling back to hardMinScore.
   *  P0.1: When shortQuery is true, thresholds are lowered to widen the candidate pool. */
  private minScoreFor(category: string, shortQuery = false): number {
    const map = this.config.categoryMinScores ?? DEFAULT_CATEGORY_MIN_SCORES;
    const base = map[category] ?? this.config.hardMinScore;
    return shortQuery ? base * SHORT_QUERY_MIN_SCORE_FACTOR : base;
  }

  async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
    const { query, limit, scopeFilter, category, includeArchived, trace, graph } = context;
    const safeLimit = clampInt(limit, 1, 20);

    // Adaptive retrieval: skip trivial queries to save embedding API calls
    if (shouldSkipRetrieval(query)) {
      return [];
    }

    let results: RetrievalResult[];

    // For vector-only mode, use legacy behavior
    if (this.config.mode === "vector" || !this.store.hasFtsSupport) {
      results = await this.vectorOnlyRetrieval(query, safeLimit, scopeFilter, category, includeArchived, trace);
    } else {
      // Hybrid retrieval with vector + BM25 + RRF fusion (+ optional PPR graph)
      results = await this.hybridRetrieval(query, safeLimit, scopeFilter, category, includeArchived, trace, graph);
    }

    // Record access for returned results (async, non-blocking).
    // Only reinforce on manual retrieval — auto-recall must not strengthen noise.
    // Tier 3.2: pass similarity scores for novelty gating — only novel retrievals
    // (high query-result distance) trigger access reinforcement.
    if (this.accessTracker && results.length > 0 && context.source !== "auto-recall") {
      this.accessTracker.recordAccess(
        results.map(r => r.entry.id),
        results.map(r => r.score),
      );
    }

    // P0.2: Record frequency hits for returned results (manual queries only)
    if (this.frequencyTracker && results.length > 0 && context.source !== "auto-recall") {
      this.frequencyTracker.recordHits(results.map(r => r.entry.id));
    }

    // A-3: Record evolution access counts (async, non-blocking)
    if (results.length > 0 && context.source !== "auto-recall" && this.store.update) {
      Promise.resolve().then(async () => {
        for (const r of results) {
          try {
            const updated = recordEvolutionAccess(r.entry.metadata);
            await this.store.update!(r.entry.id, { metadata: updated });
          } catch { /* evolution tracking must never block retrieval */ }
        }
      });
    }

    // F-1: Audit log — record retrieve operation (non-blocking, silent on failure)
    try {
      this.auditLogger?.log({
        operation: "retrieve",
        scope: context.scopeFilter?.[0],
        actor: context.source || "manual",
        details: `query="${context.query.slice(0, 80)}" hits=${results.length}`,
      });
    } catch {
      // Audit must never block retrieval
    }

    return results;
  }

  private async vectorOnlyRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
    includeArchived?: boolean,
    trace?: TraceCollector,
  ): Promise<RetrievalResult[]> {
    // Temporal reasoning for vector-only mode
    const temporal = parseTemporalQuery(query);
    const searchQuery = temporal.constraint ? temporal.cleanedQuery : query;

    trace?.startStage("vector_search", 0);
    const queryVector = await this.embedder.embedQuery(searchQuery);
    // P0.1: Lower minScore for short queries
    const shortQ = isShortQuery(searchQuery);
    const vectorMinScore = shortQ
      ? this.config.minScore * SHORT_QUERY_MIN_SCORE_FACTOR
      : this.config.minScore;
    const results = await this.store.vectorSearch(queryVector, limit, vectorMinScore, scopeFilter);
    trace?.endStage(results.length, results.map(r => r.score));

    // Filter by category if specified
    const afterCategory = category
      ? results.filter(r => r.entry.category === category)
      : results;

    // Filter archived records (default: exclude)
    const afterArchive = includeArchived
      ? afterCategory
      : afterCategory.filter(r => parseMetadata(r.entry.metadata).archived !== true);

    // Temporal filter
    const filtered = temporal.constraint
      ? afterArchive.filter(r => matchesTemporalConstraint(r.entry.timestamp, temporal.constraint!))
      : afterArchive;

    const mapped = filtered.map((result, index) => ({
      ...result,
      sources: {
        vector: { score: result.score, rank: index + 1 },
      },
    } as RetrievalResult));

    // P0.1: Anchor boost for vector-only path
    const anchorBoosted = applyAnchorBoost(mapped, searchQuery);

    trace?.startStage("recency_boost", anchorBoosted.length);
    const boosted = this.applyRecencyBoost(anchorBoosted);
    trace?.endStage(boosted.length, boosted.map(r => r.score));

    trace?.startStage("importance_weight", boosted.length);
    const weighted = this.applyImportanceWeight(boosted);
    trace?.endStage(weighted.length, weighted.map(r => r.score));

    trace?.startStage("confidence_weight", weighted.length);
    const confidenceWeighted = this.applyConfidence(weighted);
    trace?.endStage(confidenceWeighted.length, confidenceWeighted.map(r => r.score));

    trace?.startStage("boundary_weight", confidenceWeighted.length);
    const boundaryWeighted = this.applyBoundaryWeight(confidenceWeighted);
    trace?.endStage(boundaryWeighted.length, boundaryWeighted.map(r => r.score));

    trace?.startStage("asset_type_weight", boundaryWeighted.length);
    const assetWeighted = this.applyAssetTypeWeight(boundaryWeighted);
    trace?.endStage(assetWeighted.length, assetWeighted.map(r => r.score));

    trace?.startStage("length_norm", assetWeighted.length);
    const lengthNormalized = this.applyLengthNormalization(assetWeighted);
    trace?.endStage(lengthNormalized.length, lengthNormalized.map(r => r.score));

    trace?.startStage("time_decay", lengthNormalized.length);
    const timeDecayed = this.applyTimeDecay(lengthNormalized);
    trace?.endStage(timeDecayed.length, timeDecayed.map(r => r.score));

    // B-1/E-1: Evolution decay blend — boost memories with high composite decay score
    const evolutionBlended = this.applyEvolutionDecayBlend(timeDecayed);

    // E-1: Access count boost — memories retrieved more often get a score nudge
    const accessBoosted = this.applyAccessCountBoost(evolutionBlended);

    // Hotness blend: boost frequently + recently accessed memories
    trace?.startStage("hotness_blend", accessBoosted.length);
    const hotnessBlended = this.applyHotnessBlend(accessBoosted);
    trace?.endStage(hotnessBlended.length, hotnessBlended.map(r => r.score));

    // P0.2: Frequency boost — repeatedly retrieved memories score higher
    trace?.startStage("frequency_boost", hotnessBlended.length);
    const frequencyBoosted = this.applyFrequencyBoost(hotnessBlended);
    trace?.endStage(frequencyBoosted.length, frequencyBoosted.map(r => r.score));

    // Session suppression: temporarily penalize "do not disturb" memories
    const afterSuppression = this.applySessionSuppression(frequencyBoosted);

    trace?.startStage("hard_min_score", afterSuppression.length);
    const hardFiltered = afterSuppression.filter(r => r.score >= this.minScoreFor(r.entry.category, shortQ));
    trace?.endStage(hardFiltered.length, hardFiltered.map(r => r.score));

    // Evolution status filter: exclude superseded/archived/consolidated memories
    const evolutionFiltered = includeArchived
      ? hardFiltered
      : hardFiltered.filter(r => isActiveMemory(r.entry.metadata));

    trace?.startStage("noise_filter", evolutionFiltered.length);
    const denoised = this.config.filterNoise
      ? filterNoise(evolutionFiltered, r => r.entry.text)
      : evolutionFiltered;
    trace?.endStage(denoised.length, denoised.map(r => r.score));

    // RIF: demote near-duplicate weak results to improve diversity
    const afterRif = this.config.enableRIF
      ? filterInterference(denoised, this.config.rifThreshold ?? 0.85, this.config.rifScoreRatio ?? 0.80)
      : denoised;

    // MMR deduplication: avoid top-k filled with near-identical memories
    trace?.startStage("mmr_diversity", afterRif.length);
    const deduplicated = this.applyMMRDiversity(afterRif);
    trace?.endStage(deduplicated.length, deduplicated.map(r => r.score));

    // Tier 3.3: Version group dedup — keep only the top-ranked version per group
    const versionDeduped = deduplicateByVersionGroup(deduplicated);

    trace?.startStage("final_limit", versionDeduped.length);
    const final = versionDeduped.slice(0, limit);
    trace?.endStage(final.length, final.map(r => r.score));

    return final;
  }

  private async hybridRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
    includeArchived?: boolean,
    trace?: TraceCollector,
    graph?: boolean,
  ): Promise<RetrievalResult[]> {
    const candidatePoolSize = Math.max(this.config.candidatePoolSize, limit * 2);

    // Temporal reasoning: extract time constraint and clean query for semantic search
    const temporal = parseTemporalQuery(query);
    const searchQuery = temporal.constraint ? temporal.cleanedQuery : query;

    // Compute query embedding once, reuse for vector search + reranking
    const queryVector = await this.embedder.embedQuery(searchQuery);

    // Run vector, BM25, and optionally PPR searches in parallel
    const useGraph = graph && isKGModeEnabled() && this.kgStore;
    const pprPromise = useGraph
      ? this.runPPRSearch(query, scopeFilter?.[0], trace)
      : Promise.resolve([] as RetrievalResult[]);

    trace?.startStage("vector_search", 0);
    const [vectorResults, bm25Results, pprResults] = await Promise.all([
      this.runVectorSearch(queryVector, candidatePoolSize, scopeFilter, category, includeArchived),
      this.runBM25Search(expandQuery(searchQuery), candidatePoolSize, scopeFilter, category, includeArchived),
      pprPromise,
    ]);
    trace?.endStage(vectorResults.length, vectorResults.map(r => r.score));

    trace?.startStage("bm25_search", 0);
    trace?.endStage(bm25Results.length, bm25Results.map(r => r.score));

    // Fuse results using weighted score fusion (async: validates BM25-only entries exist in store)
    const shortQ = isShortQuery(searchQuery);
    trace?.startStage("rrf_fusion", vectorResults.length + bm25Results.length + pprResults.length);
    const fusedResults = await this.fuseResults(vectorResults, bm25Results, pprResults, shortQ);
    trace?.endStage(fusedResults.length, fusedResults.map(r => r.score));

    // Temporal filter: when query has a time constraint, remove non-matching candidates
    trace?.startStage("temporal_filter", fusedResults.length);
    const temporalFiltered = temporal.constraint
      ? fusedResults.filter(r => matchesTemporalConstraint(r.entry.timestamp, temporal.constraint!))
      : fusedResults;
    trace?.endStage(temporalFiltered.length, temporalFiltered.map(r => r.score));

    // Multi-vector L0/L1 blend: re-score candidates using metadata abstracts/overviews
    trace?.startStage("multi_vector_blend", temporalFiltered.length);
    const multiVecBlended = this.applyMultiVectorBlend(temporalFiltered, searchQuery);
    trace?.endStage(multiVecBlended.length, multiVecBlended.map(r => r.score));

    // P0.1: Anchor boost — short query terms matching short anchor text
    trace?.startStage("anchor_boost", multiVecBlended.length);
    const anchorBoosted = applyAnchorBoost(multiVecBlended, searchQuery);
    trace?.endStage(anchorBoosted.length, anchorBoosted.map(r => r.score));

    // Apply minimum score threshold
    trace?.startStage("min_score_filter", anchorBoosted.length);
    // P0.1: Lower minScore for short queries to widen the candidate pool
    const effectiveMinScore = isShortQuery(searchQuery)
      ? this.config.minScore * SHORT_QUERY_MIN_SCORE_FACTOR
      : this.config.minScore;
    const filtered = anchorBoosted.filter(r => r.score >= effectiveMinScore);
    trace?.endStage(filtered.length, filtered.map(r => r.score));

    // Rerank if enabled
    trace?.startStage("rerank", filtered.length);
    const reranked = this.config.rerank !== "none"
      ? await this.rerankResults(query, queryVector, filtered.slice(0, limit * 2))
      : filtered;
    trace?.endStage(reranked.length, reranked.map(r => r.score));

    // Apply temporal re-ranking (recency boost)
    trace?.startStage("recency_boost", reranked.length);
    const temporalReranked = this.applyRecencyBoost(reranked);
    trace?.endStage(temporalReranked.length, temporalReranked.map(r => r.score));

    // Apply importance weighting
    trace?.startStage("importance_weight", temporalReranked.length);
    const importanceWeighted = this.applyImportanceWeight(temporalReranked);
    trace?.endStage(importanceWeighted.length, importanceWeighted.map(r => r.score));

    // Viewpoint confidence: penalize corrected/contradicted memories
    trace?.startStage("confidence_weight", importanceWeighted.length);
    const confidenceWeighted = this.applyConfidence(importanceWeighted);
    trace?.endStage(confidenceWeighted.length, confidenceWeighted.map(r => r.score));

    // Prefer higher-authority durable memories over raw evidence when scores are close.
    trace?.startStage("boundary_weight", confidenceWeighted.length);
    const boundaryWeighted = this.applyBoundaryWeight(confidenceWeighted);
    trace?.endStage(boundaryWeighted.length, boundaryWeighted.map(r => r.score));

    // Separate pinned assets from synthesized briefs.
    trace?.startStage("asset_type_weight", boundaryWeighted.length);
    const assetWeighted = this.applyAssetTypeWeight(boundaryWeighted);
    trace?.endStage(assetWeighted.length, assetWeighted.map(r => r.score));

    // Apply length normalization (penalize long entries dominating via keyword density)
    trace?.startStage("length_norm", assetWeighted.length);
    const lengthNormalized = this.applyLengthNormalization(assetWeighted);
    trace?.endStage(lengthNormalized.length, lengthNormalized.map(r => r.score));

    // Apply time decay (penalize stale entries)
    trace?.startStage("time_decay", lengthNormalized.length);
    const timeDecayed = this.applyTimeDecay(lengthNormalized);
    trace?.endStage(timeDecayed.length, timeDecayed.map(r => r.score));

    // B-1/E-1: Evolution decay blend — boost memories with high composite decay score
    const evolutionBlended = this.applyEvolutionDecayBlend(timeDecayed);

    // E-1: Access count boost — memories retrieved more often get a score nudge
    const accessBoosted = this.applyAccessCountBoost(evolutionBlended);

    // Hotness blend: boost frequently + recently accessed memories
    trace?.startStage("hotness_blend", accessBoosted.length);
    const hotnessBlended = this.applyHotnessBlend(accessBoosted);
    trace?.endStage(hotnessBlended.length, hotnessBlended.map(r => r.score));

    // P0.2: Frequency boost — repeatedly retrieved memories score higher
    trace?.startStage("frequency_boost", hotnessBlended.length);
    const frequencyBoosted = this.applyFrequencyBoost(hotnessBlended);
    trace?.endStage(frequencyBoosted.length, frequencyBoosted.map(r => r.score));

    // Hard minimum score cutoff (post all scoring stages)
    // P0.1: lower thresholds for short queries (shortQ declared earlier for fuseResults)
    trace?.startStage("hard_min_score", frequencyBoosted.length);
    const hardFiltered = frequencyBoosted.filter(r => r.score >= this.minScoreFor(r.entry.category, shortQ));
    trace?.endStage(hardFiltered.length, hardFiltered.map(r => r.score));

    // Evolution status filter: exclude superseded/archived/consolidated memories
    const evolutionFiltered = includeArchived
      ? hardFiltered
      : hardFiltered.filter(r => isActiveMemory(r.entry.metadata));

    // Filter noise
    trace?.startStage("noise_filter", evolutionFiltered.length);
    const denoised = this.config.filterNoise
      ? filterNoise(evolutionFiltered, r => r.entry.text)
      : evolutionFiltered;
    trace?.endStage(denoised.length, denoised.map(r => r.score));

    // RIF: demote near-duplicate weak results to improve diversity
    const afterRif = this.config.enableRIF
      ? filterInterference(denoised, this.config.rifThreshold ?? 0.85, this.config.rifScoreRatio ?? 0.80)
      : denoised;

    // MMR deduplication: avoid top-k filled with near-identical memories
    trace?.startStage("mmr_diversity", afterRif.length);
    const deduplicated = this.applyMMRDiversity(afterRif);
    trace?.endStage(deduplicated.length, deduplicated.map(r => r.score));

    // Tier 3.3: Version group dedup — keep only the top-ranked version per group
    const versionDeduped = deduplicateByVersionGroup(deduplicated);

    trace?.startStage("final_limit", versionDeduped.length);
    const final = versionDeduped.slice(0, limit);
    trace?.endStage(final.length, final.map(r => r.score));

    return final;
  }

  private async runVectorSearch(
    queryVector: number[],
    limit: number,
    scopeFilter?: string[],
    category?: string,
    includeArchived?: boolean,
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    let results: MemorySearchResult[];
    try {
      results = await this.store.vectorSearch(queryVector, limit, 0.1, scopeFilter);
    } catch (err) {
      // Fail-open: log warning and continue with empty results (backport from v1.0.30)
      logWarn("vectorSearch failed, continuing with empty results:", err);
      results = [];
    }

    // Filter by category if specified
    const afterCategory = category
      ? results.filter(r => r.entry.category === category)
      : results;

    // Filter archived records (default: exclude)
    const filtered = includeArchived
      ? afterCategory
      : afterCategory.filter(r => parseMetadata(r.entry.metadata).archived !== true);

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private async runBM25Search(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
    includeArchived?: boolean,
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    const results = await this.store.bm25Search(query, limit, scopeFilter);

    // Filter by category if specified
    const afterCategory = category
      ? results.filter(r => r.entry.category === category)
      : results;

    // Filter archived records (default: exclude)
    const filtered = includeArchived
      ? afterCategory
      : afterCategory.filter(r => parseMetadata(r.entry.metadata).archived !== true);

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  /**
   * Run PPR graph traversal: detect entities -> BFS neighborhood -> PPR -> map to MemoryEntry.
   * Returns RetrievalResult[] with graph source scores.
   */
  private async runPPRSearch(
    query: string,
    scope?: string,
    trace?: TraceCollector,
  ): Promise<RetrievalResult[]> {
    if (!this.kgStore) return [];

    try {
      trace?.startStage("ppr_entity_detect", 0);
      const detected = await detectEntities(query, this.kgStore, scope);
      trace?.endStage(detected.entities.length, []);

      if (detected.entities.length === 0) return [];

      // BFS neighborhood from KG
      trace?.startStage("ppr_neighborhood", detected.entities.length);
      const hopLimit = detected.isMultiHop ? 3 : 2;
      const neighborhood = await this.kgStore.getNeighborhood(detected.entities, hopLimit, scope);
      trace?.endStage(neighborhood.length, []);

      if (neighborhood.length === 0) return [];

      // Run PPR
      trace?.startStage("ppr_traverse", neighborhood.length);
      const graph = buildGraph(neighborhood);
      const pprResults = pprTraverse(graph, detected.entities, { hopLimit, topK: 20 });
      trace?.endStage(pprResults.length, pprResults.map(r => r.score));

      if (pprResults.length === 0) return [];

      // Collect all source_memory_ids from triples related to PPR-scored entities
      const entityScoreMap = new Map(pprResults.map(r => [r.entity, r.score]));
      const memoryScoreMap = new Map<string, number>();

      for (const nr of neighborhood) {
        for (const triple of nr.triples) {
          const subjectScore = entityScoreMap.get(triple.subject) ?? 0;
          const objectScore = entityScoreMap.get(triple.object) ?? 0;
          const tripleScore = Math.max(subjectScore, objectScore) * triple.confidence;

          if (tripleScore > 0 && triple.source_memory_id) {
            const existing = memoryScoreMap.get(triple.source_memory_id) ?? 0;
            memoryScoreMap.set(triple.source_memory_id, Math.max(existing, tripleScore));
          }
        }
      }

      // Fetch memory entries for the top scored memories
      const sortedMemories = [...memoryScoreMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);

      const results: RetrievalResult[] = [];
      let rank = 0;
      for (const [memId, score] of sortedMemories) {
        const entry = await this.store.getById(memId);
        if (!entry) continue;
        rank++;
        results.push({
          entry,
          score,
          sources: {
            graph: { score, rank },
          },
        });
      }

      logInfo(`[PPR] ${detected.entities.length} seed entities -> ${pprResults.length} PPR nodes -> ${results.length} memories`);
      return results;
    } catch (err) {
      logWarn(`[PPR] graph traversal failed, continuing without graph results: ${String(err)}`);
      return [];
    }
  }

  private async fuseResults(
    vectorResults: Array<MemorySearchResult & { rank: number }>,
    bm25Results: Array<MemorySearchResult & { rank: number }>,
    graphResults: RetrievalResult[] = [],
    shortQuery: boolean = false,
  ): Promise<RetrievalResult[]> {
    // Adaptive weights: short queries (≤4 tokens) favor BM25 for exact keyword matching.
    // For normal queries, use config weights directly.
    const vW = shortQuery
      ? this.config.vectorWeight * 0.7
      : this.config.vectorWeight;
    const bW = shortQuery
      ? Math.min(this.config.bm25Weight * 1.5, 0.6)
      : this.config.bm25Weight;
    const totalW = vW + bW;

    // Create maps for quick lookup
    const vectorMap = new Map<string, MemorySearchResult & { rank: number }>();
    const bm25Map = new Map<string, MemorySearchResult & { rank: number }>();
    const graphMap = new Map<string, RetrievalResult>();

    vectorResults.forEach(result => {
      vectorMap.set(result.entry.id, result);
    });

    bm25Results.forEach(result => {
      bm25Map.set(result.entry.id, result);
    });

    graphResults.forEach(result => {
      graphMap.set(result.entry.id, result);
    });

    // Get all unique document IDs
    const allIds = new Set([...vectorMap.keys(), ...bm25Map.keys(), ...graphMap.keys()]);

    // Calculate fused scores using configurable weights
    const fusedResults: RetrievalResult[] = [];

    for (const id of allIds) {
      const vectorResult = vectorMap.get(id);
      const bm25Result = bm25Map.get(id);
      const graphResult = graphMap.get(id);

      // FIX(#15): BM25-only results may be "ghost" entries whose vector data was
      // deleted but whose FTS index entry lingers until the next index rebuild.
      // Validate that the entry actually exists in the store before including it.
      if (!vectorResult && !graphResult && bm25Result) {
        try {
          const exists = await this.store.hasId(id);
          if (!exists) continue; // Skip ghost entry
        } catch {
          // If hasId fails, keep the result (fail-open)
        }
      }

      // Use the result with more complete data (prefer vector > graph > BM25)
      const baseResult = vectorResult || graphResult || bm25Result!;

      const vectorScore = vectorResult ? vectorResult.score : 0;
      const bm25Score = bm25Result ? bm25Result.score : 0;
      const graphScore = graphResult?.sources.graph?.score ?? 0;

      let fusedScore: number;
      if (vectorResult && bm25Result) {
        // Both signals agree: weighted average + 5% dual-match confirmation bonus.
        // Graph hit adds up to 15% on top.
        fusedScore = clamp01(
          ((vW * vectorScore + bW * bm25Score) / totalW) * 1.05 + (graphScore * 0.15),
          0.1,
        );
      } else if (vectorResult) {
        // Vector only: semantic match, graph as bonus
        fusedScore = clamp01(vectorScore + (graphScore * 0.15), 0.1);
      } else if (graphResult) {
        // Graph only: entity-relationship match, BM25 as bonus
        fusedScore = clamp01(graphScore + (bm25Score > 0 ? 0.10 : 0), 0.1);
      } else {
        // BM25 only: exact keyword match without semantic confirmation.
        // Short queries get a small boost since BM25 is more reliable for exact terms.
        const bm25OnlyBoost = shortQuery ? 1.15 : 1.0;
        fusedScore = clamp01(bm25Score * bm25OnlyBoost, 0.1);
      }

      fusedResults.push({
        entry: baseResult.entry,
        score: fusedScore,
        sources: {
          vector: vectorResult ? { score: vectorResult.score, rank: vectorResult.rank } : undefined,
          bm25: bm25Result ? { score: bm25Result.score, rank: bm25Result.rank } : undefined,
          graph: graphResult?.sources.graph,
          fused: { score: fusedScore },
        },
      });
    }

    // Sort by fused score descending
    return fusedResults.sort((a, b) => b.score - a.score);
  }

  /**
   * Rerank results using cross-encoder API (Jina, Pinecone, or compatible).
   * Falls back to cosine similarity if API is unavailable or fails.
   */
  private async rerankResults(query: string, queryVector: number[], results: RetrievalResult[]): Promise<RetrievalResult[]> {
    if (results.length === 0) {
      return results;
    }

    // Try cross-encoder rerank via configured provider API
    const provider = this.config.rerankProvider || "jina";
    const needsApiKey = provider !== "vllm";
    if (this.config.rerank === "cross-encoder" && (!needsApiKey || this.config.rerankApiKey)) {
      try {
        const model = this.config.rerankModel || "jina-reranker-v3";
        const endpoint = this.config.rerankEndpoint || "https://api.jina.ai/v1/rerank";
        const documents = results.map(r => r.entry.text);

        // Build provider-specific request
        const { headers, body } = buildRerankRequest(provider, this.config.rerankApiKey || "", model, query, documents, results.length);

        // Timeout: 5 seconds to prevent stalling retrieval pipeline
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        if (response.ok) {
          const data = await response.json() as Record<string, unknown>;

          // Parse provider-specific response into unified format
          const parsed = parseRerankResponse(provider, data);

          if (!parsed) {
            logWarn("Rerank API: invalid response shape, falling back to cosine");
          } else {
            // Build a Set of returned indices to identify unreturned candidates
            const returnedIndices = new Set(parsed.map(r => r.index));

            const reranked = parsed
              .filter(item => item.index >= 0 && item.index < results.length)
              .map(item => {
                const original = results[item.index];
                // Blend: 60% cross-encoder score + 40% original fused score
                const blendedScore = clamp01(
                  item.score * 0.6 + original.score * 0.4,
                  original.score * 0.5,
                );
                return {
                  ...original,
                  score: blendedScore,
                  sources: {
                    ...original.sources,
                    reranked: { score: item.score },
                  },
                };
              });

            // Keep unreturned candidates with their original scores (slightly penalized)
            const unreturned = results
              .filter((_, idx) => !returnedIndices.has(idx))
              .map(r => ({ ...r, score: r.score * 0.8 }));

            return [...reranked, ...unreturned].sort((a, b) => b.score - a.score);
          }
        } else {
          const errText = await response.text().catch(() => "");
          logWarn(`Rerank API returned ${response.status}: ${errText.slice(0, 200)}, falling back to cosine`);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          logWarn("Rerank API timed out (5s), falling back to cosine");
        } else {
          logWarn("Rerank API failed, falling back to cosine:", error);
        }
      }
    }

    // Fallback: lightweight cosine similarity rerank
    try {
      const reranked = results.map(result => {
        const cosineScore = cosineSimilarity(queryVector, result.entry.vector);
        const combinedScore = (result.score * 0.7) + (cosineScore * 0.3);

        return {
          ...result,
          score: clamp01(combinedScore, result.score),
          sources: {
            ...result.sources,
            reranked: { score: cosineScore },
          },
        };
      });

      return reranked.sort((a, b) => b.score - a.score);
    } catch (error) {
      logWarn("Reranking failed, returning original results:", error);
      return results;
    }
  }

  /**
   * Multi-vector L0/L1 blend: re-score candidates using text overlap
   * between query and L0 abstract / L1 overview stored in metadata.
   *
   * Short/conceptual queries get higher L0/L1 weight (topic matching).
   * Detailed queries stay dominated by L2 main vector score.
   * Feature-gated: RECALLNEST_MULTI_VECTOR=true.
   */
  private applyMultiVectorBlend(results: RetrievalResult[], query: string): RetrievalResult[] {
    if (!isMultiVectorEnabled() || results.length === 0) return results;

    const qTokenCount = tokenize(query).length;
    const blendConfig = adaptiveBlendConfig(qTokenCount);

    return results.map(r => {
      const { l0, l1 } = extractMultiVectorText(r.entry.metadata);

      const l0Score = l0 ? textOverlapScore(query, l0) : null;
      const l1Score = l1 ? textOverlapScore(query, l1) : null;

      // Skip blending if no L0/L1 available
      if (l0Score === null && l1Score === null) return r;

      const blendedScore = blendMultiVectorScores(r.score, l0Score, l1Score, blendConfig);
      return { ...r, score: blendedScore };
    });
  }

  /**
   * Apply recency boost: newer memories get a small score bonus.
   * This ensures corrections/updates naturally outrank older entries
   * when semantic similarity is close.
   * Formula: boost = exp(-ageDays / halfLife) * weight
   */
  private applyRecencyBoost(results: RetrievalResult[]): RetrievalResult[] {
    const { recencyHalfLifeDays, recencyWeight } = this.config;
    if (!recencyHalfLifeDays || recencyHalfLifeDays <= 0 || !recencyWeight) {
      return results;
    }

    const now = Date.now();
    const boosted = results.map(r => {
      const ts = (r.entry.timestamp && r.entry.timestamp > 0) ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;
      const boost = Math.exp(-ageDays / recencyHalfLifeDays) * recencyWeight;
      return {
        ...r,
        score: clamp01(r.score + boost, r.score),
      };
    });

    return boosted.sort((a, b) => b.score - a.score);
  }

  /**
   * Apply importance weighting: memories with higher importance get a score boost.
   * This ensures critical memories (importance=1.0) outrank casual ones (importance=0.5)
   * when semantic similarity is close.
   * Formula: score *= (baseWeight + (1 - baseWeight) * importance)
   * With baseWeight=0.5: importance=1.0 → ×1.0, importance=0.7 → ×0.85, importance=0.5 → ×0.75, importance=0.0 → ×0.5
   */
  private applyImportanceWeight(results: RetrievalResult[]): RetrievalResult[] {
    const baseWeight = 0.5;
    const weighted = results.map(r => {
      const importance = r.entry.importance ?? 0.5;
      const factor = baseWeight + (1 - baseWeight) * importance;
      return {
        ...r,
        score: clamp01(r.score * factor, r.score * baseWeight),
      };
    });
    return weighted.sort((a, b) => b.score - a.score);
  }

  /**
   * Viewpoint confidence: corrected/contradicted memories are penalized,
   * confirmed memories are untouched. Same multiplicative pattern as importance.
   * Formula: score *= (0.5 + 0.5 * confidence)
   */
  private applyConfidence(results: RetrievalResult[]): RetrievalResult[] {
    const weighted = results.map(r => ({
      ...r,
      score: applyConfidenceWeight(r.score, r.entry),
    }));
    return weighted.sort((a, b) => b.score - a.score);
  }

  private applyAssetTypeWeight(results: RetrievalResult[]): RetrievalResult[] {
    const weighted = results.map(r => {
      const metadata = parseMetadata(r.entry.metadata);
      const isAsset = metadata.source === "asset" || r.entry.scope.startsWith("asset:");
      if (!isAsset) return r;

      const assetType = String(metadata.assetType || (r.entry.scope.startsWith("asset:brief:") ? "memory-brief" : "pinned-memory"));
      const factor = assetType === "memory-brief"
        ? 0.88
        : assetType === "pinned-memory"
          ? 1.04
          : 1.0;

      return {
        ...r,
        score: clamp01(r.score * factor, r.score * 0.75),
      };
    });

    return weighted.sort((a, b) => b.score - a.score);
  }

  private applyBoundaryWeight(results: RetrievalResult[]): RetrievalResult[] {
    const weighted = results.map(r => {
      const boundary = extractBoundaryMetadata(r.entry.metadata);
      let factor = 1.0;

      if (boundary?.layer === "durable") {
        factor = boundary.authority === "structured-memory" ? 1.03 : 1.01;
      } else if (boundary?.layer === "evidence") {
        factor = boundary.authority === "transcript-ingest" ? 0.97 : 0.99;
      } else if (!boundary) {
        if (isDurableMemoryScope(r.entry.scope)) factor = 1.01;
        if (isTranscriptScope(r.entry.scope)) factor = 0.99;
      }

      return {
        ...r,
        score: clamp01(r.score * factor, r.score * 0.85),
      };
    });

    return weighted.sort((a, b) => b.score - a.score);
  }

  /**
   * Length normalization: penalize long entries that dominate search results
   * via sheer keyword density and broad semantic coverage.
   * Short, focused entries (< anchor) get a slight boost.
   * Long, sprawling entries (> anchor) get penalized.
   * Formula: score *= 1 / (1 + log2(charLen / anchor))
   */
  private applyLengthNormalization(results: RetrievalResult[]): RetrievalResult[] {
    const anchor = this.config.lengthNormAnchor;
    if (!anchor || anchor <= 0) return results;

    const normalized = results.map(r => {
      const charLen = r.entry.text.length;
      const ratio = charLen / anchor;
      // No penalty for entries at or below anchor length.
      // Gentle logarithmic decay for longer entries:
      //   anchor (500) → 1.0, 800 → 0.75, 1000 → 0.67, 1500 → 0.56, 2000 → 0.50
      // This prevents long, keyword-rich entries from dominating top-k
      // while keeping their scores reasonable.
      const logRatio = Math.log2(Math.max(ratio, 1)); // no boost for short entries
      const factor = 1 / (1 + 0.5 * logRatio);
      return {
        ...r,
        score: clamp01(r.score * factor, r.score * 0.3),
      };
    });

    return normalized.sort((a, b) => b.score - a.score);
  }

  /**
   * Time decay: Weibull stretched-exponential penalty for old entries.
   * Borrowed from memory-lancedb-pro v1.1.0 decay engine.
   *
   * Tier-aware: Core memories decay slower (β=0.8, floor=0.85),
   * Working memories at standard rate (β=1.0, floor=0.65),
   * Peripheral memories decay faster (β=1.3, floor=0.45).
   *
   * Combined with access-tracker reinforcement: frequently recalled
   * memories get extended half-life regardless of tier.
   */
  private applyTimeDecay(results: RetrievalResult[]): RetrievalResult[] {
    const baseHalfLife = this.config.timeDecayHalfLifeDays;
    if (!baseHalfLife || baseHalfLife <= 0) return results;

    const now = Date.now();
    const decayed = results.map(r => {
      // HP-7: Exempt core/pinned/recently-accessed from decay
      if (isDecayExempt(r.entry.metadata, r.entry.importance)) return r;

      const ts = (r.entry.timestamp && r.entry.timestamp > 0) ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;

      // Use access-reinforced half-life if tracker is attached
      const halfLife = this.accessTracker
        ? this.accessTracker.computeEffectiveHalfLife(baseHalfLife, r.entry.metadata)
        : baseHalfLife;

      // Resolve tier from metadata (defaults to peripheral)
      const tier = resolveTier(r.entry.metadata);

      // Weibull decay with tier-specific shape and floor
      const factor = weibullDecay(ageDays, halfLife, tier);
      return {
        ...r,
        score: clamp01(r.score * factor, r.score * 0.3),
      };
    });

    return decayed.sort((a, b) => b.score - a.score);
  }

  /**
   * Blend access-frequency hotness into retrieval scores.
   *
   * Formula: final = score * (1 - alpha) + hotness * alpha
   * where hotness = sigmoid(log1p(accessCount)) * exp(-decayRate * ageDays)
   *
   * No-op when hotnessWeight is 0 or AccessTracker is absent.
   */
  /**
   * B-1/E-1: Evolution decay blend — factor in composite decay score
   * (time × frequency × importance) as a scoring signal.
   * Weight increased from 0.05 to 0.10 with B-3 LLM importance assessment.
   */
  private applyEvolutionDecayBlend(results: RetrievalResult[]): RetrievalResult[] {
    const EVOLUTION_BLEND_WEIGHT = 0.10;
    return results.map(r => {
      // HP-7: Exempt entries get max decay score (1.0) → no penalty
      if (isDecayExempt(r.entry.metadata, r.entry.importance)) {
        return {
          ...r,
          score: clamp01(r.score * (1 - EVOLUTION_BLEND_WEIGHT) + 1.0 * EVOLUTION_BLEND_WEIGHT, 0),
        };
      }
      const evo = parseEvolution(r.entry.metadata, r.entry.timestamp);
      const decay = computeDecayScore(evo, r.entry.importance);
      return {
        ...r,
        score: clamp01(r.score * (1 - EVOLUTION_BLEND_WEIGHT) + decay * EVOLUTION_BLEND_WEIGHT, 0),
      };
    });
  }

  /**
   * E-1: Access count boost — memories with higher access_count get a score nudge.
   * Complements frequency-tracker (query→memory mapping) by operating at
   * the individual memory level (total retrieval hits across all queries).
   * Formula: score *= 1 + log2(1 + accessCount) × 0.03, capped at ×1.15.
   */
  private applyAccessCountBoost(results: RetrievalResult[]): RetrievalResult[] {
    return results.map(r => {
      const evo = parseEvolution(r.entry.metadata, r.entry.timestamp);
      if (evo.accessCount <= 0) return r;
      const boost = Math.min(0.15, Math.log2(1 + evo.accessCount) * 0.03);
      return {
        ...r,
        score: clamp01(r.score * (1 + boost), 0),
      };
    });
  }

  private applyHotnessBlend(results: RetrievalResult[]): RetrievalResult[] {
    const raw = this.config.hotnessWeight;
    const alpha = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0));
    if (alpha <= 0 || !this.accessTracker) return results;

    const blended = results.map((r) => {
      const { accessCount, lastAccessedAt } = parseAccessMetadata(r.entry.metadata);
      const hotness = computeHotnessScore(
        accessCount,
        lastAccessedAt || r.entry.timestamp,
      );
      return {
        ...r,
        score: clamp01(r.score * (1 - alpha) + hotness * alpha, 0),
      };
    });

    return blended.sort((a, b) => b.score - a.score);
  }

  /**
   * P0.2: Frequency boost — memories that get repeatedly retrieved score higher.
   * Unlike hotness (access-tracker based, decay-oriented), this is pure hit-count
   * boost designed to surface "always relevant" memories like daily patrol rules.
   */
  private applyFrequencyBoost(results: RetrievalResult[]): RetrievalResult[] {
    if (!this.frequencyTracker || results.length === 0) return results;
    return results.map(r => {
      const multiplier = this.frequencyTracker!.getBoostMultiplier(r.entry.id);
      if (multiplier <= 1.0) return r;
      return { ...r, score: Math.min(1, r.score * multiplier) };
    });
  }

  /**
   * MMR-inspired diversity filter: greedily select results that are both
   * relevant (high score) and diverse (low similarity to already-selected).
   *
   * Uses cosine similarity between memory vectors. If two memories have
   * cosine similarity > threshold (default 0.92), the lower-scored one
   * is demoted to the end rather than removed entirely.
   *
   * This prevents top-k from being filled with near-identical entries
   * (e.g. 3 similar "SVG style" memories) while keeping them available
   * if the pool is small.
   */
  /**
   * Session-level "do not disturb": penalize suppressed memories (score × 0.3).
   * Inspired by dopamine-mediated transient inhibition — memory isn't deleted,
   * just temporarily quieted so it doesn't dominate irrelevant sessions.
   */
  private applySessionSuppression(results: RetrievalResult[]): RetrievalResult[] {
    if (this.sessionSuppressed.size === 0) return results;
    return results.map(r =>
      this.sessionSuppressed.has(r.entry.id)
        ? { ...r, score: r.score * 0.3 }
        : r,
    ).sort((a, b) => b.score - a.score);
  }

  private applyMMRDiversity(results: RetrievalResult[], similarityThreshold = 0.85): RetrievalResult[] {
    if (results.length <= 1) return results;

    const selected: RetrievalResult[] = [];
    const deferred: RetrievalResult[] = [];

    for (const candidate of results) {
      // Check if this candidate is too similar to any already-selected result
      const tooSimilar = selected.some(s => {
        // Both must have vectors to compare.
        // LanceDB returns Arrow Vector objects (not plain arrays),
        // so use .length directly and Array.from() for conversion.
        const sVec = s.entry.vector;
        const cVec = candidate.entry.vector;
        if (!sVec?.length || !cVec?.length) return false;
        const sArr = Array.from(sVec as Iterable<number>);
        const cArr = Array.from(cVec as Iterable<number>);
        const sim = cosineSimilarity(sArr, cArr);
        return sim > similarityThreshold;
      });

      if (tooSimilar) {
        deferred.push(candidate);
      } else {
        selected.push(candidate);
      }
    }
    // Append deferred results at the end (available but deprioritized)
    return [...selected, ...deferred];
  }

  // Update configuration
  updateConfig(newConfig: Partial<RetrievalConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  // Get current configuration
  getConfig(): RetrievalConfig {
    return { ...this.config };
  }

  // Test retrieval system
  async test(query = "test query"): Promise<{
    success: boolean;
    mode: string;
    hasFtsSupport: boolean;
    error?: string;
  }> {
    try {
      const results = await this.retrieve({
        query,
        limit: 1,
      });

      return {
        success: true,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
      };
    } catch (error) {
      return {
        success: false,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createRetriever(
  store: MemoryStore,
  embedder: Embedder,
  config?: Partial<RetrievalConfig>
): MemoryRetriever {
  const fullConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
  return new MemoryRetriever(store, embedder, fullConfig);
}
