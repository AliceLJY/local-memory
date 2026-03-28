import { describe, expect, it } from "bun:test";

import { DEFAULT_CATEGORY_MIN_SCORES, DEFAULT_RETRIEVAL_CONFIG } from "../retriever.js";

describe("DEFAULT_CATEGORY_MIN_SCORES", () => {
  it("has entries for all 6 durable categories", () => {
    const expected = ["profile", "preferences", "entities", "events", "cases", "patterns"];
    for (const cat of expected) {
      expect(DEFAULT_CATEGORY_MIN_SCORES[cat]).toBeNumber();
    }
  });

  it("profile and preferences have lower thresholds than global hardMinScore", () => {
    expect(DEFAULT_CATEGORY_MIN_SCORES.profile).toBeLessThan(DEFAULT_RETRIEVAL_CONFIG.hardMinScore);
    expect(DEFAULT_CATEGORY_MIN_SCORES.preferences).toBeLessThan(DEFAULT_RETRIEVAL_CONFIG.hardMinScore);
  });

  it("cases and patterns have higher thresholds than global hardMinScore", () => {
    expect(DEFAULT_CATEGORY_MIN_SCORES.cases).toBeGreaterThan(DEFAULT_RETRIEVAL_CONFIG.hardMinScore);
    expect(DEFAULT_CATEGORY_MIN_SCORES.patterns).toBeGreaterThan(DEFAULT_RETRIEVAL_CONFIG.hardMinScore);
  });

  it("events threshold equals global hardMinScore", () => {
    expect(DEFAULT_CATEGORY_MIN_SCORES.events).toBe(DEFAULT_RETRIEVAL_CONFIG.hardMinScore);
  });

  it("all thresholds are in valid range (0, 1)", () => {
    for (const [, threshold] of Object.entries(DEFAULT_CATEGORY_MIN_SCORES)) {
      expect(threshold).toBeGreaterThan(0);
      expect(threshold).toBeLessThan(1);
    }
  });
});
