import type { LLMClient } from "./llm-client.js";
import type { Embedder } from "./embedder.js";
import type { MemoryStore } from "./store.js";
import type { ConflictCandidateStore } from "./conflict-store.js";
import type { KGExtractor } from "./kg-extractor.js";
import type { AuditLogger } from "./audit-log.js";
import type { StoredMemoryRecord, DurableMemoryCategory } from "./memory-schema.js";
import { persistMemory } from "./capture-engine.js";
import { detectLang, getSessionPromptHook } from "./language-hook.js";
import { withWriteLock } from "./distill-lock.js";

// ============================================================================
// Types
// ============================================================================

export interface ConversationMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name?: string;
  timestamp?: string;
}

export interface MicrocompactResult {
  tokens_freed: number;
  tools_cleared: number;
}

export interface SummaryResult {
  text: string;
  dimensions: Record<string, string>;
}

export interface PersistResult {
  memories_stored: number;
  memories_deduped: number;
  memories_conflicted: number;
  ids: string[];
}

export interface DistillResult {
  microcompact: MicrocompactResult;
  summary: SummaryResult;
  persisted: PersistResult;
  compacted_messages: ConversationMessage[];
}

interface PersistDeps {
  store: Pick<MemoryStore, "store" | "list" | "update" | "getById" | "get" | "vectorSearch">;
  embedder: Pick<Embedder, "embedPassage">;
  conflictStore?: Pick<ConflictCandidateStore, "save" | "replace" | "getOpenByFingerprint" | "getLatestByFingerprint">;
  llm?: LLMClient | null;
  kgExtractor?: KGExtractor | null;
  auditLogger?: AuditLogger | null;
}

// ============================================================================
// Constants
// ============================================================================

const CLEARABLE_TOOLS = new Set([
  "read_file", "bash", "grep", "glob", "web_search", "web_fetch",
  "edit_file", "write_file", "Read", "Write", "Edit", "Bash",
  "Grep", "Glob", "WebSearch", "WebFetch",
]);

// Session summary fallback prompts (used when babel-memory is not installed)

const DEFAULT_DIMENSION_LABELS: Record<string, string> = {
  user_intent: "User intent and requests",
  technical_concepts: "Key technical concepts",
  files_and_code: "Files and code segments involved",
  errors_and_fixes: "Errors and fix records",
  problem_solving: "Problem solving process",
  user_quotes: "User original quotes preserved",
  user_profile: "Stable facts about the user: identity, role, background, long-term context",
  unfinished_tasks: "Unfinished tasks",
  current_state: "Current work state",
  next_steps: "Suggested next steps",
};

