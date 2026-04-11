import type { EmotionMetadata } from "./memory-schema.js";
import { isEmotionScoringEnabled } from "./memory-schema.js";

const NEGATIVE_SIGNALS: string[] = [
  // English
  "fail", "failed", "failure", "broken", "bug", "error", "wrong", "crash",
  "frustrat", "hate", "terrible", "awful", "annoying", "pain", "stuck",
  "problem", "issue", "mess", "ugly", "worst",
  // Chinese
  "失败", "痛苦", "困扰", "崩溃", "报错", "出错", "难受", "烦",
  "卡住", "折腾", "头疼", "坑", "讨厌", "不喜欢", "糟糕", "恶心",
];

const POSITIVE_SIGNALS: string[] = [
  // English
  "solved", "fixed", "works", "perfect", "great", "love", "excellent",
  "success", "breakthrough", "finally", "awesome", "beautiful", "clean",
  "elegant", "smooth", "done", "shipped",
  // Chinese
  "搞定", "成功", "突破", "完美", "太好了", "顺利", "解决", "漂亮",
  "优雅", "通过", "上线", "喜欢", "开心", "厉害",
];

const HIGH_AROUSAL_SIGNALS: string[] = [
  "!", "!!", "urgent", "critical", "immediately", "ASAP", "emergency",
  "紧急", "立刻", "马上", "赶紧", "救命",
];

/** Chinese negation prefixes that flip positive → negative */
const CN_NEGATION_PREFIXES = ["不", "没", "非", "无", "别", "未"];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Count positive signal matches, handling Chinese negation.
 * "不喜欢" → skip positive, add to negatedCount (caller adds to negative).
 * Returns { positive, negated } counts.
 */
function countPositiveSignals(lower: string): { positive: number; negated: number } {
  let positive = 0;
  let negated = 0;
  for (const signal of POSITIVE_SIGNALS) {
    const s = signal.toLowerCase();
    const idx = lower.indexOf(s);
    if (idx === -1) continue;
    const isNegated = idx > 0 && CN_NEGATION_PREFIXES.some(neg => lower.substring(idx - neg.length, idx) === neg);
    if (isNegated) {
      negated++;
    } else {
      positive++;
    }
  }
  return { positive, negated };
}

/**
 * Detect emotional valence and arousal from text using keyword heuristics.
 * Zero LLM cost. Returns neutral emotion for empty text.
 */
export function detectEmotion(text: string): EmotionMetadata {
  if (!text || text.length === 0) {
    return { valence: 0, arousal: 0, label: "neutral" };
  }

  const lower = text.toLowerCase();

  const negCount = NEGATIVE_SIGNALS.filter(s => lower.includes(s.toLowerCase())).length;
  const { positive: posCount, negated: negatedPosCount } = countPositiveSignals(lower);
  const arousalCount = HIGH_AROUSAL_SIGNALS.filter(s => text.includes(s)).length;

  // Negated positive signals (e.g. "不开心") count as additional negatives
  const valence = clamp((posCount - negCount - negatedPosCount) * 0.3, -1, 1);
  const arousal = clamp(arousalCount * 0.25, 0, 1);
  const label = valence > 0.25 ? "positive" : valence < -0.25 ? "negative" : "neutral";

  return { valence, arousal, label };
}

/**
 * Conditionally detect emotion. Returns null when feature flag is off.
 */
export function detectEmotionIfEnabled(text: string): EmotionMetadata | null {
  if (!isEmotionScoringEnabled()) return null;
  return detectEmotion(text);
}
