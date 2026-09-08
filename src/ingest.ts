/**
 * Ingest Pipeline — 把各种来源的对话/文件转成 MemoryEntry 喂进 LanceDB
 *
 * 支持的数据源：
 * 1. Claude Code transcript (.jsonl) — 提取 user/assistant 对话轮次
 * 2. Codex sessions (.jsonl) — 提取 response_item + event_msg
 * 3. Markdown 记忆文件 (.md) — 按标题分块
 * 4. Gemini conversations — 暂不支持（加密 protobuf，等官方开放导出）
 */

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { detectLang, tokenizeFts } from "./language-hook.js";
import { redactSecrets } from "./pii-detector.js";
import type { MemoryStore, MemoryEntry } from "./store.js";
import type { Embedder } from "./embedder.js";
import { chunkDocument, type ChunkerConfig } from "./chunker.js";
import type { ConnectorOutputV1, ConnectorRecord } from "./connector-types.js";
import { isConnectorOutputV1 } from "./connector-types.js";
import { isObsidianVault, scanVault } from "./obsidian-connector.js";
import { segmentEvents, type EventSegmenterConfig, DEFAULT_EVENT_SEGMENTER_CONFIG } from "./event-segmenter.js";
import { isProcessed, markProcessed } from "./tracker.js";
import * as envConfig from "./env-config.js";
import type { LLMClient, SmartExtraction } from "./llm-client.js";
import { resolveIngestBoundary } from "./memory-boundaries.js";
import { isActiveMemory } from "./memory-evolution.js";
import { isNoise } from "./noise-filter.js";
import {
  inferReplyStylePreferenceSlot,
  inferToolChoicePreferenceSlot,
  parseBrandItemPreference,
  samePreferenceSlot,
} from "./preference-slots.js";
import { compressToolOutput } from "./tool-output-compressor.js";
import { tagNarrativeIfEnabled } from "./narrative-tagger.js";

// ============================================================================
// Types
// ============================================================================

export interface IngestSource {
  path: string;
  glob: string;
  description: string;
}

export interface IngestResult {
  source: string;
  filesProcessed: number;
  chunksIngested: number;
  chunksSkipped: number;
  chunksDeduped: number;
  dedupReasonCounts: DedupReasonCounts;
  errors: string[];
  /** 子 agent 独立会话文件被整文件跳过的数量（目前只有 Codex 分支会产生；见 isCodexSubagentSessionFile）。 */
  subagentFilesSkipped?: number;
}

interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  sessionId: string;
  /**
   * 本条记忆所在 session 里用户亲手贴的图片总数——注意是整个 session 的，
   * 不是本轮的张数。工具产的图（截图 / 读图，实测占全部图片九成）不计。
   *
   * 粒度取 session 而不是轮次，是有意的（2026-08-27 定）：图所在的那一轮
   * 常常因为正文太短根本没进库，精确坐标挂不上去；而同 session 的别的轮次
   * 进了库。打成 session 级的标，搜到那些轮次时才能顺藤摸到图。
   *
   * 代价是精度低：一个 session 里几十条记忆会带同一个标，图未必跟搜到的
   * 这一条有关。这是粒度换覆盖，明知而为——判断值不值得看，回 Deja 按
   * session 读原文，图本体不进库。
   */
  sessionImages?: number;
  /**
   * 本 session 里 AI 自己产的图片总数：工具截图、读进来的图片文件、模型生成的图。
   * 实测它是用户贴图的三倍多（5812 vs 1629）。
   *
   * 跟 sessionImages 分开计，因为两者服务的检索意图不是一回事——人找「我发过的
   * 那张截图」要的是前者；agent 回溯「我当时生成的示意图长什么样」「那个页面当时
   * 渲染成什么样」要的是后者。混成一个数，两种意图都答不好；只留前者，则 agent
   * 自己回溯时看不见任何线索。
   */
  sessionToolImages?: number;
}

// ============================================================================
// Dedup & L0 Summary
// ============================================================================

/** Score thresholds for two-stage dedup (borrowed from memory-lancedb-pro v1.1.0).
 *  - Above HARD: definitely duplicate, skip without LLM
 *  - Between SOFT and HARD: borderline, ask LLM if available
 *  - Below SOFT: definitely unique, store directly
 *
 *  2026-03-26: raised from 0.80/0.68 → 0.92/0.78.
 *  Old thresholds caused 72% data loss — temporal events, user instructions,
 *  and file operations on familiar topics were killed as "duplicates".
 */
const DEDUP_HARD_THRESHOLD = 0.92;
const DEDUP_SOFT_THRESHOLD = 0.78;
const DEDUP_CANDIDATE_LIMIT = 5;

interface AtomicPreferenceGuardDecision {
  shouldForceCreate: boolean;
  matchedText?: string;
}

export type DedupReason = "hard" | "exact" | "llm-skip" | "llm-merge" | "unique";

export type DedupReasonCounts = Record<DedupReason, number>;

/** Secondary action on an existing memory during dedup (e.g., delete outdated entries). */
export interface DedupAction {
  id: string;
  action: "delete";
  reason: string;
}

export interface DedupCheckResult {
  action: "store" | "skip";
  reason: DedupReason;
  existingText?: string;
  /** Secondary actions on other existing memories (only populated with LLM dedup). */
  secondaryDeletes?: DedupAction[];
}

function createDedupReasonCounts(): DedupReasonCounts {
  return {
    hard: 0,
    exact: 0,
    "llm-skip": 0,
    "llm-merge": 0,
    unique: 0,
  };
}

function recordDedupDecision(result: IngestResult, decision: DedupCheckResult): void {
  result.dedupReasonCounts[decision.reason] += 1;
  if (decision.reason !== "unique") {
    result.chunksDeduped += 1;
  }
}

/**
 * Execute secondary delete actions from a dedup decision.
 * Errors are isolated per-action to avoid cascading failures.
 */
async function executeSecondaryDeletes(
  store: MemoryStore,
  deletes: DedupAction[],
): Promise<number> {
  let executed = 0;
  for (const del of deletes) {
    try {
      await store.delete(del.id);
      executed++;
    } catch {
      // Per-action error isolation: log and continue
    }
  }
  return executed;
}

export function getDedupSkippedCount(result: IngestResult): number {
  return result.dedupReasonCounts.hard
    + result.dedupReasonCounts.exact
    + result.dedupReasonCounts["llm-skip"];
}

export function getDedupSkipRate(result: IngestResult): number {
  const skipped = getDedupSkippedCount(result);
  const considered = result.chunksIngested + skipped;
  if (considered === 0) return 0;
  return skipped / considered;
}

export function formatDedupReasonSummary(result: IngestResult): string {
  const counts = result.dedupReasonCounts;
  return `hard:${counts.hard}, exact:${counts.exact}, llm-skip:${counts["llm-skip"]}, llm-merge:${counts["llm-merge"]}`;
}

/**
 * Two-stage dedup: vector pre-filter + optional LLM semantic decision.
 *
 * Returns: "store" | "skip"
 *
 * Note: when the LLM says MERGE, we currently keep the new chunk instead of
 * dropping it. We do not have a structured ingest-time merge path yet, and
 * swallowing "same topic + new information" transcript chunks is worse for
 * recall fidelity than storing an incremental near-duplicate.
 */
