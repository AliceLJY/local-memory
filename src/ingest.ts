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
import type { MemoryStore, MemoryEntry } from "./store.js";
import type { Embedder } from "./embedder.js";
import { chunkDocument, type ChunkerConfig } from "./chunker.js";
import type { ConnectorOutputV1, ConnectorRecord } from "./connector-types.js";
import { isConnectorOutputV1 } from "./connector-types.js";
import { isObsidianVault, scanVault } from "./obsidian-connector.js";
import { segmentEvents, type EventSegmenterConfig, DEFAULT_EVENT_SEGMENTER_CONFIG } from "./event-segmenter.js";
import { isProcessed, markProcessed } from "./tracker.js";
import type { LLMClient, SmartExtraction } from "./llm-client.js";
import { resolveIngestBoundary } from "./memory-boundaries.js";
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
}

interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  sessionId: string;
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
    // Stage 1: vector similarity check
    const results = await store.vectorSearch(vector, DEDUP_CANDIDATE_LIMIT, DEDUP_SOFT_THRESHOLD);
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
  return process.env.RECALLNEST_CORE_SUMMARY === "true";
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
    const texts = batch.map(c => c.text);
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
        await store.store({
          text: entryText,
          vector: vectors[j],
          category: extractions[j].category as any,
          scope: batch[j].scope,
          importance: extractions[j].importance,
          metadata: JSON.stringify({ source: batch[j].scope.split(":")[0], l0_abstract: extractions[j].l0, l1_overview: extractions[j].l1, l2_content: extractions[j].l1 || extractions[j].l0 }),
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

function parseCCTranscript(filePath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  let sessionId = "";

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);

      if (!sessionId && obj.sessionId) {
        sessionId = obj.sessionId;
      }

      if (obj.type === "user" && obj.message) {
        const msg = obj.message;
        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          // Extract text blocks, skip tool_use/tool_result/images
          text = msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text || "")
            .join("\n");
        }

        if (text.trim().length > 10) {
          turns.push({
            role: "user",
            text: text.trim(),
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
    } catch {
      // Skip malformed lines
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
}> {
  const filtered = filterNoiseTurns(turns);
  const chunks: Array<{ text: string; timestamp: string; sessionId: string }> = [];

  for (let i = 0; i < filtered.length; i++) {
    const turn = filtered[i];

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
              chunks.push({ text: chunk, timestamp: turn.timestamp, sessionId: turn.sessionId });
            }
          } else {
            chunks.push({ text: seg.text, timestamp: turn.timestamp, sessionId: turn.sessionId });
          }
        }
      } else {
        chunks.push({
          text: merged,
          timestamp: turn.timestamp,
          sessionId: turn.sessionId,
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
              chunks.push({ text: chunk, timestamp: turn.timestamp, sessionId: turn.sessionId });
            }
          } else {
            chunks.push({ text: seg.text, timestamp: turn.timestamp, sessionId: turn.sessionId });
          }
        }
      } else {
        chunks.push({
          text,
          timestamp: turn.timestamp,
          sessionId: turn.sessionId,
        });
      }
    }
  }

  // P1 defence-in-depth: re-filter AFTER splitting. Long turns pass the
  // turn-level filterNoiseTurns gate, but chunking can peel their tail into
  // severed context-JSON fragments that the turn-level check never saw.
  return chunks.filter((c) => !isNoise(c.text));
}

// ============================================================================
// Codex Session Parser
// ============================================================================

function parseCodexSession(filePath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  let sessionId = "";

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const payload = obj.payload;
      const timestamp = obj.timestamp || "";

      if (obj.type === "session_meta" && payload?.id) {
        sessionId = payload.id;
      }

      // response_item: contains user input and assistant output
      if (obj.type === "response_item" && payload) {
        const role = payload.role;
        const content = payload.content;

        if (Array.isArray(content)) {
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
    } catch {
      // Skip malformed lines
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
  options: { limit?: number; verbose?: boolean; noDedup?: boolean; llm?: LLMClient | null; recentHours?: number } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    source: "cc",
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
              dedupedChunks.map(c => ({ text: c.text, scope: `cc:${c.sessionId.slice(0, 8)}` }))
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
              source: "cc",
              scope: `cc:${chunk.sessionId.slice(0, 8)}`,
              text: dedupedTexts[j],
              vector: dedupedVectors[j],
              extraction: ext,
              sessionId: chunk.sessionId,
              file,
              coreSummary: coreSummaries[j],
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

      const texts = sections.map((s) => s.text);
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

      const texts = chunkResult.chunks;
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
