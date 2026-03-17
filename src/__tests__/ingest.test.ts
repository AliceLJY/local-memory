import { describe, expect, it } from "bun:test";

import { dedupCheck } from "../ingest.js";

function buildSearchResult(text: string, score: number) {
  return {
    score,
    entry: {
      id: `memory-${score}`,
      text,
      vector: [score],
      category: "events",
      scope: "cc:test-session",
      importance: 0.6,
      timestamp: 1_700_000_000_000,
      metadata: "{}",
    },
  };
}

describe("dedupCheck", () => {
  it("stores a new same-brand item preference instead of treating it as a duplicate topic", async () => {
    let llmCalls = 0;
    const store = {
      async vectorSearch() {
        return [
          buildSearchResult("喜欢吃麦当劳的麦旋风", 0.92),
          buildSearchResult("喜欢吃麦当劳的板烧鸡腿堡", 0.89),
        ];
      },
    };
    const llm = {
      async dedupDecision() {
        llmCalls += 1;
        return { action: "SKIP" as const, reason: "same topic" };
      },
    };

    const result = await dedupCheck(
      store as any,
      [1, 0, 0],
      "我喜欢吃麦当劳的麦辣鸡翅",
      llm as any,
    );

    expect(result.action).toBe("store");
    expect(result.existingText).toBe("喜欢吃麦当劳的板烧鸡腿堡");
    expect(llmCalls).toBe(0);
  });

  it("stores a new atomic preference even when the closest match is an aggregate summary", async () => {
    const store = {
      async vectorSearch() {
        return [
          buildSearchResult("喜欢吃麦当劳的麦旋风、板烧鸡腿堡和藤椒鸡派", 0.94),
        ];
      },
    };

    const result = await dedupCheck(
      store as any,
      [1, 0, 0],
      "我喜欢吃麦当劳的麦辣鸡翅",
    );

    expect(result.action).toBe("store");
    expect(result.existingText).toContain("麦旋风");
  });

  it("still skips when an exact atomic preference already exists among the candidates", async () => {
    const store = {
      async vectorSearch() {
        return [
          buildSearchResult("喜欢吃麦当劳的麦旋风、板烧鸡腿堡和藤椒鸡派", 0.94),
          buildSearchResult("我喜欢吃麦当劳的麦辣鸡翅", 0.82),
        ];
      },
    };

    const result = await dedupCheck(
      store as any,
      [1, 0, 0],
      "我喜欢吃麦当劳的麦辣鸡翅",
    );

    expect(result.action).toBe("skip");
    expect(result.existingText).toBe("我喜欢吃麦当劳的麦辣鸡翅");
  });

  it("stores a new reply-style preference instead of collapsing different style traits into one topic", async () => {
    let llmCalls = 0;
    const store = {
      async vectorSearch() {
        return [
          buildSearchResult("User prefers concise, direct replies.", 0.91),
        ];
      },
    };
    const llm = {
      async dedupDecision() {
        llmCalls += 1;
        return { action: "SKIP" as const, reason: "same topic" };
      },
    };

    const result = await dedupCheck(
      store as any,
      [1, 0, 0],
      "User prefers colloquial, grounded replies.",
      llm as any,
    );

    expect(result.action).toBe("store");
    expect(result.existingText).toBe("User prefers concise, direct replies.");
    expect(llmCalls).toBe(0);
  });

  it("stores a new tool-choice preference instead of collapsing different tool choices into one topic", async () => {
    let llmCalls = 0;
    const store = {
      async vectorSearch() {
        return [
          buildSearchResult("Uses Bun over Node.", 0.91),
        ];
      },
    };
    const llm = {
      async dedupDecision() {
        llmCalls += 1;
        return { action: "SKIP" as const, reason: "same topic" };
      },
    };

    const result = await dedupCheck(
      store as any,
      [1, 0, 0],
      "Prefers rg over grep.",
      llm as any,
    );

    expect(result.action).toBe("store");
    expect(result.existingText).toBe("Uses Bun over Node.");
    expect(llmCalls).toBe(0);
  });
});
