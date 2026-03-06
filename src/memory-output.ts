import type { MemoryEntry } from "./store.js";
import type { RetrievalResult } from "./retriever.js";
import type { RetrievalProfileName } from "./retrieval-profiles.js";

interface MemoryMetadata {
  source?: string;
  sessionId?: string;
  file?: string;
  heading?: string;
  [key: string]: unknown;
}

interface RenderContext {
  query: string;
  profile: RetrievalProfileName;
}

function parseMetadata(entry: MemoryEntry): MemoryMetadata {
  try {
    return JSON.parse(entry.metadata || "{}") as MemoryMetadata;
  } catch {
    return {};
  }
}

function getDateLabel(timestamp: number): string {
  if (!timestamp) return "unknown";
  return new Date(timestamp).toISOString().split("T")[0] || "unknown";
}

function getSourceLabel(result: RetrievalResult): string {
  const meta = parseMetadata(result.entry);
  return String(meta.source || result.entry.scope || "?");
}

function getFileLabel(result: RetrievalResult): string {
  const meta = parseMetadata(result.entry);
  return String(meta.file || meta.heading || "-");
}

function getSessionLabel(result: RetrievalResult): string {
  const meta = parseMetadata(result.entry);
  return String(meta.sessionId || result.entry.scope || "-");
}

function getRetrievalPath(result: RetrievalResult): string {
  const parts: string[] = [];
  if (result.sources.vector) parts.push("vector");
  if (result.sources.bm25) parts.push("bm25");
  if (result.sources.reranked) parts.push("reranked");
  return parts.join("+") || "direct";
}

function cleanSnippet(text: string, maxLen = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 3)}...`;
}

function extractTerms(query: string): string[] {
  const matches = query.match(/[\p{Script=Han}]{2,}|[a-z0-9._/-]{3,}/giu) || [];
  return Array.from(new Set(matches.map(term => term.toLowerCase()))).slice(0, 8);
}

function findMatchedTerms(query: string, text: string): string[] {
  const haystack = text.toLowerCase();
  return extractTerms(query).filter(term => haystack.includes(term));
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？.!?])\s+|\n+/)
    .map(part => part.trim())
    .filter(Boolean);
}

function pickBestSnippet(query: string, text: string): string {
  const terms = extractTerms(query);
  const sentences = splitSentences(text);
  if (sentences.length === 0) return cleanSnippet(text);

  let bestSentence = sentences[0] || text;
  let bestScore = -1;

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
    if (score > bestScore) {
      bestSentence = sentence;
      bestScore = score;
    }
  }

  return cleanSnippet(bestSentence);
}

function ageDays(timestamp: number): number | null {
  if (!timestamp) return null;
  return Math.max(0, (Date.now() - timestamp) / 86_400_000);
}

function buildWhyMatched(query: string, result: RetrievalResult): string {
  const reasons: string[] = [];
  const matchedTerms = findMatchedTerms(query, result.entry.text);
  const meta = parseMetadata(result.entry);

  if (result.sources.vector && result.sources.bm25) {
    reasons.push("semantic+keyword");
  } else if (result.sources.vector) {
    reasons.push("semantic");
  } else if (result.sources.bm25) {
    reasons.push("keyword");
  }

  if (result.sources.reranked) {
    reasons.push("reranked");
  }

  if (matchedTerms.length > 0) {
    reasons.push(`terms:${matchedTerms.slice(0, 3).join(",")}`);
  }

  const days = ageDays(result.entry.timestamp);
  if (days !== null && days <= 14) {
    reasons.push(`fresh:${Math.round(days)}d`);
  }

  if ((result.entry.importance || 0) >= 0.7) {
    reasons.push("important");
  }

  if (meta.heading) {
    reasons.push(`heading:${String(meta.heading).slice(0, 24)}`);
  }

  return reasons.join(" | ") || "retrieved";
}

function buildSearchRow(index: number, query: string, result: RetrievalResult): string[] {
  return [
    String(index + 1).padEnd(2),
    result.entry.id.slice(0, 8).padEnd(8),
    `${(result.score * 100).toFixed(0)}%`.padEnd(5),
    getSourceLabel(result).padEnd(7),
    getDateLabel(result.entry.timestamp),
    getRetrievalPath(result).padEnd(20),
    getFileLabel(result),
    cleanSnippet(pickBestSnippet(query, result.entry.text), 120),
  ];
}

export function formatSearchResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  if (results.length === 0) return "No results found.";

  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Hits    : ${results.length}`,
    "",
    "#  ID       Score Source  Date       Retrieval Path       File / Snippet",
    "-- -------- ----- ------- ---------- -------------------- --------------",
  ];

  for (let i = 0; i < results.length; i++) {
    const row = buildSearchRow(i, context.query, results[i]);
    lines.push(`${row[0]} ${row[1]} ${row[2]} ${row[3]} ${row[4]} ${row[5]} ${row[6]} | ${row[7]}`);
  }

  return lines.join("\n");
}

