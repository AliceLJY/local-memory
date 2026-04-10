import { describe, test, expect } from "bun:test";
import { weibullDecay, adjustHalfLifeForEmotion, computeArousalBoost } from "../decay-engine.js";

describe("emotion-adjusted decay", () => {
  test("returns base half-life when no emotion", () => {
    expect(adjustHalfLifeForEmotion(60, undefined)).toBe(60);
    expect(adjustHalfLifeForEmotion(60, null)).toBe(60);
  });

  test("strong negative emotion extends half-life ~27%", () => {
    const adjusted = adjustHalfLifeForEmotion(60, { valence: -0.9, arousal: 0.5, label: "frustration" });
    expect(adjusted).toBeCloseTo(60 * 1.27, 0);
  });

  test("strong positive emotion extends half-life ~24%", () => {
    const adjusted = adjustHalfLifeForEmotion(60, { valence: 0.8, arousal: 0.3, label: "excitement" });
    expect(adjusted).toBeCloseTo(60 * 1.24, 0);
  });

  test("neutral emotion has negligible effect", () => {
    const adjusted = adjustHalfLifeForEmotion(60, { valence: 0.05, arousal: 0.1, label: "neutral" });
    expect(adjusted).toBeCloseTo(60, 0);
  });

  test("emotional memory decays slower at 30 days", () => {
    const baseHL = 60;
    const emotionalHL = adjustHalfLifeForEmotion(baseHL, { valence: -0.8, arousal: 0.7, label: "frustration" });
    const neutralDecay = weibullDecay(30, baseHL, "working");
    const emotionalDecay = weibullDecay(30, emotionalHL, "working");
    expect(emotionalDecay).toBeGreaterThan(neutralDecay);
  });

  test("arousal boost is 1.0 for zero arousal", () => {
    expect(computeArousalBoost({ valence: 0.5, arousal: 0, label: "positive" })).toBe(1.0);
  });

  test("arousal boost max ~1.1 for high arousal", () => {
    const boost = computeArousalBoost({ valence: 0.5, arousal: 0.9, label: "excitement" });
    expect(boost).toBeCloseTo(1.09, 1);
  });

  test("arousal boost is 1.0 for null emotion", () => {
    expect(computeArousalBoost(undefined)).toBe(1.0);
    expect(computeArousalBoost(null)).toBe(1.0);
  });
});
