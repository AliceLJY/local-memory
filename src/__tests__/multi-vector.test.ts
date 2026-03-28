import { describe, expect, it, beforeEach, afterEach } from "bun:test";

import {
  blendMultiVectorScores,
  cosineSimilarity,
  DEFAULT_BLEND_CONFIG,
  embedMultiVector,
  extractMultiVectorText,
  isMultiVectorEnabled,
} from "../multi-vector.js";

describe("isMultiVectorEnabled", () => {
  const original = process.env.RECALLNEST_MULTI_VECTOR;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.RECALLNEST_MULTI_VECTOR;
    } else {
      process.env.RECALLNEST_MULTI_VECTOR = original;
    }
  });

  it("returns false by default", () => {
    delete process.env.RECALLNEST_MULTI_VECTOR;
    expect(isMultiVectorEnabled()).toBe(false);
  });

  it("returns true when set to 'true'", () => {
    process.env.RECALLNEST_MULTI_VECTOR = "true";
    expect(isMultiVectorEnabled()).toBe(true);
  });
});

describe("extractMultiVectorText", () => {
  it("extracts L0 and L1 from valid metadata", () => {
    const meta = JSON.stringify({
      l0_abstract: "User prefers TypeScript",
      l1_overview: "User consistently chooses TypeScript over JavaScript for type safety",
    });
    const result = extractMultiVectorText(meta);
    expect(result.l0).toBe("User prefers TypeScript");
    expect(result.l1).toContain("TypeScript");
  });

  it("returns empty for missing fields", () => {
    const meta = JSON.stringify({ source: "manual" });
    const result = extractMultiVectorText(meta);
    expect(result.l0).toBeUndefined();
    expect(result.l1).toBeUndefined();
  });

  it("returns empty for undefined metadata", () => {
    const result = extractMultiVectorText(undefined);
    expect(result.l0).toBeUndefined();
  });

  it("skips very short L0/L1 text (<=5 chars)", () => {
    const meta = JSON.stringify({ l0_abstract: "abc", l1_overview: "short" });
    const result = extractMultiVectorText(meta);
    expect(result.l0).toBeUndefined();
    expect(result.l1).toBeUndefined();
  });
});

describe("embedMultiVector", () => {
  const mockEmbedder = {
    async embedPassage(text: string) {
      return [text.length, 0.5, 0.1];
    },
  };

  it("returns null vectors when disabled", async () => {
    delete process.env.RECALLNEST_MULTI_VECTOR;
    const result = await embedMultiVector(mockEmbedder, JSON.stringify({
      l0_abstract: "Some abstract text here",
    }));
    expect(result.vector_l0).toBeNull();
    expect(result.vector_l1).toBeNull();
  });

  it("generates vectors when enabled and text available", async () => {
    process.env.RECALLNEST_MULTI_VECTOR = "true";
    const result = await embedMultiVector(mockEmbedder, JSON.stringify({
      l0_abstract: "User prefers TypeScript",
      l1_overview: "Detailed overview of TypeScript preference with reasoning",
    }));
    expect(result.vector_l0).not.toBeNull();
    expect(result.vector_l1).not.toBeNull();
    expect(result.vector_l0![0]).toBe("User prefers TypeScript".length);
    // Cleanup
    delete process.env.RECALLNEST_MULTI_VECTOR;
  });

  it("returns null for missing L0/L1 text even when enabled", async () => {
    process.env.RECALLNEST_MULTI_VECTOR = "true";
    const result = await embedMultiVector(mockEmbedder, JSON.stringify({ source: "manual" }));
    expect(result.vector_l0).toBeNull();
    expect(result.vector_l1).toBeNull();
    delete process.env.RECALLNEST_MULTI_VECTOR;
  });
});

describe("blendMultiVectorScores", () => {
  it("returns main score when no L0/L1 available", () => {
    expect(blendMultiVectorScores(0.8, null, null)).toBe(0.8);
  });

  it("blends with L0 only", () => {
    const blended = blendMultiVectorScores(0.8, 0.9, null);
    // (0.8 * 0.65 + 0.9 * 0.20) / (0.65 + 0.20) = (0.52 + 0.18) / 0.85
    expect(blended).toBeCloseTo(0.824, 2);
  });

  it("blends with both L0 and L1", () => {
    const blended = blendMultiVectorScores(0.8, 0.9, 0.7);
    // (0.8*0.65 + 0.9*0.20 + 0.7*0.15) / (0.65+0.20+0.15) = (0.52+0.18+0.105)/1.0
    expect(blended).toBeCloseTo(0.805, 2);
  });

  it("supports custom weights", () => {
    const config = { vectorWeight: 0.5, l0Weight: 0.3, l1Weight: 0.2 };
    const blended = blendMultiVectorScores(0.8, 0.9, 0.7, config);
    expect(blended).toBeCloseTo(0.81, 2);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0, 5);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched dimensions", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});
