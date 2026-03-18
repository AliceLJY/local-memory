import { describe, expect, it } from "bun:test";

import { promoteMemory } from "../capture-engine.js";
import { createRetriever } from "../retriever.js";
import { buildRetrievalContext, matchesScopeFilter } from "../scope-policy.js";

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function createCoreRetriever(entries: Array<{
  id: string;
  text: string;
  scope: string;
  category?: "entities" | "events";
  vector: number[];
}>) {
  return createRetriever({
    hasFtsSupport: false,
    async vectorSearch(queryVector: number[], limit = 5, minScore = 0, scopeFilter?: string[]) {
      return entries
        .filter((entry) => matchesScopeFilter(entry.scope, scopeFilter))
        .map((entry) => ({
          entry: {
            id: entry.id,
            text: entry.text,
            vector: entry.vector,
            category: entry.category || "entities",
            scope: entry.scope,
            importance: 0.8,
            timestamp: Date.parse("2026-03-17T00:00:00.000Z"),
            metadata: "{}",
          },
          score: cosineSimilarity(queryVector, entry.vector),
        }))
        .filter((result) => result.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
  } as any, {
    async embedQuery(query: string) {
      if (/衰减|公式|曲线|weibull/i.test(query)) return [1, 0, 0];
      if (/部署|deploy|region|在哪/i.test(query)) return [0, 1, 0];
      return [0, 0, 1];
    },
    async embedPassage() {
      return [0, 0, 1];
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
}

function createCaptureDeps() {
  const storedEntries: any[] = [];
  let seq = 1;

  return {
    storedEntries,
    deps: {
      embedder: {
        async embedPassage(text: string) {
          return [text.length, 1, 0];
        },
      },
      store: {
        async store(entry: any) {
          const stored = {
            ...entry,
            id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
            timestamp: 1_700_000_000_000 + seq,
          };
          seq += 1;
          storedEntries.push(stored);
          return stored;
        },
        async list(_scopeFilter?: string[], category?: string, limit = 20, offset = 0) {
          return storedEntries
            .filter((entry) => !category || entry.category === category)
            .slice(offset, offset + limit);
        },
        async update(id: string, updates: any) {
          const index = storedEntries.findIndex((entry) => entry.id === id);
          if (index < 0) return null;
          storedEntries[index] = {
            ...storedEntries[index],
            ...updates,
            timestamp: updates.timestamp ?? storedEntries[index].timestamp,
          };
          return storedEntries[index];
        },
        async get(id: string) {
          return storedEntries.find((entry) => entry.id === id) || null;
        },
        async getById(id: string) {
          return storedEntries.find((entry) => entry.id === id) || null;
        },
      },
      conflictStore: {
        async save(record: any) {
          return record;
        },
        async replace(record: any) {
          return record;
        },
        async getOpenByFingerprint() {
          return null;
        },
        async getLatestByFingerprint() {
          return null;
        },
      },
    },
  };
}

describe("core recall eval", () => {
  it("hits the right memory for a vague associative query within the target scope", async () => {
    const retriever = createCoreRetriever([
      {
        id: "alpha-weibull",
        text: "RecallNest uses Weibull decay with beta=0.8 for the core tier.",
        scope: "project:alpha",
        vector: [1, 0, 0],
      },
      {
        id: "alpha-entity",
        text: "RecallNest exposes checkpoint_session and resume_context.",
        scope: "project:alpha",
        vector: [0, 0, 1],
      },
      {
        id: "beta-deploy",
        text: "Project beta deploys in us-east-1.",
        scope: "project:beta",
        vector: [0, 1, 0],
      },
    ]);

    const results = await retriever.retrieve(buildRetrievalContext({
      query: "那个衰减曲线用的什么公式来着",
      limit: 5,
      scope: "project:alpha",
    }, {
      operation: "test:associative-recall",
    }));

    expect(results[0]?.entry.id).toBe("alpha-weibull");
    expect(results.every((result) => result.entry.scope === "project:alpha")).toBe(true);
  });

  it("does not leak results from another scope when default scope is inferred", async () => {
    const retriever = createCoreRetriever([
      {
        id: "alpha-note",
        text: "Project alpha stores its API key outside the memory index.",
        scope: "project:alpha",
        vector: [0, 0, 1],
      },
      {
        id: "beta-deploy",
        text: "Project beta deploys in us-east-1.",
        scope: "project:beta",
        vector: [0, 1, 0],
      },
    ]);

    const results = await retriever.retrieve(buildRetrievalContext({
      query: "部署在哪",
      limit: 5,
    }, {
      operation: "test:scope-isolation",
      env: {
        RECALLNEST_DEFAULT_SCOPE: "project:alpha",
      } as NodeJS.ProcessEnv,
    }));

    expect(results.some((result) => result.entry.id === "beta-deploy")).toBe(false);
    expect(results.every((result) => result.entry.scope === "project:alpha")).toBe(true);
  });

  it("preserves text and provenance when promoting evidence into durable memory", async () => {
    const { deps, storedEntries } = createCaptureDeps();
    const source = await deps.store.store({
      text: "RecallNest uses Weibull decay with beta=0.8 for the core tier.",
      vector: [1, 0, 0],
      category: "events",
      scope: "cc:session-alpha",
      importance: 0.5,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "entities",
        },
      }),
    });

    const promoted = await promoteMemory(deps as any, {
      memoryId: source.id,
      category: "entities",
      scope: "project:alpha",
      source: "agent",
      tags: ["core-eval"],
    });

    expect(promoted.text).toBe("RecallNest uses Weibull decay with beta=0.8 for the core tier.");
    expect(promoted.resolvedScope).toBe("project:alpha");
    expect(storedEntries[1]?.text).toBe("RecallNest uses Weibull decay with beta=0.8 for the core tier.");
    expect(JSON.parse(storedEntries[1]?.metadata || "{}")).toMatchObject({
      promotedFrom: {
        memoryId: source.id,
        scope: "cc:session-alpha",
        category: "events",
      },
    });
  });
});
