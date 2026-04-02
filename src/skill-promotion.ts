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
}

export interface PromotionConfig {
  /** Minimum similar cases to suggest pattern promotion (default: 3) */
  minCaseOccurrences: number;
  /** Similarity threshold for case clustering (default: 0.75) */
  caseSimilarityThreshold: number;
  /** Max candidates to return (default: 5) */
  maxCandidates: number;
}

const DEFAULT_CONFIG: PromotionConfig = {
  minCaseOccurrences: 3,
  caseSimilarityThreshold: 0.75,
  maxCandidates: 5,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PromotionStore = Pick<MemoryStore, "list" | "vectorSearch">;

function isActive(entry: MemoryEntry): boolean {
  return isActiveMemory(entry.metadata);
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

interface Cluster {
  seed: MemoryEntry;
  members: MemoryEntry[];
}

function greedyCluster(
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

  // 1. Load all entries in scope (high limit to get everything meaningful)
  const entries = await store.list([scope], undefined, 500, 0);
  const active = entries.filter(isActive);

  const cases = active.filter(e => e.category === "cases");
  const patterns = active.filter(e => e.category === "patterns");

  const result: PromotionScanResult = {
    candidates: [],
    scannedCases: cases.length,
    scannedPatterns: patterns.length,
  };

  // 2. Cluster cases by vector similarity
  if (cases.length >= cfg.minCaseOccurrences) {
    const clusters = greedyCluster(cases, cfg.caseSimilarityThreshold);

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

  // 3. Detect pattern_to_skill candidates
  for (const pattern of patterns) {
    if (result.candidates.length >= cfg.maxCandidates) break;
    if (!hasStructuredSteps(pattern.text)) continue;
    if (!pattern.vector?.length) continue;

    // Find cases similar to this pattern
    const similarCases = cases.filter(c => {
      if (!c.vector?.length) return false;
      const sim = cosineSimilarity(pattern.vector, c.vector);
      return sim >= cfg.caseSimilarityThreshold;
    });

    if (similarCases.length < 2) continue;

    result.candidates.push({
      type: "pattern_to_skill",
      sourceEntries: [
        { id: pattern.id, text: pattern.text, score: 1.0 },
        ...similarCases.map(c => ({
          id: c.id,
          text: c.text,
          score: cosineSimilarity(pattern.vector, c.vector),
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
