/**
 * P0.1 — Anchor Generator
 *
 * Generates a short (≤80 chars) retrieval anchor for each memory.
 * Short anchors bridge the embedding distance gap between brief queries
 * (e.g. "轮巡") and long stored documents.
 *
 * Heuristic-only — no LLM calls, no latency added to writes.
 */

const MAX_ANCHOR_LENGTH = 80;

/** CJK character detector */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/** Extract first meaningful sentence (period, or newline). */
function firstSentence(text: string): string {
  // Split on newline first (preserves paragraph structure)
  const firstLine = text.split(/\n/)[0].trim();

  // Then split on sentence boundaries within that line
  const match = firstLine.match(/^(.+?)[。！？.!?]/);
  return match ? match[1].trim() : firstLine;
}

/** Extract structured title from metadata (patterns, cases). */
function extractTitle(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) return undefined;
  const wp = metadata.workflowPattern as Record<string, unknown> | undefined;
  if (wp?.title && typeof wp.title === "string") return wp.title;
  const cm = metadata.caseMemory as Record<string, unknown> | undefined;
  if (cm?.title && typeof cm.title === "string") return cm.title;
  return undefined;
}

/**
 * Generate a retrieval anchor (≤80 chars) for a memory entry.
 *
 * Priority:
 * 1. Structured title from metadata (patterns/cases always have one)
 * 2. First sentence of text (heuristic)
 *
 * If the text is already short (≤ MAX_ANCHOR_LENGTH), returns undefined
 * (no anchor needed — the text itself is a good match target).
 */
export function generateAnchor(
  text: string,
  metadata?: Record<string, unknown>,
): string | undefined {
  // Short text already matches short queries well — skip anchor
  if (text.length <= MAX_ANCHOR_LENGTH) return undefined;

  // Try structured title first (most precise)
  const title = extractTitle(metadata);
  if (title && title.length <= MAX_ANCHOR_LENGTH) {
    return title;
  }

  // Fall back to first sentence
  let anchor = firstSentence(text);

  // Truncate to max length, preserving word/char boundary
  if (anchor.length > MAX_ANCHOR_LENGTH) {
    if (CJK_RE.test(anchor)) {
      // CJK: cut at char boundary
      anchor = anchor.slice(0, MAX_ANCHOR_LENGTH);
    } else {
      // Latin: cut at word boundary
      anchor = anchor.slice(0, MAX_ANCHOR_LENGTH).replace(/\s+\S*$/, "");
    }
  }

  // If anchor is too similar to full text start, it adds no value
  if (anchor === text.slice(0, anchor.length)) {
    // Still useful — the shorter embedding will be closer to short queries
    return anchor;
  }

  return anchor || undefined;
}
