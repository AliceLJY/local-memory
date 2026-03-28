/**
 * Capture Heuristic — lightweight salience filter + pattern-based signal extraction.
 *
 * Borrowed from UltraMemory's auto-capture.ts, adapted for RecallNest:
 * - Reuses RecallNest's own noise-filter (richer than UltraMemory's)
 * - Extended Chinese patterns (primary user language)
 * - Returns items compatible with CaptureMemoryInput for batch persistence
 *
 * Zero LLM calls — pure regex/heuristic.
 * Persistence is the caller's responsibility (via persistMemoryBatch).
 */

import { isNoise } from "./noise-filter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoCaptureItem {
  text: string;
  category: "profile" | "preferences" | "events" | "cases" | "patterns";
  importance: number;
  sourceContext: string;
}

export interface AutoCaptureResult {
  /** True if text was rejected by salience pre-filter (too short / noise / greeting) */
  skippedSalience: boolean;
  items: AutoCaptureItem[];
}

// ---------------------------------------------------------------------------
// Salience pre-filter
// ---------------------------------------------------------------------------

/** Max items extracted per turn to avoid flooding the store. */
const MAX_ITEMS_PER_TURN = 5;

/** Minimum text length worth analyzing (below this is almost always noise). */
const MIN_TEXT_LENGTH = 20;

/** Greetings / affirmations / single-word responses (EN + ZH). */
const GREETING_RE =
  /^(hi|hello|hey|thanks|thank you|ok|yes|no|sure|got it|好的|谢谢|嗯|是的|好吧|行|可以|没问题|收到|明白|了解|知道了)[\s!.！。]*$/i;

/**
 * Heuristic salience check — should this conversation turn be analyzed
 * for memory extraction?
 */
export function shouldCapture(text: string): boolean {
  if (!text || text.trim().length < MIN_TEXT_LENGTH) return false;
  if (isNoise(text)) return false;
  if (GREETING_RE.test(text.trim().toLowerCase())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Heuristic extraction patterns
// ---------------------------------------------------------------------------

interface SignalPattern {
  re: RegExp;
  category: AutoCaptureItem["category"];
  importance: number;
  sourceContext: string;
}

const SIGNAL_PATTERNS: SignalPattern[] = [
  // --- Preference signals (0.8) ---
  {
    re: /(?:\b(?:i prefer|i like|i don't like|i hate|i love|i want|i need|i always use|i never use)\b|我喜欢|我不喜欢|我偏好|我想要|我习惯|我一般用|我从不用|我讨厌|以后都用|以后不要)/i,
    category: "preferences",
    importance: 0.8,
    sourceContext: "preference signal",
  },
  // --- Identity / profile signals (0.9) ---
  {
    re: /(?:\b(?:my name is|i am a|i'm a|i work at|i live in|my role is|i'm responsible for)\b|我叫|我是|我在|我的角色|我负责|我的工作是|我住在)/i,
    category: "profile",
    importance: 0.9,
    sourceContext: "identity signal",
  },
  // --- Decision signals (0.7) ---
  {
    re: /(?:\b(?:i decided|we decided|let's go with|the decision is|we agreed|final call)\b|决定了|我们选择|最终方案|确定用|就这么定了|敲定)/i,
    category: "events",
    importance: 0.7,
    sourceContext: "decision signal",
  },
  // --- Correction signals (0.85 — high value, user explicitly correcting agent) ---
  {
    re: /(?:\b(?:actually|no,? not|that's wrong|correction:|you're wrong|that's incorrect)\b|更正|其实不是|不对|搞错了|纠正一下|你说错了|应该是)/i,
    category: "cases",
    importance: 0.85,
    sourceContext: "correction signal",
  },
  // --- Explicit memory instruction signals (0.85) ---
  {
    re: /(?:\b(?:remember that|don't forget|keep in mind|note that|important:)\b|记住|别忘了|注意|以后记得|帮我记|你要记住)/i,
    category: "events",
    importance: 0.85,
    sourceContext: "explicit memory instruction",
  },
  // --- Pattern / workflow signals (0.75) ---
  {
    re: /(?:\b(?:the pattern is|the workflow is|the process is|step 1|the rule is|always do)\b|流程是|步骤是|规则是|每次都要|固定做法|标准流程)/i,
    category: "patterns",
    importance: 0.75,
    sourceContext: "pattern signal",
  },
];

/**
 * Extract memory-worthy items from conversation text using simple heuristics.
 *
 * Lightweight alternative to LLM-based extraction.
 * Returns items ready for persistence via persistMemoryBatch.
 */
export function extractHeuristic(text: string): AutoCaptureItem[] {
  const items: AutoCaptureItem[] = [];
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text);
  const minSentenceLen = hasCJK ? 6 : 15;

  const sentences = text
    .split(/[.!?。！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > minSentenceLen);

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];

    for (const pattern of SIGNAL_PATTERNS) {
      if (pattern.re.test(sentence)) {
        // For correction signals, include the next sentence to capture
        // the actual corrected fact (e.g. "Actually, that's wrong. The limit is 200.")
        let capturedText = sentence;
        if (pattern.sourceContext === "correction signal" && i + 1 < sentences.length) {
          capturedText = `${sentence}. ${sentences[i + 1]}`;
          i++; // skip next sentence since we consumed it
        }

        items.push({
          text: capturedText,
          category: pattern.category,
          importance: pattern.importance,
          sourceContext: pattern.sourceContext,
        });
        break; // first matching pattern wins for this sentence
      }
    }

    if (items.length >= MAX_ITEMS_PER_TURN) break;
  }

  return items.slice(0, MAX_ITEMS_PER_TURN);
}

/**
 * Full auto-capture pipeline: salience check → heuristic extraction.
 */
export function autoCapture(text: string): AutoCaptureResult {
  if (!shouldCapture(text)) {
    return { skippedSalience: true, items: [] };
  }
  return { skippedSalience: false, items: extractHeuristic(text) };
}