function normalizeDedupText(value: string): string {
  return value
    .replace(/^\[(用户|助手)\]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect content that carries temporal events, file operations, or explicit
 * user memory instructions. These should never be hard-deduped because they
 * describe *new happenings* about potentially familiar topics.
 *
 * Categories protected:
 * 1. Date-stamped events (2026-03-25, 昨天, 今天, etc.)
 * 2. File operations (paths with /, mv, cp, mkdir, 整理, 搬到, 放到)
 * 3. Explicit memory instructions (记住, remember, 以后注意, 别忘了)
 * 4. Feedback/corrections (不要, 别再, stop doing, don't)
 */
export function isTemporalOrActionContent(text: string): boolean {
  // Date patterns: ISO dates, Chinese relative dates
  const datePattern = /\b20\d{2}[-/]\d{2}[-/]\d{2}\b|昨天|今天|前天|上次|刚才|刚刚|本周|这周|上周/;
  // File operation patterns
  const fileOpPattern = /\/Users\/|~\/|\.md\b|\.json\b|mkdir|mv\s|cp\s|整理|搬到|放到|移到|复制到|保存到|写入|归档/;
  // Explicit memory instructions
  const memoryPattern = /记住|remember|以后注意|别忘了|下次[要记别]|务必|一定要|不要忘/i;
  // Feedback/correction patterns
  const feedbackPattern = /不要再|别再|stop\s+doing|don'?t\s+\w+|以后别|纠正|改掉|这次的教训/i;

  return datePattern.test(text)
    || fileOpPattern.test(text)
    || memoryPattern.test(text)
    || feedbackPattern.test(text);
}

function shouldForceCreateAtomicPreference(
  incomingText: string,
  existingTexts: string[],
): AtomicPreferenceGuardDecision {
  const incoming = parseBrandItemPreference(incomingText);
  if (!incoming || incoming.aggregate || incoming.items.length !== 1) {
    return { shouldForceCreate: false };
  }

  let sameBrandDifferentItem: string | undefined;

  for (const existingText of existingTexts) {
    const existing = parseBrandItemPreference(existingText);
    if (!existing || existing.brand !== incoming.brand) continue;

    if (existing.items.includes(incoming.items[0])) {
      return { shouldForceCreate: false };
    }

    sameBrandDifferentItem = existingText;
  }

  return sameBrandDifferentItem
    ? { shouldForceCreate: true, matchedText: sameBrandDifferentItem }
    : { shouldForceCreate: false };
}

function shouldForceCreateReplyStylePreference(
  incomingText: string,
  existingTexts: string[],
): AtomicPreferenceGuardDecision {
  const incoming = inferReplyStylePreferenceSlot(incomingText);
  if (!incoming) {
    return { shouldForceCreate: false };
  }

  let matchedText: string | undefined;

  for (const existingText of existingTexts) {
    const existing = inferReplyStylePreferenceSlot(existingText);
    if (!existing) continue;

    if (samePreferenceSlot(existing, incoming)) {
      return { shouldForceCreate: false };
    }

    matchedText = existingText;
  }

  return matchedText
    ? { shouldForceCreate: true, matchedText }
    : { shouldForceCreate: false };
}

function shouldForceCreateToolChoicePreference(
  incomingText: string,
  existingTexts: string[],
): AtomicPreferenceGuardDecision {
  const incoming = inferToolChoicePreferenceSlot(incomingText);
  if (!incoming) {
    return { shouldForceCreate: false };
  }

  let matchedText: string | undefined;

  for (const existingText of existingTexts) {
    const existing = inferToolChoicePreferenceSlot(existingText);
    if (!existing) continue;

    if (samePreferenceSlot(existing, incoming)) {
      return { shouldForceCreate: false };
    }

    matchedText = existingText;
  }

  return matchedText
    ? { shouldForceCreate: true, matchedText }
    : { shouldForceCreate: false };
}

export async function dedupCheck(
  store: MemoryStore,
  vector: number[],
  text: string,
  llm?: LLMClient | null,
): Promise<DedupCheckResult> {
  try {
    // Stage 1: vector similarity check. store.vectorSearch() has no status filter, so
    // superseded belief-history rows surface here — dedupe against one and incoming
    // content gets dropped as a duplicate of a belief that is no longer held (returning
    // to an earlier position would be silently discarded).
    const results = (await store.vectorSearch(vector, DEDUP_CANDIDATE_LIMIT, DEDUP_SOFT_THRESHOLD))
      .filter((result) => isActiveMemory(result.entry.metadata));
    if (results.length === 0) {
      return { action: "store", reason: "unique" }; // Clearly unique
    }

    const normalizedIncoming = normalizeDedupText(text);
    const exact = results.find((result) => normalizeDedupText(result.entry.text) === normalizedIncoming);
    if (exact) {
      return { action: "skip", reason: "exact", existingText: exact.entry.text };
    }

    const atomicPreferenceGuard = shouldForceCreateAtomicPreference(
      text,
      results.map((result) => result.entry.text),
    );
    if (atomicPreferenceGuard.shouldForceCreate) {
      return {
        action: "store",
        reason: "unique",
        existingText: atomicPreferenceGuard.matchedText,
      };
    }

    const replyStyleGuard = shouldForceCreateReplyStylePreference(
      text,
      results.map((result) => result.entry.text),
    );
    if (replyStyleGuard.shouldForceCreate) {
      return {
        action: "store",
        reason: "unique",
        existingText: replyStyleGuard.matchedText,
      };
    }

    const toolChoiceGuard = shouldForceCreateToolChoicePreference(
      text,
      results.map((result) => result.entry.text),
    );
    if (toolChoiceGuard.shouldForceCreate) {
      return {
        action: "store",
        reason: "unique",
        existingText: toolChoiceGuard.matchedText,
      };
    }

    // Guard: temporal events, file operations, and explicit user memory instructions
    // bypass hard dedup — these are often about familiar topics but carry new facts.
    if (isTemporalOrActionContent(text)) {
      // Still allow exact dedup (handled above), but never hard-skip.
      // Fall through to LLM judgment if available, else store.
      const topScore = results[0].score;
      const existingText = results[0].entry.text;
      if (!llm) {
        return { action: "store", reason: "unique", existingText };
      }
      // Let LLM decide (skip the hard threshold)
      try {
        const hasMulti = typeof (llm as any).dedupDecisionMulti === "function";
        if (hasMulti) {
          const candidates = results
            .filter(r => r.score >= DEDUP_SOFT_THRESHOLD)
            .slice(0, DEDUP_CANDIDATE_LIMIT)
            .map(r => ({ id: r.entry.id, text: r.entry.text }));
          const decision = await llm.dedupDecisionMulti(text, candidates);
          if (decision.action === "SKIP") {
            return { action: "skip", reason: "llm-skip", existingText };
          }
          return { action: "store", reason: decision.action === "MERGE" ? "llm-merge" : "unique", existingText };
        } else {
          const decision = await llm.dedupDecision(text, existingText);
          if (decision.action === "SKIP") {
            return { action: "skip", reason: "llm-skip", existingText };
          }
          return { action: "store", reason: decision.action === "MERGE" ? "llm-merge" : "unique", existingText };
        }
      } catch {
        return { action: "store", reason: "unique", existingText };
      }
    }

    const topScore = results[0].score;
    const existingText = results[0].entry.text;

    // Hard duplicate: skip without LLM
    if (topScore >= DEDUP_HARD_THRESHOLD) {
      return { action: "skip", reason: "hard", existingText };
    }

    // Borderline: ask LLM if available
    if (llm) {
      try {
        // Use multi-candidate dedup if LLM supports it, else fall back to 1:1
        const hasMulti = typeof (llm as any).dedupDecisionMulti === "function";

        let primaryAction: "CREATE" | "MERGE" | "SKIP" = "CREATE";
        let primaryReason = "";
        const secondaryDeletes: DedupAction[] = [];

        if (hasMulti) {
          const candidates = results
            .filter(r => r.score >= DEDUP_SOFT_THRESHOLD)
            .slice(0, DEDUP_CANDIDATE_LIMIT)
            .map(r => ({ id: r.entry.id, text: r.entry.text }));

          const decision = await llm.dedupDecisionMulti(text, candidates);
          primaryAction = decision.action;
          primaryReason = decision.reason;

          // Build secondary deletes from validated actions (resolve IDs at parse time)
          if (decision.actions) {
            for (const act of decision.actions) {
              const target = candidates[act.match_index - 1];
              if (target) {
                secondaryDeletes.push({
                  id: target.id,
                  action: "delete",
                  reason: typeof act.reason === "string" ? act.reason : "",
                });
              }
            }
          }
        } else {
          const decision = await llm.dedupDecision(text, existingText);
          primaryAction = decision.action;
          primaryReason = decision.reason;
        }

        if (primaryAction === "SKIP") {
          return {
            action: "skip",
            reason: "llm-skip",
            existingText,
            ...(secondaryDeletes.length > 0 ? { secondaryDeletes } : {}),
          };
        }
        if (primaryAction === "MERGE") {
          return {
            action: "store",
            reason: "llm-merge",
            existingText,
            ...(secondaryDeletes.length > 0 ? { secondaryDeletes } : {}),
          };
        }
        // CREATE — still execute secondary deletes if any
        if (secondaryDeletes.length > 0) {
          return { action: "store", reason: "unique", secondaryDeletes };
        }
      } catch {
        // LLM failed, fall through to store
      }
    }

    return { action: "store", reason: "unique" };
  } catch {
    return { action: "store", reason: "unique" }; // Fail-open
  }
}

/**
 * Extractive L0 fallback: takes the first meaningful sentence.
 * Used when LLM is unavailable or fails.
 */
function extractL0Fallback(text: string): string {
  // Strip role prefixes
  const cleaned = text.replace(/^\[(用户|助手)\]\s*/gm, "").trim();

  // Split into sentences (Chinese + English punctuation)
  const sentences = cleaned.split(/(?<=[。！？\.\!\?\n])\s*/);

  for (const s of sentences) {
    const trimmed = s.trim();
    // Skip very short or boilerplate sentences
    if (trimmed.length >= 15 && !/^(好的|OK|是的|嗯|谢谢|Thanks)/.test(trimmed)) {
      return trimmed.slice(0, 150);
    }
  }

  // Fallback: first 150 chars
  return cleaned.slice(0, 150);
}

/** Fallback extraction result when LLM is unavailable */
function fallbackExtraction(text: string): SmartExtraction {
  return {
    category: "events", // Default to events (most common, safest)
    l0: extractL0Fallback(text),
    l1: "",
    importance: 0.6,
  };
}

/**
 * Smart extraction for a batch of texts.
 * Uses LLM 6-category extraction when available, falls back to heuristic.
 * Returns: category + L0 + L1 + importance for each text.
 */
async function smartExtractBatch(
  texts: string[],
  llm?: LLMClient | null,
): Promise<SmartExtraction[]> {
  if (!llm) {
    return texts.map(fallbackExtraction);
  }

  try {
    const llmResults = await llm.smartExtractBatch(texts);
    // Fill in fallbacks for any LLM failures
    return llmResults.map((r, i) => r ?? fallbackExtraction(texts[i]));
  } catch {
    return texts.map(fallbackExtraction);
  }
}

/**
 * Tier 3.1: Check if core summary generation is enabled.
 */
function isCoreSummaryEnabled(): boolean {
  return envConfig.coreSummary();
}

/**
 * Tier 3.1: Generate core summaries for a batch of texts.
 * Only runs when RECALLNEST_CORE_SUMMARY=true and LLM is available.
 * Returns null array when disabled (no overhead).
 */
async function generateCoreSummaries(
  texts: string[],
  llm?: LLMClient | null,
): Promise<(string | null)[]> {
  if (!isCoreSummaryEnabled() || !llm) {
    return new Array(texts.length).fill(null);
  }
  try {
    return await llm.generateCoreSummaryBatch(texts);
  } catch {
    return new Array(texts.length).fill(null);
  }
}

/**
 * Batch-internal cosine dedup: after extraction + embedding, remove candidates
 * whose vectors are too similar (>threshold) to a higher-importance candidate
 * in the same batch. This saves downstream per-entry LLM dedup calls.
 *
 * Returns indices of entries to KEEP (in original order).
 */
export function batchInternalDedup(
  vectors: number[][],
  importances: number[],
  threshold = 0.93,
): number[] {
  if (vectors.length <= 1) return vectors.map((_, i) => i);

  // Build index pairs sorted by importance descending (break ties by order)
  const order = vectors.map((_, i) => i)
    .sort((a, b) => (importances[b] ?? 0.5) - (importances[a] ?? 0.5) || a - b);

  const kept = new Set<number>();
  const keptVectors: number[][] = [];

  for (const idx of order) {
    const vec = vectors[idx];
    let tooSimilar = false;

    for (const kv of keptVectors) {
      if (cosine(vec, kv) > threshold) {
        tooSimilar = true;
        break;
      }
    }

    if (!tooSimilar) {
      kept.add(idx);
      keptVectors.push(vec);
    }
  }

  // Return in original order
  return vectors.map((_, i) => i).filter(i => kept.has(i));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm === 0 ? 0 : dot / norm;
}

// ─── Pending extraction queue (for when LLM is unavailable) ─────────────────

const PENDING_EXTRACTION_FILE = resolve(
  dirname(import.meta.url.replace("file://", "")), "..", "data", "pending-extraction.json"
);

function queueForLaterExtraction(chunks: Array<{ text: string; scope: string }>): void {
  let pending: Array<{ text: string; scope: string; queuedAt: string }> = [];
  try {
    const raw = JSON.parse(readFileSync(PENDING_EXTRACTION_FILE, "utf-8"));
    if (Array.isArray(raw)) pending = raw;
  } catch { /* empty or missing */ }
  const now = new Date().toISOString();
  for (const chunk of chunks) {
    pending.push({ ...chunk, queuedAt: now });
  }
  try {
    writeFileSync(PENDING_EXTRACTION_FILE, JSON.stringify(pending, null, 2));
  } catch (err) {
    console.error("[recallnest] Failed to write pending extraction queue:", err instanceof Error ? err.message : String(err));
  }
}

export async function drainPendingQueue(
  store: MemoryStore,
  embedder: Embedder,
  llm: LLMClient,
): Promise<{ processed: number; errors: number }> {
  let pending: Array<{ text: string; scope: string; queuedAt: string }> = [];
  try {
    const raw = JSON.parse(readFileSync(PENDING_EXTRACTION_FILE, "utf-8"));
    if (!Array.isArray(raw)) {
      console.error("[recallnest] Pending extraction queue is malformed (not an array), resetting");
      return { processed: 0, errors: 0 };
    }
    pending = raw;
  } catch { return { processed: 0, errors: 0 }; }

  if (pending.length === 0) return { processed: 0, errors: 0 };

  let processed = 0, errors = 0;
  for (let i = 0; i < pending.length; i += 20) {
    const batch = pending.slice(i, i + 20);
    // F-3b: scrub before the LLM extraction call and downstream embedding
    const texts = batch.map(c => redactSecrets(c.text).text);
    const extractions = await smartExtractBatch(texts, llm);
    const embeddingTexts = extractions.map(e => e.l1 || e.l0);
    const vectors = await embedder.embedBatchPassage(embeddingTexts);

    // Batch-internal dedup: drop near-duplicate candidates before storing
    const keepIndices = batchInternalDedup(
      vectors,
      extractions.map(e => e.importance),
    );

    for (const j of keepIndices) {
      try {
        const entryText = extractions[j].l1 || extractions[j].l0;
        const language = detectLang(entryText);
        const fts_text = tokenizeFts(entryText, language);
        // 2026-08-24 修：回填路径此前直接 store.store()，绕过 buildIngestedEntry，
        // 导致条目缺 boundary/layer/tier（transcript 碎片不降权）。改走同一构造器；
        // 入队时未保留原文件路径，file 用 "pending-queue" 诚实标记回填来源。
        const entry = buildIngestedEntry({
          source: batch[j].scope.split(":")[0],
          scope: batch[j].scope,
          text: entryText,
          vector: vectors[j],
          extraction: extractions[j],
          file: "pending-queue",
        });
        await store.store({
          ...entry,
          category: entry.category as any,
          language,
          fts_text,
        });
        processed++;
      } catch { errors++; }
    }
  }

  // Clear the queue
  try {
    writeFileSync(PENDING_EXTRACTION_FILE, "[]");
  } catch (err) {
    console.error("[recallnest] Failed to clear pending extraction queue:", err instanceof Error ? err.message : String(err));
  }
  return { processed, errors };
}

/** Determine initial tier based on category and importance */
function initialTier(extraction: Pick<SmartExtraction, "category" | "importance">): "core" | "working" | "peripheral" {
  // Profile and patterns are inherently important → working
  if (extraction.category === "profile" || extraction.category === "patterns") return "working";
  // Cases (problem→solution) are valuable → working
  if (extraction.category === "cases") return "working";
  // High importance → working
  if (extraction.importance >= 0.8) return "working";
  // Everything else → peripheral
  return "peripheral";
}

function buildIngestedEntry(params: {
  source: string;
  scope: string;
  text: string;
  vector: number[];
  extraction: SmartExtraction;
  file: string;
  sessionId?: string;
  heading?: string;
  /** Tier 3.1: optional core summary (≤200 chars) for token-efficient context output */
  coreSummary?: string | null;
  /** 本条记忆所在 session 里用户亲手贴的图片总数；无图时不传 */
  sessionImages?: number;
  /** 本条记忆所在 session 里 AI 自己产的图片总数（截图 / 读图 / 生图）；无则不传 */
  sessionToolImages?: number;
}): {
  text: string;
  vector: number[];
  category: string;
  scope: string;
  importance: number;
  metadata: string;
} {
  const resolution = resolveIngestBoundary({
    source: params.source,
    scope: params.scope,
    category: params.extraction.category,
  });
  const tier = resolution.boundary.layer === "evidence"
    ? "peripheral"
    : initialTier({
        category: resolution.category,
        importance: params.extraction.importance,
      });

  // HP-narrative: Tag with autobiographical narrative metadata when enabled
  const narrative = tagNarrativeIfEnabled({
    scope: params.scope,
    text: params.text,
    timestamp: Date.now(),
    sessionId: params.sessionId,
  });

  return {
    text: params.text,
    vector: params.vector,
    category: resolution.category,
    scope: params.scope,
    importance: params.extraction.importance,
    metadata: JSON.stringify({
      source: params.source,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      file: params.file,
      ...(params.heading ? { heading: params.heading } : {}),
      l0_abstract: params.extraction.l0,
      l1_overview: params.extraction.l1,
      l2_content: params.text,
      ...(params.coreSummary ? { core_summary: params.coreSummary } : {}),
      ...(params.sessionImages ? { sessionImages: params.sessionImages } : {}),
      ...(params.sessionToolImages ? { sessionToolImages: params.sessionToolImages } : {}),
      tier,
      boundary: resolution.boundary,
      ...(narrative ? { narrative } : {}),
    }),
  };
}

// ============================================================================
// Helpers
// ============================================================================

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function matchGlob(filename: string, glob: string): boolean {
  // Simple glob: *.jsonl, *.md, *.{json,md,txt}
  const patterns = glob
    .replace(/\{([^}]+)\}/g, (_, group) => `(${group.split(",").join("|")})`)
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*");
  return new RegExp(`^${patterns}$`).test(filename);
}

// Chunker config for conversation text
const CONVERSATION_CHUNK_CONFIG: ChunkerConfig = {
  maxChunkSize: 2000,
  overlapSize: 100,
  minChunkSize: 100,
  semanticSplit: true,
  maxLinesPerChunk: 40,
};

// Chunker config for markdown files
const MARKDOWN_CHUNK_CONFIG: ChunkerConfig = {
  maxChunkSize: 1500,
  overlapSize: 100,
  minChunkSize: 80,
  semanticSplit: true,
  maxLinesPerChunk: 30,
};

// ============================================================================
// CC Transcript Parser
// ============================================================================

/**
 * 数一条 transcript 记录里所有的图片信号，**不预设它们是什么用途、在什么位置**。
 *
 * 这是有意的宽口径：AI 产图的形态一直在长（工具截图、读进来的图片文件、模型生图、
 * 写公众号时让它配的插图……），任何"列举有哪几类"的写法都注定漏掉下一类。所以这里
 * 只回答一个问题——「这是不是一张图」，然后由调用方用**补集**去定义 AI 产图：
 * 整条记录里的图 减去 用户在消息里亲手贴的，剩下的全算，不问出身。
 *
 * 判据是「携带图片的块」的三种通用形态，跨 Anthropic / OpenAI / Kimi 都成立：
 *   - type 里含 image（image / input_image / image_url / image_generation_* …）
 *   - 有 image_url / imageUrl 字段
 *   - 有 media_type / mimeType 且以 image/ 开头
 *
 * ⚠️ 这是**信号计数不是精确张数**：一次生图可能同时留下 call 与 end 两条记录，
 * 会被数成 2。这是刻意选的方向——宁可多算，不可漏报，因为它服务的问题是
 * 「这附近有没有图」而不是「精确几张」。
 */
function countImageSignals(node: unknown, depth = 0): number {
  if (depth > 10 || node === null || typeof node !== "object") return 0;
  if (Array.isArray(node)) {
    let sum = 0;
    for (const item of node) sum += countImageSignals(item, depth + 1);
    return sum;
  }

  const obj = node as Record<string, unknown>;
  const type = obj.type;
  const mediaType = obj.media_type ?? obj.mimeType;
  const isImageBlock =
    (typeof type === "string" && type.includes("image")) ||
    typeof obj.image_url === "string" ||
    (obj.imageUrl !== null && typeof obj.imageUrl === "object") ||
    (typeof mediaType === "string" && mediaType.startsWith("image/"));

  // 命中即计一次并停止下钻：一个图片块内部不会再嵌另一张独立的图，继续递归
  // 只会把 {type:"image", source:{media_type:"image/png"}} 这种数成两张。
  if (isImageBlock) return 1;

  let count = 0;
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object") {
      count += countImageSignals(value, depth + 1);
    }
  }
  return count;
}

