import type { EmotionMetadata } from "./memory-schema.js";
import { isEmotionScoringEnabled } from "./memory-schema.js";

const NEGATIVE_SIGNALS: string[] = [
  "fail", "failed", "failure", "broken", "bug", "error", "wrong", "crash",
  "frustrat", "hate", "terrible", "awful", "annoying", "pain", "stuck",
  "problem", "issue", "mess", "ugly", "worst",
];

const POSITIVE_SIGNALS: string[] = [
  "solved", "fixed", "works", "perfect", "great", "love", "excellent",
  "success", "breakthrough", "finally", "awesome", "beautiful", "clean",
  "elegant", "smooth", "done", "shipped",
];

const HIGH_AROUSAL_SIGNALS: string[] = [
  "!", "!!", "urgent", "critical", "immediately", "ASAP", "emergency",
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

  const valence = clamp((posCount - negCount) * 0.25, -1, 1);
  const arousal = clamp(arousalCount * 0.25, 0, 1);
  const label = valence > 0.3 ? "positive" : valence < -0.3 ? "negative" : "neutral";

  return { valence, arousal, label };
}

/**
 * Conditionally detect emotion. Returns null when feature flag is off.
 */
export function detectEmotionIfEnabled(text: string): EmotionMetadata | null {
  if (!isEmotionScoringEnabled()) return null;
  return detectEmotion(text);
}
