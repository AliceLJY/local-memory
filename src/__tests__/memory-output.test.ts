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