export function parseCCTranscript(filePath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  let sessionId = "";
  // 整个 session 里的图片计数，扫完全文后统一盖到每个 turn 上。两类分开数：
  // 用户亲手贴的 vs AI 自己产的（工具截图 / 读图 / 生图）。
  // 数得到是因为本函数本来就逐行读完整个文件，顺带累加不额外花钱。
  let sessionImages = 0;
  let sessionToolImages = 0;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // 子 agent 侧链（isSidechain:true）的 user 行是主 agent 写给子 agent 的任务信封，不是人说的话。
      // 今天 CC 把侧链分文件存在 <session>/subagents/agent-*.jsonl，而本函数的调用方只读项目目录顶层
      // 的 .jsonl，所以这一行当前不会命中；留着是防 CC 哪天把侧链内联回主文件（2026-09-08 借鉴 ECC
      // observe.sh 的「按结构字段认谁在说、不认 role」）。
      if (obj.isSidechain === true) continue;
      // 这一行里所有的图片信号。用户亲手贴的那部分在下面单独精确认，
      // 其余的一律按补集归入 AI 产图——不枚举它是截图、读图、生图还是配图。
      const lineImageSignals = countImageSignals(obj);
      let lineUserImages = 0;

      if (!sessionId && obj.sessionId) {
        sessionId = obj.sessionId;
      }

      if (obj.type === "user" && obj.message) {
        const msg = obj.message;
        let text = "";
        let turnImages = 0;
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          // 文本块照旧提取，tool_use / tool_result 仍然整块丢弃（架构决定，见 memory-boundaries）。
          // 图片本体也不进库，只数一下：这里只认顶层的 image block，
          // tool_result 里内嵌的不算——那是工具截图/读图，实测占全部图片九成。
          text = msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text || "")
            .join("\n");
          turnImages = msg.content.filter((c: any) => c?.type === "image").length;
        }
        sessionImages += turnImages;
        lineUserImages = turnImages;

        // 只贴图不配字的那一轮，此前会被长度闸整条丢掉——实测占含图轮次的 12.5%，
        // 且丢掉的常是「操作步骤在这里」+ 截图这类正文全在图里的高价值轮次
        // （最极端的样本是 0 字配 7 张图）。给它一个占位正文，让它能跟下一条
        // 助手回复合成 chunk——助手的回复通常描述了图里是什么，那就是定位这些图的文字。
        //
        // 有配文时正文一个字都不改：文字本身已是检索入口，往里塞标记只会稀释 embedding。
        const trimmed = text.trim();
        const body = trimmed.length > 0
          ? trimmed
          : turnImages > 0
            ? `[图片×${turnImages}]`
            : "";

        if (body.length > 10 || turnImages > 0) {
          turns.push({
            role: "user",
            text: body,
            timestamp: obj.timestamp || "",
            sessionId,
          });
        }
      }

      if (obj.type === "assistant" && obj.message) {
        const msg = obj.message;
        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text || "")
            .join("\n");
        }

        // 中文 8 字符已是完整句，阈值不宜过高（v1.1.0 反馈）
        if (text.trim().length > 8) {
          turns.push({
            role: "assistant",
            text: text.trim(),
            timestamp: obj.timestamp || "",
            sessionId,
          });
        }
      }

      // 补集：这一行里除用户亲手贴的之外的图，全算 AI 产的，不问出身。
      // 用补集而不是列举，是因为 AI 产图的形态会一直长（生图、截图、读图、
      // 写文章时的配图……），任何枚举都注定漏掉下一类。
      sessionToolImages += Math.max(0, lineImageSignals - lineUserImages);
    } catch {
      // Skip malformed lines
    }
  }

  // 整份 transcript 扫完才知道总数，统一盖到每个 turn 上——这条标记回答的是
  // 「这条记忆所在的 session 里有没有图」，不是「这一轮有没有图」。图所在的那轮
  // 常因正文太短进不了库，只有盖到同 session 的其他轮次上，才可能被搜到。
  if (sessionImages > 0 || sessionToolImages > 0) {
    for (const turn of turns) {
      if (sessionImages > 0) turn.sessionImages = sessionImages;
      if (sessionToolImages > 0) turn.sessionToolImages = sessionToolImages;
    }
  }

  return turns;
}

