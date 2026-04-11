/**
 * Retrieval Interference Filter (RIF)
 *
 * Brain-inspired: retrieval-induced forgetting — retrieving A actively
 * suppresses similar-but-not-selected B, improving future signal-to-noise.
 *
 * In practice: after scoring, demote near-duplicate results from the same
 * topic that are significantly weaker than a higher-ranked result.
 * They're moved to the end (not removed) as fallback.
 */

import type { RetrievalResult } from "./retriever.js";

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Filter interference: demote near-duplicate results that are significantly
 * weaker than a higher-ranked similar result.
 *
 * @param results - Scored results sorted by score descending
 * @param similarityThreshold - Cosine similarity above which two results are "near-duplicate" (default: 0.85)
 * @param scoreRatio - A result scoring below this ratio of its near-duplicate is demoted (default: 0.80)
 * @param clusterTopK - F2: Max results per semantic cluster before demotion (default: 3)
 */
export function filterInterference(
  results: RetrievalResult[],
  similarityThreshold = 0.85,
  scoreRatio = 0.80,
  clusterTopK = 3,
): RetrievalResult[] {
  if (results.length <= 2) return results;

  const kept: RetrievalResult[] = [];
  const demoted: RetrievalResult[] = [];

  // F2: Track cluster membership — each kept result seeds or joins a cluster
  // clusterMap: kept-index → cluster-id
  const clusterMap: number[] = [];
  const clusterCounts = new Map<number, number>(); // cluster-id → count
  let nextClusterId = 0;

  for (const candidate of results) {
    let isDemoted = false;
    let matchedClusterId: number | null = null;

    for (let i = 0; i < kept.length; i++) {
      const sim = cosineSimilarity(candidate.entry.vector, kept[i].entry.vector);
      if (sim > similarityThreshold) {
        matchedClusterId = clusterMap[i];
        // Original RIF: demote if score too low relative to stronger result
        if (candidate.score < kept[i].score * scoreRatio) {
          isDemoted = true;
          break;
        }
        // F2: Cluster top-K — demote if cluster already has K members
        const count = clusterCounts.get(matchedClusterId) ?? 0;
        if (count >= clusterTopK) {
          // Demote with 50% score penalty instead of full demotion
          demoted.push({ ...candidate, score: candidate.score * 0.5 });
          isDemoted = true;
          break;
        }
        break;
      }
    }

    if (!isDemoted) {
      const cid = matchedClusterId ?? nextClusterId++;
      clusterMap.push(cid);
      clusterCounts.set(cid, (clusterCounts.get(cid) ?? 0) + 1);
      kept.push(candidate);
    } else if (matchedClusterId == null) {
      // Demoted by score ratio, not cluster overflow
      demoted.push(candidate);
    }
    // cluster overflow case already pushed to demoted above
  }

  // Demoted results go to the end as fallback
  return [...kept, ...demoted];
}

// ---------------------------------------------------------------------------
// Helpers
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
