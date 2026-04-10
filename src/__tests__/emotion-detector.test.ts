import { describe, test, expect } from "bun:test";
import { detectEmotion } from "../emotion-detector.js";

describe("emotion-detector: heuristic", () => {
  test("detects strong negative text", () => {
    const result = detectEmotion("This bug is driving me crazy, everything is broken and wrong");
    expect(result.valence).toBeLessThan(-0.3);
    expect(result.label).toBe("negative");
  });

  test("detects strong positive text", () => {
    const result = detectEmotion("Finally solved it! Works perfectly, great progress today");
    expect(result.valence).toBeGreaterThan(0.3);
    expect(result.label).toBe("positive");
  });

  test("detects neutral text", () => {
    const result = detectEmotion("The user prefers dark mode and uses VS Code");
    expect(Math.abs(result.valence)).toBeLessThan(0.3);
    expect(result.label).toBe("neutral");
  });

  test("detects high arousal", () => {
    const result = detectEmotion("URGENT! Critical production issue, fix immediately!");
    expect(result.arousal).toBeGreaterThan(0.3);
  });

  test("detects low arousal for calm text", () => {
    const result = detectEmotion("The default configuration uses port 3000");
    expect(result.arousal).toBeLessThan(0.3);
  });

  test("handles mixed signals with net positive", () => {
    const result = detectEmotion("Had a frustrating bug but finally solved it perfectly");
    expect(result.valence).toBeGreaterThan(0);
  });

  test("handles empty text gracefully", () => {
    const result = detectEmotion("");
    expect(result.valence).toBe(0);
    expect(result.arousal).toBe(0);
    expect(result.label).toBe("neutral");
  });

  test("clamps valence to [-1, 1]", () => {
    const result = detectEmotion("broken error wrong bug failure hate broken error wrong");
    expect(result.valence).toBeGreaterThanOrEqual(-1);
    expect(result.valence).toBeLessThanOrEqual(1);
  });

  test("clamps arousal to [0, 1]", () => {
    const result = detectEmotion("URGENT! CRITICAL! IMMEDIATELY! ASAP!");
    expect(result.arousal).toBeGreaterThanOrEqual(0);
    expect(result.arousal).toBeLessThanOrEqual(1);
  });
});
