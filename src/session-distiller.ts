/**
 * Session Distiller — 会话蒸馏器
 *
 * 三层蒸馏：
 * - Layer 1: 微压缩（零成本，清除旧工具调用结果）
 * - Layer 2: LLM 结构化摘要（9 维度）
 * - Layer 3: 记忆沉淀（提取知识存入 RecallNest）
 *
 * 来源：OpenHarness auto-compaction 模式 → RecallNest 适配
 * CC/OpenHarness compact 完就丢，这里补上"沉淀为持久记忆"的闭环。
 */

import type { LLMClient } from "./llm-client.js";
import type { DurableMemoryCategory } from "./memory-schema.js";

// ============================================================================
// Types
// ============================================================================

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  /** tool_use / tool_result: tool name */
  name?: string;
  /** tool_use: tool call ID */
  id?: string;
  /** tool_use: input params */
  input?: Record<string, unknown>;
  /** tool_result: the result content */
  content?: string;
  /** text block content */
  text?: string;
  /** tool_result: the tool_use_id this result corresponds to */
  tool_use_id?: string;
}

export interface MicrocompactResult {
  messages: ConversationMessage[];
  tokensFred: number;
  toolsCleared: number;
}

export interface SummaryDimensions {
  userIntent: string;
  keyConcepts: string;
  filesAndCode: string;
  errorsAndFixes: string;
  problemSolving: string;
  userQuotes: string;
  pendingTasks: string;
  currentWork: string;
  suggestedNext: string;
}

export interface SummarizeResult {
  text: string;
  dimensions: SummaryDimensions;
}

export interface PersistResult {
  memoriesStored: number;
  memoriesDeduped: number;
  memoriesConflicted: number;
  memoriesRejected: number;
  ids: string[];
}

export interface DistillSessionResult {
  microcompact: {
    tokensFreed: number;
    toolsCleared: number;
  };
  summary: SummarizeResult | null;
  persisted: PersistResult | null;
  compactedMessages: ConversationMessage[];
}

// ============================================================================
// Constants
// ============================================================================

/** Tools whose old results can be safely cleared */
const COMPACTABLE_TOOLS = new Set([
  "Read",
  "read_file",
  "Bash",
  "bash",
  "Grep",
  "grep",
  "Glob",
  "glob",
  "WebSearch",
  "web_search",
  "WebFetch",
  "web_fetch",
  "Edit",
  "edit_file",
  "Write",
  "write_file",
]);

const CLEARED_MARKER = "[Cleared]";

const DEFAULT_KEEP_RECENT_TOOLS = 5;
const DEFAULT_PRESERVE_RECENT = 6;

// ============================================================================
// Layer 1: Microcompact (zero cost, pure rules)
// ============================================================================

/** Estimate tokens from text: ~1 token per 4 chars, conservative. */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Extract text content from a message (handles both string and ContentBlock[]).
 */
function getMessageText(msg: ConversationMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .map((b) => b.text || b.content || "")
    .filter(Boolean)
    .join("\n");
}

/**
 * Collect all tool_use block IDs from compactable tools in message order.
 */
function collectCompactableToolUseIds(messages: ConversationMessage[]): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (
        block.type === "tool_use" &&
        block.id &&
        block.name &&
        COMPACTABLE_TOOLS.has(block.name)
      ) {
        ids.push(block.id);
      }
    }
  }
  return ids;
}

/**
 * Layer 1: Microcompact — clear old tool results, keep recent N.
 *
 * Pure function. Returns a deep copy with cleared results + stats.
 * Does NOT call LLM.
 */
export function microcompact(
  messages: ConversationMessage[],
  keepRecent = DEFAULT_KEEP_RECENT_TOOLS,
): MicrocompactResult {
  const toolUseIds = collectCompactableToolUseIds(messages);

  // Keep the most recent N tool results
  const keepSet = new Set(toolUseIds.slice(-keepRecent));

  let tokensFreed = 0;
  let toolsCleared = 0;

  // Deep copy + clear old results
  const result: ConversationMessage[] = messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { ...msg };
    }
    const newContent: ContentBlock[] = msg.content.map((block) => {
      if (
        block.type === "tool_result" &&
        block.tool_use_id &&
        !keepSet.has(block.tool_use_id) &&
        block.content
      ) {
        // Check if this tool_use_id belongs to a compactable tool
        const isCompactable = toolUseIds.includes(block.tool_use_id);
        if (isCompactable) {
          const freed = estimateTokens(block.content);
          tokensFreed += freed;
          toolsCleared++;
          return {
            ...block,
            content: CLEARED_MARKER,
          };
        }
      }
      return { ...block };
    });
    return { ...msg, content: newContent };
  });

  return { messages: result, tokensFred: tokensFreed, toolsCleared };
}

