/**
 * Context Renderer — reorder recall results by contextual relevance.
 *
 * Borrowed from UltraMemory's context-renderer.ts, adapted for RecallNest:
 * - "verbatim" mode: pass-through (default, backward-compatible)
 * - "highlight" mode: reorder by 60% vector score + 40% term overlap
 * - "synthesize" mode: reserved for future LLM-based rendering (falls back to highlight)
 *
 * Pure functions, zero dependencies on store/embedder/LLM.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RenderMode = "verbatim" | "highlight" | "synthesize";

export interface RenderableMemory {
  id: string;
  text: string;
  score: number;
  category: string;
}

export interface RenderedMemory {
  id: string;
  text: string;
  category: string;
  /** Contextual relevance score (0–1), combining vector score + term overlap. */
  relevance: number;
}

export interface RenderResult {
  mode: RenderMode;
  memories: RenderedMemory[];
}

// ---------------------------------------------------------------------------
// Stop words (EN + ZH function words)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "about", "between", "under", "above",
  "this", "that", "these", "those", "it", "its", "i", "me", "my",
  "we", "our", "you", "your", "he", "she", "they", "them", "and",
  "or", "but", "if", "then", "so", "just", "also", "not", "no",
  // Chinese function words
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人",
  "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去",
  "你", "会", "着", "没有", "看", "好", "自己", "这",
]);

// ---------------------------------------------------------------------------
// Term extraction
// ---------------------------------------------------------------------------

/** Extract significant terms from text (lowercase, deduped, stop words removed). */
export function extractTerms(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
    .split(/\s+/);
  return new Set(words.filter(w => w.length > 1 && !STOP_WORDS.has(w)));
}

/** Compute Jaccard-like overlap between two term sets. */
export function computeTermOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const term of a) {
    if (b.has(term)) overlap++;
  }
  return overlap / Math.max(a.size, b.size);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render recalled memories adapted to the current query context.
 *
 * - verbatim: return as-is in original order (default)
 * - highlight: reorder by contextual relevance (60% vector score + 40% term overlap)
 * - synthesize: reserved for future LLM pass (currently falls back to highlight)
 */
export function renderMemories(
  memories: RenderableMemory[],
  query: string,
  mode: RenderMode = "verbatim",
  taskContext?: string,
): RenderResult {
  if (mode === "verbatim" || memories.length === 0) {
    return {
      mode: "verbatim",
      memories: memories.map(m => ({
        id: m.id,
        text: m.text,
        category: m.category,
        relevance: m.score,
      })),
    };
  }

  // synthesize not yet implemented — fall back to highlight
  const effectiveMode: RenderMode = mode === "synthesize" ? "highlight" : mode;

  const queryTerms = extractTerms(query + (taskContext ? " " + taskContext : ""));

  const scored = memories.map(m => {
    const memTerms = extractTerms(m.text);
    const overlap = computeTermOverlap(queryTerms, memTerms);
    const relevance = 0.6 * m.score + 0.4 * overlap;
    return {
      id: m.id,
      text: m.text,
      category: m.category,
      relevance: Math.round(relevance * 1000) / 1000,
    };
  });

  scored.sort((a, b) => b.relevance - a.relevance);

  return { mode: effectiveMode, memories: scored };
}
