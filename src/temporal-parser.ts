/**
 * Temporal Reasoning (Tier 4.4)
 *
 * Parses time expressions from queries and converts them to
 * timestamp-based constraints for filtering memories.
 *
 * Design: rule-based (zero LLM calls), bilingual (EN + ZH).
 * Falls back gracefully — if no time expression detected, returns null.
 */

// ============================================================================
// Types
// ============================================================================

export interface TemporalConstraint {
  type: "range" | "before" | "after";
  /** Start of range (inclusive), Unix ms */
  startMs?: number;
  /** End of range (inclusive), Unix ms */
  endMs?: number;
  /** Original matched expression (for debug/trace) */
  anchor: string;
}

export interface TemporalParseResult {
  /** Extracted temporal constraint, null if no time expression detected */
  constraint: TemporalConstraint | null;
  /** Query with temporal expressions removed (for semantic search) */
  cleanedQuery: string;
}

// ============================================================================
// Date Helpers
// ============================================================================

function startOfYear(year: number): number {
  return new Date(year, 0, 1).getTime();
}

function endOfYear(year: number): number {
  return new Date(year + 1, 0, 1).getTime() - 1;
}

function startOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getTime();
}

function endOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 1).getTime() - 1;
}

function daysAgo(n: number): number {
  return Date.now() - n * 86_400_000;
}

// ============================================================================
// Month Mapping
// ============================================================================

const MONTH_MAP_EN: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const MONTH_MAP_ZH: Record<string, number> = {
  "一月": 0, "二月": 1, "三月": 2, "四月": 3, "五月": 4, "六月": 5,
  "七月": 6, "八月": 7, "九月": 8, "十月": 9, "十一月": 10, "十二月": 11,
};

// ============================================================================
// Pattern Definitions (ordered by specificity — most specific first)
// ============================================================================

type PatternHandler = (match: RegExpMatchArray) => { constraint: TemporalConstraint; matchedText: string };

interface TemporalPattern {
  pattern: RegExp;
  handler: PatternHandler;
  /** F3 writer: safe to extract as an absolute event time from memory text
   *  (no Date.now() dependency, unlike relative anchors). */
  absolute?: boolean;
}

function now(): Date {
  return new Date();
}

