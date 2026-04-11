/**
 * Phase 1 integration tests: Emotional Valence in Decay pipeline.
 *
 * Validates the full wiring:
 * 1. detectEmotion → salience + source fields
 * 2. computeDecayScore → emotion-aware weights (0.15/0.25/0.45/0.15)
 * 3. Backward compatibility when emotion flag is off or metadata absent
 */
import { describe, test, expect } from "bun:test";
import { detectEmotion } from "../emotion-detector.js";
import { computeDecayScore, type EvolutionMetadata } from "../memory-evolution.js";

// ---------------------------------------------------------------------------
// 1. detectEmotion: salience + source fields
// ---------------------------------------------------------------------------

describe("detectEmotion salience & source", () => {
  test("returns salience field as (|valence| + arousal) / 2", () => {
    const result = detectEmotion("Finally fixed that horrible production bug after 3 days!");
    expect(result.salience).toBeDefined();
    expect(typeof result.salience).toBe("number");
    // salience = (|valence| + arousal) / 2
    const expected = (Math.abs(result.valence) + result.arousal) / 2;
    expect(result.salience).toBeCloseTo(expected, 5);
  });

  test("returns source: keyword", () => {
    const result = detectEmotion("This is a great success!");
    expect(result.source).toBe("keyword");
  });

  test("neutral text returns salience 0", () => {
    const result = detectEmotion("The meeting is at 3pm tomorrow.");
    expect(result.salience).toBe(0);
  });

  test("empty text returns salience 0 and source keyword", () => {
    const result = detectEmotion("");
    expect(result.salience).toBe(0);
    expect(result.source).toBe("keyword");
  });

  test("high emotion + high arousal gives high salience", () => {
    const result = detectEmotion("CRITICAL BUG! Everything is broken! Urgent fix needed!");
    expect(result.salience).toBeGreaterThan(0.2);
  });

  test("salience is clamped to [0, 1]", () => {
    const result = detectEmotion("fail fail fail broken broken crash crash urgent urgent critical critical !!!");
    expect(result.salience).toBeGreaterThanOrEqual(0);
    expect(result.salience).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 2. computeDecayScore: emotion-aware weights
// ---------------------------------------------------------------------------

describe("computeDecayScore with emotion", () => {
  const now = Date.now();
  const baseEvo: EvolutionMetadata = {
    status: "active",
    version: 1,
    accessCount: 3,
    lastAccessedAt: now - 7 * 86_400_000, // 7 days ago
    supersededBy: null,
    supersedes: null,
    evolutionNote: null,
    consolidatedInto: null,
    contributedToPattern: null,
    sourceMemories: [],
    validFrom: now - 30 * 86_400_000, // 30 days old
    validUntil: null,
  };

  // Save and restore env
  const origFlag = process.env.RECALLNEST_EMOTION_SCORING;

  test("with emotion flag ON and metadata, emotional memory scores higher", () => {
    process.env.RECALLNEST_EMOTION_SCORING = "true";
    try {
      const emotionalMeta = JSON.stringify({
        emotion: { valence: -0.9, arousal: 0.8, label: "frustration", salience: 0.85, source: "keyword" },
      });
      const neutralMeta = JSON.stringify({
        emotion: { valence: 0, arousal: 0, label: "neutral", salience: 0, source: "keyword" },
      });

      const emotionalScore = computeDecayScore(baseEvo, 0.5, now, emotionalMeta);
      const neutralScore = computeDecayScore(baseEvo, 0.5, now, neutralMeta);

      expect(emotionalScore).toBeGreaterThan(neutralScore);
    } finally {
      process.env.RECALLNEST_EMOTION_SCORING = origFlag;
    }
  });

  test("with emotion flag ON, weights sum close to 1.0", () => {
    process.env.RECALLNEST_EMOTION_SCORING = "true";
    try {
      // At max values: time=1, freq=1, importance=1, salience=1
      // Score should be 0.15 + 0.25 + 0.45 + 0.15 = 1.0
      const freshEvo: EvolutionMetadata = {
        ...baseEvo,
        accessCount: 100,
        lastAccessedAt: now,
        validFrom: now, // just created
      };
      const maxMeta = JSON.stringify({
        emotion: { valence: 1, arousal: 1, label: "positive", salience: 1, source: "keyword" },
      });

      const score = computeDecayScore(freshEvo, 1.0, now, maxMeta);
      expect(score).toBeCloseTo(1.0, 1);
    } finally {
      process.env.RECALLNEST_EMOTION_SCORING = origFlag;
    }
  });

  test("backward compat: no metadata param still works", () => {
    const score = computeDecayScore(baseEvo, 0.5, now);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test("backward compat: metadata without emotion still works", () => {
    process.env.RECALLNEST_EMOTION_SCORING = "true";
    try {
      const noEmotionMeta = JSON.stringify({ tier: "working" });
      const score = computeDecayScore(baseEvo, 0.5, now, noEmotionMeta);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    } finally {
      process.env.RECALLNEST_EMOTION_SCORING = origFlag;
    }
  });

  test("with emotion flag OFF, metadata is ignored (base weights)", () => {
    process.env.RECALLNEST_EMOTION_SCORING = "";
    try {
      const emotionalMeta = JSON.stringify({
        emotion: { valence: -0.9, arousal: 0.8, label: "frustration", salience: 0.85, source: "keyword" },
      });

      const withMeta = computeDecayScore(baseEvo, 0.5, now, emotionalMeta);
      const withoutMeta = computeDecayScore(baseEvo, 0.5, now);

      expect(withMeta).toBeCloseTo(withoutMeta, 5);
    } finally {
      process.env.RECALLNEST_EMOTION_SCORING = origFlag;
    }
  });
});