/**
 * Group conversation turns into meaningful chunks.
 * Strategy: merge adjacent user+assistant pairs into one chunk,
 * so search can find the full context of a Q&A exchange.
 */
/**
 * Pre-filter turns before chunking: remove noise turns that would dilute
 * embedding quality if stored. Applied at ingest time so noisy data never
 * enters the vector index.
 */
function filterNoiseTurns(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.filter((turn) => !isNoise(turn.text));
}

export function groupTurnsIntoChunks(turns: ConversationTurn[]): Array<{
  text: string;
  timestamp: string;
  sessionId: string;
  sessionImages?: number;
  sessionToolImages?: number;
}> {
  const filtered = filterNoiseTurns(turns);
  const chunks: Array<{
    text: string;
    timestamp: string;
    sessionId: string;
    sessionImages?: number;
    sessionToolImages?: number;
  }> = [];

  for (let i = 0; i < filtered.length; i++) {
    const turn = filtered[i];
    // 同一 session 切出来的每个 chunk 都带同一个标——它说的是「这个 session 有图」，
    // 跟这一片本身有没有图无关，这正是 session 粒度要的效果。
    const imgMark = {
      ...(turn.sessionImages ? { sessionImages: turn.sessionImages } : {}),
      ...(turn.sessionToolImages ? { sessionToolImages: turn.sessionToolImages } : {}),
    };

    // If this is a user turn followed by an assistant turn, merge them
    if (turn.role === "user" && i + 1 < filtered.length && filtered[i + 1].role === "assistant") {
      const nextTurn = filtered[i + 1];
      // Compress tool output noise before chunking (git boilerplate, passing tests, base64)
      const merged = compressToolOutput(`[用户] ${turn.text}\n\n[助手] ${nextTurn.text}`);

      // If merged text is too long, segment by events then fallback to chunker
      if (merged.length > CONVERSATION_CHUNK_CONFIG.maxChunkSize) {
        const segments = segmentEvents(merged, {
          maxSegmentSize: CONVERSATION_CHUNK_CONFIG.maxChunkSize,
          minSegmentSize: CONVERSATION_CHUNK_CONFIG.minChunkSize,
        });
        for (const seg of segments) {
          // If a segment is still too long, chunk it further
          if (seg.text.length > CONVERSATION_CHUNK_CONFIG.maxChunkSize) {
            const chunkResult = chunkDocument(seg.text, CONVERSATION_CHUNK_CONFIG);
            for (const chunk of chunkResult.chunks) {
              chunks.push({ text: chunk, timestamp: turn.timestamp, sessionId: turn.sessionId, ...imgMark });
            }
          } else {
            chunks.push({ text: seg.text, timestamp: turn.timestamp, sessionId: turn.sessionId, ...imgMark });
          }
        }
      } else {
        chunks.push({
          text: merged,
          timestamp: turn.timestamp,
          sessionId: turn.sessionId,
          ...imgMark,
        });
      }

      i++; // Skip the assistant turn we already consumed
    } else {
      // Standalone turn (user without response, or orphan assistant)
      const prefix = turn.role === "user" ? "[用户]" : "[助手]";
      const text = compressToolOutput(`${prefix} ${turn.text}`);

      if (text.length > CONVERSATION_CHUNK_CONFIG.maxChunkSize) {
        const segments = segmentEvents(text, {
          maxSegmentSize: CONVERSATION_CHUNK_CONFIG.maxChunkSize,
          minSegmentSize: CONVERSATION_CHUNK_CONFIG.minChunkSize,
        });
        for (const seg of segments) {
          if (seg.text.length > CONVERSATION_CHUNK_CONFIG.maxChunkSize) {
            const chunkResult = chunkDocument(seg.text, CONVERSATION_CHUNK_CONFIG);
            for (const chunk of chunkResult.chunks) {
              chunks.push({ text: chunk, timestamp: turn.timestamp, sessionId: turn.sessionId, ...imgMark });
            }
          } else {
            chunks.push({ text: seg.text, timestamp: turn.timestamp, sessionId: turn.sessionId, ...imgMark });
          }
        }
      } else {
        chunks.push({
          text,
          timestamp: turn.timestamp,
          sessionId: turn.sessionId,
          ...imgMark,
        });
      }
    }
  }

  // P1 defence-in-depth: re-filter AFTER splitting. Long turns pass the
  // turn-level filterNoiseTurns gate, but chunking can peel their tail into
  // severed context-JSON fragments that the turn-level check never saw.
  // F-3b: scrub secrets at the chunk boundary — this is the shared text
  // finalization point for all session-ingest paths (CC/Codex/Gemini), before
  // any chunk reaches embedding, LLM extraction, or storage.
  return chunks
    .filter((c) => !isNoise(c.text))
    .map((c) => {
      const r = redactSecrets(c.text);
      return r.redacted > 0 ? { ...c, text: r.text } : c;
    });
}

// ============================================================================
// Codex Session Parser
// ============================================================================

/**
 * Codex multi_agent 派出的子 agent 会话是独立的 rollout 文件，首行 session_meta 带 parent_thread_id
 * （另有 agent_nickname / agent_role / multi_agent_version）。文件里 role=user 的 input_text 是主 agent
 * 派的任务，不是人说的话——2026-09-08 实测本机 5,597 个 Codex 会话文件里 2,555 个（45.6%）是子 agent 文件，
 * 其 user turn 占全部 user turn 的 46.7%（近 7 天 63.7%）。ingest 前整文件跳过，与 Kimi 分支只读
 * agents/main/wire.jsonl 同一个判据：按结构字段认「谁在说」，不认 role。只读首行，不整读文件。
 */
export function isCodexSubagentSessionFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8");
    const nl = content.indexOf("\n");
    const first = (nl === -1 ? content : content.slice(0, nl)).trim();
    if (!first) return false;
    const obj = JSON.parse(first);
    if (obj?.type !== "session_meta") return false;
    const parent = obj.payload?.parent_thread_id;
    return typeof parent === "string" && parent.length > 0;
  } catch {
    return false;
  }
}

export function parseCodexSession(filePath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  let sessionId = "";
  // 同 parseCCTranscript：两类图片分开计数。
  // Codex 的图片字段是 input_image（OpenAI 格式），不是 Anthropic 的 image；
  // 用户贴的在 payload.content 里可以精确认；其余一律按补集归 AI 产图。
  let sessionImages = 0;
  let sessionToolImages = 0;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const payload = obj.payload;
      const timestamp = obj.timestamp || "";
      // 同 parseCCTranscript：整行图片信号，减去用户贴的，剩下全归 AI 产
      const lineImageSignals = countImageSignals(obj);
      let lineUserImages = 0;

      if (obj.type === "session_meta" && payload?.id) {
        sessionId = payload.id;
      }

      // response_item: contains user input and assistant output
      if (obj.type === "response_item" && payload) {
        const role = payload.role;
        const content = payload.content;

        if (Array.isArray(content)) {
          // 只精确认用户消息里的 input_image；Codex 自己生的图 / 读的图挂在
          // payload.output 等别处，由下面的补集统一接住，这里不去枚举它们。
          if (role === "user") {
            const own = content.filter((c: any) => c?.type === "input_image").length;
            sessionImages += own;
            lineUserImages += own;
          }
          for (const c of content) {
            if (c.type === "input_text" && c.text && c.text.length > 10) {
              // Skip system/developer prompts (usually very long instructions)
              if (role === "developer" || c.text.includes("<permissions instructions>")) {
                continue;
              }
              turns.push({
                role: "user",
                text: c.text.trim(),
                timestamp,
                sessionId,
              });
            }
            if (c.type === "output_text" && c.text && c.text.length > 8) {
              turns.push({
                role: "assistant",
                text: c.text.trim(),
                timestamp,
                sessionId,
              });
            }
          }
        }
      }

      // event_msg: user messages
      if (obj.type === "event_msg" && payload?.type === "user_message") {
        const msg = payload.message;
        if (msg && typeof msg === "string" && msg.length > 10) {
          // Avoid duplicates with response_item input_text
          const lastTurn = turns[turns.length - 1];
          if (!lastTurn || lastTurn.text !== msg.trim()) {
            turns.push({
              role: "user",
              text: msg.trim(),
              timestamp,
              sessionId,
            });
          }
        }
      }

      // 补集：除用户亲手贴的之外，这一行里的图全算 AI 产的，不问出身。
      sessionToolImages += Math.max(0, lineImageSignals - lineUserImages);
    } catch {
      // Skip malformed lines
    }
  }

  if (sessionImages > 0 || sessionToolImages > 0) {
    for (const turn of turns) {
      if (sessionImages > 0) turn.sessionImages = sessionImages;
      if (sessionToolImages > 0) turn.sessionToolImages = sessionToolImages;
    }
  }

  return turns;
}