const PATTERNS: TemporalPattern[] = [
  // --- Operator syntax: after:YYYY-MM, before:YYYY-MM ---
  {
    pattern: /after:(\d{4})-(\d{1,2})/i,
    handler: (m) => {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      return {
        constraint: { type: "after", startMs: startOfMonth(year, month), anchor: m[0] },
        matchedText: m[0],
      };
    },
  },
  {
    pattern: /before:(\d{4})-(\d{1,2})/i,
    handler: (m) => {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      return {
        constraint: { type: "before", endMs: endOfMonth(year, month), anchor: m[0] },
        matchedText: m[0],
      };
    },
  },

  // --- Absolute year+month (ZH): "2023年三月" / "2023年3月" ---
  {
    absolute: true,
    pattern: /(\d{4})年([\u4e00-\u9fff]+月|\d{1,2}月)/,
    handler: (m) => {
      const year = parseInt(m[1], 10);
      const monthStr = m[2].replace("月", "");
      let month: number;
      if (/^\d+$/.test(monthStr)) {
        month = parseInt(monthStr, 10) - 1;
      } else {
        month = MONTH_MAP_ZH[monthStr + "月"] ?? -1;
      }
      if (month < 0 || month > 11) return { constraint: { type: "range", anchor: m[0] }, matchedText: m[0] };
      return {
        constraint: {
          type: "range",
          startMs: startOfMonth(year, month),
          endMs: endOfMonth(year, month),
          anchor: m[0],
        },
        matchedText: m[0],
      };
    },
  },

  // --- Absolute year+month (EN): "March 2023" / "2023 March" ---
  {
    absolute: true,
    pattern: /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})\b/i,
    handler: (m) => {
      const month = MONTH_MAP_EN[m[1].toLowerCase()];
      const year = parseInt(m[2], 10);
      if (month === undefined) return { constraint: { type: "range", anchor: m[0] }, matchedText: m[0] };
      return {
        constraint: { type: "range", startMs: startOfMonth(year, month), endMs: endOfMonth(year, month), anchor: m[0] },
        matchedText: m[0],
      };
    },
  },

  // --- Absolute year (ZH): "2023年" (standalone, not followed by month) ---
  {
    absolute: true,
    pattern: /(\d{4})年(?:的(?:记忆|事|内容|对话))?/,
    handler: (m) => {
      const year = parseInt(m[1], 10);
      return {
        constraint: { type: "range", startMs: startOfYear(year), endMs: endOfYear(year), anchor: m[0] },
        matchedText: m[0],
      };
    },
  },

  // --- "in YYYY" / "from YYYY" ---
  {
    absolute: true,
    pattern: /\b(?:in|from|during)\s+(\d{4})\b/i,
    handler: (m) => {
      const year = parseInt(m[1], 10);
      return {
        constraint: { type: "range", startMs: startOfYear(year), endMs: endOfYear(year), anchor: m[0] },
        matchedText: m[0],
      };
    },
  },

  // --- Relative: "最近N天/周/月" ---
  {
    pattern: /最近(\d+)\s*(天|周|月|个月)/,
    handler: (m) => {
      const n = parseInt(m[1], 10);
      let days: number;
      switch (m[2]) {
        case "天": days = n; break;
        case "周": days = n * 7; break;
        case "月": case "个月": days = n * 30; break;
        default: days = n;
      }
      return {
        constraint: { type: "range", startMs: daysAgo(days), endMs: Date.now(), anchor: m[0] },
        matchedText: m[0],
      };
    },
  },

  // --- Relative: "last N days/weeks/months" ---
  {
    pattern: /\blast\s+(\d+)\s*(days?|weeks?|months?)\b/i,
    handler: (m) => {
      const n = parseInt(m[1], 10);
      let days: number;
      if (/week/i.test(m[2])) days = n * 7;
      else if (/month/i.test(m[2])) days = n * 30;
      else days = n;
      return {
        constraint: { type: "range", startMs: daysAgo(days), endMs: Date.now(), anchor: m[0] },
        matchedText: m[0],
      };
    },
  },

  // --- Relative: "去年N月" (must come before standalone 去年) ---
  {
    pattern: /去年(\d{1,2})月/,
    handler: (m) => {
      const month = parseInt(m[1], 10) - 1;
      const year = now().getFullYear() - 1;
      return {
        constraint: { type: "range", startMs: startOfMonth(year, month), endMs: endOfMonth(year, month), anchor: m[0] },
        matchedText: m[0],
      };
    },
  },

  // --- Relative: "上周/上个月/去年/前年" ---
  {
    pattern: /(上周|上个月|去年|前年|大前年)/,
    handler: (m) => {
      const n = now();
      const year = n.getFullYear();
      const month = n.getMonth();
      switch (m[1]) {
        case "上周":
          return { constraint: { type: "range", startMs: daysAgo(14), endMs: daysAgo(7), anchor: m[0] }, matchedText: m[0] };
        case "上个月":
          return { constraint: { type: "range", startMs: startOfMonth(year, month - 1), endMs: endOfMonth(year, month - 1), anchor: m[0] }, matchedText: m[0] };
        case "去年":
          return { constraint: { type: "range", startMs: startOfYear(year - 1), endMs: endOfYear(year - 1), anchor: m[0] }, matchedText: m[0] };
        case "前年":
          return { constraint: { type: "range", startMs: startOfYear(year - 2), endMs: endOfYear(year - 2), anchor: m[0] }, matchedText: m[0] };
        case "大前年":
          return { constraint: { type: "range", startMs: startOfYear(year - 3), endMs: endOfYear(year - 3), anchor: m[0] }, matchedText: m[0] };
        default:
          return { constraint: { type: "range", anchor: m[0] }, matchedText: m[0] };
      }
    },
  },

  // --- Relative: "last week/month/year" ---
  {
    pattern: /\blast\s+(week|month|year)\b/i,
    handler: (m) => {
      const n = now();
      const year = n.getFullYear();
      const month = n.getMonth();
      switch (m[1].toLowerCase()) {
        case "week":
          return { constraint: { type: "range", startMs: daysAgo(14), endMs: daysAgo(7), anchor: m[0] }, matchedText: m[0] };
        case "month":
          return { constraint: { type: "range", startMs: startOfMonth(year, month - 1), endMs: endOfMonth(year, month - 1), anchor: m[0] }, matchedText: m[0] };
        case "year":
          return { constraint: { type: "range", startMs: startOfYear(year - 1), endMs: endOfYear(year - 1), anchor: m[0] }, matchedText: m[0] };
        default:
          return { constraint: { type: "range", anchor: m[0] }, matchedText: m[0] };
      }
    },
  },

];

