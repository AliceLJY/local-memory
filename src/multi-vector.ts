/**
 * Multi-Vector L0/L1/L2 Embedding Support
 *
 * Borrowed from UltraMemory's multi-vector approach:
 * - L0 (abstract): 1-sentence concept-level summary → good for broad topic match
 * - L1 (overview): bullet-point structure → good for structural match
 * - L2 (detail): full content → default vector (already exists)
 *
 * RecallNest already stores L0/L1/L2 text in metadata. This module:
 * 1. Extracts L0/L1 text from metadata
 * 2. Generates additional vector embeddings for them
 * 3. Provides a blending function for retrieval scoring
 *
 * Opt-in via RECALLNEST_MULTI_VECTOR=true environment variable.
 * When disabled, all functions are no-ops that return empty results.
 */

import type { Embedder } from "./embedder.js";
import * as envConfig from "./env-config.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function isMultiVectorEnabled(): boolean {
  return envConfig.multiVector();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MultiVectorEmbeddings {
  /** L0 abstract vector (concept-level). Null if no L0 text available. */
  vector_l0: number[] | null;
  /** L1 overview vector (structure-level). Null if no L1 text available. */
  vector_l1: number[] | null;
}

export interface MultiVectorBlendConfig {
  /** Weight for main vector channel (default: 0.65) */
  vectorWeight: number;
  /** Weight for L0 abstract channel (default: 0.20) */
  l0Weight: number;
  /** Weight for L1 overview channel (default: 0.15) */
  l1Weight: number;
}

export const DEFAULT_BLEND_CONFIG: MultiVectorBlendConfig = {
  vectorWeight: 0.65,
  l0Weight: 0.20,
  l1Weight: 0.15,
};

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Extract L0 and L1 text from metadata JSON string. */
export function extractMultiVectorText(metadata?: string): { l0?: string; l1?: string } {
  if (!metadata) return {};
  try {
    const meta = JSON.parse(metadata);
    return {
      l0: typeof meta.l0_abstract === "string" && meta.l0_abstract.length > 5 ? meta.l0_abstract : undefined,
      l1: typeof meta.l1_overview === "string" && meta.l1_overview.length > 5 ? meta.l1_overview : undefined,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

/**
 * Generate L0 and L1 vector embeddings from metadata text.
 * Returns null vectors when text is not available or multi-vector is disabled.
 */
export async function embedMultiVector(
  embedder: Pick<Embedder, "embedPassage">,
  metadata?: string,
): Promise<MultiVectorEmbeddings> {
  if (!isMultiVectorEnabled()) {
    return { vector_l0: null, vector_l1: null };
  }

  const { l0, l1 } = extractMultiVectorText(metadata);

  const [vector_l0, vector_l1] = await Promise.all([
    l0 ? embedder.embedPassage(l0) : Promise.resolve(null),
    l1 ? embedder.embedPassage(l1) : Promise.resolve(null),
  ]);

  return { vector_l0, vector_l1 };
}

// ---------------------------------------------------------------------------
// Score Blending
// ---------------------------------------------------------------------------

/**
 * Blend multi-vector scores into a single relevance score.
 *
 * When L0/L1 scores are available, the main vector score is weighted down
 * and supplemented by abstract/overview channel scores.
 * When L0/L1 are unavailable, falls back to main vector score only.
 */
export function blendMultiVectorScores(
  mainScore: number,
  l0Score: number | null,
  l1Score: number | null,
  config: MultiVectorBlendConfig = DEFAULT_BLEND_CONFIG,
): number {
  if (l0Score === null && l1Score === null) {
    return mainScore; // No multi-vector data, use main score as-is
  }

  // Redistribute weights among available channels
  let totalWeight = config.vectorWeight;
  let weightedSum = mainScore * config.vectorWeight;

  if (l0Score !== null) {
    totalWeight += config.l0Weight;
    weightedSum += l0Score * config.l0Weight;
  }

  if (l1Score !== null) {
    totalWeight += config.l1Weight;
    weightedSum += l1Score * config.l1Weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : mainScore;
}

// ---------------------------------------------------------------------------
// Cosine Similarity (for in-memory multi-vector scoring)
// ---------------------------------------------------------------------------

/** Compute cosine similarity between two vectors. Returns 0 for mismatched/empty vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Text-Overlap Scoring (lightweight proxy for L0/L1 vector similarity)
// ---------------------------------------------------------------------------

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const STOP_WORDS_EN = new Set(["a","an","the","is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","shall","should","may","might","can","could","of","in","to","for","with","on","at","by","from","and","or","but","not","no","so","if","as","it","i","my","me","we","our","us","you","your","he","she","they","them","this","that","what","which","who","how","when","where","why"]);
const STOP_WORDS_ZH = new Set(["的","了","在","是","我","有","和","就","不","人","都","一","一个","上","也","很","到","说","要","去","你","会","着","没有","看","好","自己","这"]);

/** Tokenize text into words, CJK-aware. Returns lowercased tokens with stop words removed. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // Walk character-by-character: CJK chars → individual tokens, Latin runs → whole-word tokens
  let currentWord = "";
  for (const ch of lower) {
    if (CJK_RANGE.test(ch)) {
      // Flush any accumulated Latin word
      if (currentWord.length > 1 && !STOP_WORDS_EN.has(currentWord)) tokens.push(currentWord);
      currentWord = "";
      // CJK char as individual token
      if (!STOP_WORDS_ZH.has(ch)) tokens.push(ch);
    } else if (/\w/.test(ch)) {
      currentWord += ch;
    } else {
      // Punctuation/whitespace: flush Latin word
      if (currentWord.length > 1 && !STOP_WORDS_EN.has(currentWord)) tokens.push(currentWord);
      currentWord = "";
    }
  }
  // Flush trailing Latin word
  if (currentWord.length > 1 && !STOP_WORDS_EN.has(currentWord)) tokens.push(currentWord);

  return tokens;
}

/**
 * Compute term-overlap score between query and candidate text.
 * Returns [0, 1] blending coverage (query terms found) and density
 * (query terms / candidate length). Density rewards concise abstracts
 * over verbose full-text, which is exactly the L0>L1>L2 gradient we want.
 */
export function textOverlapScore(query: string, candidateText: string): number {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 0;

  const cTokens = tokenize(candidateText);
  if (cTokens.length === 0) return 0;

  const cSet = new Set(cTokens);
  let hits = 0;
  for (const t of qTokens) {
    if (cSet.has(t)) hits++;
  }

  // Coverage: what fraction of query terms appear in candidate [0, 1]
  const coverage = hits / qTokens.length;

  // Density: query term hits / candidate token count — rewards concise text [0, 1]
  const density = hits / cTokens.length;

  // Blend: coverage dominant (70%), density as tiebreaker (30%)
  return coverage * 0.7 + density * 0.3;
}

/**
 * Adaptive blend weights based on query length.
 * Short/conceptual queries → weight L0/L1 more.
 * Long/detailed queries → weight L2 (main vector) more.
 */
export function adaptiveBlendConfig(queryTokenCount: number): MultiVectorBlendConfig {
  if (queryTokenCount <= 3) {
    // Topic-level: boost L0/L1
    return { vectorWeight: 0.50, l0Weight: 0.25, l1Weight: 0.25 };
  }
  if (queryTokenCount <= 10) {
    // Default balanced
    return DEFAULT_BLEND_CONFIG;
  }
  // Detailed query: rely on L2 main vector
  return { vectorWeight: 0.80, l0Weight: 0.10, l1Weight: 0.10 };
}
