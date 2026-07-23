import type { MemoryEntry } from "./store.js";
import type { RetrievalResult } from "./retriever.js";
import type { RetrievalProfileName } from "./retrieval-profiles.js";
import { extractMemoryProvenance } from "./memory-boundaries.js";
import { extractMultiVectorText } from "./multi-vector.js";
import { parseNarrative } from "./narrative-schema.js";
import { getConfidence, getConfidenceMetadata } from "./confidence-tracker.js";
import { estimateTokens } from "./context-collapse-renderer.js";
import { evaluateEntryFreshness, createFreshnessCache } from "./freshness.js";

interface MemoryMetadata {
  source?: string;
  sessionId?: string;
  file?: string;
  heading?: string;
  preferenceSlot?: {
    type?: string;
    brand?: string;
    item?: string;
    traits?: string[];
    preferredTool?: string;
    avoidedTool?: string;
  };
  [key: string]: unknown;
}

interface RenderContext {
  query: string;
  profile: RetrievalProfileName;
}

export interface DistilledSourceSummary {
  source: string;
  hits: number;
  newest: string;
  files: string[];
}

export interface DistilledEvidence {
  memoryId: string;
  source: string;
  scope: string;
  date: string;
  retrievalPath: string;
  snippet: string;
}

export interface DistilledSummary {
  query: string;
  profile: RetrievalProfileName;
  hits: number;
  sources: DistilledSourceSummary[];
  takeaways: string[];
  evidence: DistilledEvidence[];
  reusableCandidates: string[];
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

function getCategoryLabel(result: RetrievalResult): string {
  return result.entry.category || "other";
}

function getTierLabel(result: RetrievalResult): string {
  const meta = parseMetadata(result.entry);
  return String(meta.tier || "peripheral");
}

function getProvenanceSummary(result: RetrievalResult): string {
  const provenance = extractMemoryProvenance({
    scope: result.entry.scope,
    metadata: result.entry.metadata,
  });
  const boundary = provenance.boundary;
  const meta = parseMetadata(result.entry);
  const parts = [
    boundary
      ? `${boundary.layer}/${boundary.authority}`
      : result.entry.scope.startsWith("memory:") || result.entry.scope.startsWith("asset:")
        ? "durable/?"
        : result.entry.scope.startsWith("cc:") || result.entry.scope.startsWith("codex:") || result.entry.scope.startsWith("gemini:")
          ? "evidence/?"
          : "-",
  ];

  if (boundary?.downgradedFrom) {
    parts.push(`downgraded:${boundary.downgradedFrom}`);
  }

  if (provenance.canonicalKey) {
    parts.push(`key:${provenance.canonicalKey}`);
  }

  if (provenance.promotedFrom) {
    const promotedBoundary = provenance.promotedFrom.boundary;
    const promotedLabel = promotedBoundary
      ? `${promotedBoundary.layer}/${promotedBoundary.authority}`
      : "-";
    parts.push(`promoted:${provenance.promotedFrom.memoryId.slice(0, 8)}<-${promotedLabel}`);
  }

  const hasObservationHistory =
    provenance.provenanceHistoryCount > 1 ||
    provenance.provenanceHistory.some((item) => typeof item.observedAt === "string");
  if (hasObservationHistory) {
    parts.push(`history:${provenance.provenanceHistoryCount}`);
    const latestObservation = [...provenance.provenanceHistory]
      .reverse()
      .find((item) => typeof item.observedAt === "string");
    if (latestObservation?.observedAt) {
      parts.push(`observed:${latestObservation.memoryId.slice(0, 8)}@${latestObservation.observedAt.slice(0, 10)}`);
    }
  }

  const preferenceSlot = meta.preferenceSlot;
  if (
    preferenceSlot?.type === "brand-item" &&
    typeof preferenceSlot.brand === "string" &&
    typeof preferenceSlot.item === "string"
  ) {
    parts.push(`slot:${preferenceSlot.type}:${preferenceSlot.brand}:${preferenceSlot.item}`);
  } else if (
    preferenceSlot?.type === "reply-style" &&
    Array.isArray(preferenceSlot.traits) &&
    preferenceSlot.traits.length > 0
  ) {
    parts.push(`slot:${preferenceSlot.type}:${preferenceSlot.traits.join(":")}`);
  } else if (
    preferenceSlot?.type === "tool-choice" &&
    typeof preferenceSlot.preferredTool === "string" &&
    typeof preferenceSlot.avoidedTool === "string"
  ) {
    parts.push(`slot:${preferenceSlot.type}:${preferenceSlot.preferredTool}:over:${preferenceSlot.avoidedTool}`);
  }

  return parts.join(" | ");
}

export function selectBriefSeedResults(results: RetrievalResult[]): RetrievalResult[] {
  const directResults = results.filter((result) => getSourceLabel(result) !== "asset");
  return directResults.length > 0 ? directResults : results;
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
  if (result.sources.narrativeSibling) parts.push("narrative");
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

/**
 * adaptive 专用 query-aware snippet：取匹配词周围窗口（而非整句/开头），保证匹配证据可见。
 * 解决 pickBestSnippet 的两个退化（Codex 审点4 C 版 P2）：① 短缩写 query（如 "CI"）
 * extractTerms 提取不到词 → 退回开头；② 匹配在超长句/log 行后段 → cleanSnippet 从头截断丢匹配。
 * 只给 adaptive 用，不改 pickBestSnippet（避免影响 normal/explain 的既有行为）。
 */
function adaptiveSnippet(query: string, text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();
  // 短缩写时 extractTerms 可能为空，用 raw query 兜底直接定位。
  const terms = extractTerms(query);
  const isFallback = terms.length === 0;
  const searchTerms = (isFallback ? [query.toLowerCase().trim()] : terms).filter(Boolean);

  let matchIdx = -1;
  for (const term of searchTerms) {
    // term 定位策略：
    // - ASCII 字母数字短缩写（CI/PR）用 word boundary，避免误匹配 "specific" 里的 "ci"（Codex C P2）
    // - CJK 单字 / 符号 query（猫 / C++ / C#）：JS \b 只认 ASCII、对它们永不匹配，回到 substring（收尾审 P2-1）
    // - 正常 extractTerms 词：substring（容忍词根 / 词形）
    // 已知限制（收尾审 P2-2，留后续）：多 term 取最早出现，未按 term rarity/coverage 给窗口打分——
    // 泛词在前、判别词在窗口外时可能漏掉判别词。第一版接受。
    let idx: number;
    if (isFallback && /^[a-z0-9]+$/i.test(term)) {
      const m = new RegExp(`\\b${term}\\b`, "i").exec(clean);
      idx = m ? m.index : -1;
    } else {
      idx = lower.indexOf(term);
    }
    if (idx >= 0 && (matchIdx < 0 || idx < matchIdx)) matchIdx = idx;
  }
  if (matchIdx < 0) return pickBestSnippet(query, text); // 完全无匹配 → 退回整句最佳

  const WINDOW_BEFORE = 60;
  const WINDOW_AFTER = 180;
  const start = Math.max(0, matchIdx - WINDOW_BEFORE);
  const end = Math.min(clean.length, matchIdx + WINDOW_AFTER);
  let snip = clean.slice(start, end).trim();
  if (start > 0) snip = "…" + snip;
  if (end < clean.length) snip = snip + "…";
  return snip;
}

function normalizeRecallText(result: RetrievalResult): string {
  const source = getSourceLabel(result);
  if (source !== "asset") return result.entry.text;

  return result.entry.text
    .replace(/^\[(Pinned Asset|Memory Brief)\]\s*/i, "")
    .replace(/\bSummary:\s*/gi, "")
    .replace(/\bSnippet:\s*/gi, "")
    .replace(/\bOriginal Scope:.*$/gim, "")
    .replace(/\bTags:.*$/gim, "")
    .replace(/\bSources:\s*/gi, "")
    .replace(/\bReusable:\s*/gi, "")
    .replace(/\bTakeaways:\s*/gi, "")
    .replace(/\bProfile:\s*/gi, "")
    .replace(/\bQuery:\s*/gi, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
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
    `${(result.score * 100).toFixed(1)}%`.padEnd(6),
    getCategoryLabel(result).padEnd(12),
    getTierLabel(result).padEnd(10),
    getSourceLabel(result).padEnd(7),
    getDateLabel(result.entry.timestamp),
    getRetrievalPath(result).padEnd(20),
    getFileLabel(result),
    cleanSnippet(pickBestSnippet(query, result.entry.text), 120),
  ];
}

function extractBriefExcerpt(result: RetrievalResult): string {
  const { l0 } = extractMultiVectorText(result.entry.metadata);
  const raw = l0 || result.entry.text;
  return cleanSnippet(raw, 80);
}

export function formatBriefResults(
  results: RetrievalResult[],
  context: { query: string },
): string {
  if (results.length === 0) return "No results found.";
  const freshnessCache = createFreshnessCache();
  const lines = [`Query: ${context.query}`, `Hits: ${results.length}`, ""];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const excerpt = extractBriefExcerpt(r);
    // Freshness suffix: only for memories that declared dependsOn (opt-in, cheap check).
    const fresh = evaluateEntryFreshness(r.entry.metadata, freshnessCache);
    const freshTag = fresh ? ` [fresh:${fresh}]` : "";
    lines.push(`#${i + 1} ${r.entry.id.slice(0, 8)} ${(r.score * 100).toFixed(1)}% — ${excerpt}${freshTag}`);
  }
  return lines.join("\n");
}

export function formatFullResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  if (results.length === 0) return "No results found.";

