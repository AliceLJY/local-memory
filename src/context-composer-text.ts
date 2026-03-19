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
