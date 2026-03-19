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
    expect(result.reason).toBe("unique");
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
    expect(result.reason).toBe("unique");
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
    expect(result.reason).toBe("exact");
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
    expect(result.reason).toBe("unique");
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
    expect(result.reason).toBe("unique");
    expect(result.existingText).toBe("Uses Bun over Node.");
    expect(llmCalls).toBe(0);
  });

  it("stores a borderline chunk when LLM says it should CREATE", async () => {
    let llmCalls = 0;
    const store = {
      async vectorSearch() {
        return [
          buildSearchResult(
            "A2A gateway 之前是先本地 smoke，再补 Claude SDK 配置。",
            0.74,
          ),
        ];
      },
    };
    const llm = {
      async dedupDecision() {
        llmCalls += 1;
        return { action: "CREATE" as const, reason: "new implementation branch" };
      },
    };

    const result = await dedupCheck(
      store as any,
      [1, 0, 0],
      "A2A gateway 升级后要补 MCP transport 配置和 LaunchAgent 环境变量，不是原来的 smoke 流程。",
      llm as any,
    );

    expect(result.action).toBe("store");
    expect(result.reason).toBe("unique");
    expect(llmCalls).toBe(1);
  });

  it("stores a borderline chunk when LLM says it adds new information and should MERGE", async () => {
    let llmCalls = 0;
    const store = {
      async vectorSearch() {
        return [
          buildSearchResult(
            "A2A 调 Claude SDK 时，可以先看 `adapters/claude.js` 里的权限相关配置。",
            0.77,
          ),
        ];
      },
    };
    const llm = {
      async dedupDecision() {
        llmCalls += 1;
        return { action: "MERGE" as const, reason: "same topic but new implementation detail" };
      },
    };

    const result = await dedupCheck(
      store as any,
      [1, 0, 0],
      "给 A2A 调用传 permissionMode: \"dontAsk\" + allowedTools，避免 Claude SDK 在后台 HTTP handler 里卡死等权限确认。",
      llm as any,
    );

    expect(result.action).toBe("store");
    expect(result.reason).toBe("llm-merge");
    expect(result.existingText).toContain("权限相关配置");
    expect(llmCalls).toBe(1);
  });

  it("skips a hard-threshold duplicate without calling the LLM", async () => {
    let llmCalls = 0;
    const store = {
      async vectorSearch() {
        return [
          buildSearchResult(
            "OpenClaw provider 配置里已经写过 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 的设置方法。",
            0.83,
          ),
        ];
      },
    };
    const llm = {
      async dedupDecision() {
        llmCalls += 1;
        return { action: "MERGE" as const, reason: "should never be called" };
      },
    };

    const result = await dedupCheck(
      store as any,
      [1, 0, 0],
      "OpenClaw provider 配置里已经写过 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 的设置方法，但这里重复了一遍。",
      llm as any,
    );

    expect(result.action).toBe("skip");
    expect(result.reason).toBe("hard");
    expect(llmCalls).toBe(0);
  });
});
