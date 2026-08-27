import { describe, expect, it } from "bun:test";

import { formatExplainResults, formatSearchResults } from "../memory-output.js";
import type { RetrievalResult } from "../retriever.js";

function buildResult(id: string, metadata: Record<string, unknown>): RetrievalResult {
  return {
    entry: {
      id,
      text: "User prefers concise, direct replies.",
      vector: [],
      category: "preferences",
      scope: "memory:agent",
      importance: 0.8,
      timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
      metadata: JSON.stringify(metadata),
    },
    score: 0.91,
    sources: {
      vector: { score: 0.9, rank: 1 },
      bm25: { score: 0.8, rank: 2 },
      fused: { score: 0.91 },
    },
  };
}

describe("memory output", () => {
  it("renders a whole-day age next to every date so nobody has to subtract", () => {
    const result = buildResult("abcd1234-0000-0000-0000-000000000009", { source: "agent" });
    const search = formatSearchResults([result], { query: "concise", profile: "default" } as any);
    expect(search).toContain("Date       Age   Retrieval Path");
    expect(search).toMatch(/2026-03-16 \d+d\s+vector/);
    const explain = formatExplainResults([result], { query: "concise", profile: "default" } as any);
    expect(explain).toMatch(/2026-03-16 \(\d+d\)/);
  });

  it("includes provenance in search results", () => {
    const output = formatSearchResults([
      buildResult("abcd1234-0000-0000-0000-000000000001", {
        source: "agent",
        canonicalKey: "user-reply-style",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
        promotedFrom: {
          memoryId: "feedface-0000-0000-0000-000000000001",
          scope: "cc:session1",
          category: "events",
          boundary: {
            layer: "evidence",
            authority: "transcript-ingest",
            conflictPolicy: "append-only",
            originalCategory: "preferences",
          },
        },
        provenanceHistory: [
          {
            memoryId: "feedface-0000-0000-0000-000000000001",
            scope: "cc:session1",
            category: "events",
            source: "cc",
          },
          {
            memoryId: "deadbeef-0000-0000-0000-000000000002",
            scope: "cc:session2",
            category: "events",
            source: "cc",
            observedAt: "2026-03-17T04:30:00.000Z",
            boundary: {
              layer: "evidence",
              authority: "transcript-ingest",
              conflictPolicy: "append-only",
              originalCategory: "preferences",
            },
          },
        ],
        provenanceHistoryCount: 2,
        preferenceSlot: {
          type: "brand-item",
          brand: "麦当劳",
          item: "麦辣鸡翅",
        },
      }),
    ], {
      query: "reply style",
      profile: "default",
    });

    expect(output).toContain("prov : durable/structured-memory");
    expect(output).toContain("key:user-reply-style");
    expect(output).toContain("promoted:feedface<-evidence/transcript-ingest");
    expect(output).toContain("history:2");
    expect(output).toContain("observed:deadbeef@2026-03-17");
    expect(output).toContain("slot:brand-item:麦当劳:麦辣鸡翅");
  });

  it("includes provenance in explain results", () => {
    const output = formatExplainResults([
      buildResult("abcd1234-0000-0000-0000-000000000001", {
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
          downgradedFrom: "preferences",
        },
      }),
    ], {
      query: "reply style",
      profile: "writing",
    });

    expect(output).toContain("prov    : evidence/transcript-ingest");
    expect(output).toContain("downgraded:preferences");
  });

  it("renders reply-style slots in provenance summaries", () => {
    const output = formatSearchResults([
      buildResult("abcd1234-0000-0000-0000-000000000002", {
        source: "agent",
        canonicalKey: "preferences:reply-style:concise:direct",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
        preferenceSlot: {
          type: "reply-style",
          traits: ["concise", "direct"],
        },
      }),
    ], {
      query: "reply style",
      profile: "default",
    });

    expect(output).toContain("slot:reply-style:concise:direct");
  });

  it("renders tool-choice slots in provenance summaries", () => {
    const output = formatSearchResults([
      buildResult("abcd1234-0000-0000-0000-000000000003", {
        source: "agent",
        canonicalKey: "preferences:tool-choice:bun:over:node",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
        preferenceSlot: {
          type: "tool-choice",
          preferredTool: "bun",
          avoidedTool: "node",
        },
      }),
    ], {
      query: "tool choice",
      profile: "default",
    });

    expect(output).toContain("slot:tool-choice:bun:over:node");
  });

  it("does not render slot provenance for plain preferences canonical keys", () => {
    const output = formatSearchResults([
      buildResult("abcd1234-0000-0000-0000-000000000004", {
        source: "agent",
        canonicalKey: "preferences:这段文案简洁直接-先别改",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
      }),
      buildResult("abcd1234-0000-0000-0000-000000000005", {
        source: "agent",
        canonicalKey: "preferences:文档里写了-uses-bun-over-node-的迁移说明",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
      }),
    ], {
      query: "preferences",
      profile: "default",
    });

    expect(output).toContain("key:preferences:这段文案简洁直接-先别改");
    expect(output).toContain("key:preferences:文档里写了-uses-bun-over-node-的迁移说明");
    expect(output).not.toContain("slot:reply-style:");
    expect(output).not.toContain("slot:tool-choice:");
  });

  it("does not render slot provenance in explain output for plain preferences canonical keys", () => {
    const output = formatExplainResults([
      buildResult("abcd1234-0000-0000-0000-000000000006", {
        source: "agent",
        canonicalKey: "preferences:这段文案简洁直接-先别改",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
      }),
    ], {
      query: "draft note",
      profile: "default",
    });

    expect(output).toContain("key:preferences:这段文案简洁直接-先别改");
    expect(output).not.toContain("slot:reply-style:");
    expect(output).not.toContain("slot:tool-choice:");
  });
});

