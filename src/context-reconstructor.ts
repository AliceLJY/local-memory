import type { RetrievalResult } from "./retriever.js";

// --- Types ---
export interface ReconstructionInput {
  query: string;
  results: RetrievalResult[];
  mode: "resume" | "search";
  maxTokens?: number;
}

export interface ReconstructionOutput {
  reconstructed: string | null;
  sources: string[];
  confidence: number;
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

// --- Gate ---
export function shouldReconstruct(c: GateConditions): boolean {
  return c.flagEnabled && c.callerOptIn && c.resultCount >= 3 && c.llmAvailable;
}

// --- Grounding Utilities ---
export function extractCitedIds(text: string): string[] {
  const ids = new Set<string>();
  const regex = /\[src:([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    ids.add(match[1]);
  }
  return [...ids];
}

export function removeSentencesWithId(text: string, id: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.filter(s => !s.includes(`[src:${id}]`)).join(" ");
}

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

// --- Prompt Builder ---
export function buildPrompt(input: ReconstructionInput): { system: string; user: string } {
  const modeHint = input.mode === "resume"
    ? "Focus on what the user was working on, key decisions, and pending actions."
    : "Focus on the most relevant facts for the query.";

  const system = `You are a memory reconstruction engine. Synthesize a coherent summary from stored memories.\n\n${modeHint}\n\nRules:\n1. Every claim MUST cite [src:MEMORY_ID]\n2. Do NOT invent facts not in source memories\n3. Contradictions: present both with [conflict]\n4. Keep under ${input.maxTokens ?? 500} tokens`;

  const block = input.results.slice(0, 10).map(r =>
    `[ID: ${r.entry.id}] ${r.entry.text} (importance: ${r.entry.importance})`
  ).join("\n\n");

  return { system, user: `Context: ${input.query}\n\nMemories:\n${block}\n\nReconstruct:` };
}

// --- Main Pipeline ---
const TIMEOUT_MS = 3000;
const COVERAGE_FLOOR = 0.6;

export async function reconstruct(
  input: ReconstructionInput,
  llmClient: ReconstructionLLMClient,
): Promise<ReconstructionOutput> {
  const raw = input.results;

  const timeout = new Promise<ReconstructionOutput>(resolve =>
    setTimeout(() => resolve({
      reconstructed: null, sources: [], confidence: 0, fallbackReason: "timeout", raw,
    }), TIMEOUT_MS)
  );

  const work = (async (): Promise<ReconstructionOutput> => {
    const { system, user } = buildPrompt(input);
    const response = await llmClient.generateReconstruction(system, user);

    if (!response) {
      return { reconstructed: null, sources: [], confidence: 0, fallbackReason: "llm_empty", raw };
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

    // Layer 2: Coverage — verify reconstructed text is grounded in source memories
    const coverage = computeCoverage(text, raw.map(r => r.entry.text));
    if (coverage < COVERAGE_FLOOR) {
      return { reconstructed: null, sources: [], confidence: 0, fallbackReason: "low_grounding", raw };
    }

    const validSources = extractCitedIds(text).filter(id => validIds.has(id));
    return {
      reconstructed: text,
      sources: validSources,
      confidence: Math.min(confidence, coverage),
      raw,
    };
  })();

  return Promise.race([work, timeout]);
}