  const freshnessCache = createFreshnessCache();
  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Hits    : ${results.length}`,
    "",
    "#  ID       Score Category     Tier       Source  Date       Retrieval Path       File / Snippet",
    "-- -------- ----- ------------ ---------- ------- ---------- -------------------- --------------",
  ];

  for (let i = 0; i < results.length; i++) {
    const row = buildSearchRow(i, context.query, results[i]);
    lines.push(`${row[0]} ${row[1]} ${row[2]} ${row[3]} ${row[4]} ${row[5]} ${row[6]} ${row[7]} ${row[8]} | ${row[9]}`);
    lines.push(`   prov : ${getProvenanceSummary(results[i])}`);
    // Full mode: append metadata details
    const meta = parseMetadata(results[i].entry);
    const evolution = typeof meta.evolutionStatus === "string" ? meta.evolutionStatus : "-";
    const accessCount = typeof meta.accessCount === "number" ? String(meta.accessCount) : "-";
    const readers = typeof meta.distinctReaderCount === "number" ? String(meta.distinctReaderCount) : "-";
    const importance = results[i].entry.importance.toFixed(2);
    const tags = Array.isArray(meta.tags) ? (meta.tags as string[]).join(", ") : "-";
    // Emotion metadata (from emotion-detector)
    const emotionPart = meta.emotion && typeof meta.emotion === "object"
      ? ` emotion=${(meta.emotion as Record<string, unknown>).label ?? "-"}(v=${(meta.emotion as Record<string, unknown>).valence ?? 0},a=${(meta.emotion as Record<string, unknown>).arousal ?? 0})`
      : "";
    // HP-narrative: Narrative metadata (from narrative-tagger)
    const narrative = parseNarrative(results[i].entry.metadata);
    const narrativePart = narrative
      ? ` narrative=${narrative.lifePeriodLabel}/${narrative.generalEventLabel}`
      : "";
    // F1: Confidence metadata
    const confMeta = getConfidenceMetadata(results[i].entry);
    const confPart = confMeta
      ? ` confidence=${confMeta.score.toFixed(2)}(${confMeta.reliability})`
      : "";
    lines.push(`   meta : evolution=${evolution} accessCount=${accessCount} readers=${readers} importance=${importance} tags=[${tags}]${confPart}${emotionPart}${narrativePart}`);
    // Freshness: only shown for memories that declared dependsOn (opt-in, cheap check).
    const fresh = evaluateEntryFreshness(results[i].entry.metadata, freshnessCache);
    if (fresh) lines.push(`   fresh: ${fresh}`);
  }

  return lines.join("\n");
}

export function formatSearchResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  if (results.length === 0) return "No results found.";

  const freshnessCache = createFreshnessCache();
  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Hits    : ${results.length}`,
    "",
    "#  ID       Score Category     Tier       Source  Date       Retrieval Path       File / Snippet",
    "-- -------- ----- ------------ ---------- ------- ---------- -------------------- --------------",
  ];

  for (let i = 0; i < results.length; i++) {
    const row = buildSearchRow(i, context.query, results[i]);
    lines.push(`${row[0]} ${row[1]} ${row[2]} ${row[3]} ${row[4]} ${row[5]} ${row[6]} ${row[7]} ${row[8]} | ${row[9]}`);
    lines.push(`   prov : ${getProvenanceSummary(results[i])}`);
    // Freshness: only shown for memories that declared dependsOn (opt-in, cheap check).
    const fresh = evaluateEntryFreshness(results[i].entry.metadata, freshnessCache);
    if (fresh) lines.push(`   fresh: ${fresh}`);
  }

  return lines.join("\n");
}