export async function ingestCodexSessions(
  store: MemoryStore,
  embedder: Embedder,
  options: { limit?: number; verbose?: boolean; noDedup?: boolean; llm?: LLMClient | null; recentHours?: number } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    source: "codex",
    filesProcessed: 0,
    chunksIngested: 0,
    chunksSkipped: 0,
    chunksDeduped: 0,
    dedupReasonCounts: createDedupReasonCounts(),
    errors: [],
  };

  // 同时扫 sessions（活跃）+ archived_sessions（App 内归档会把文件移到这里，否则会漏）
  const baseDirs = [
    expandHome("~/.codex/sessions"),
    expandHome("~/.codex/archived_sessions"),
  ];
  const existingDirs = baseDirs.filter((d) => existsSync(d));
  if (existingDirs.length === 0) {
    result.errors.push(`Codex sessions directory not found: ${baseDirs.join(", ")}`);
    return result;
  }

  const recentMode = options.recentHours !== undefined;
  const cutoffMs = recentMode ? Date.now() - options.recentHours! * 3600_000 : 0;

  // Find all .jsonl files recursively
  const allFiles: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".jsonl")) {
        allFiles.push(full);
      }
    }
  }
  for (const dir of existingDirs) walk(dir);
  allFiles.sort();

  // --recent: only keep files modified within N hours
  const filteredFiles = recentMode
    ? allFiles.filter((f) => { try { return statSync(f).mtimeMs >= cutoffMs; } catch { return false; } })
    : allFiles;

  const filesToProcess = options.limit ? filteredFiles.slice(0, options.limit) : filteredFiles;
  const total = filesToProcess.length;

  for (let fi = 0; fi < filesToProcess.length; fi++) {
    const filePath = filesToProcess[fi];

    try {
      const stat = statSync(filePath);
      if (stat.size < 200) {
        result.chunksSkipped++;
        continue;
      }

      // In --recent mode, skip ingested-files check — files may have new content appended
      if (!recentMode && isProcessed(filePath, stat.size, stat.mtimeMs)) {
        result.chunksSkipped++;
        continue;
      }

      // 子 agent 独立会话整文件跳过（判据与理由见 isCodexSubagentSessionFile）。标记 processed 是为了
      // 下一轮非 --recent 的增量不再重读它；子 agent 的结论本就该由主 agent 落盘，原文由 Deja 全量索引兜底。
      if (isCodexSubagentSessionFile(filePath)) {
        result.subagentFilesSkipped = (result.subagentFilesSkipped ?? 0) + 1;
        markProcessed(filePath, stat.size, 0, stat.mtimeMs);
        continue;
      }

      const turns = parseCodexSession(filePath);
      if (turns.length === 0) {
        result.chunksSkipped++;
        markProcessed(filePath, stat.size, 0, stat.mtimeMs);
        continue;
      }

      const chunks = groupTurnsIntoChunks(turns);
      const texts = chunks.map((c) => c.text);
      const batchSize = 32;
      let fileChunks = 0;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchChunks = chunks.slice(i, i + batchSize);

        try {
          const vectors = await embedder.embedBatchPassage(batch);
          const toStore: Array<{text: string; vector: number[]; category: string; scope: string; importance: number; metadata: string}> = [];

          // Dedup + L0 batch
          const dedupedTexts: string[] = [];
          const dedupedVectors: number[][] = [];
          const dedupedChunks: typeof batchChunks = [];

          for (let j = 0; j < batch.length; j++) {
            const vector = vectors[j];
            if (!vector || vector.length === 0) {
              result.chunksSkipped++;
              continue;
            }
            if (!options.noDedup) {
              const decision = await dedupCheck(store, vector, batch[j], options.llm);
              recordDedupDecision(result, decision);
              if (decision.secondaryDeletes?.length) {
                await executeSecondaryDeletes(store, decision.secondaryDeletes);
              }
              if (decision.action === "skip") continue;
            }
            dedupedTexts.push(batch[j]);
            dedupedVectors.push(vector);
            dedupedChunks.push(batchChunks[j]);
          }

          if (dedupedTexts.length > 0) {
            if (!options.llm) {
              queueForLaterExtraction(
                dedupedChunks.map(c => ({ text: c.text, scope: `codex:${c.sessionId.slice(0, 8)}` }))
              );
              result.chunksSkipped += dedupedTexts.length;
            } else {
              const extractions = await smartExtractBatch(dedupedTexts, options.llm);
              const coreSummaries = await generateCoreSummaries(dedupedTexts, options.llm);
              for (let j = 0; j < dedupedTexts.length; j++) {
                const chunk = dedupedChunks[j];
                const ext = extractions[j];
                toStore.push(buildIngestedEntry({
                  source: "codex",
                  scope: `codex:${chunk.sessionId.slice(0, 8)}`,
                  text: dedupedTexts[j],
                  vector: dedupedVectors[j],
                  extraction: ext,
                  sessionId: chunk.sessionId,
                  file: basename(filePath),
                  coreSummary: coreSummaries[j],
                  sessionImages: chunk.sessionImages,
                  sessionToolImages: chunk.sessionToolImages,
                }));
              }
            }
          }

          if (toStore.length > 0) {
            await store.storeBatch(toStore);
            result.chunksIngested += toStore.length;
            fileChunks += toStore.length;
          }
        } catch (err: any) {
          result.errors.push(`Embedding batch error: ${err.message}`);
        }
      }

      markProcessed(filePath, stat.size, fileChunks, stat.mtimeMs);
      result.filesProcessed++;

      if ((fi + 1) % 10 === 0 || fi + 1 === total) {
        console.log(
          `  Codex: ${fi + 1}/${total} files, ${result.chunksIngested} chunks ingested`,
        );
      }
    } catch (err: any) {
      result.errors.push(`Error processing ${basename(filePath)}: ${err.message}`);
    }
  }

  return result;
}

// ============================================================================
// Kimi Code Session Parser
// ============================================================================
// Kimi Code 的 wire.jsonl 是事件流（非 role/content 行），对话内容只在三类事件里：
//   turn.prompt (origin.kind="user")          → 用户输入，.input 是 text part 数组
//   context.append_message                    → 消息；用户消息只收 origin.kind="user"
//                                               （injection/skill_activation 等是系统注入，跳过）
//   context.append_loop_event content.part    → 助手文本（part.type==="text"；think 跳过）
// 其余类型（llm.tools_snapshot / mcp.tools_discovered / config.update / llm.request /
// usage.record / permission.* 等，约占 86% 体积）是运行事件，一律跳过。
export function parseKimiSession(filePath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  // sessionId 从路径取：.../sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl
  // 去掉 "session_" 前缀，否则 scope 统一变成 kimi:session_
  const pathParts = filePath.split("/");
  const rawId = pathParts.length >= 4 ? pathParts[pathParts.length - 4] : basename(filePath, ".jsonl");
  const sessionId = rawId.replace(/^session_/, "");
  // 同 parseCCTranscript：两类图片分开计数。
  // Kimi 的图片字段是 image_url；用户贴的在 turn.prompt / context.append_message，
  // AI 产的在 context.append_loop_event 的 tool.result 里。
  let sessionImages = 0;
  let sessionToolImages = 0;

  const pushTurn = (role: "user" | "assistant", text: string, timestamp: string) => {
    const trimmed = text.trim();
    // 中文 8 字符已是完整句；用户阈值与 codex/cc 对齐
    if (trimmed.length <= (role === "user" ? 10 : 8)) return;
    // turn.prompt 与随后的 context.append_message 重复记录同一用户输入（同 codex 相邻去重）
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && lastTurn.role === role && lastTurn.text === trimmed) return;
    turns.push({ role, text: trimmed, timestamp, sessionId });
  };

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const timestamp = typeof obj.time === "number" ? new Date(obj.time).toISOString() : "";

      // 图片统计在这里一次算完，不放进下面的分支——那些分支各自 continue，
      // 放进去会被跳过。用户贴的精确认，其余按补集归 AI 产，不枚举出身。
      {
        const lineImageSignals = countImageSignals(obj);
        let lineUserImages = 0;
        if (obj.type === "turn.prompt" && obj.origin?.kind === "user" && Array.isArray(obj.input)) {
          lineUserImages = obj.input.filter((c: any) => c?.type === "image_url").length;
        } else if (obj.type === "context.append_message") {
          const m = obj.message;
          if (m?.role === "user" && m?.origin?.kind === "user" && Array.isArray(m.content)) {
            lineUserImages = m.content.filter((c: any) => c?.type === "image_url").length;
          }
        }
        sessionImages += lineUserImages;
        sessionToolImages += Math.max(0, lineImageSignals - lineUserImages);
      }

      if (obj.type === "turn.prompt") {
        if (obj.origin?.kind !== "user") continue;
        const parts = Array.isArray(obj.input) ? obj.input : [];
        const text = parts
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text || "")
          .join("\n");
        if (text) pushTurn("user", text, timestamp);
        continue;
      }

      if (obj.type === "context.append_message") {
        const msg = obj.message;
        if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
        // 系统注入（system-reminder、skill 激活、后台任务通知）不是用户对话内容
        if (msg.role === "user" && msg.origin?.kind !== "user") continue;
        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text || "")
            .join("\n");
        }
        if (text) pushTurn(msg.role, text, timestamp);
        continue;
      }

      if (obj.type === "context.append_loop_event") {
        const part = obj.event?.type === "content.part" ? obj.event.part : null;
        if (part?.type === "text" && typeof part.text === "string") {
          pushTurn("assistant", part.text, timestamp);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (sessionImages > 0 || sessionToolImages > 0) {
    for (const turn of turns) {
      if (sessionImages > 0) turn.sessionImages = sessionImages;
      if (sessionToolImages > 0) turn.sessionToolImages = sessionToolImages;
    }
  }

  return turns;
}

export async function ingestKimiSessions(
  store: MemoryStore,
  embedder: Embedder,
  options: { limit?: number; verbose?: boolean; noDedup?: boolean; llm?: LLMClient | null; recentHours?: number } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    source: "kimi",
    filesProcessed: 0,
    chunksIngested: 0,
    chunksSkipped: 0,
    chunksDeduped: 0,
    dedupReasonCounts: createDedupReasonCounts(),
    errors: [],
  };

  const baseDir = expandHome("~/.kimi-code/sessions");
  const indexPath = expandHome("~/.kimi-code/session_index.jsonl");

  // 文件发现：优先 session_index.jsonl（精确），再 walk sessions 目录兜底（索引缺漏时）。
  // 只收 agents/main/wire.jsonl，子 agent 的 agents/agent-N/wire.jsonl 与主对话重复，不采。
  const seen = new Set<string>();
  const allFiles: string[] = [];
  const addFile = (p: string) => {
    if (!seen.has(p) && existsSync(p)) {
      seen.add(p);
      allFiles.push(p);
    }
  };

  if (existsSync(indexPath)) {
    try {
      for (const line of readFileSync(indexPath, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (typeof entry.sessionDir === "string" && entry.sessionDir) {
            addFile(join(entry.sessionDir, "agents", "main", "wire.jsonl"));
          }
        } catch {
          // Skip malformed index lines
        }
      }
    } catch {
      // 索引读不出来就走下面的目录扫描
    }
  }

  if (existsSync(baseDir)) {
    const mainWireSuffix = join("agents", "main", "wire.jsonl");
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (full.endsWith(mainWireSuffix)) {
          addFile(full);
        }
      }
    };
    walk(baseDir);
  }

  if (allFiles.length === 0) {
    result.errors.push(`Kimi Code sessions not found: ${baseDir} (index: ${indexPath})`);
    return result;
  }
  allFiles.sort();

  const recentMode = options.recentHours !== undefined;
  const cutoffMs = recentMode ? Date.now() - options.recentHours! * 3600_000 : 0;

  // --recent: only keep files modified within N hours
  const filteredFiles = recentMode
    ? allFiles.filter((f) => { try { return statSync(f).mtimeMs >= cutoffMs; } catch { return false; } })
    : allFiles;

  const filesToProcess = options.limit ? filteredFiles.slice(0, options.limit) : filteredFiles;
  const total = filesToProcess.length;

  for (let fi = 0; fi < filesToProcess.length; fi++) {
    const filePath = filesToProcess[fi];

    try {
      const stat = statSync(filePath);
      if (stat.size < 200) {
        result.chunksSkipped++;
        continue;
      }

      // In --recent mode, skip ingested-files check — files may have new content appended
      if (!recentMode && isProcessed(filePath, stat.size, stat.mtimeMs)) {
        result.chunksSkipped++;
        continue;
      }

      const turns = parseKimiSession(filePath);
      if (turns.length === 0) {
        result.chunksSkipped++;
        markProcessed(filePath, stat.size, 0, stat.mtimeMs);
        continue;
      }

      const chunks = groupTurnsIntoChunks(turns);
      const texts = chunks.map((c) => c.text);
      const batchSize = 32;
      let fileChunks = 0;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchChunks = chunks.slice(i, i + batchSize);

        try {
          const vectors = await embedder.embedBatchPassage(batch);
          const toStore: Array<{text: string; vector: number[]; category: string; scope: string; importance: number; metadata: string}> = [];

          // Dedup + L0 batch
          const dedupedTexts: string[] = [];
          const dedupedVectors: number[][] = [];
          const dedupedChunks: typeof batchChunks = [];

          for (let j = 0; j < batch.length; j++) {
            const vector = vectors[j];
            if (!vector || vector.length === 0) {
              result.chunksSkipped++;
              continue;
            }
            if (!options.noDedup) {
              const decision = await dedupCheck(store, vector, batch[j], options.llm);
              recordDedupDecision(result, decision);
              if (decision.secondaryDeletes?.length) {
                await executeSecondaryDeletes(store, decision.secondaryDeletes);
              }
              if (decision.action === "skip") continue;
            }
            dedupedTexts.push(batch[j]);
            dedupedVectors.push(vector);
            dedupedChunks.push(batchChunks[j]);
          }

          if (dedupedTexts.length > 0) {
            if (!options.llm) {
              queueForLaterExtraction(
                dedupedChunks.map(c => ({ text: c.text, scope: `kimi:${c.sessionId.slice(0, 8)}` }))
              );
              result.chunksSkipped += dedupedTexts.length;
            } else {
              const extractions = await smartExtractBatch(dedupedTexts, options.llm);
              const coreSummaries = await generateCoreSummaries(dedupedTexts, options.llm);
              for (let j = 0; j < dedupedTexts.length; j++) {
                const chunk = dedupedChunks[j];
                const ext = extractions[j];
                toStore.push(buildIngestedEntry({
                  source: "kimi",
                  scope: `kimi:${chunk.sessionId.slice(0, 8)}`,
                  text: dedupedTexts[j],
                  vector: dedupedVectors[j],
                  extraction: ext,
                  sessionId: chunk.sessionId,
                  file: basename(filePath),
                  coreSummary: coreSummaries[j],
                  sessionImages: chunk.sessionImages,
                  sessionToolImages: chunk.sessionToolImages,
                }));
              }
            }
          }

          if (toStore.length > 0) {
            await store.storeBatch(toStore);
            result.chunksIngested += toStore.length;
            fileChunks += toStore.length;
          }
        } catch (err: any) {
          result.errors.push(`Embedding batch error: ${err.message}`);
        }
      }

      markProcessed(filePath, stat.size, fileChunks, stat.mtimeMs);
      result.filesProcessed++;

      if ((fi + 1) % 10 === 0 || fi + 1 === total) {
        console.log(
          `  Kimi: ${fi + 1}/${total} files, ${result.chunksIngested} chunks ingested`,
        );
      }
    } catch (err: any) {
      result.errors.push(`Error processing ${basename(filePath)}: ${err.message}`);
    }
  }

  return result;
}