const DEFAULT_SESSION_SYSTEM = `You are a session summarizer. Analyze the conversation and produce a structured summary.
Wrap the summary in <summary></summary> tags.
Use numbered ## headings for each dimension:
${Object.entries(DEFAULT_DIMENSION_LABELS).map(([, label], i) => `## ${i + 1}. ${label}`).join("\n")}
If a dimension has no relevant content, write "N/A".`;

interface DimensionMapping {
  category: DurableMemoryCategory;
  importance: number;
}

const DIMENSION_TO_MEMORY: Record<string, DimensionMapping> = {
  user_intent: { category: "events", importance: 0.5 },
  files_and_code: { category: "entities", importance: 0.6 },
  errors_and_fixes: { category: "cases", importance: 0.7 },
  problem_solving: { category: "patterns", importance: 0.8 },
  user_quotes: { category: "preferences", importance: 0.7 },
  // user_profile → profile：让 distill 能沉淀"用户是谁"的稳定身份事实（不只是偏好）。
  // distill 走 source=agent，不被 resolveIngestBoundary 降级，直接进 durable profile。
  user_profile: { category: "profile", importance: 0.8 },
  // 2026-05-13 P1.2: 加 unfinished_tasks + next_steps 持久化映射
  // LLM 早在 DEFAULT_DIMENSION_LABELS 行 74/76 已产出这两条，但缺映射被丢弃
  // 都映射到 cases/patterns 走 tag 兜底（extractAndPersist 自动加 tags: ["session_distill", dimKey]）
  // 未来如要 unresolved-first 召回，按 tags 含 "unfinished_tasks" 过滤即可
  unfinished_tasks: { category: "cases", importance: 0.75 },
  next_steps: { category: "patterns", importance: 0.65 },
};

// ============================================================================
// Layer 1: Microcompact
// ============================================================================

export function microcompact(
  messages: ConversationMessage[],
  opts: { preserveRecent?: number; keepRecentTools?: number } = {},
): { messages: ConversationMessage[]; result: MicrocompactResult } {
  const preserveRecent = opts.preserveRecent ?? 6;
  const keepRecentTools = opts.keepRecentTools ?? 5;

  if (messages.length === 0) {
    return { messages: [], result: { tokens_freed: 0, tools_cleared: 0 } };
  }

  const cutoff = Math.max(0, messages.length - preserveRecent);
  let tokensFreed = 0;
  let toolsCleared = 0;

  // Find tool messages eligible for clearing (before the preserve window)
  const toolIndices: number[] = [];
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];
    if (msg.role === "tool" && msg.tool_name && CLEARABLE_TOOLS.has(msg.tool_name)) {
      toolIndices.push(i);
    }
  }

  // Keep the most recent N tool results even if they're before the cutoff
  const indicesToClear = new Set(
    toolIndices.slice(0, Math.max(0, toolIndices.length - keepRecentTools)),
  );

  const compacted: ConversationMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (indicesToClear.has(i)) {
      const tokenCount = Math.ceil(msg.content.length / 4);
      tokensFreed += tokenCount;
      toolsCleared++;
      compacted.push({
        ...msg,
        content: `[Cleared: ${msg.tool_name}, ~${tokenCount} tokens]`,
      });
    } else {
      compacted.push({ ...msg });
    }
  }

  return {
    messages: compacted,
    result: { tokens_freed: tokensFreed, tools_cleared: toolsCleared },
  };
}

// ============================================================================
// Layer 2: LLM Structured Summary
// ============================================================================

export async function summarizeSession(
  messages: ConversationMessage[],
  llm: LLMClient,
): Promise<SummaryResult> {
  const conversationText = messages
    .map((m) => `[${m.role}${m.tool_name ? `:${m.tool_name}` : ""}] ${m.content.slice(0, 500)}`)
    .join("\n")
    .slice(0, 8000);

  // Use babel-memory bilingual prompt if available, otherwise fallback to defaults
  const lang = detectLang(conversationText);
  const babelPrompt = getSessionPromptHook(lang);
  const sessionSystemPrompt = babelPrompt?.system ?? DEFAULT_SESSION_SYSTEM;
  const dimensionLabels = babelPrompt?.dimensionLabels ?? DEFAULT_DIMENSION_LABELS;
  const dimensionKeys = Object.keys(dimensionLabels);

  const raw = await llm.chatLong(sessionSystemPrompt, conversationText, 2000);

  if (!raw) {
    return { text: "", dimensions: {} };
  }

  // Extract <summary> block, discard <analysis>
  const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : raw;

  // Parse dimensions from ## headings
  const dimensions: Record<string, string> = {};
  const sections = summaryText.split(/^## \d+\.\s*/m).filter(Boolean);

  for (const section of sections) {
    const firstLine = section.split("\n")[0].trim().toLowerCase();
    for (const key of dimensionKeys) {
      const label = dimensionLabels[key].toLowerCase();
      if (firstLine.includes(label) || label.includes(firstLine.replace(/\s+/g, " ").trim())) {
        const body = section.split("\n").slice(1).join("\n").trim();
        if (body && body !== "N/A") {
          dimensions[key] = body;
        }
        break;
      }
    }
  }

  return { text: summaryText, dimensions };
}

// ============================================================================
// Layer 3: Extract and Persist
// ============================================================================

export async function extractAndPersist(
  summary: SummaryResult,
  deps: PersistDeps,
  scope: string,
): Promise<PersistResult> {
  const result: PersistResult = {
    memories_stored: 0,
    memories_deduped: 0,
    memories_conflicted: 0,
    ids: [],
  };

  for (const [dimKey, mapping] of Object.entries(DIMENSION_TO_MEMORY)) {
    const dimText = summary.dimensions[dimKey];
    if (!dimText || dimText.trim().length < 10) continue;

    try {
      const stored = await persistMemory(deps, {
        text: dimText.slice(0, 4000),
        category: mapping.category,
        importance: mapping.importance,
        scope,
        source: "agent" as const,
        tags: ["session_distill", dimKey],
      });

      trackDisposition(result, stored);
    } catch {
      // Non-fatal: continue with other dimensions
    }
  }

  return result;
}

function trackDisposition(result: PersistResult, stored: StoredMemoryRecord): void {
  result.ids.push(stored.id);
  switch (stored.disposition) {
    case "deduped":
      result.memories_deduped++;
      break;
    case "conflict":
      result.memories_conflicted++;
      break;
    default:
      result.memories_stored++;
      break;
  }
}

// ============================================================================
// Full Pipeline
// ============================================================================

export async function distillSession(
  messages: ConversationMessage[],
  deps: PersistDeps & { llm: LLMClient },
  opts: {
    scope?: string;
    preserveRecent?: number;
    keepRecentTools?: number;
    persist?: boolean;
  } = {},
): Promise<DistillResult> {
  const scope = opts.scope || "default";
  const shouldPersist = opts.persist ?? true;

  // Layer 1: Microcompact
  const { messages: compacted, result: microcompactResult } = microcompact(
    messages,
    { preserveRecent: opts.preserveRecent, keepRecentTools: opts.keepRecentTools },
  );

  // Layer 2: Summarize (using compacted messages minus preserved recent)
  const preserveRecent = opts.preserveRecent ?? 6;
  const cutoff = Math.max(0, compacted.length - preserveRecent);
  const oldMessages = compacted.slice(0, cutoff);
  const summaryResult = oldMessages.length > 0
    ? await summarizeSession(oldMessages, deps.llm)
    : { text: "", dimensions: {} };

  // Layer 3: Persist (optional)
  let persistResult: PersistResult = {
    memories_stored: 0,
    memories_deduped: 0,
    memories_conflicted: 0,
    ids: [],
  };

  if (shouldPersist && Object.keys(summaryResult.dimensions).length > 0) {
    // P0-1: serialize the persist phase per scope across processes. Wait (not skip) —
    // skipping would drop this session's distilled knowledge when two sessions distill
    // the same scope at once. Writes are fast and store-write already makes each write
    // idempotent, so the brief wait is lossless; microcompact/summary above run unlocked.
    persistResult = await withWriteLock(
      `distill-${scope}`,
      () => extractAndPersist(summaryResult, deps, scope),
    );
  }

  return {
    microcompact: microcompactResult,
    summary: summaryResult,
    persisted: persistResult,
    compacted_messages: compacted,
  };
}
