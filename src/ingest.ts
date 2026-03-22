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
import type { MemoryStore, MemoryEntry } from "./store.js";
import type { Embedder } from "./embedder.js";
import { chunkDocument, type ChunkerConfig } from "./chunker.js";
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
 */
const DEDUP_HARD_THRESHOLD = 0.80;
const DEDUP_SOFT_THRESHOLD = 0.68;
const DEDUP_CANDIDATE_LIMIT = 5;

interface AtomicPreferenceGuardDecision {
  shouldForceCreate: boolean;
  matchedText?: string;
}

export type DedupReason = "hard" | "exact" | "llm-skip" | "llm-merge" | "unique";

export type DedupReasonCounts = Record<DedupReason, number>;

export interface DedupCheckResult {
  action: "store" | "skip";
  reason: DedupReason;
  existingText?: string;
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

    const topScore = results[0].score;
    const existingText = results[0].entry.text;

    // Hard duplicate: skip without LLM
    if (topScore >= DEDUP_HARD_THRESHOLD) {
      return { action: "skip", reason: "hard", existingText };
    }

    // Borderline: ask LLM if available
    if (llm) {
      try {
        const decision = await llm.dedupDecision(text, existingText);
        if (decision.action === "SKIP") {
          return { action: "skip", reason: "llm-skip", existingText };
        }
        if (decision.action === "MERGE") {
          return { action: "store", reason: "llm-merge", existingText };
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

// ─── Pending extraction queue (for when LLM is unavailable) ─────────────────

const PENDING_EXTRACTION_FILE = resolve(
  dirname(import.meta.url.replace("file://", "")), "..", "data", "pending-extraction.json"
);

function queueForLaterExtraction(chunks: Array<{ text: string; scope: string }>): void {
  let pending: Array<{ text: string; scope: string; queuedAt: string }> = [];
  try {
    pending = JSON.parse(readFileSync(PENDING_EXTRACTION_FILE, "utf-8"));
  } catch { /* empty or missing */ }
  const now = new Date().toISOString();
  for (const chunk of chunks) {
    pending.push({ ...chunk, queuedAt: now });
  }
  writeFileSync(PENDING_EXTRACTION_FILE, JSON.stringify(pending, null, 2));
}

export async function drainPendingQueue(
  store: MemoryStore,
  embedder: Embedder,
  llm: LLMClient,
): Promise<{ processed: number; errors: number }> {
  let pending: Array<{ text: string; scope: string; queuedAt: string }> = [];
  try {
    pending = JSON.parse(readFileSync(PENDING_EXTRACTION_FILE, "utf-8"));
  } catch { return { processed: 0, errors: 0 }; }

  if (pending.length === 0) return { processed: 0, errors: 0 };

  let processed = 0, errors = 0;
  for (let i = 0; i < pending.length; i += 20) {
    const batch = pending.slice(i, i + 20);
    const texts = batch.map(c => c.text);
    const extractions = await smartExtractBatch(texts, llm);
    const embeddingTexts = extractions.map(e => e.l1 || e.l0);
    const vectors = await embedder.embedBatchPassage(embeddingTexts);
    for (let j = 0; j < extractions.length; j++) {
      try {
        await store.store({
          text: extractions[j].l1 || extractions[j].l0,
          vector: vectors[j],
          category: extractions[j].category as any,
          scope: batch[j].scope,
          importance: extractions[j].importance,
          metadata: JSON.stringify({ source: batch[j].scope.split(":")[0], l0: extractions[j].l0 }),
        });
        processed++;
      } catch { errors++; }
    }
  }

  // Clear the queue
  writeFileSync(PENDING_EXTRACTION_FILE, "[]");
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
      l0: params.extraction.l0,
      l1: params.extraction.l1,
      tier,
      boundary: resolution.boundary,
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

function groupTurnsIntoChunks(turns: ConversationTurn[]): Array<{
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
      const merged = `[用户] ${turn.text}\n\n[助手] ${nextTurn.text}`;

      // If merged text is too long, chunk it
      if (merged.length > CONVERSATION_CHUNK_CONFIG.maxChunkSize) {
        const chunkResult = chunkDocument(merged, CONVERSATION_CHUNK_CONFIG);
        for (const chunk of chunkResult.chunks) {
          chunks.push({
            text: chunk,
            timestamp: turn.timestamp,
            sessionId: turn.sessionId,
          });
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
      const text = `${prefix} ${turn.text}`;

      if (text.length > CONVERSATION_CHUNK_CONFIG.maxChunkSize) {
        const chunkResult = chunkDocument(text, CONVERSATION_CHUNK_CONFIG);
        for (const chunk of chunkResult.chunks) {
          chunks.push({
            text: chunk,
            timestamp: turn.timestamp,
            sessionId: turn.sessionId,
          });
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

  return chunks;
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
  options: { limit?: number; verbose?: boolean; noDedup?: boolean; llm?: LLMClient | null } = {},
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

  const baseDir = expandHome("~/.codex/sessions");
  if (!existsSync(baseDir)) {
    result.errors.push(`Codex sessions directory not found: ${baseDir}`);
    return result;
  }

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
  walk(baseDir);
  allFiles.sort();

  const filesToProcess = options.limit ? allFiles.slice(0, options.limit) : allFiles;
  const total = filesToProcess.length;

  for (let fi = 0; fi < filesToProcess.length; fi++) {
    const filePath = filesToProcess[fi];

    try {
      const stat = statSync(filePath);
      if (stat.size < 200) {
        result.chunksSkipped++;
        continue;
      }

      if (isProcessed(filePath, stat.size, stat.mtimeMs)) {
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
  options: { limit?: number; verbose?: boolean; noDedup?: boolean; llm?: LLMClient | null } = {},
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

  const filesToProcess = options.limit ? allFiles.slice(0, options.limit) : allFiles;
  const total = filesToProcess.length;

  for (let fi = 0; fi < filesToProcess.length; fi++) {
    const filePath = filesToProcess[fi];

    try {
      const stat = statSync(filePath);
      if (stat.size < 100) {
        result.chunksSkipped++;
        continue;
      }

      if (isProcessed(filePath, stat.size, stat.mtimeMs)) {
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
  options: { limit?: number; verbose?: boolean; noDedup?: boolean; llm?: LLMClient | null } = {},
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

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

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
      if (isProcessed(filePath, stat.size, stat.mtimeMs)) {
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
    result.errors.push(`Directory not found: ${dir}`);
    return result;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const filePath = join(dir, file);

    try {
      const stat = statSync(filePath);
      if (isProcessed(filePath, stat.size, stat.mtimeMs)) {
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
              if (decision.action === "skip") continue;
            }
            dedupedTexts.push(batch[j]);
            dedupedVectors.push(vector);
            dedupedSections.push(batchSections[j]);
          }

          if (dedupedTexts.length > 0) {
            const extractions = await smartExtractBatch(dedupedTexts, options.llm);
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
              if (decision.action === "skip") continue;
            }
            dedupedTexts.push(batch[j]);
            dedupedVectors.push(vector);
          }

          if (dedupedTexts.length > 0) {
            const extractions = await smartExtractBatch(dedupedTexts, options.llm);
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
