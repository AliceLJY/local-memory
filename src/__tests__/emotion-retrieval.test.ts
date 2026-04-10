import { describe, test, expect } from "bun:test";
import { applyEmotionWeight } from "../retriever.js";

describe("applyEmotionWeight", () => {
  const makeResult = (id: string, score: number, emotionJson?: object) => ({
    id,
    text: "test",
    vector: [],
    category: "events" as const,
    scope: "test",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: emotionJson ? JSON.stringify({ emotion: emotionJson }) : "{}",
    score,
    sources: {},
  });

  test("null query emotion returns unchanged", () => {
    const results = [makeResult("a", 0.8, { valence: 0.9, arousal: 0.5 })];
    const output = applyEmotionWeight(results, null);
    expect(output[0].score).toBe(0.8);
  });

  test("low-valence query returns unchanged", () => {
    const queryEmotion = { valence: 0.1, arousal: 0, label: "neutral" };
    const results = [makeResult("a", 0.8, { valence: 0.9, arousal: 0.5 })];
    const output = applyEmotionWeight(results, queryEmotion);
    expect(output[0].score).toBe(0.8);
  });

  test("negative query boosts negative memories", () => {
    const queryEmotion = { valence: -0.8, arousal: 0.5, label: "frustration" };
    const results = [
      makeResult("neg", 0.7, { valence: -0.7, arousal: 0.5 }),
      makeResult("pos", 0.7, { valence: 0.8, arousal: 0.3 }),
    ];
    const output = applyEmotionWeight(results, queryEmotion);
    expect(output.find(r => r.id === "neg")!.score).toBeGreaterThan(
      output.find(r => r.id === "pos")!.score
    );
  });

  test("no emotion data leaves score unchanged", () => {
    const queryEmotion = { valence: -0.8, arousal: 0.5, label: "negative" };
    const results = [makeResult("no-emo", 0.7)];
    const output = applyEmotionWeight(results, queryEmotion);
    expect(output[0].score).toBe(0.7);
  });

  test("max boost is 15%", () => {
    const queryEmotion = { valence: 1.0, arousal: 1.0, label: "positive" };
    const results = [makeResult("a", 1.0, { valence: 1.0, arousal: 1.0 })];
    const output = applyEmotionWeight(results, queryEmotion);
    expect(output[0].score).toBeCloseTo(1.15, 2);
  });
});
