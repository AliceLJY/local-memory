import { describe, expect, it } from "bun:test";

import { computeTermOverlap, extractTerms, renderMemories, type RenderableMemory } from "../context-renderer.js";

const MEMORIES: RenderableMemory[] = [
  { id: "a", text: "I prefer TypeScript for all projects", score: 0.8, category: "preferences" },
  { id: "b", text: "Docker deployment pipeline for RecallNest", score: 0.75, category: "patterns" },
  { id: "c", text: "Fixed a LanceDB indexing bug yesterday", score: 0.9, category: "cases" },
];

describe("extractTerms", () => {
  it("removes stop words and short words", () => {
    const terms = extractTerms("The quick brown fox is a great animal");
    expect(terms.has("the")).toBe(false);
    expect(terms.has("is")).toBe(false);
    expect(terms.has("a")).toBe(false);
    expect(terms.has("quick")).toBe(true);
    expect(terms.has("brown")).toBe(true);
  });

  it("handles CJK text", () => {
    const terms = extractTerms("我喜欢用 TypeScript 写代码");
    expect(terms.has("typescript")).toBe(true);
  });

  it("lowercases all terms", () => {
    const terms = extractTerms("TypeScript Docker LanceDB");
    expect(terms.has("typescript")).toBe(true);
    expect(terms.has("docker")).toBe(true);
  });
});

describe("computeTermOverlap", () => {
  it("returns 0 for empty sets", () => {
    expect(computeTermOverlap(new Set(), new Set(["a"]))).toBe(0);
    expect(computeTermOverlap(new Set(["a"]), new Set())).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    const s = new Set(["typescript", "docker"]);
    expect(computeTermOverlap(s, s)).toBe(1);
  });

  it("returns partial overlap correctly", () => {
    const a = new Set(["typescript", "docker", "lancedb"]);
    const b = new Set(["typescript", "lancedb", "react"]);
    // overlap=2, max(3,3)=3 → 2/3 ≈ 0.667
    expect(computeTermOverlap(a, b)).toBeCloseTo(0.667, 2);
  });
});

describe("renderMemories", () => {
  it("verbatim mode preserves original order", () => {
    const result = renderMemories(MEMORIES, "anything");
    expect(result.mode).toBe("verbatim");
    expect(result.memories.map(m => m.id)).toEqual(["a", "b", "c"]);
    expect(result.memories[0].relevance).toBe(0.8);
  });

  it("highlight mode reorders by contextual relevance", () => {
    const result = renderMemories(MEMORIES, "LanceDB indexing bug fix", "highlight");
    expect(result.mode).toBe("highlight");
    // Memory "c" should rank highest because it has strong term overlap with query
    expect(result.memories[0].id).toBe("c");
  });

  it("highlight mode uses taskContext for scoring", () => {
    const result = renderMemories(MEMORIES, "deployment", "highlight", "Docker pipeline");
    // Memory "b" should rank high due to Docker + deployment + pipeline overlap
    expect(result.memories[0].id).toBe("b");
  });

  it("synthesize mode processes memories", () => {
    const result = renderMemories(MEMORIES, "TypeScript preferences", "synthesize");
    expect(result.mode).toBe("synthesize");
    expect(result.memories.length).toBe(3);
  });

  it("returns empty for empty input", () => {
    const result = renderMemories([], "query", "highlight");
    expect(result.memories.length).toBe(0);
  });

  it("relevance scores are rounded to 3 decimals in highlight mode", () => {
    const result = renderMemories(MEMORIES, "test query", "highlight");
    for (const m of result.memories) {
      const decimals = String(m.relevance).split(".")[1]?.length ?? 0;
      expect(decimals).toBeLessThanOrEqual(3);
    }
  });
});
