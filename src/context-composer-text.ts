import { normalizeText } from "./term-registry.js";

export function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function cleanText(text: string, maxLen: number): string {
  const compact = compactWhitespace(text);
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

export function stripConversationMarkers(text: string): string {
  return text
    .replace(/<image[^>]*>\s*/gi, "")
    .replace(/\[(用户|助手|Pinned Asset|Memory Brief)\]\s*/g, "")
    .replace(/\bSummary:\s*/gi, "")
    .replace(/\bSnippet:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tier 3.1: Extract the best available summary text from a memory entry.
 * Priority: core_summary > l1_overview > l0_abstract > raw text.
 * Falls back to raw text (stripped of conversation markers) when no summaries exist.
 */
export function bestSummaryText(text: string, metadata?: string): string {
  if (metadata) {
    try {
      const meta = JSON.parse(metadata);
      if (typeof meta.core_summary === "string" && meta.core_summary.length > 0) {
        return meta.core_summary;
      }
      if (typeof meta.l1_overview === "string" && meta.l1_overview.length > 0) {
        return meta.l1_overview;
      }
      if (typeof meta.l0_abstract === "string" && meta.l0_abstract.length > 0) {
        return meta.l0_abstract;
      }
    } catch { /* metadata parse failed, use raw text */ }
  }
  return stripConversationMarkers(text);
}

export function dedupeText(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const key = normalizeText(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length >= limit) break;
  }
  return output;
}