// ============================================================================
// Gemini Session Parser
// ============================================================================

function parseGeminiSession(filePath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);
    const sessionId = data.sessionId || basename(filePath, ".json");
    const messages = data.messages || [];

    for (const msg of messages) {
      const type = msg.type; // "user" | "gemini" | "info"
      if (type === "info") continue; // Skip system info messages

      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((c: any) => c.text)
          .map((c: any) => c.text)
          .join("\n");
      }

      if (text.trim().length < 10) continue;

      turns.push({
        role: type === "user" ? "user" : "assistant",
        text: text.trim(),
        timestamp: data.startTime || "",
        sessionId,
      });
    }
  } catch {
    // Skip malformed files
  }

  return turns;
}

export async function ingestGeminiSessions(
  store: MemoryStore,
  embedder: Embedder,
  options: { limit?: number; verbose?: boolean; noDedup?: boolean; llm?: LLMClient | null; recentHours?: number } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    source: "gemini",
    filesProcessed: 0,
    chunksIngested: 0,
    chunksSkipped: 0,
    chunksDeduped: 0,
    dedupReasonCounts: createDedupReasonCounts(),
    errors: [],
  };

  // Scan all project dirs under ~/.gemini/tmp/
  const baseDir = expandHome("~/.gemini/tmp");
  if (!existsSync(baseDir)) {
    result.errors.push(`Gemini tmp directory not found: ${baseDir}`);
    return result;
  }

  const recentMode = options.recentHours !== undefined;
  const cutoffMs = recentMode ? Date.now() - options.recentHours! * 3600_000 : 0;

  const allFiles: string[] = [];
  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.startsWith("session-") && entry.name.endsWith(".json")) {
          allFiles.push(full);
        }
      }
    } catch { /* skip permission errors */ }
  }
  walk(baseDir);
  allFiles.sort();

  // --recent: only keep files modified within N hours
  const filteredFiles = recentMode
    ? allFiles.filter((f) => { try { return statSync(f).mtimeMs >= cutoffMs; } catch { return false; } })
    : allFiles;

  const filesToProcess = options.limit ? filteredFiles.slice(0, options.limit) : filteredFiles;
  const total = filesToProcess.length;

  for (let fi = 0; fi < filesToProcess.length; fi++) {
    const filePath = filesToProcess[fi];

    try {
      const stat = statSync(filePath);
      if (stat.size < 100) {
        result.chunksSkipped++;
        continue;
      }

      // In --recent mode, skip ingested-files check — files may have new content appended
      if (!recentMode && isProcessed(filePath, stat.size, stat.mtimeMs)) {
        result.chunksSkipped++;
        continue;
      }

      const turns = parseGeminiSession(filePath);
      if (turns.length === 0) {
        result.chunksSkipped++;
        markProcessed(filePath, stat.size, 0, stat.mtimeMs);
        continue;
      }

      const chunks = groupTurnsIntoChunks(turns);
      const texts = chunks.map((c) => c.text);
      const batchSize = 32;
      let fileChunks = 0;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchChunks = chunks.slice(i, i + batchSize);

        try {
          const vectors = await embedder.embedBatchPassage(batch);
          const toStore: Array<{text: string; vector: number[]; category: string; scope: string; importance: number; metadata: string}> = [];

          const dedupedTexts: string[] = [];
          const dedupedVectors: number[][] = [];
          const dedupedChunks: typeof batchChunks = [];

          for (let j = 0; j < batch.length; j++) {
            const vector = vectors[j];
            if (!vector || vector.length === 0) {
              result.chunksSkipped++;
              continue;
            }
            if (!options.noDedup) {
              const decision = await dedupCheck(store, vector, batch[j], options.llm);
              recordDedupDecision(result, decision);
              if (decision.secondaryDeletes?.length) {
                await executeSecondaryDeletes(store, decision.secondaryDeletes);
              }
              if (decision.action === "skip") continue;
            }
            dedupedTexts.push(batch[j]);
            dedupedVectors.push(vector);
            dedupedChunks.push(batchChunks[j]);
          }

          if (dedupedTexts.length > 0) {
            if (!options.llm) {
              queueForLaterExtraction(
                dedupedChunks.map(c => ({ text: c.text, scope: `gemini:${c.sessionId.slice(0, 8)}` }))
              );
              result.chunksSkipped += dedupedTexts.length;
            } else {
              const extractions = await smartExtractBatch(dedupedTexts, options.llm);
              const coreSummaries = await generateCoreSummaries(dedupedTexts, options.llm);
              for (let j = 0; j < dedupedTexts.length; j++) {
                const chunk = dedupedChunks[j];
                const ext = extractions[j];
                toStore.push(buildIngestedEntry({
                  source: "gemini",
                  scope: `gemini:${chunk.sessionId.slice(0, 8)}`,
                  text: dedupedTexts[j],
                  vector: dedupedVectors[j],
                  extraction: ext,
                  sessionId: chunk.sessionId,
                  file: basename(filePath),
                  coreSummary: coreSummaries[j],
                }));
              }
            }
          }

          if (toStore.length > 0) {
            await store.storeBatch(toStore);
            result.chunksIngested += toStore.length;
            fileChunks += toStore.length;
          }
        } catch (err: any) {
          result.errors.push(`Embedding batch error: ${err.message}`);
        }
      }

      markProcessed(filePath, stat.size, fileChunks, stat.mtimeMs);
      result.filesProcessed++;

      if ((fi + 1) % 10 === 0 || fi + 1 === total) {
        console.log(
          `  Gemini: ${fi + 1}/${total} files, ${result.chunksIngested} chunks ingested`,
        );
      }
    } catch (err: any) {
      result.errors.push(`Error processing ${basename(filePath)}: ${err.message}`);
    }
  }

  return result;
}

// ============================================================================
// Markdown Parser
// ============================================================================

/**
 * Split a markdown file by headings (## or #) into chunks.
 * Each chunk includes the heading + content under it.
 */