const ADAPTIVE_TOKEN_BUDGET = 8000;
const ADAPTIVE_FULL_SCORE = 0.85;

/**
 * P-fidelity (点4): adaptive 保真度渲染 — 借鉴 RepoPrompt CE「保真度阶梯」的内核
 * （按相关性分配保真度 + token 预算），但 search-native 实现。
 *
 * 为什么不复用 resume_context 的 collapseResults（CC+Codex 共识，Codex 三轮 review）：
 * collapse 的 l0 floor / 按 score 重排 / query-agnostic fallback 都是为 resume 场景定制，
 * 搬到 search 连续撞三个 P2（隐藏过滤 / 覆盖 highlight 排序 / 丢失匹配证据）。search 的语义
 * 不同——结果是"为什么这条命中"，必须 query-aware；故第一版自实现两档：
 *   - 高相关（score ≥ 0.85）→ 全文
 *   - 其余 → query-aware snippet（pickBestSnippet，显示匹配证据）
 * 按 handler 传入顺序（normal=score / highlight=contextual）依次填入 token 预算，超预算时
 * 全文降级 snippet、snippet 仍超则停止（剩余计入 omitted）。完整三档保真度阶梯（每条记忆预存
 * 多档摘要 + 预缓存 token 成本）留作后续大改。
 */
