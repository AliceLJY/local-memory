/**
 * Tests for Tier 3.5: Result Synthesizer
 *
 * Validates:
 * 1. synthesize() with enough fragments calls LLM
 * 2. synthesize() returns fragments when below threshold
 * 3. synthesize() returns fragments when no LLM
 * 4. synthesize() handles LLM failure gracefully
 * 5. synthesizeSection() respects RECALLNEST_SYNTHESIZE env
 * 6. synthesizeSection() passes through when disabled
 * 7. Single fragment returned as-is (no LLM call)
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  synthesize,
  synthesizeSection,
  isSynthesisEnabled,
  DEFAULT_SYNTHESIZER_CONFIG,
} from "../result-synthesizer.js";
import type { LLMClient } from "../llm-client.js";

// ---------------------------------------------------------------------------
// Mock LLM Client
// ---------------------------------------------------------------------------

function createMockLLM(response: string | null = "Synthesized narrative."): LLMClient & { calls: Array<{ fragments: string[]; query: string }> } {
  const calls: Array<{ fragments: string[]; query: string }> = [];
  return {
    calls,
    async synthesizeFragments(fragments: string[], query: string) {
      calls.push({ fragments, query });
      return response;
    },
  } as any;
}

function createFailingLLM(): LLMClient {
  return {
    async synthesizeFragments() {
      throw new Error("LLM connection failed");
    },
  } as any;
}

// ---------------------------------------------------------------------------
// synthesize() tests
// ---------------------------------------------------------------------------

describe("synthesize", () => {
  it("calls LLM when fragments >= minFragments", async () => {
    const llm = createMockLLM("Combined narrative about user preferences.");
    const fragments = ["Pref A: dark mode", "Pref B: vim keys", "Pref C: compact layout"];

    const result = await synthesize(fragments, "user preferences", llm);

    expect(result.synthesized).toBe(true);
    expect(result.text).toBe("Combined narrative about user preferences.");
    expect(result.reason).toBe("ok");
    expect(llm.calls.length).toBe(1);
    expect(llm.calls[0].query).toBe("user preferences");
  });

  it("skips synthesis when fragments < minFragments", async () => {
    const llm = createMockLLM();
    const fragments = ["Only one", "Two items"];

    const result = await synthesize(fragments, "test", llm);

    expect(result.synthesized).toBe(false);
    expect(result.reason).toBe("below-threshold");
    expect(result.fragments).toEqual(fragments);
    expect(llm.calls.length).toBe(0);
  });

  it("skips synthesis when no LLM provided", async () => {
    const fragments = ["A", "B", "C"];
    const result = await synthesize(fragments, "test", null);

    expect(result.synthesized).toBe(false);
    expect(result.reason).toBe("no-llm");
  });

  it("handles LLM failure gracefully", async () => {
    const llm = createFailingLLM();
    const fragments = ["A", "B", "C"];

    const result = await synthesize(fragments, "test", llm);

    expect(result.synthesized).toBe(false);
    expect(result.reason).toBe("error");
    expect(result.fragments).toEqual(fragments);
  });

  it("handles empty LLM response", async () => {
    const llm = createMockLLM(null);
    const fragments = ["A", "B", "C"];

    const result = await synthesize(fragments, "test", llm);

    expect(result.synthesized).toBe(false);
    expect(result.reason).toBe("empty-response");
  });

  it("handles empty fragments array", async () => {
    const llm = createMockLLM();
    const result = await synthesize([], "test", llm);

    expect(result.synthesized).toBe(false);
    expect(result.reason).toBe("below-threshold");
  });

  it("respects custom minFragments config", async () => {
    const llm = createMockLLM("ok");
    const fragments = ["A", "B"];

    // Default minFragments=3, so 2 items would be below threshold
    const result2 = await synthesize(fragments, "test", llm, { ...DEFAULT_SYNTHESIZER_CONFIG, minFragments: 2 });
    expect(result2.synthesized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// synthesizeSection() tests
// ---------------------------------------------------------------------------

describe("synthesizeSection", () => {
  const originalEnv = process.env.RECALLNEST_SYNTHESIZE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.RECALLNEST_SYNTHESIZE = originalEnv;
    } else {
      delete process.env.RECALLNEST_SYNTHESIZE;
    }
  });

  it("returns original items when RECALLNEST_SYNTHESIZE is not set", async () => {
    delete process.env.RECALLNEST_SYNTHESIZE;
    const items = ["A", "B", "C", "D"];
    const llm = createMockLLM("synthesized");

    const result = await synthesizeSection(items, "test", llm);

    expect(result).toEqual(items);
    expect(llm.calls.length).toBe(0);
  });

  it("synthesizes when RECALLNEST_SYNTHESIZE=true", async () => {
    process.env.RECALLNEST_SYNTHESIZE = "true";
    const items = ["Profile: developer", "Preference: dark mode", "Entity: project X"];
    const llm = createMockLLM("User is a developer who prefers dark mode and works on project X.");

    const result = await synthesizeSection(items, "user context", llm);

    expect(result).toEqual(["User is a developer who prefers dark mode and works on project X."]);
  });

  it("returns original items when synthesis fails", async () => {
    process.env.RECALLNEST_SYNTHESIZE = "true";
    const items = ["A", "B", "C"];
    const llm = createFailingLLM();

    const result = await synthesizeSection(items, "test", llm);

    expect(result).toEqual(items);
  });
});

// ---------------------------------------------------------------------------
// isSynthesisEnabled() tests
// ---------------------------------------------------------------------------

describe("isSynthesisEnabled", () => {
  const originalEnv = process.env.RECALLNEST_SYNTHESIZE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.RECALLNEST_SYNTHESIZE = originalEnv;
    } else {
      delete process.env.RECALLNEST_SYNTHESIZE;
    }
  });

  it("returns false when env not set", () => {
    delete process.env.RECALLNEST_SYNTHESIZE;
    expect(isSynthesisEnabled()).toBe(false);
  });

  it("returns true when env is 'true'", () => {
    process.env.RECALLNEST_SYNTHESIZE = "true";
    expect(isSynthesisEnabled()).toBe(true);
  });

  it("returns false when env is other value", () => {
    process.env.RECALLNEST_SYNTHESIZE = "false";
    expect(isSynthesisEnabled()).toBe(false);
  });
});