function parseMarkdown(filePath: string): Array<{ text: string; heading: string }> {
  const content = readFileSync(filePath, "utf-8");
  const chunks: Array<{ text: string; heading: string }> = [];

  // Split by headings
  const sections = content.split(/^(#{1,3}\s+.+)$/m);

  let currentHeading = basename(filePath, ".md");
  let currentText = "";

  for (const section of sections) {
    if (/^#{1,3}\s+/.test(section)) {
      // This is a heading — save previous section
      if (currentText.trim().length > 30) {
        pushMarkdownChunks(chunks, currentHeading, currentText.trim());
      }
      currentHeading = section.replace(/^#+\s+/, "").trim();
      currentText = "";
    } else {
      currentText += section;
    }
  }

  // Don't forget the last section
  if (currentText.trim().length > 30) {
    pushMarkdownChunks(chunks, currentHeading, currentText.trim());
  }

  return chunks;
}

function pushMarkdownChunks(
  chunks: Array<{ text: string; heading: string }>,
  heading: string,
  text: string,
): void {
  const fullText = `[${heading}] ${text}`;
  if (fullText.length > MARKDOWN_CHUNK_CONFIG.maxChunkSize) {
    const result = chunkDocument(fullText, MARKDOWN_CHUNK_CONFIG);
    for (const chunk of result.chunks) {
      chunks.push({ text: chunk, heading });
    }
  } else {
    chunks.push({ text: fullText, heading });
  }
}

// ============================================================================
// Main Ingest Functions
// ============================================================================

export async function ingestCCTranscripts(
  store: MemoryStore,
  embedder: Embedder,
  sourcePath: string,
  options: {
    limit?: number;
    verbose?: boolean;
    noDedup?: boolean;
    llm?: LLMClient | null;
    recentHours?: number;
    /**
     * scope 前缀与来源标签。默认 "cc" —— 这个默认值是承重的：
     * memory-boundaries.ts 的 TRANSCRIPT_SCOPE_PREFIXES 靠前缀把会话碎片降权到
     * evidence 层，前缀写错等于让某个端的 shell 输出被当成"用户说过的话"。
     * 新增来源时必须同时在那份清单里登记，别只在这里传个新字符串。
     */
    scopePrefix?: string;
  } = {},
): Promise<IngestResult> {
  const scopePrefix = options.scopePrefix ?? "cc";
  const result: IngestResult = {
    source: scopePrefix,
    filesProcessed: 0,
    chunksIngested: 0,
    chunksSkipped: 0,
    chunksDeduped: 0,
    dedupReasonCounts: createDedupReasonCounts(),
    errors: [],
  };

  const dir = expandHome(sourcePath);
  // session-digest.py 摘要调用留下的会话记录不 ingest（2026-08-24 审计：这类
  // transcript 是原始会话 8000 字符采样的副本，ingest 后 scope/metadata 指向
  // 摘要任务自身 sid——内容是真的、坐标是假的，已产生 1,950 条 evidence 污染）。
  if (dir.includes("session-digest")) {
    return result;
  }
  if (!existsSync(dir)) {
    result.errors.push(`Directory not found: ${dir}`);
    return result;
  }

  const recentMode = options.recentHours !== undefined;
  const cutoffMs = recentMode ? Date.now() - options.recentHours! * 3600_000 : 0;

  let files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  // --recent: only keep files modified within N hours
  if (recentMode) {
    files = files.filter((f) => {
      try { return statSync(join(dir, f)).mtimeMs >= cutoffMs; } catch { return false; }
    });
  }

  const filesToProcess = options.limit ? files.slice(0, options.limit) : files;
  const total = filesToProcess.length;

  for (let fi = 0; fi < filesToProcess.length; fi++) {
    const file = filesToProcess[fi];
    const filePath = join(dir, file);

    try {
      // Skip very small files (likely empty sessions)
      const stat = statSync(filePath);
      if (stat.size < 500) {
        result.chunksSkipped++;
        continue;
      }

      // Skip already processed files (incremental mode)
      // In --recent mode, skip this check — files may have new content appended
      if (!recentMode && isProcessed(filePath, stat.size, stat.mtimeMs)) {
        result.chunksSkipped++;
        continue;
      }

      const turns = parseCCTranscript(filePath);
      if (turns.length === 0) {
        result.chunksSkipped++;
        markProcessed(filePath, stat.size, 0, stat.mtimeMs);
        continue;
      }

      const chunks = groupTurnsIntoChunks(turns);
      let fileChunks = 0;

      // Batch embed + batch store for efficiency
      const texts = chunks.map((c) => c.text);
      const batchSize = 32;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchChunks = chunks.slice(i, i + batchSize);

        try {
          const vectors = await embedder.embedBatchPassage(batch);

          // Collect non-duplicate chunks
          const dedupedTexts: string[] = [];
          const dedupedVectors: number[][] = [];
          const dedupedChunks: typeof batchChunks = [];

          for (let j = 0; j < batch.length; j++) {
            const vector = vectors[j];
            if (!vector || vector.length === 0) {
              result.chunksSkipped++;
              continue;
            }

            // Two-stage dedup: vector pre-filter + optional LLM
            if (!options.noDedup) {
              const decision = await dedupCheck(store, vector, batch[j], options.llm);
              recordDedupDecision(result, decision);
              if (decision.secondaryDeletes?.length) {
                await executeSecondaryDeletes(store, decision.secondaryDeletes);
              }
              if (decision.action === "skip") continue;
            }

            dedupedTexts.push(batch[j]);
            dedupedVectors.push(vector);
            dedupedChunks.push(batchChunks[j]);
          }

          if (dedupedTexts.length === 0) continue;

          // Without LLM: queue raw chunks for later extraction instead of storing garbage
          if (!options.llm) {
            queueForLaterExtraction(
              dedupedChunks.map(c => ({ text: c.text, scope: `${scopePrefix}:${c.sessionId.slice(0, 8)}` }))
            );
            result.chunksSkipped += dedupedTexts.length;
            continue;
          }

          // Batch smart extraction (LLM 6-category)
          const extractions = await smartExtractBatch(dedupedTexts, options.llm);
          const coreSummaries = await generateCoreSummaries(dedupedTexts, options.llm);

          const toStore: Array<{text: string; vector: number[]; category: string; scope: string; importance: number; metadata: string}> = [];
          for (let j = 0; j < dedupedTexts.length; j++) {
            const chunk = dedupedChunks[j];
            const ext = extractions[j];
            toStore.push(buildIngestedEntry({
              // 必须跟 scope 前缀一致：memory-boundaries 有两道闸，isTranscriptScope 看 scope、
              // isTranscriptSource 看这个字段。写死 "cc" 时降权仍然生效（cc 也在清单里），
              // 所以错了不会报错、只会让「按来源过滤」静默失真——2026-08-20 接 minis 源时漏改这处，
              // 库里出现 10 条 scope=minis: 而 source=cc 的记录。
              source: scopePrefix,
              scope: `${scopePrefix}:${chunk.sessionId.slice(0, 8)}`,
              text: dedupedTexts[j],
              vector: dedupedVectors[j],
              extraction: ext,
              sessionId: chunk.sessionId,
              file,
              coreSummary: coreSummaries[j],
              sessionImages: chunk.sessionImages,
              sessionToolImages: chunk.sessionToolImages,
            }));
          }

          if (toStore.length > 0) {
            await store.storeBatch(toStore);
            result.chunksIngested += toStore.length;
            fileChunks += toStore.length;
          }
        } catch (err: any) {
          result.errors.push(`Embedding batch error in ${file}: ${err.message}`);
        }
      }

      markProcessed(filePath, stat.size, fileChunks, stat.mtimeMs);
      result.filesProcessed++;

      // Progress
      if ((fi + 1) % 10 === 0 || fi + 1 === total) {
        console.log(
          `  CC: ${fi + 1}/${total} files, ${result.chunksIngested} chunks ingested`,
        );
      }
    } catch (err: any) {
      result.errors.push(`Error processing ${file}: ${err.message}`);
    }
  }

  return result;
}

export async function ingestMarkdownFiles(
  store: MemoryStore,
  embedder: Embedder,
  sourcePath: string,
  scope: string,
  options: { verbose?: boolean; noDedup?: boolean; llm?: LLMClient | null; recentHours?: number } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    source: scope,
    filesProcessed: 0,
    chunksIngested: 0,
    chunksSkipped: 0,
    chunksDeduped: 0,
    dedupReasonCounts: createDedupReasonCounts(),
    errors: [],
  };

  const dir = expandHome(sourcePath);
  if (!existsSync(dir)) {
    result.errors.push(`Directory not found: ${dir}`);
    return result;
  }

  const recentMode = options.recentHours !== undefined;
  const cutoffMs = recentMode ? Date.now() - options.recentHours! * 3600_000 : 0;

  let files = readdirSync(dir).filter((f) => f.endsWith(".md"));

  // --recent: only keep files modified within N hours
  if (recentMode) {
    files = files.filter((f) => {
      try { return statSync(join(dir, f)).mtimeMs >= cutoffMs; } catch { return false; }
    });
  }

  for (const file of files) {
    const filePath = join(dir, file);

    try {
      const stat = statSync(filePath);
      // In --recent mode, skip ingested-files check — files may have new content appended
      if (!recentMode && isProcessed(filePath, stat.size, stat.mtimeMs)) {
        result.chunksSkipped++;
        continue;
      }

      const sections = parseMarkdown(filePath);
      if (sections.length === 0) {
        result.chunksSkipped++;
        markProcessed(filePath, stat.size, 0, stat.mtimeMs);
        continue;
      }

      // F-3b: scrub before embedding and storage
      const texts = sections.map((s) => redactSecrets(s.text).text);
      const batchSize = 32;
      let fileChunks = 0;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchSections = sections.slice(i, i + batchSize);

        try {
          const vectors = await embedder.embedBatchPassage(batch);
          const toStore: Array<{text: string; vector: number[]; category: string; scope: string; importance: number; metadata: string}> = [];

          const dedupedTexts: string[] = [];
          const dedupedVectors: number[][] = [];
          const dedupedSections: typeof batchSections = [];

          for (let j = 0; j < batch.length; j++) {
            const vector = vectors[j];
            if (!vector || vector.length === 0) {
              result.chunksSkipped++;
              continue;
            }
            if (!options.noDedup) {
              const decision = await dedupCheck(store, vector, batch[j], options.llm);
              recordDedupDecision(result, decision);
              if (decision.secondaryDeletes?.length) {
                await executeSecondaryDeletes(store, decision.secondaryDeletes);
              }
              if (decision.action === "skip") continue;
            }
            dedupedTexts.push(batch[j]);
            dedupedVectors.push(vector);
            dedupedSections.push(batchSections[j]);
          }

          if (dedupedTexts.length > 0) {
            const extractions = await smartExtractBatch(dedupedTexts, options.llm);
            const coreSummaries = await generateCoreSummaries(dedupedTexts, options.llm);
            for (let j = 0; j < dedupedTexts.length; j++) {
              const ext = extractions[j];
              toStore.push(buildIngestedEntry({
                source: scope,
                scope,
                text: dedupedTexts[j],
                vector: dedupedVectors[j],
                extraction: ext,
                file,
                heading: dedupedSections[j].heading,
                coreSummary: coreSummaries[j],
              }));
            }
          }

          if (toStore.length > 0) {
            await store.storeBatch(toStore);
            result.chunksIngested += toStore.length;
            fileChunks += toStore.length;
          }
        } catch (err: any) {
          result.errors.push(`Embedding error in ${file}: ${err.message}`);
        }
      }

      markProcessed(filePath, stat.size, fileChunks, stat.mtimeMs);
      result.filesProcessed++;

      if (options.verbose) {
        console.log(`  ${scope}: ${file} → ${sections.length} chunks`);
      }
    } catch (err: any) {
      result.errors.push(`Error processing ${file}: ${err.message}`);
    }
  }

  return result;
}