// ============================================================================
// Main Parser
// ============================================================================

/**
 * Parse a query for temporal expressions and extract constraints.
 * Returns the constraint and a cleaned query (temporal part removed).
 */
export function parseTemporalQuery(query: string): TemporalParseResult {
  for (const { pattern, handler } of PATTERNS) {
    const match = query.match(pattern);
    if (match) {
      const { constraint, matchedText } = handler(match);
      if (constraint.startMs || constraint.endMs) {
        const cleanedQuery = query.replace(matchedText, "").replace(/\s+/g, " ").trim();
        return { constraint, cleanedQuery: cleanedQuery || query };
      }
    }
  }

  return { constraint: null, cleanedQuery: query };
}

/**
 * Check if a timestamp falls within a temporal constraint.
 */
export function matchesTemporalConstraint(timestampMs: number, constraint: TemporalConstraint): boolean {
  switch (constraint.type) {
    case "range":
      if (constraint.startMs && timestampMs < constraint.startMs) return false;
      if (constraint.endMs && timestampMs > constraint.endMs) return false;
      return true;
    case "after":
      return constraint.startMs ? timestampMs >= constraint.startMs : true;
    case "before":
      return constraint.endMs ? timestampMs <= constraint.endMs : true;
    default:
      return true;
  }
}

/**
 * Build a LanceDB WHERE clause string from a temporal constraint.
 * Returns null if no constraint applicable.
 */
export function temporalWhereClause(constraint: TemporalConstraint): string | null {
  const conditions: string[] = [];
  if (constraint.startMs) conditions.push(`timestamp >= ${constraint.startMs}`);
  if (constraint.endMs) conditions.push(`timestamp <= ${constraint.endMs}`);
  return conditions.length > 0 ? conditions.join(" AND ") : null;
}

/**
 * F3 writer: extract an ABSOLUTE event time from memory TEXT (not a query).
 *
 * Only patterns flagged `absolute` are scanned — relative anchors ("上周" /
 * "last month") resolve against Date.now() and would mis-anchor when applied
 * to historical memory text, so they are deliberately skipped in this pass.
 * Returns the START of the matched period as the event time, plus the matched
 * anchor string (for dry-run auditability), or null when no absolute anchor
 * is present.
 */
export function extractEventTimeFromText(
  text: string,
): { eventTime: number; anchor: string } | null {
  for (const { pattern, handler, absolute } of PATTERNS) {
    if (!absolute) continue;
    const match = text.match(pattern);
    if (!match) continue;
    const { constraint, matchedText } = handler(match);
    if (constraint.startMs != null) {
      return { eventTime: constraint.startMs, anchor: matchedText };
    }
  }
  return null;
}