export function formatCollapsedResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  if (results.length === 0) return "No results found.";

  const rendered: string[] = [];
  let tokensUsed = 0;
  let shown = 0;

  // 保留传入顺序（不重排）：handler 已按 normal=score / highlight=contextual 排好。
  for (const r of results) {
    const isFull = r.score >= ADAPTIVE_FULL_SCORE;
    let level = isFull ? "FULL" : "SNIP";
    // query-aware：snippet 取匹配词周围窗口、显示匹配证据（search 是"为什么命中"）。
    let text = isFull ? r.entry.text : adaptiveSnippet(context.query, r.entry.text);
    let tokens = estimateTokens(text);

    if (tokensUsed + tokens > ADAPTIVE_TOKEN_BUDGET) {
      if (isFull) {
        // 全文超预算 → 降级为 query-aware snippet
        text = adaptiveSnippet(context.query, r.entry.text);
        level = "SNIP";
        tokens = estimateTokens(text);
      }
      if (tokensUsed + tokens > ADAPTIVE_TOKEN_BUDGET) break; // snippet 仍超 → 停止，剩余计入 omitted
    }
    tokensUsed += tokens;
    shown++;

    // 定位信息：id / score / category / source（Codex 约束：search 结果必须可定位）
    const id = r.entry.id.slice(0, 8);
    const scorePct = `${(r.score * 100).toFixed(0)}%`;
    rendered.push(`[${level}] ${id}  ${scorePct}  ${getCategoryLabel(r)}  ${getSourceLabel(r)}`);
    rendered.push(text);
    rendered.push("");
  }

  const omitted = results.length - shown;
  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Mode    : adaptive — full text for score ≥ ${ADAPTIVE_FULL_SCORE}, query-aware snippet otherwise, ${ADAPTIVE_TOKEN_BUDGET}-token budget`,
    `Shown   : ${shown} of ${results.length}${omitted > 0 ? ` (${omitted} omitted: token budget)` : ""}`,
    "",
    ...rendered,
  ];
  return lines.join("\n").trimEnd();
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
    const score = `${(result.score * 100).toFixed(1)}%`;
    const retrieval = getRetrievalPath(result);
    const file = getFileLabel(result);
    const session = getSessionLabel(result);
    const why = buildWhyMatched(context.query, result);

    lines.push(`${i + 1}. ${result.entry.id.slice(0, 8)} | ${score} | ${getSourceLabel(result)} | ${getDateLabel(result.entry.timestamp)}`);
    lines.push(`   category: ${getCategoryLabel(result)}`);
    lines.push(`   tier    : ${getTierLabel(result)}`);
    lines.push(`   path    : ${retrieval}`);
    lines.push(`   session : ${session}`);
    lines.push(`   file    : ${file}`);
    lines.push(`   prov    : ${getProvenanceSummary(result)}`);
    lines.push(`   why     : ${why}`);
    lines.push(`   snippet : ${pickBestSnippet(context.query, result.entry.text)}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function summarizeResults(
  results: RetrievalResult[],
  context: RenderContext,
): DistilledSummary {
  if (results.length === 0) {
    return {
      query: context.query,
      profile: context.profile,
      hits: 0,
      sources: [],
      takeaways: [],
      evidence: [],
      reusableCandidates: [],
    };
  }

  const sourceMap = new Map<string, { hits: number; newest: number; files: Set<string> }>();
  const topTakeaways: string[] = [];
  const evidence: DistilledEvidence[] = [];
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
    const takeaway = `${getSourceLabel(result)}: ${pickBestSnippet(context.query, normalizeRecallText(result))}`;
    if (!seenTakeaways.has(takeaway)) {
      topTakeaways.push(takeaway);
      seenTakeaways.add(takeaway);
    }
    if (topTakeaways.length >= 4) break;
  }

  for (const result of results.slice(0, 5)) {
    evidence.push({
      memoryId: result.entry.id,
      source: getSourceLabel(result),
      scope: result.entry.scope,
      date: getDateLabel(result.entry.timestamp),
      retrievalPath: getRetrievalPath(result),
      snippet: pickBestSnippet(context.query, normalizeRecallText(result)),
    });
  }

  for (const result of results) {
    const candidate = pickBestSnippet(context.query, normalizeRecallText(result));
    if (candidate.length < 20) continue;
    if (seenReusable.has(candidate)) continue;
    reusable.push(candidate);
    seenReusable.add(candidate);
    if (reusable.length >= 3) break;
  }

  const sources = Array.from(sourceMap.entries())
    .sort((a, b) => b[1].hits - a[1].hits)
    .map(([source, stats]) => ({
      source,
      hits: stats.hits,
      newest: getDateLabel(stats.newest),
      files: Array.from(stats.files).slice(0, 3),
    }));

  return {
    query: context.query,
    profile: context.profile,
    hits: results.length,
    sources,
    takeaways: topTakeaways,
    evidence,
    reusableCandidates: reusable,
  };
}

export function distillResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  const summary = summarizeResults(results, context);
  if (summary.hits === 0) return "No results found.";

  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Hits    : ${summary.hits}`,
    "",
    "Source Map",
    "Source     Hits  Newest      Files",
    "---------- ----- ----------  ------------------------------",
  ];

  for (const item of summary.sources) {
    lines.push(
      `${item.source.padEnd(10)} ${String(item.hits).padEnd(5)} ${item.newest.padEnd(10)}  ${item.files.join(", ") || "-"}`,
    );
  }

  lines.push("", "Core Takeaways");
  summary.takeaways.forEach((item, index) => lines.push(`${index + 1}. ${item}`));

  lines.push("", "Evidence");
  summary.evidence.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.source} | ${item.date} | ${item.retrievalPath} | ${item.snippet}`);
  });

  lines.push("", "Reusable Memory Candidates");
  if (summary.reusableCandidates.length === 0) {
    lines.push("1. No strong reusable memory candidate yet. Expand the query or use a broader profile.");
  } else {
    summary.reusableCandidates.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }

  return lines.join("\n");
}
