import { describe, test, expect, afterAll } from "bun:test";
import { detectEmotionIfEnabled } from "../emotion-detector.js";
import { shouldReconstruct, extractCitedIds, removeSentencesWithId } from "../context-reconstructor.js";
import { adjustHalfLifeForEmotion, weibullDecay } from "../decay-engine.js";

describe("feature flag isolation", () => {
  const saved = {
    emo: process.env.RECALLNEST_EMOTION_SCORING,
    con: process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL,
  };

  afterAll(() => {
    if (saved.emo !== undefined) process.env.RECALLNEST_EMOTION_SCORING = saved.emo;
    else delete process.env.RECALLNEST_EMOTION_SCORING;
    if (saved.con !== undefined) process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL = saved.con;
    else delete process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL;
  });

  test("emotion off -> detectEmotionIfEnabled returns null", () => {
    delete process.env.RECALLNEST_EMOTION_SCORING;
    expect(detectEmotionIfEnabled("terrible bug")).toBeNull();
  });

  test("constructive off -> shouldReconstruct false", () => {
    expect(shouldReconstruct({
      flagEnabled: false, callerOptIn: true, resultCount: 10, llmAvailable: true,
    })).toBe(false);
  });
});

describe("emotion + decay end-to-end", () => {
  test("emotional memory retains more score at 30 days", () => {
    const baseHL = 60;
    const emoHL = adjustHalfLifeForEmotion(baseHL, { valence: -0.8, arousal: 0.7, label: "frustration" });
    expect(weibullDecay(30, emoHL, "working")).toBeGreaterThan(weibullDecay(30, baseHL, "working"));
  });
});

describe("grounding end-to-end", () => {
  test("removes phantom citations and lowers confidence", () => {
    const text = "Valid [src:r1]. Fake [src:phantom]. Also valid [src:r2].";
    const validIds = new Set(["r1", "r2"]);
    let result = text;
    let confidence = 1.0;
    for (const id of extractCitedIds(result)) {
      if (!validIds.has(id)) {
        result = removeSentencesWithId(result, id);
        confidence -= 0.2;
      }
    }
    expect(result).not.toContain("phantom");
    expect(confidence).toBe(0.8);
  });
});
