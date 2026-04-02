/**
 * Tests for CC-7 Context Collapse Renderer + CC-2 Staleness Hints.
 */
import { describe, expect, test } from "bun:test";
import {
  collapseResults,
  extractL0,
  extractL1,
  extractL2,
  estimateTokens,
  buildStalenessHint,
  DEFAULT_COLLAPSE_CONFIG,
  type CollapseInput,
} from "../context-collapse-renderer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<CollapseInput> = {}): CollapseInput {
  return {
    entryId: "test-id",
    text: "This is the full text of the memory entry with details about the project.",
    metadata: JSON.stringify({
      l0_abstract: "Short summary of the memory",
      l1_overview: "Overview: This is a medium-length structured overview of the memory entry.",
    }),
    score: 0.9,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

describe("extractL0", () => {
  test("uses l0_abstract from metadata", () => {
    const meta = JSON.stringify({ l0_abstract: "L0 summary text" });
    expect(extractL0("full text here", meta)).toBe("L0 summary text");
  });

  test("uses anchor as fallback", () => {
    const meta = JSON.stringify({ anchor: "anchor text here" });
    expect(extractL0("full text here", meta)).toBe("anchor text here");
  });

  test("falls back to first sentence", () => {
    expect(extractL0("First sentence here. Second sentence.", undefined)).toBe("First sentence here.");
  });

  test("truncates long text without metadata", () => {
    const longText = "A".repeat(200);
    const result = extractL0(longText, undefined);
    expect(result.length).toBeLessThanOrEqual(81); // 80 + "…"
  });
});

describe("extractL1", () => {
  test("uses core_summary from metadata", () => {
    const meta = JSON.stringify({ core_summary: "Core summary text" });
    expect(extractL1("full text", meta)).toBe("Core summary text");
  });

  test("uses l1_overview from metadata", () => {
    const meta = JSON.stringify({ l1_overview: "L1 overview text" });
    expect(extractL1("full text", meta)).toBe("L1 overview text");
  });

  test("falls back to truncated full text", () => {
    const longText = "A".repeat(500);
    const result = extractL1(longText, undefined);
    expect(result.length).toBeLessThanOrEqual(301); // 300 + "…"
  });
});

describe("extractL2", () => {
  test("returns full text", () => {
    expect(extractL2("full text content")).toBe("full text content");
  });
});

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  test("estimates English text", () => {
    const tokens = estimateTokens("Hello world");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  test("CJK characters cost more", () => {
    const cjk = estimateTokens("你好世界");
    const ascii = estimateTokens("abcd");
    expect(cjk).toBeGreaterThan(ascii);
  });
});

// ---------------------------------------------------------------------------
// Staleness hint (CC-2)
// ---------------------------------------------------------------------------

describe("buildStalenessHint", () => {
  test("returns undefined for recent items", () => {
    const now = Date.now();
    expect(buildStalenessHint(now - 3 * 86_400_000, 7, now)).toBeUndefined();
  });

  test("returns hint for old items", () => {
    const now = Date.now();
    const hint = buildStalenessHint(now - 30 * 86_400_000, 7, now);
    expect(hint).toContain("30 days ago");
    expect(hint).toContain("verify");
  });

  test("returns undefined at exact threshold", () => {
    const now = Date.now();
    expect(buildStalenessHint(now - 7 * 86_400_000, 7, now)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Core collapse rendering
// ---------------------------------------------------------------------------

describe("collapseResults", () => {
  test("renders high-score items at L2", () => {
    const items = [makeInput({ score: 0.95 })];
    const result = collapseResults(items);
    expect(result).toHaveLength(1);
    expect(result[0].renderLevel).toBe("L2");
    expect(result[0].text).toBe(items[0].text); // Full text
  });

  test("renders medium-score items at L1", () => {
    const items = [makeInput({ score: 0.75 })];
    const result = collapseResults(items);
    expect(result).toHaveLength(1);
    expect(result[0].renderLevel).toBe("L1");
  });

  test("renders low-score items at L0", () => {
    const items = [makeInput({ score: 0.55 })];
    const result = collapseResults(items);
    expect(result).toHaveLength(1);
    expect(result[0].renderLevel).toBe("L0");
  });

  test("excludes items below L0 threshold", () => {
    const items = [makeInput({ score: 0.30 })];
    const result = collapseResults(items);
    expect(result).toHaveLength(0);
  });

  test("sorts by score descending", () => {
    const items = [
      makeInput({ entryId: "low", score: 0.55 }),
      makeInput({ entryId: "high", score: 0.95 }),
      makeInput({ entryId: "mid", score: 0.75 }),
    ];
    const result = collapseResults(items);
    expect(result.map(r => r.entryId)).toEqual(["high", "mid", "low"]);
  });

  test("respects token budget — downgrades when over budget", () => {
    const longText = "A".repeat(2000);
    const items = [
      makeInput({ entryId: "big", text: longText, score: 0.95 }),
      makeInput({ entryId: "small", score: 0.90 }),
    ];
    // Very small budget forces downgrade
    const result = collapseResults(items, { tokenBudget: 100 });
    // At least one should be downgraded or excluded
    const levels = result.map(r => r.renderLevel);
    expect(levels.some(l => l !== "L2") || result.length < 2).toBe(true);
  });

  test("adds staleness hints for old items", () => {
    const oldTimestamp = Date.now() - 30 * 86_400_000;
    const items = [makeInput({ score: 0.95, timestamp: oldTimestamp })];
    const result = collapseResults(items);
    expect(result[0].stalenessHint).toBeDefined();
    expect(result[0].stalenessHint).toContain("30 days ago");
  });

  test("no staleness hint for recent items", () => {
    const items = [makeInput({ score: 0.95, timestamp: Date.now() })];
    const result = collapseResults(items);
    expect(result[0].stalenessHint).toBeUndefined();
  });

  test("custom thresholds work", () => {
    const items = [makeInput({ score: 0.70 })];
    // With custom thresholds where 0.70 is L2
    const result = collapseResults(items, {
      thresholds: { l2: 0.60, l1: 0.40, l0: 0.20 },
    });
    expect(result[0].renderLevel).toBe("L2");
  });

  test("empty input returns empty output", () => {
    expect(collapseResults([])).toEqual([]);
  });

  test("handles missing metadata gracefully", () => {
    const items = [makeInput({ score: 0.75, metadata: undefined })];
    const result = collapseResults(items);
    expect(result).toHaveLength(1);
    expect(result[0].renderLevel).toBe("L1");
  });
});
