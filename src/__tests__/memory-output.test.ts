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
      }),
    ], {
      query: "reply style",
      profile: "default",
    });

    expect(output).toContain("prov : durable/structured-memory");
    expect(output).toContain("key:user-reply-style");
    expect(output).toContain("promoted:feedface<-evidence/transcript-ingest");
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
});
