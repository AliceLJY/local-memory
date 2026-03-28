import { describe, expect, it } from "bun:test";

import { autoCapture, extractHeuristic, shouldCapture } from "../capture-heuristic.js";

// =============================================================================
// shouldCapture
// =============================================================================

describe("shouldCapture", () => {
  it("rejects empty or very short text", () => {
    expect(shouldCapture("")).toBe(false);
    expect(shouldCapture("hi")).toBe(false);
    expect(shouldCapture("short")).toBe(false);
    expect(shouldCapture("a".repeat(19))).toBe(false);
  });

  it("rejects greetings (EN)", () => {
    expect(shouldCapture("hello!")).toBe(false);
    expect(shouldCapture("thanks!")).toBe(false);
    expect(shouldCapture("ok")).toBe(false);
    expect(shouldCapture("got it")).toBe(false);
  });

  it("rejects greetings (ZH)", () => {
    expect(shouldCapture("好的")).toBe(false);
    expect(shouldCapture("谢谢")).toBe(false);
    expect(shouldCapture("嗯")).toBe(false);
    expect(shouldCapture("是的")).toBe(false);
    expect(shouldCapture("收到")).toBe(false);
  });

  it("rejects noise (denial patterns from noise-filter)", () => {
    expect(shouldCapture("I don't have any information about that topic")).toBe(false);
    expect(shouldCapture("No relevant memories found for your query")).toBe(false);
  });

  it("accepts meaningful text above threshold", () => {
    expect(shouldCapture("I prefer using TypeScript for all my projects because it catches bugs early")).toBe(true);
    expect(shouldCapture("我喜欢用 Docker 来管理本地开发环境，因为可以隔离依赖")).toBe(true);
  });
});

// =============================================================================
// extractHeuristic
// =============================================================================

describe("extractHeuristic", () => {
  it("extracts preference signals (EN)", () => {
    const items = extractHeuristic("I prefer dark mode for all my editors. The weather is nice today.");
    expect(items.length).toBe(1);
    expect(items[0].category).toBe("preferences");
    expect(items[0].importance).toBe(0.8);
    expect(items[0].sourceContext).toBe("preference signal");
    expect(items[0].text).toContain("dark mode");
  });

  it("extracts preference signals (ZH)", () => {
    const items = extractHeuristic("我喜欢用 Bun 而不是 Node.js 来运行 TypeScript 项目");
    expect(items.length).toBe(1);
    expect(items[0].category).toBe("preferences");
    expect(items[0].text).toContain("Bun");
  });

  it("extracts identity / profile signals (EN)", () => {
    const items = extractHeuristic("My name is Alice and I work at a cultural organization");
    expect(items.length).toBe(1);
    expect(items[0].category).toBe("profile");
    expect(items[0].importance).toBe(0.9);
  });

  it("extracts identity / profile signals (ZH)", () => {
    const items = extractHeuristic("我是一个医学出身的内容创作者，目前在做AI相关的公众号运营");
    expect(items.length).toBe(1);
    expect(items[0].category).toBe("profile");
  });

  it("extracts decision signals", () => {
    const items = extractHeuristic("We decided to use LanceDB as the vector store for this project");
    expect(items.length).toBe(1);
    expect(items[0].category).toBe("events");
    expect(items[0].importance).toBe(0.7);
    expect(items[0].sourceContext).toBe("decision signal");
  });

  it("extracts correction signals with next sentence", () => {
    const items = extractHeuristic(
      "Actually, that's wrong. The rate limit is 200 per minute. And the sky is blue."
    );
    expect(items.length).toBe(1);
    expect(items[0].category).toBe("cases");
    expect(items[0].importance).toBe(0.85);
    // Should include both the correction and the next sentence
    expect(items[0].text).toContain("that's wrong");
    expect(items[0].text).toContain("rate limit");
  });

  it("extracts explicit memory instruction signals (ZH)", () => {
    const items = extractHeuristic("记住这个：我的 API key 过期日期是每月 15 号需要更新");
    expect(items.length).toBe(1);
    expect(items[0].sourceContext).toBe("explicit memory instruction");
    expect(items[0].importance).toBe(0.85);
  });

  it("extracts pattern / workflow signals", () => {
    const items = extractHeuristic("The workflow is: first run tests, then commit, then push to remote");
    expect(items.length).toBe(1);
    expect(items[0].category).toBe("patterns");
    expect(items[0].importance).toBe(0.75);
  });

  it("extracts multiple signals from multi-sentence text", () => {
    const items = extractHeuristic(
      "I prefer using VS Code for editing. My name is Bob and I work at Acme Corp. We decided to migrate to AWS."
    );
    expect(items.length).toBe(3);
    expect(items[0].category).toBe("preferences");
    expect(items[1].category).toBe("profile");
    expect(items[2].category).toBe("events");
  });

  it("caps at MAX_ITEMS_PER_TURN (5)", () => {
    const text = [
      "I prefer TypeScript over JavaScript.",
      "I like dark mode.",
      "I love coffee.",
      "I want a fast editor.",
      "I need good autocomplete.",
      "I hate slow builds.",
      "I always use ESLint.",
    ].join(" ");
    const items = extractHeuristic(text);
    expect(items.length).toBeLessThanOrEqual(5);
  });

  it("returns empty for text with no signals", () => {
    const items = extractHeuristic("The function calculates the sum of two numbers and returns the result to the caller");
    expect(items.length).toBe(0);
  });

  it("filters out sentences shorter than minSentenceLen", () => {
    // Short EN sentences below 15 chars should be skipped
    const items = extractHeuristic("I like it. That is all there is to say about the matter.");
    // "I like it" is 9 chars → filtered
    expect(items.every((item) => item.text.length >= 15)).toBe(true);
  });
});

// =============================================================================
// autoCapture (integration)
// =============================================================================

describe("autoCapture", () => {
  it("returns skippedSalience=true for noise", () => {
    const result = autoCapture("hello!");
    expect(result.skippedSalience).toBe(true);
    expect(result.items.length).toBe(0);
  });

  it("returns skippedSalience=false with items for valid text", () => {
    const result = autoCapture("I prefer using RecallNest for all my memory management needs");
    expect(result.skippedSalience).toBe(false);
    expect(result.items.length).toBe(1);
    expect(result.items[0].category).toBe("preferences");
  });

  it("returns skippedSalience=false with empty items for text without signals", () => {
    const result = autoCapture("The function calculates the sum of two numbers and returns the result to the caller");
    expect(result.skippedSalience).toBe(false);
    expect(result.items.length).toBe(0);
  });
});