// ============================================================================
// Layer 2: LLM Structured Summary (9 dimensions)
// ============================================================================

const SUMMARIZE_SYSTEM_PROMPT = `你是会话蒸馏助手。你的任务是把一段 AI 助手对话压缩为结构化摘要。

严格按以下 9 个维度输出，每个维度用 ## 标题分隔。如果某个维度没有相关内容，写"无"。

## 1. 用户意图与请求
所有用户明确提出的请求，完整列出。

## 2. 关键技术概念
讨论过的技术、框架、模式、术语。

## 3. 涉及的文件与代码段
每个被查看或修改的文件，附行号和关键代码片段。

## 4. 错误与修复记录
遇到的每个错误、原因、解决方法。

## 5. 问题解决过程
尝试过的方法，哪些成功哪些失败，为什么。

## 6. 用户原话保留
用户说的非指令性话语（偏好表达、观点、要求风格等），原样保留。

## 7. 未完成任务
明确要求但尚未完成的工作。

## 8. 当前工作状态
蒸馏时正在进行的任务的详细状态。

## 9. 建议的下一步
基于上下文推断的最合理下一步操作。

要求：
- 直接输出内容，不要加任何前缀解释
- 保真规则：文件路径、URL、端口号、API 名称原样保留
- 每个维度简洁但完整，不遗漏关键信息`;

/**
 * Parse LLM summary output into 9 dimensions.
 */