export async function ingestGenericText(
  store: MemoryStore,
  embedder: Embedder,
  sourcePath: string,
  scope: string,
  globPattern: string,
  options: { verbose?: boolean; noDedup?: boolean; llm?: LLMClient | null } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    source: scope,
    filesProcessed: 0,
    chunksIngested: 0,
    chunksSkipped: 0,
    chunksDeduped: 0,
    dedupReasonCounts: createDedupReasonCounts(),
    errors: [],
  };

  const dir = expandHome(sourcePath);
  if (!existsSync(dir)) {
    // Not an error — the directory might not exist yet (e.g. gemini/codex)
    if (options.verbose) {
      console.log(`  ${scope}: directory not found, skipping (${dir})`);
    }
    return result;
  }

  const files = readdirSync(dir).filter((f) => matchGlob(f, globPattern));

  for (const file of files) {
    const filePath = join(dir, file);

    try {
      const content = readFileSync(filePath, "utf-8");
      if (content.trim().length < 50) {
        result.chunksSkipped++;
        continue;
      }

      // For JSON files, try to extract conversation structure
      let textToChunk = content;
      if (file.endsWith(".json")) {
        try {
          const parsed = JSON.parse(content);
          // Handle common export formats
          if (Array.isArray(parsed)) {
            textToChunk = parsed
              .map((item: any) => {
                if (typeof item === "string") return item;
                if (item.content) return `[${item.role || "?"}] ${item.content}`;
                return JSON.stringify(item);
              })
              .join("\n\n");
          }
        } catch {
          // Not valid JSON, treat as plain text
        }
      }

      const chunkResult = chunkDocument(textToChunk, CONVERSATION_CHUNK_CONFIG);

      // F-3b: scrub before embedding and storage
      const texts = chunkResult.chunks.map((t) => redactSecrets(t).text);
      const batchSize = 32;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);

        try {
          const vectors = await embedder.embedBatchPassage(batch);
          const dedupedTexts: string[] = [];
          const dedupedVectors: number[][] = [];

          for (let j = 0; j < batch.length; j++) {
            const vector = vectors[j];
            if (!vector || vector.length === 0) {
              result.chunksSkipped++;
              continue;
            }
            if (!options.noDedup) {
              const decision = await dedupCheck(store, vector, batch[j], options.llm);
              recordDedupDecision(result, decision);
              if (decision.secondaryDeletes?.length) {
                await executeSecondaryDeletes(store, decision.secondaryDeletes);
              }
              if (decision.action === "skip") continue;
            }
            dedupedTexts.push(batch[j]);
            dedupedVectors.push(vector);
          }

          if (dedupedTexts.length > 0) {
            const extractions = await smartExtractBatch(dedupedTexts, options.llm);
            const coreSummaries = await generateCoreSummaries(dedupedTexts, options.llm);
            const toStore: Array<{text: string; vector: number[]; category: string; scope: string; importance: number; metadata: string}> = [];

            for (let j = 0; j < dedupedTexts.length; j++) {
              const ext = extractions[j];
              toStore.push(buildIngestedEntry({
                source: scope,
                scope,
                text: dedupedTexts[j],
                vector: dedupedVectors[j],
                extraction: ext,
                file,
                coreSummary: coreSummaries[j],
              }));
            }

            if (toStore.length > 0) {
              await store.storeBatch(toStore);
              result.chunksIngested += toStore.length;
            }
          }
        } catch (err: any) {
          result.errors.push(`Embedding error in ${file}: ${err.message}`);
        }
      }

      result.filesProcessed++;
    } catch (err: any) {
      result.errors.push(`Error processing ${file}: ${err.message}`);
    }
  }

  return result;
}

// ============================================================================
// Connector-v1 Ingest (GB-2)
// ============================================================================

/**
 * Ingest a connector-v1 formatted JSON payload.
 *
 * External connectors (Obsidian, Email, RSS, etc.) produce a standard
 * ConnectorOutputV1 JSON → this function consumes it through the existing
 * dedup / smartExtract / buildIngestedEntry pipeline.
 *
 * contentHash on each record enables incremental sync: if a record with the
 * same hash is already in the store, it is skipped without embedding.
 */
export async function ingestConnectorFile(
  store: MemoryStore,
  embedder: Embedder,
  content: string,
  options: { verbose?: boolean; noDedup?: boolean; llm?: LLMClient | null } = {},
): Promise<IngestResult> {
  const parsed = JSON.parse(content);
  if (!isConnectorOutputV1(parsed)) {
    return {
      source: "connector",
      filesProcessed: 0,
      chunksIngested: 0,
      chunksSkipped: 0,
      chunksDeduped: 0,
      dedupReasonCounts: createDedupReasonCounts(),
      errors: ["Invalid connector-v1 format: missing version/source/scope/records"],
    };
  }

  const connectorData = parsed as ConnectorOutputV1;
  const { source, scope, records } = connectorData;

  const result: IngestResult = {
    source: `connector:${source}`,
    filesProcessed: 1,
    chunksIngested: 0,
    chunksSkipped: 0,
    chunksDeduped: 0,
    dedupReasonCounts: createDedupReasonCounts(),
    errors: [],
  };

  if (records.length === 0) return result;

  const batchSize = 32;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const texts = batch.map((r: ConnectorRecord) =>
      r.title ? `[${r.title}] ${r.text}` : r.text,
    );

    try {
      const vectors = await embedder.embedBatchPassage(texts);

      // --- dedup pass ---
      const dedupedTexts: string[] = [];
      const dedupedVectors: number[][] = [];
      const dedupedRecords: ConnectorRecord[] = [];

      for (let j = 0; j < batch.length; j++) {
        const vector = vectors[j];
        if (!vector || vector.length === 0) {
          result.chunksSkipped++;
          continue;
        }
        if (!options.noDedup) {
          const decision = await dedupCheck(store, vector, texts[j], options.llm);
          recordDedupDecision(result, decision);
          if (decision.secondaryDeletes?.length) {
            await executeSecondaryDeletes(store, decision.secondaryDeletes);
          }
          if (decision.action === "skip") continue;
        }
        dedupedTexts.push(texts[j]);
        dedupedVectors.push(vector);
        dedupedRecords.push(batch[j]);
      }

      if (dedupedTexts.length === 0) continue;

      // --- extract + build entries ---
      const extractions = await smartExtractBatch(dedupedTexts, options.llm);
      const coreSummaries = await generateCoreSummaries(dedupedTexts, options.llm);
      const toStore: Array<{
        text: string;
        vector: number[];
        category: string;
        scope: string;
        importance: number;
        metadata: string;
      }> = [];

      for (let j = 0; j < dedupedTexts.length; j++) {
        const record = dedupedRecords[j];
        const entry = buildIngestedEntry({
          source: `connector:${source}`,
          scope,
          text: dedupedTexts[j],
          vector: dedupedVectors[j],
          extraction: extractions[j],
          file: record.id,
          heading: record.title,
          coreSummary: coreSummaries[j],
        });

        // Merge connector-specific metadata
        const meta = JSON.parse(entry.metadata);
        if (record.tags?.length) meta.connectorTags = record.tags;
        if (record.contentHash) meta.contentHash = record.contentHash;
        if (record.sourceMetadata) meta.sourceMetadata = record.sourceMetadata;
        entry.metadata = JSON.stringify(meta);

        // Respect categoryHint / importanceHint from connector
        if (record.categoryHint) {
          entry.category = record.categoryHint;
        }
        if (record.importanceHint !== undefined) {
          entry.importance = record.importanceHint;
        }

        toStore.push(entry);
      }

      if (toStore.length > 0) {
        await store.storeBatch(toStore);
        result.chunksIngested += toStore.length;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Connector batch error: ${msg}`);
    }
  }

  if (options.verbose) {
    console.log(`  connector:${source}: ${records.length} records → ${result.chunksIngested} stored`);
  }

  // GB-3: Write source heartbeat after connector ingest
  try {
    const { writeHeartbeat } = await import("./source-heartbeat.js");
    writeHeartbeat(source, result.chunksIngested, result.errors);
  } catch {
    // Heartbeat write is best-effort — don't break ingest on failure
  }

  return result;
}

// ============================================================================
// Obsidian Vault Ingest (GB-1)
// ============================================================================

/**
 * Scan an Obsidian vault and ingest its markdown files through the connector-v1 pipeline.
 *
 * Wrapper that:
 * 1. Validates the path is an Obsidian vault (.obsidian/ exists)
 * 2. Calls scanVault() to produce a ConnectorOutputV1 payload
 * 3. Feeds the payload to ingestConnectorFile()
 */
export async function ingestObsidianVault(
  store: MemoryStore,
  embedder: Embedder,
  vaultPath: string,
  options: {
    verbose?: boolean;
    noDedup?: boolean;
    llm?: LLMClient | null;
    scopePrefix?: string;
  } = {},
): Promise<IngestResult> {
  const resolved = expandHome(vaultPath);

  if (!isObsidianVault(resolved)) {
    return {
      source: "obsidian",
      filesProcessed: 0,
      chunksIngested: 0,
      chunksSkipped: 0,
      chunksDeduped: 0,
      dedupReasonCounts: createDedupReasonCounts(),
      errors: [`Not an Obsidian vault (missing .obsidian/ directory): ${resolved}`],
    };
  }

  const output = scanVault(resolved, { scopePrefix: options.scopePrefix });
  const content = JSON.stringify(output);

  if (options.verbose) {
    console.log(`  obsidian: scanned ${output.records.length} notes from ${resolved}`);
  }

  return ingestConnectorFile(store, embedder, content, options);
}