// session 级图片标记（2026-08-27）：ingest 不把图编进库，只记「这个 session 里
// 用户贴过几张图」。检索侧必须把它显式说出来——不说，读到这条记忆的人不会知道
// 附近还有图没看，写入侧就白做了。
describe("memory output — session 级图片标记", () => {
  it("有 sessionImages 时多给一行 imgs，带张数和回查坐标", () => {
    const output = formatSearchResults(
      [
        buildResult("abcd1234-0000-0000-0000-00000000000a", {
          source: "cc",
          sessionId: "05a9a168-9ee9-489e-9a9a-7f691a272ef1",
          sessionImages: 7,
        }),
      ],
      { query: "报错", profile: "default" } as any,
    );

    expect(output).toContain("imgs :");
    expect(output).toContain("7 张");
    expect(output).toContain("sess=05a9a168");
    // 措辞要说清这是 session 级、未必属于本条，否则读的人会当成「这条有图」
    expect(output).toContain("同 session");
  });

  // AI 产图单独成一类：它答的是「我当时生成的图 / 页面当时什么样」，
  // 跟「我发过的那张截图」不是一个问题。实测它比用户贴图多三倍多，
  // 只标用户贴图会让一半以上的带图 session 完全没有标记。
  it("只有 AI 产图时也出 imgs 行，并与用户贴图分开报", () => {
    const output = formatSearchResults(
      [
        buildResult("abcd1234-0000-0000-0000-00000000000c", {
          source: "codex",
          sessionId: "019f710a-84a6-7a73-a283-a198cf9a6208",
          sessionToolImages: 23,
        }),
      ],
      { query: "截图", profile: "default" } as any,
    );

    expect(output).toContain("imgs :");
    expect(output).toContain("AI 产图 23 张");
    expect(output).not.toContain("用户贴图");
  });

  // 反向断言：无图记忆不该多出这一行，否则就是给所有记忆添噪音
  it("没有任何图片标记的记忆不输出 imgs 行", () => {
    const output = formatSearchResults(
      [buildResult("abcd1234-0000-0000-0000-00000000000b", { source: "agent" })],
      { query: "concise", profile: "default" } as any,
    );

    expect(output).not.toContain("imgs :");
  });
});
