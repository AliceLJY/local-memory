import { describe, expect, it } from "bun:test";

import { createRetriever } from "../retriever.js";

function buildEntry(id: string, scoreText: string, scope: string, metadata: Record<string, unknown>) {
  return {
    entry: {
      id,
      text: scoreText,
      vector: [1, 0, 0],
      category: "preferences",
      scope,
      importance: 0.8,
      timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
      metadata: JSON.stringify(metadata),
    },
    score: 0.8,
  };
}

describe("retriever provenance weighting", () => {
  it("prefers durable structured memories over evidence when scores are close", async () => {
    const retriever = createRetriever({
      hasFtsSupport: false,
      async vectorSearch() {
        return [
          {
            ...buildEntry("evidence-1", "Transcript hint", "cc:session1", {
              source: "cc",
              boundary: {
                layer: "evidence",
                authority: "transcript-ingest",
                conflictPolicy: "append-only",
                originalCategory: "preferences",
              },
            }),
            score: 0.8,
          },
          {
            ...buildEntry("durable-1", "Curated durable preference", "memory:agent", {
              source: "agent",
              boundary: {
                layer: "durable",
                authority: "structured-memory",
                conflictPolicy: "latest-wins",
                originalCategory: "preferences",
              },
            }),
            score: 0.79,
          },
        ];
      },
    } as any, {
      async embedQuery() {
        return [1, 0, 0];
      },
      async embedPassage() {
        return [1, 0, 0];
      },
    } as any, {
      mode: "vector",
      rerank: "none",
      filterNoise: false,
      hardMinScore: 0,
      minScore: 0,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 0,
    });

    const results = await retriever.retrieve({
      query: "user reply style preference",
      limit: 5,
      category: "preferences",
    });

    expect(results[0]?.entry.id).toBe("durable-1");
    expect(results[1]?.entry.id).toBe("evidence-1");
  });

  it("does not override clearly stronger relevance with provenance weighting", async () => {
    const retriever = createRetriever({
      hasFtsSupport: false,
      async vectorSearch() {
        return [
          {
            ...buildEntry("evidence-strong", "Very strong transcript evidence", "cc:session1", {
              source: "cc",
              boundary: {
                layer: "evidence",
                authority: "transcript-ingest",
                conflictPolicy: "append-only",
                originalCategory: "preferences",
              },
            }),
            score: 0.95,
          },
          {
            ...buildEntry("durable-weaker", "Weaker durable preference", "memory:agent", {
              source: "agent",
              boundary: {
                layer: "durable",
                authority: "structured-memory",
                conflictPolicy: "latest-wins",
                originalCategory: "preferences",
              },
            }),
            score: 0.7,
          },
        ];
      },
    } as any, {
      async embedQuery() {
        return [1, 0, 0];
      },
      async embedPassage() {
        return [1, 0, 0];
      },
    } as any, {
      mode: "vector",
      rerank: "none",
      filterNoise: false,
      hardMinScore: 0,
      minScore: 0,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 0,
    });

    const results = await retriever.retrieve({
      query: "user reply style preference",
      limit: 5,
      category: "preferences",
    });

    expect(results[0]?.entry.id).toBe("evidence-strong");
  });
});
