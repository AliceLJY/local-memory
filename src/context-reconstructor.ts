import type { RetrievalResult } from "./retriever.js";
import { detectHeuristicContradiction } from "./consolidation-engine.js";

// ============================================================================
// Phase 4: Constructive Retrieval — Types
// ============================================================================

/** How a candidate entered the reconstruction pool. */
export type CandidateSourceType =
  | "direct"
  | "kg_neighbor"
  | "evolution_chain"
  | "cluster_member"
  | "narrative_sibling";

export interface CandidateSource {
  type: CandidateSourceType;
  /** Human-readable reason, e.g. "neighbor of entity Docker" */
  reason?: string;
}

/** One source entry in the reconstruction output — tracks provenance. */
export interface ReconstructionSourceEntry {
  id: string;
  source: CandidateSource;
  /** What this memory contributed to the reconstruction (extracted from LLM output). */
  contribution: string;
}

/** A detected contradiction between two source memories. */
export interface ContradictionEntry {
  memoryIds: [string, string];
  description: string;
}

// --- Reconstruction I/O ---

export interface ReconstructionInput {
  query: string;
  results: RetrievalResult[];
  mode: "resume" | "search";
  maxTokens?: number;
  /** Phase 4: checkpoint context injected into the reconstruction prompt. */
  checkpointContext?: {
    openLoops?: string[];
    nextActions?: string[];
    scope?: string;
  };
}

export interface ReconstructionOutput {
  reconstructed: string | null;
  /** V2: Typed source entries with provenance tracking. */
  sources: ReconstructionSourceEntry[];
  confidence: number;
  /** Detected contradictions between source memories. */
  contradictions: ContradictionEntry[];
  /** Source-map grounding coverage (0-1). */
  coverage: number;
  fallbackReason?: string;
  raw: RetrievalResult[];
}

export interface GateConditions {
  flagEnabled: boolean;
  callerOptIn: boolean;
  resultCount: number;
  llmAvailable: boolean;
}

export interface ReconstructionLLMClient {
  generateReconstruction(system: string, user: string): Promise<string | null>;
}

// ============================================================================
// Phase 4: Candidate Expansion
// ============================================================================

/** Dependency injection for candidate expansion sources. */
export interface CandidateExpansionDeps {
  /** Expand via KG graph neighbor traversal. */
  expandViaKG?: (results: RetrievalResult[]) => Promise<RetrievalResult[]>;
  /** Expand via evolution chains (supersedes / supersededBy). */
  expandViaEvolution?: (results: RetrievalResult[]) => Promise<RetrievalResult[]>;
  /** Expand via cluster member lookup (sourceMemories of cluster insights). */
  expandViaClusters?: (results: RetrievalResult[]) => Promise<RetrievalResult[]>;
  /** Expand via narrative siblings (shared generalEventId). */
  expandViaNarrative?: (results: RetrievalResult[]) => Promise<RetrievalResult[]>;
}

/** Hard cap for total expanded candidate set. */
const EXPANSION_CAP = 20;

/**
 * Expand direct retrieval results with related candidates from multiple sources.
 * Returns the expanded result set + a source map for provenance tracking.
 */
export async function expandCandidates(
  directResults: RetrievalResult[],
  deps: CandidateExpansionDeps,
): Promise<{ results: RetrievalResult[]; sourceMap: Map<string, CandidateSource> }> {
  const sourceMap = new Map<string, CandidateSource>();
  const seen = new Set<string>();
  const all: RetrievalResult[] = [];

  // Tag direct results first
  for (const r of directResults) {
    sourceMap.set(r.entry.id, { type: "direct" });
    seen.add(r.entry.id);
    all.push(r);
  }

  if (all.length >= EXPANSION_CAP) {
    return { results: all.slice(0, EXPANSION_CAP), sourceMap };
  }

  // Run all expansion sources in parallel
  const expansionTypes: Array<{
    type: CandidateSourceType;
    fn?: (results: RetrievalResult[]) => Promise<RetrievalResult[]>;
  }> = [
    { type: "kg_neighbor", fn: deps.expandViaKG },
    { type: "evolution_chain", fn: deps.expandViaEvolution },
    { type: "cluster_member", fn: deps.expandViaClusters },
    { type: "narrative_sibling", fn: deps.expandViaNarrative },
  ];

  const expansionPromises = expansionTypes.map(({ fn }) =>
    fn ? fn(directResults).catch(() => [] as RetrievalResult[]) : Promise.resolve([] as RetrievalResult[]),
  );
  const expansionResults = await Promise.all(expansionPromises);

  // Merge expanded results, respecting the cap
  for (let i = 0; i < expansionResults.length; i++) {
    const sourceType = expansionTypes[i].type;
    for (const r of expansionResults[i]) {
      if (all.length >= EXPANSION_CAP) break;
      if (seen.has(r.entry.id)) continue;
      seen.add(r.entry.id);
      sourceMap.set(r.entry.id, { type: sourceType });
      all.push(r);
    }
    if (all.length >= EXPANSION_CAP) break;
  }

  return { results: all, sourceMap };
}

