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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
  const posCount = POSITIVE_SIGNALS.filter(s => lower.includes(s.toLowerCase())).length;
  const arousalCount = HIGH_AROUSAL_SIGNALS.filter(s => text.includes(s)).length;

  const valence = clamp((posCount - negCount) * 0.3, -1, 1);
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