export function formatExplainResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  if (results.length === 0) return "No results found.";

  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Hits    : ${results.length}`,
    "",
    "# Explain",
  ];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const score = `${(result.score * 100).toFixed(0)}%`;
    const retrieval = getRetrievalPath(result);
    const file = getFileLabel(result);
    const session = getSessionLabel(result);
    const why = buildWhyMatched(context.query, result);

    lines.push(`${i + 1}. ${result.entry.id.slice(0, 8)} | ${score} | ${getSourceLabel(result)} | ${getDateLabel(result.entry.timestamp)}`);
    lines.push(`   path    : ${retrieval}`);
    lines.push(`   session : ${session}`);
    lines.push(`   file    : ${file}`);
    lines.push(`   why     : ${why}`);
    lines.push(`   snippet : ${pickBestSnippet(context.query, result.entry.text)}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function distillResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  if (results.length === 0) return "No results found.";

  const sourceMap = new Map<string, { hits: number; newest: number; files: Set<string> }>();
  const topTakeaways: string[] = [];
  const evidence: string[] = [];
  const reusable: string[] = [];
  const seenTakeaways = new Set<string>();
  const seenReusable = new Set<string>();

  for (const result of results) {
    const source = getSourceLabel(result);
    const file = getFileLabel(result);
    const bucket = sourceMap.get(source) || { hits: 0, newest: 0, files: new Set<string>() };
    bucket.hits += 1;
    bucket.newest = Math.max(bucket.newest, result.entry.timestamp || 0);
    if (file !== "-") bucket.files.add(file);
    sourceMap.set(source, bucket);
  }

  for (const result of results) {
    const takeaway = `${getSourceLabel(result)}: ${pickBestSnippet(context.query, result.entry.text)}`;
    if (!seenTakeaways.has(takeaway)) {
      topTakeaways.push(takeaway);
      seenTakeaways.add(takeaway);
    }
    if (topTakeaways.length >= 4) break;
  }

  for (const result of results.slice(0, 5)) {
    evidence.push(
      `${getSourceLabel(result)} | ${getDateLabel(result.entry.timestamp)} | ${getRetrievalPath(result)} | ${pickBestSnippet(context.query, result.entry.text)}`,
    );
  }

  for (const result of results) {
    const candidate = pickBestSnippet(context.query, result.entry.text);
    if (candidate.length < 20) continue;
    if (seenReusable.has(candidate)) continue;
    reusable.push(candidate);
    seenReusable.add(candidate);
    if (reusable.length >= 3) break;
  }

  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Hits    : ${results.length}`,
    "",
    "Source Map",
    "Source     Hits  Newest      Files",
    "---------- ----- ----------  ------------------------------",
  ];

  const sortedSources = Array.from(sourceMap.entries()).sort((a, b) => b[1].hits - a[1].hits);
  for (const [source, stats] of sortedSources) {
    lines.push(
      `${source.padEnd(10)} ${String(stats.hits).padEnd(5)} ${getDateLabel(stats.newest).padEnd(10)}  ${Array.from(stats.files).slice(0, 3).join(", ") || "-"}`,
    );
  }

  lines.push("", "Core Takeaways");
  topTakeaways.forEach((item, index) => lines.push(`${index + 1}. ${item}`));

  lines.push("", "Evidence");
  evidence.forEach((item, index) => lines.push(`${index + 1}. ${item}`));

  lines.push("", "Reusable Memory Candidates");
  if (reusable.length === 0) {
    lines.push("1. No strong reusable memory candidate yet. Expand the query or use a broader profile.");
  } else {
    reusable.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }

  return lines.join("\n");
}
