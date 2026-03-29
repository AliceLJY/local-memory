/**
 * Event Segmentation (Tier 4.5)
 *
 * Replaces fixed-character chunking with semantic event boundaries for
 * conversation text. Ensures retrieval gets complete semantic units
 * (a full Q&A exchange, a complete list, an intact code block) rather
 * than fragments cut mid-thought.
 *
 * Design: rule-based (zero LLM calls), CJK-aware, falls back to chunker
 * for segments that exceed embedding model limits.
 */

// ============================================================================
// Types
// ============================================================================

export interface EventSegment {
  text: string;
  /** Reason this boundary was detected */
  boundaryType: "topic_shift" | "qa_boundary" | "list_end" | "code_block" | "time_jump" | "initial" | "max_size";
}

export interface EventSegmenterConfig {
  /** Max chars per segment before forced split (default: 2000) */
  maxSegmentSize: number;
  /** Min chars per segment to avoid fragments (default: 200) */
  minSegmentSize: number;
}

export const DEFAULT_EVENT_SEGMENTER_CONFIG: EventSegmenterConfig = {
  maxSegmentSize: 2000,
  minSegmentSize: 200,
};

// ============================================================================
// Boundary Detection Signals
// ============================================================================

/**
 * Topic shift markers — words/phrases that signal a new topic in conversation.
 * Ordered roughly by strength of signal.
 */
const TOPIC_SHIFT_PATTERNS = [
  // Strong signals (explicit topic change)
  /^(?:\[用户\]|\[助手\])?\s*(?:另外|顺便|对了|换个话题|说到|关于另一个)/m,
  /^(?:\[用户\]|\[助手\])?\s*(?:by the way|speaking of|on another note|moving on|anyway|also,? I wanted)/im,
  // Medium signals (new question after discussion)
  /^(?:\[用户\])\s*.{0,20}[？?]\s*$/m,
];

/** Detect if text at a given line index starts a new topic */
function isTopicShift(line: string): boolean {
  return TOPIC_SHIFT_PATTERNS.some(p => p.test(line));
}

/**
 * Q&A boundary: a [用户] line after an [助手] block signals a new exchange.
 */
function isQABoundary(line: string, prevLine: string): boolean {
  return /^\[用户\]/.test(line) && /^\[助手\]/.test(prevLine.trimStart());
}

/**
 * Time jump: date/time markers that indicate a temporal discontinuity.
 */
const TIME_JUMP_PATTERN = /^(?:\[用户\]|\[助手\])?\s*(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|(?:今天|昨天|前天|上周|上个月|today|yesterday|last week))/i;

function isTimeJump(line: string): boolean {
  return TIME_JUMP_PATTERN.test(line);
}

// ============================================================================
// Code Block Tracking
// ============================================================================

/** Track code fence state to avoid splitting inside code blocks */
function isCodeFence(line: string): boolean {
  return /^```/.test(line.trim());
}

// ============================================================================
// List Completeness
// ============================================================================

/** Detect numbered or bulleted list items */
const LIST_ITEM_PATTERN = /^\s*(?:\d+[.)]\s|[-*+]\s)/;

function isListItem(line: string): boolean {
  return LIST_ITEM_PATTERN.test(line);
}

// ============================================================================
// Core Segmenter
// ============================================================================

/**
 * Segment conversation text into semantic event units.
 *
 * Strategy:
 * 1. Walk lines, tracking state (in-code-block, in-list, etc.)
 * 2. At each potential boundary, decide: split or continue
 * 3. Respect min/max size constraints
 * 4. Never split inside code blocks or mid-list
 */
export function segmentEvents(
  text: string,
  config: EventSegmenterConfig = DEFAULT_EVENT_SEGMENTER_CONFIG,
): EventSegment[] {
  if (!text || text.trim().length === 0) return [];

  // Very short text: no point in segmenting
  if (text.length <= config.minSegmentSize) {
    return [{ text: text.trim(), boundaryType: "initial" }];
  }

  const lines = text.split("\n");
  const segments: EventSegment[] = [];
  let currentLines: string[] = [];
  let currentLen = 0;
  let inCodeBlock = false;
  let inList = false;
  let pendingBoundary: EventSegment["boundaryType"] | null = null;

  function flushSegment(boundaryType: EventSegment["boundaryType"]) {
    const segText = currentLines.join("\n").trim();
    if (segText.length > 0) {
      segments.push({ text: segText, boundaryType });
    }
    currentLines = [];
    currentLen = 0;
    pendingBoundary = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLen = line.length + 1; // +1 for \n

    // Track code block state
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      currentLines.push(line);
      currentLen += lineLen;
      continue;
    }

    // Never split inside code blocks
    if (inCodeBlock) {
      currentLines.push(line);
      currentLen += lineLen;
      // Safety: if code block is absurdly long, force close
      if (currentLen > config.maxSegmentSize * 2) {
        inCodeBlock = false;
        flushSegment("code_block");
      }
      continue;
    }

    // Track list state
    if (isListItem(line)) {
      inList = true;
      currentLines.push(line);
      currentLen += lineLen;
      continue;
    } else if (inList && line.trim().length > 0) {
      // Non-list line after list items: list ended
      inList = false;
      // If accumulated enough, this is a good split point
      if (currentLen >= config.minSegmentSize) {
        pendingBoundary = "list_end";
      }
    }

    // Check boundary signals (only if we have enough content)
    if (currentLen >= config.minSegmentSize) {
      const prevLine = currentLines.length > 0 ? currentLines[currentLines.length - 1] : "";

      if (isTopicShift(line)) {
        flushSegment("topic_shift");
      } else if (isQABoundary(line, prevLine)) {
        flushSegment("qa_boundary");
      } else if (isTimeJump(line)) {
        flushSegment("time_jump");
      } else if (pendingBoundary) {
        flushSegment(pendingBoundary);
      }
    }

    // Force split if exceeding max size
    if (currentLen + lineLen > config.maxSegmentSize && currentLen >= config.minSegmentSize) {
      flushSegment("max_size");
    }

    currentLines.push(line);
    currentLen += lineLen;
  }

  // Flush remaining
  if (currentLines.length > 0) {
    flushSegment(segments.length === 0 ? "initial" : "max_size");
  }

  // Merge tiny trailing segments into the previous one
  if (segments.length > 1) {
    const last = segments[segments.length - 1];
    if (last.text.length < config.minSegmentSize) {
      const prev = segments[segments.length - 2];
      segments[segments.length - 2] = {
        text: prev.text + "\n" + last.text,
        boundaryType: prev.boundaryType,
      };
      segments.pop();
    }
  }

  return segments;
}
