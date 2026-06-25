import { describe, expect, it } from "bun:test";

import { registerCoreTools } from "../mcp-tools-core.js";
import type { RetrievalContext, RetrievalResult } from "../retriever.js";

function makeResult(id: string, scope: string, text: string): RetrievalResult {
  return {
    entry: {
      id,
      text,
      vector: [1, 0, 0],
      category: "events",
      scope,
      importance: 0.8,
      timestamp: Date.parse("2026-06-26T00:00:00.000Z"),
      metadata: "{}",
    },
    score: 0.9,
    sources: {
      vector: { score: 0.9, rank: 1 },
      fused: { score: 0.9 },
    },
  };
}

function createSearchHarness(scopeRelations: Record<string, string[]> = {}) {
  const handlers = new Map<string, any>();
  const calls: RetrievalContext[] = [];
  const byScope: Record<string, RetrievalResult[]> = {
    "project:alpha": [
      makeResult("alpha-note", "project:alpha", "Alpha owns the default deployment notes."),
    ],
    "project:beta": [
      makeResult("beta-note", "project:beta", "Beta has related deployment follow-up context."),
    ],
  };

  const store = {
    async vectorSearch() {
      return [];
    },
    async update() {
      return null;
    },
    async getById() {
      return null;
    },
    async stats() {
      return {
        totalCount: 2,
        scopeCounts: {
          "project:alpha": 1,
          "project:beta": 1,
        },
        categoryCounts: {},
      };
    },
  };

  registerCoreTools({
    registerTool(name: string, _description: string, _schema: unknown, handler: unknown) {
      handlers.set(name, handler);
    },
    getComponents() {
      return {
        store,
        embedder: {
          async embedPassage() {
            return [1, 0, 0];
          },
        },
        retriever: {
          async retrieve(context: RetrievalContext) {
            calls.push(context);
            const scope = context.scopeFilter?.[0] ?? "__all__";
            return byScope[scope] ?? [];
          },
          setKGStore() {},
          setLLMClient() {},
        },
        profile: { name: "default" },
        accessTracker: null,
        frequencyTracker: null,
        llm: null,
      };
    },
    config: {
      dbPath: "data/memory.lance",
      embedding: {
        provider: "openai-compatible",
        apiKey: "test",
        model: "test",
      },
      sources: {},
      scopeRelations,
    },
    checkpointStore: {},
    conflictStore: {},
    workflowObservationStore: {},
    toolDescriptions: new Map(),
    toolTiers: {},
    getKGExtractor: () => null,
    getKGStore: () => null,
  } as any);

  return {
    calls,
    search: handlers.get("search_memory") as (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
  };
}

describe("search_memory related scope sidecar", () => {
  it("keeps related scopes out of default scoped search", async () => {
    const harness = createSearchHarness({
      "project:alpha": ["project:beta"],
    });

    const result = await harness.search({
      query: "deployment",
      scope: "project:alpha",
      limit: 5,
    });

    expect(harness.calls.map(call => call.scopeFilter)).toEqual([["project:alpha"]]);
    expect(result.content[0]?.text).toContain("Alpha owns the default deployment notes.");
    expect(result.content[0]?.text).not.toContain("Beta has related deployment follow-up context.");
    expect(result.content[0]?.text).not.toContain("Related scope results");
  });

  it("adds related scope results only when explicitly requested", async () => {
    const harness = createSearchHarness({
      "project:alpha": ["project:beta"],
    });

    const result = await harness.search({
      query: "deployment",
      scope: "project:alpha",
      limit: 5,
      includeRelatedScopes: true,
    });

    expect(harness.calls.map(call => call.scopeFilter)).toEqual([
      ["project:alpha"],
      ["project:beta"],
    ]);
    expect(result.content[0]?.text).toContain("Alpha owns the default deployment notes.");
    expect(result.content[0]?.text).toContain("Related scope results");
    expect(result.content[0]?.text).toContain("project:beta");
    expect(result.content[0]?.text).toContain("Beta has related deployment follow-up context.");
  });
});
