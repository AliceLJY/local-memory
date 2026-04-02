import { describe, expect, it } from "bun:test";

import { filterByRelevance, type FilterConfig } from "../post-retrieval-filter.js";
import type { LLMClient } from "../llm-client.js";
import type { RetrievalResult } from "../retriever.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(id: string, text: string, score: number): RetrievalResult {
  return {
    entry: {
      id,
      text,
      vector: [],
      category: "events",
      scope: "test",
      importance: 0.5,
      timestamp: Date.now(),
    },
    score,
    sources: {},
  };
}

function makeMockLLM(response: boolean[] | null, shouldThrow = false): LLMClient {
  return {
    chatJson: async () => {
      if (shouldThrow) throw new Error("LLM failure");
      return response;
    },
  } as unknown as LLMClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("filterByRelevance", () => {
  it("returns empty array for empty results", async () => {
    const llm = makeMockLLM([]);
    const out = await filterByRelevance([], "some query", llm);
    expect(out).toEqual([]);
  });

  it("returns original results when query is empty", async () => {
    const results = [makeResult("a", "hello", 0.8)];
    const llm = makeMockLLM([true]);
    const out = await filterByRelevance(results, "", llm);
    expect(out).toEqual(results);
  });

  it("returns all when LLM marks all as relevant", async () => {
    const results = [
      makeResult("a", "TypeScript project setup", 0.9),
      makeResult("b", "Docker deployment notes", 0.85),
    ];
    const llm = makeMockLLM([true, true]);
    const out = await filterByRelevance(results, "project setup", llm);
    expect(out).toHaveLength(2);
    expect(out[0].entry.id).toBe("a");
    expect(out[1].entry.id).toBe("b");
  });

  it("filters out items LLM marks as irrelevant", async () => {
    const results = [
      makeResult("a", "TypeScript project setup", 0.9),
      makeResult("b", "Favorite pizza recipe", 0.85),
      makeResult("c", "Docker deployment notes", 0.8),
    ];
    const llm = makeMockLLM([true, false, true]);
    const out = await filterByRelevance(results, "project deployment", llm);
    expect(out).toHaveLength(2);
    expect(out[0].entry.id).toBe("a");
    expect(out[1].entry.id).toBe("c");
  });

  it("drops items below minScoreForFilter without LLM call", async () => {
    const results = [
      makeResult("a", "High score item", 0.9),
      makeResult("b", "Low score item", 0.3),
      makeResult("c", "Very low score", 0.1),
    ];
    // LLM only sees 1 item (the one above threshold)
    const llm = makeMockLLM([true]);
    const out = await filterByRelevance(results, "test query", llm);
    expect(out).toHaveLength(1);
    expect(out[0].entry.id).toBe("a");
  });

  it("returns all candidates when all are below minScoreForFilter", async () => {
    const results = [
      makeResult("a", "Low score A", 0.3),
      makeResult("b", "Low score B", 0.2),
    ];
    const llm = makeMockLLM([]);
    const out = await filterByRelevance(results, "test query", llm);
    expect(out).toHaveLength(0);
  });

  it("truncates to maxItems", async () => {
    const results = Array.from({ length: 15 }, (_, i) =>
      makeResult(`item-${i}`, `Memory item ${i}`, 0.9 - i * 0.01),
    );
    // LLM receives only 5 items, marks all as relevant
    const cfg: Partial<FilterConfig> = { maxItems: 5 };
    const llm = makeMockLLM([true, true, true, true, true]);
    const out = await filterByRelevance(results, "test query", llm, cfg);
    expect(out).toHaveLength(5);
    expect(out[0].entry.id).toBe("item-0");
    expect(out[4].entry.id).toBe("item-4");
  });

  it("returns candidates on LLM failure (graceful fallback)", async () => {
    const results = [
      makeResult("a", "Important memory", 0.9),
      makeResult("b", "Another memory", 0.85),
    ];
    const llm = makeMockLLM(null, true);
    const out = await filterByRelevance(results, "test query", llm);
    // Should return all candidates, not lose data
    expect(out).toHaveLength(2);
    expect(out[0].entry.id).toBe("a");
  });

  it("returns candidates when LLM returns non-array", async () => {
    const results = [
      makeResult("a", "Important memory", 0.9),
    ];
    const llm = makeMockLLM(null);
    const out = await filterByRelevance(results, "test query", llm);
    expect(out).toHaveLength(1);
  });

  it("uses l0_abstract from metadata when available", async () => {
    const result = makeResult("a", "Very long raw text that should not be used", 0.9);
    result.entry.metadata = JSON.stringify({ l0_abstract: "Short summary" });
    const calls: string[] = [];
    const llm = {
      chatJson: async (_sys: string, user: string) => {
        calls.push(user);
        return [true];
      },
    } as unknown as LLMClient;

    await filterByRelevance([result], "test", llm);
    expect(calls[0]).toContain("Short summary");
    expect(calls[0]).not.toContain("Very long raw text");
  });

  it("handles custom minScoreForFilter", async () => {
    const results = [
      makeResult("a", "High", 0.9),
      makeResult("b", "Medium", 0.6),
      makeResult("c", "Low", 0.4),
    ];
    const cfg: Partial<FilterConfig> = { minScoreForFilter: 0.65 };
    const llm = makeMockLLM([true]);
    const out = await filterByRelevance(results, "test", llm, cfg);
    expect(out).toHaveLength(1);
    expect(out[0].entry.id).toBe("a");
  });

  it("handles shorter LLM verdict array than candidates", async () => {
    const results = [
      makeResult("a", "Memory A", 0.9),
      makeResult("b", "Memory B", 0.85),
      makeResult("c", "Memory C", 0.8),
    ];
    // LLM returns fewer verdicts than items
    const llm = makeMockLLM([true, false]);
    const out = await filterByRelevance(results, "test", llm);
    // Only first item passes (index 0 = true, index 1 = false, index 2 = out of bounds)
    expect(out).toHaveLength(1);
    expect(out[0].entry.id).toBe("a");
  });
});