// ============================================================================
// Gate
// ============================================================================

export function shouldReconstruct(c: GateConditions): boolean {
  return c.flagEnabled && c.callerOptIn && c.resultCount >= 3 && c.llmAvailable;
}

// ============================================================================
// Grounding Utilities
// ============================================================================

/** Extract [src:MEMORY_ID] citations from LLM output. */
export function extractCitedIds(text: string): string[] {
  const ids = new Set<string>();
  const regex = /\[src:([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    ids.add(match[1]);
  }
  return [...ids];
}

/** Remove sentences containing a specific citation tag. */
export function removeSentencesWithId(text: string, id: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.filter(s => !s.includes(`[src:${id}]`)).join(" ");
}

/**
 * Phase 4: Source-map grounded coverage — replaces the old lexical overlap approach.
 * Counts what fraction of reconstruction sentences are backed by valid [src:ID] citations.
 */
export function computeSourceMapCoverage(
  reconstructed: string,
  validIds: Set<string>,
): number {
  const sentences = reconstructed.split(/(?<=[.!?])\s+/).filter(s => s.length > 5);
  if (sentences.length === 0) return 0;

  let grounded = 0;
  for (const sent of sentences) {
    const cited = extractCitedIds(sent);
    // A sentence is grounded if it has at least one valid citation
    if (cited.some(id => validIds.has(id))) {
      grounded++;
    }
  }
  return grounded / sentences.length;
}

/**
 * Legacy lexical coverage — kept for backward compat in tests.
 * @deprecated Use computeSourceMapCoverage instead.
 */
export function computeCoverage(reconstructed: string, sourceTexts: string[]): number {
  const sentences = reconstructed.split(/(?<=[.!?])\s+/).filter(s => s.length > 5);
  if (sentences.length === 0) return 0;

  const sourceWords = new Set<string>();
  for (const src of sourceTexts) {
    for (const w of src.toLowerCase().split(/\s+/)) {
      if (w.length > 2) sourceWords.add(w);
    }
  }

  let covered = 0;
  for (const sent of sentences) {
    const words = sent.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) continue;
    const overlap = words.filter(w => sourceWords.has(w)).length / words.length;
    if (overlap > 0.3) covered++;
  }
  return covered / sentences.length;
}

// ============================================================================
// Contradiction Detection
// ============================================================================

/**
 * Phase 4: Detect contradictions across the candidate set.
 * Reuses the heuristic contradiction detector from consolidation-engine.
 * O(n^2) but n is capped at EXPANSION_CAP (20), so max 190 comparisons.
 */
export function detectContradictions(results: RetrievalResult[]): ContradictionEntry[] {
  const contradictions: ContradictionEntry[] = [];
  const MAX_CONTRADICTIONS = 5;

  for (let i = 0; i < results.length && contradictions.length < MAX_CONTRADICTIONS; i++) {
    for (let j = i + 1; j < results.length && contradictions.length < MAX_CONTRADICTIONS; j++) {
      if (detectHeuristicContradiction(results[i].entry.text, results[j].entry.text)) {
        contradictions.push({
          memoryIds: [results[i].entry.id, results[j].entry.id],
          description: `Potential conflict between "${results[i].entry.text.slice(0, 60)}..." and "${results[j].entry.text.slice(0, 60)}..."`,
        });
      }
    }
  }

  return contradictions;
}

// ============================================================================
// Prompt Builder
// ============================================================================

export function buildPrompt(input: ReconstructionInput): { system: string; user: string } {
  const modeHint = input.mode === "resume"
    ? "Focus on what the user was working on, key decisions, and pending actions."
    : "Focus on the most relevant facts for the query.";

  // Phase 4: Inject checkpoint context into the prompt for richer reconstruction
  let checkpointHint = "";
  if (input.checkpointContext) {
    const parts: string[] = [];
    if (input.checkpointContext.scope) {
      parts.push(`Active scope: ${input.checkpointContext.scope}`);
    }
    if (input.checkpointContext.openLoops?.length) {
      parts.push(`Open loops:\n${input.checkpointContext.openLoops.map(l => `- ${l}`).join("\n")}`);
    }
    if (input.checkpointContext.nextActions?.length) {
      parts.push(`Next actions:\n${input.checkpointContext.nextActions.map(a => `- ${a}`).join("\n")}`);
    }
    if (parts.length > 0) {
      checkpointHint = `\n\nCheckpoint state:\n${parts.join("\n")}`;
    }
  }

  const system = `You are a memory reconstruction engine. Synthesize a coherent summary from stored memories.\n\n${modeHint}\n\nRules:\n1. Every claim MUST cite [src:MEMORY_ID]\n2. Do NOT invent facts not in source memories\n3. Contradictions: present both sides with [conflict] tag and cite both sources\n4. Keep under ${input.maxTokens ?? 500} tokens${checkpointHint}`;

  const block = input.results.slice(0, 10).map(r =>
    `[ID: ${r.entry.id}] ${r.entry.text} (importance: ${r.entry.importance})`
  ).join("\n\n");

  return { system, user: `Context: ${input.query}\n\nMemories:\n${block}\n\nReconstruct:` };
}

// ============================================================================
// Main Pipeline
// ============================================================================

const TIMEOUT_MS = 3000;
const COVERAGE_FLOOR = 0.5;

/**
 * Phase 4 Constructive Retrieval pipeline.
 *
 * 1. Expand candidates (if deps provided)
 * 2. Detect contradictions across expanded set
 * 3. Run LLM reconstruction with grounded prompt
 * 4. Verify via source-map coverage (not lexical overlap)
 * 5. Return typed ReconstructionOutput with sources, contradictions, coverage
 */
export async function reconstruct(
  input: ReconstructionInput,
  llmClient: ReconstructionLLMClient,
  expansionDeps?: CandidateExpansionDeps,
): Promise<ReconstructionOutput> {
  const emptyOutput = (reason: string, raw: RetrievalResult[]): ReconstructionOutput => ({
    reconstructed: null,
    sources: [],
    confidence: 0,
    contradictions: [],
    coverage: 0,
    fallbackReason: reason,
    raw,
  });

  // Step 1: Candidate expansion (if deps provided)
  let expandedResults = input.results;
  let sourceMap = new Map<string, CandidateSource>(
    input.results.map(r => [r.entry.id, { type: "direct" as CandidateSourceType }]),
  );

  if (expansionDeps) {
    const expanded = await expandCandidates(input.results, expansionDeps);
    expandedResults = expanded.results;
    sourceMap = expanded.sourceMap;
  }

  // Step 2: Detect contradictions across the candidate set
  const contradictions = detectContradictions(expandedResults);

  // Build input with expanded results
  const expandedInput: ReconstructionInput = { ...input, results: expandedResults };
  const raw = expandedResults;

  const timeout = new Promise<ReconstructionOutput>(resolve =>
    setTimeout(() => resolve(emptyOutput("timeout", raw)), TIMEOUT_MS),
  );

  const work = (async (): Promise<ReconstructionOutput> => {
    const { system, user } = buildPrompt(expandedInput);
    const response = await llmClient.generateReconstruction(system, user);

    if (!response) {
      return emptyOutput("llm_empty", raw);
    }

    let text = response;
    let confidence = 1.0;

    // Layer 1: ID verification — remove sentences citing non-existent memory IDs
    const validIds = new Set(raw.map(r => r.entry.id));
    for (const id of extractCitedIds(text)) {
      if (!validIds.has(id)) {
        text = removeSentencesWithId(text, id);
        confidence -= 0.2;
      }
    }
    confidence = Math.max(0, confidence);

    // Layer 2: Source-map grounded coverage (replaces lexical overlap)
    const coverage = computeSourceMapCoverage(text, validIds);
    if (coverage < COVERAGE_FLOOR) {
      return { ...emptyOutput("low_grounding", raw), contradictions, coverage };
    }

    // Build typed source entries from cited IDs + source map
    const citedIds = extractCitedIds(text).filter(id => validIds.has(id));
    const sources: ReconstructionSourceEntry[] = citedIds.map(id => ({
      id,
      source: sourceMap.get(id) ?? { type: "direct" as CandidateSourceType },
      contribution: extractContributionForId(text, id),
    }));

    return {
      reconstructed: text,
      sources,
      confidence: Math.min(confidence, coverage),
      contradictions,
      coverage,
      raw,
    };
  })();

  return Promise.race([work, timeout]);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract the sentence(s) citing a specific memory ID as its "contribution".
 * Returns the first sentence that cites the ID, truncated.
 */
function extractContributionForId(text: string, id: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const match = sentences.find(s => s.includes(`[src:${id}]`));
  if (!match) return "";
  // Strip the citation tag and truncate
  return match.replace(/\[src:[^\]]+\]/g, "").trim().slice(0, 120);
}