function parseDimensions(text: string): SummaryDimensions {
  const extract = (heading: string): string => {
    const pattern = new RegExp(
      `## \\d+\\.\\s*${heading}[\\s\\S]*?(?=## \\d+\\.|$)`,
    );
    const match = text.match(pattern);
    if (!match) return "";
    // Remove the heading line itself
    return match[0]
      .replace(/^## \d+\..*\n?/, "")
      .trim();
  };

  return {
    userIntent: extract("用户意图与请求"),
    keyConcepts: extract("关键技术概念"),
    filesAndCode: extract("涉及的文件与代码段"),
    errorsAndFixes: extract("错误与修复记录"),
    problemSolving: extract("问题解决过程"),
    userQuotes: extract("用户原话保留"),
    pendingTasks: extract("未完成任务"),
    currentWork: extract("当前工作状态"),
    suggestedNext: extract("建议的下一步"),
  };
}

/**
 * Build a flat text from messages for LLM input.
 */
function flattenMessages(messages: ConversationMessage[]): string {
  return messages
    .map((msg) => {
      const text = getMessageText(msg);
      return `[${msg.role}]: ${text}`;
    })
    .join("\n\n");
}

/**
 * Layer 2: Summarize session via LLM into 9 structured dimensions.
 *
 * Returns null if LLM is unavailable or fails.
 */
export async function summarizeSession(
  messages: ConversationMessage[],
  llm: LLMClient,
  preserveRecent = DEFAULT_PRESERVE_RECENT,
): Promise<{ summary: SummarizeResult; compactedMessages: ConversationMessage[] } | null> {
  if (messages.length <= preserveRecent) {
    // Nothing old enough to summarize
    return null;
  }

  const older = messages.slice(0, -preserveRecent);
  const newer = messages.slice(-preserveRecent);

  const userContent = flattenMessages(older);
  if (!userContent.trim()) return null;

  // Call LLM via chatRaw (supports custom max_tokens, uses circuit breaker)
  const rawText = await llm.chatRaw(SUMMARIZE_SYSTEM_PROMPT, userContent, 4000);
  if (!rawText) return null;

  const dimensions = parseDimensions(rawText);
  const summary: SummarizeResult = { text: rawText, dimensions };

  // Build compacted messages: [summary as synthetic user msg] + [recent preserved]
  const summaryMsg: ConversationMessage = {
    role: "user",
    content:
      "此会话从之前的对话延续而来。以下摘要涵盖了早期部分的内容。\n\n" +
      rawText +
      "\n\n最近的消息已原样保留。" +
      "\n请从上次中断处继续对话，不要询问用户任何进一步的问题。直接恢复——不要确认摘要，不要复述之前的内容。",
  };

  return {
    summary,
    compactedMessages: [summaryMsg, ...newer],
  };
}

// ============================================================================
// Layer 3: Memory Persistence (RecallNest-specific)
// ============================================================================

interface DimensionMapping {
  dimension: keyof SummaryDimensions;
  category: DurableMemoryCategory;
  importance: number;
  /** Skip if content matches this */
  skipIfEmpty: string;
}

const DIMENSION_MAPPINGS: DimensionMapping[] = [
  { dimension: "userIntent", category: "events", importance: 0.5, skipIfEmpty: "无" },
  { dimension: "errorsAndFixes", category: "cases", importance: 0.7, skipIfEmpty: "无" },
  { dimension: "problemSolving", category: "patterns", importance: 0.8, skipIfEmpty: "无" },
  { dimension: "userQuotes", category: "preferences", importance: 0.7, skipIfEmpty: "无" },
  { dimension: "filesAndCode", category: "entities", importance: 0.6, skipIfEmpty: "无" },
];

/** Min content length to bother persisting (skip trivial extractions). */
const MIN_PERSIST_LENGTH = 20;

export interface PersistDeps {
  persistMemory: (input: unknown) => Promise<{ disposition: string; id: string }>;
}

/**
 * Layer 3: Extract knowledge from structured summary and persist to RecallNest.
 *
 * Uses the existing persistMemory() flow (dedup, conflict detection, admission control).
 */
export async function extractAndPersist(
  dimensions: SummaryDimensions,
  scope: string,
  deps: PersistDeps,
): Promise<PersistResult> {
  const result: PersistResult = {
    memoriesStored: 0,
    memoriesDeduped: 0,
    memoriesConflicted: 0,
    memoriesRejected: 0,
    ids: [],
  };

  for (const mapping of DIMENSION_MAPPINGS) {
    const content = dimensions[mapping.dimension];
    if (!content || content.trim() === mapping.skipIfEmpty || content.trim().length < MIN_PERSIST_LENGTH) {
      continue;
    }

    try {
      const stored = await deps.persistMemory({
        text: content.slice(0, 4000), // Respect MemoryTextSchema max
        category: mapping.category,
        importance: mapping.importance,
        scope,
        source: "session_distill",
        tags: ["session-distill"],
      });

      switch (stored.disposition) {
        case "stored":
        case "updated":
          result.memoriesStored++;
          result.ids.push(stored.id);
          break;
        case "deduped":
          result.memoriesDeduped++;
          break;
        case "conflict":
          result.memoriesConflicted++;
          break;
        case "rejected":
          result.memoriesRejected++;
          break;
      }
    } catch {
      // Non-fatal: skip this dimension on error
      result.memoriesRejected++;
    }
  }

  return result;
}

// ============================================================================
// Orchestrator: distillSession (combines all 3 layers)
// ============================================================================

export interface DistillSessionInput {
  messages: ConversationMessage[];
  scope: string;
  preserveRecent?: number;
  keepRecentTools?: number;
  persist?: boolean;
}

export interface DistillSessionDeps {
  llm: LLMClient | null;
  persistMemory: PersistDeps["persistMemory"];
}

/**
 * Full session distillation: microcompact → LLM summary → persist to RecallNest.
 */
export async function distillSession(
  input: DistillSessionInput,
  deps: DistillSessionDeps,
): Promise<DistillSessionResult> {
  const preserveRecent = input.preserveRecent ?? DEFAULT_PRESERVE_RECENT;
  const keepRecentTools = input.keepRecentTools ?? DEFAULT_KEEP_RECENT_TOOLS;
  const shouldPersist = input.persist !== false;

  // Layer 1: Microcompact
  const mc = microcompact(input.messages, keepRecentTools);

  // Layer 2: LLM summary (if LLM available)
  let summaryResult: { summary: SummarizeResult; compactedMessages: ConversationMessage[] } | null = null;
  if (deps.llm) {
    summaryResult = await summarizeSession(mc.messages, deps.llm, preserveRecent);
  }

  // Layer 3: Persist (if summary succeeded and persist enabled)
  let persistResult: PersistResult | null = null;
  if (shouldPersist && summaryResult) {
    persistResult = await extractAndPersist(
      summaryResult.summary.dimensions,
      input.scope,
      { persistMemory: deps.persistMemory },
    );
  }

  return {
    microcompact: {
      tokensFreed: mc.tokensFred,
      toolsCleared: mc.toolsCleared,
    },
    summary: summaryResult?.summary ?? null,
    persisted: persistResult,
    compactedMessages: summaryResult?.compactedMessages ?? mc.messages,
  };
}
