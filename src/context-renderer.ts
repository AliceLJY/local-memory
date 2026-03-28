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
// Temporal helpers
// ---------------------------------------------------------------------------

/** Detect whether a query asks for a specific date/time. */
export function isTemporalQuery(query: string): boolean {
  return /^when\b|what (date|time|day|year|month)\b|how long ago\b/i.test(query);
}

/** Extract a bracketed date anchor from memory text, e.g. "[1:56 pm on 7 May, 2023]". */
function extractAnchorDate(text: string): { dateStr: string; year: number; month: number } | null {
  const m = text.match(/\[(?:\d{1,2}:\d{2}\s*(?:am|pm)\s+on\s+)?(\d{1,2})\s+(\w+),?\s+(\d{4})\]/i);
  if (!m) return null;
  const monthMap: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const month = monthMap[m[2].toLowerCase()];
  if (!month) return null;
  return { dateStr: m[0], year: parseInt(m[3], 10), month };
}

/**
 * Annotate relative time expressions with absolute dates.
 * E.g. "last year" in text dated [7 May, 2023] → "last year (i.e., 2022)"
 */
export function resolveRelativeDates(text: string): string {
  const anchor = extractAnchorDate(text);
  if (!anchor) return text;

  const { year, month } = anchor;
  const MONTHS = ["", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  return text
    .replace(/\blast year\b/gi, `last year (i.e., ${year - 1})`)
    .replace(/\bnext year\b/gi, `next year (i.e., ${year + 1})`)
    .replace(/\blast month\b/gi, `last month (i.e., ${MONTHS[month === 1 ? 12 : month - 1]} ${month === 1 ? year - 1 : year})`)
    .replace(/\bnext month\b/gi, `next month (i.e., ${MONTHS[month === 12 ? 1 : month + 1]} ${month === 12 ? year + 1 : year})`)
    .replace(/\b(\d+)\s+years?\s+ago\b/gi, (match, n) => `${match} (i.e., ${year - parseInt(n, 10)})`)
    .replace(/\ba few years ago\b/gi, `a few years ago (i.e., around ${year - 3})`)
    .replace(/\blast week\b/gi, `last week (i.e., the week before ${anchor.dateStr})`)
    .replace(/\blast saturday\b/gi, `last Saturday (i.e., the Saturday before ${anchor.dateStr})`);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render recalled memories adapted to the current query context.
 *
 * - verbatim: return as-is in original order (default)
 * - highlight: reorder by contextual relevance (60% vector score + 40% term overlap)
 * - synthesize: highlight + temporal date annotation for "when" queries
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

  const temporal = isTemporalQuery(query);
  const queryTerms = extractTerms(query + (taskContext ? " " + taskContext : ""));

  const scored = memories.map(m => {
    const memTerms = extractTerms(m.text);
    const overlap = computeTermOverlap(queryTerms, memTerms);
    const relevance = 0.6 * m.score + 0.4 * overlap;

    // In synthesize mode for temporal queries, annotate relative dates
    const renderedText = (mode === "synthesize" && temporal)
      ? resolveRelativeDates(m.text)
      : m.text;

    return {
      id: m.id,
      text: renderedText,
      category: m.category,
      relevance: Math.round(relevance * 1000) / 1000,
    };
  });

  scored.sort((a, b) => b.relevance - a.relevance);

  return { mode, memories: scored };
}
