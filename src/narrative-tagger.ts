/**
 * Rule-based Narrative Tagger — assigns autobiographical narrative metadata.
 *
 * Heuristics:
 * 1. Life period = scope prefix + quarterly time window (Conway's lifetime periods)
 * 2. General event = scope + daily cluster OR session ID (extended events)
 * 3. Specific event = unique episode (scope + timestamp + text hash)
 * 4. Keyword signals enrich labels (project-setup, debugging, learning, etc.)
 *
 * Zero LLM cost — pure rule-based, matching the emotion-detector pattern.
 */

import type { NarrativeMetadata } from "./narrative-schema.js";
import { isNarrativeModeEnabled } from "./narrative-schema.js";

// ---------------------------------------------------------------------------
// Keyword Signals — enrich general event labels
// ---------------------------------------------------------------------------

const EVENT_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["project-setup", ["init", "setup", "bootstrap", "create", "scaffold", "new project", "初始化", "搭建"]],
  ["development", ["implement", "build", "code", "feature", "refactor", "开发", "实现", "重构"]],
  ["debugging", ["debug", "bug", "fix", "error", "crash", "investigate", "调试", "排查", "修复"]],
  ["deployment", ["deploy", "ship", "release", "publish", "launch", "上线", "部署", "发布"]],
  ["learning", ["learn", "study", "research", "explore", "understand", "学习", "研究", "探索"]],
  ["migration", ["migrate", "upgrade", "move", "transfer", "port", "迁移", "升级"]],
  ["review", ["review", "audit", "inspect", "check", "评审", "审查"]],
  ["writing", ["write", "draft", "article", "blog", "post", "写作", "文章", "草稿"]],
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getQuarterLabel(date: Date): string {
  const q = Math.floor(date.getMonth() / 3) + 1;
  return `${date.getFullYear()}-Q${q}`;
}

function extractScopePrefix(scope: string): string {
  return scope.split(":")[0] || "global";
}

/** Deterministic short hash for stable IDs */
function quickHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Detect the dominant event type from text via keyword matching */
function detectEventType(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [label, keywords] of EVENT_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) {
      return label;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ID Derivation
// ---------------------------------------------------------------------------

function deriveLifePeriodId(scope: string, timestamp: number): string {
  const date = new Date(timestamp);
  const quarter = getQuarterLabel(date);
  const prefix = extractScopePrefix(scope);
  return `lp:${prefix}:${quarter}`;
}

function deriveLifePeriodLabel(scope: string, timestamp: number): string {
  const date = new Date(timestamp);
  const quarter = getQuarterLabel(date);
  const prefix = extractScopePrefix(scope);
  return `${prefix} (${quarter})`;
}

function deriveGeneralEventId(scope: string, timestamp: number, sessionId?: string): string {
  if (sessionId) {
    return `ge:${sessionId}`;
  }
  const date = new Date(timestamp);
  const day = date.toISOString().split("T")[0];
  const scopeKey = scope.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 40);
  return `ge:${scopeKey}:${day}`;
}

function deriveGeneralEventLabel(
  scope: string,
  text: string,
  timestamp: number,
): string {
  const date = new Date(timestamp);
  const day = date.toISOString().split("T")[0];
  const eventType = detectEventType(text);
  const scopeShort = scope.length > 30 ? scope.slice(0, 30) + "\u2026" : scope;

  if (eventType) {
    return `${eventType} @ ${scopeShort} (${day})`;
  }
  return `activity @ ${scopeShort} (${day})`;
}

function deriveSpecificEventId(scope: string, timestamp: number, textHash: string): string {
  const prefix = extractScopePrefix(scope);
  return `se:${prefix}:${timestamp}:${textHash}`;
}

function deriveSpecificEventLabel(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? clean.slice(0, 57) + "\u2026" : clean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Tag a memory with narrative metadata using rule-based heuristics.
 * Returns null when RECALLNEST_NARRATIVE_MODE is not enabled.
 */
export function tagNarrative(params: {
  scope: string;
  text: string;
  timestamp: number;
  sessionId?: string;
  sequence?: number;
}): NarrativeMetadata | null {
  if (!isNarrativeModeEnabled()) return null;

  const { scope, text, timestamp, sessionId, sequence } = params;
  const textHash = quickHash(text.slice(0, 200));

  return {
    lifePeriodId: deriveLifePeriodId(scope, timestamp),
    lifePeriodLabel: deriveLifePeriodLabel(scope, timestamp),
    generalEventId: deriveGeneralEventId(scope, timestamp, sessionId),
    generalEventLabel: deriveGeneralEventLabel(scope, text, timestamp),
    specificEventId: deriveSpecificEventId(scope, timestamp, textHash),
    specificEventLabel: deriveSpecificEventLabel(text),
    startAt: timestamp,
    endAt: null,
    sequence: sequence ?? 0,
  };
}

/**
 * Conditionally tag narrative. Returns null when feature flag is off.
 * Convenience wrapper matching the detectEmotionIfEnabled pattern.
 */
export function tagNarrativeIfEnabled(params: {
  scope: string;
  text: string;
  timestamp: number;
  sessionId?: string;
  sequence?: number;
}): NarrativeMetadata | null {
  return tagNarrative(params);
}
