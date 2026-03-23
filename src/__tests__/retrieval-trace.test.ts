import { describe, expect, it } from "bun:test";
import { TraceCollector } from "../retrieval-trace.js";
import { createRetriever } from "../retriever.js";

describe("TraceCollector", () => {
  it("accumulates stages correctly", () => {
    const trace = new TraceCollector();
    trace.startStage("vector_search", 0);
    trace.endStage(20, [0.3, 0.9]);

    trace.startStage("min_score_filter", 20);
    trace.endStage(15, [0.35, 0.9]);

    const result = trace.finalize("test query", "hybrid");
    expect(result.query).toBe("test query");
    expect(result.mode).toBe("hybrid");
    expect(result.stages).toHaveLength(2);
    expect(result.finalCount).toBe(15);
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("computes droppedCount as input - output", () => {
    const trace = new TraceCollector();
    trace.startStage("hard_min_score", 20);
    trace.endStage(12);

    const result = trace.finalize("q", "vector");
    expect(result.stages[0].droppedCount).toBe(8);
  });

  it("computes scoreRange from surviving scores", () => {
    const trace = new TraceCollector();
    trace.startStage("rerank", 10);
    trace.endStage(8, [0.2, 0.5, 0.8, 0.3, 0.6, 0.7, 0.4, 0.9]);

    const stage = trace.finalize("q", "hybrid").stages[0];
    expect(stage.scoreRange).not.toBeNull();
    expect(stage.scoreRange![0]).toBeCloseTo(0.2);
    expect(stage.scoreRange![1]).toBeCloseTo(0.9);
  });

  it("returns null scoreRange when no scores provided", () => {
    const trace = new TraceCollector();
    trace.startStage("noise_filter", 5);
    trace.endStage(3);

    expect(trace.finalize("q", "hybrid").stages[0].scoreRange).toBeNull();
  });

  it("summarize() produces readable multi-line output", () => {
    const trace = new TraceCollector();
    trace.startStage("vector_search", 0);
    trace.endStage(20, [0.31, 0.89]);
    trace.startStage("min_score_filter", 20);
    trace.endStage(18, [0.35, 0.89]);

    const summary = trace.summarize("auth middleware", "hybrid");
    expect(summary).toContain('[retrieve] query="auth middleware" mode=hybrid');
    expect(summary).toContain("vector_search: 0 → 20");
    expect(summary).toContain("min_score_filter: 20 → 18 (2 dropped)");
    expect(summary).toContain("final: 18 results");
  });
});

describe("retriever with trace", () => {
  it("populates trace stages without changing retrieval behavior", async () => {
    const trace = new TraceCollector();

    const retriever = createRetriever(
      {
        hasFtsSupport: false,
        async vectorSearch() {
          return [
            {
              entry: {
                id: "m1",
                text: "test memory",
                vector: [1, 0, 0],
                category: "entities",
                scope: "project:test",
                importance: 0.8,
                timestamp: Date.now(),
                metadata: "{}",
              },
              score: 0.8,
            },
          ];
        },
      } as any,
      {
        async embedQuery() { return [1, 0, 0]; },
        async embedPassage() { return [1, 0, 0]; },
      } as any,
      {
        mode: "vector",
        rerank: "none",
        filterNoise: false,
        hardMinScore: 0,
        minScore: 0,
        recencyWeight: 0,
        timeDecayHalfLifeDays: 0,
        lengthNormAnchor: 0,
      },
    );

    const results = await retriever.retrieve({
      query: "authentication middleware config",
      limit: 5,
      trace,
    });

    // Results unchanged
    expect(results).toHaveLength(1);
    expect(results[0].entry.id).toBe("m1");

    // Trace populated
    const traceResult = trace.finalize("test", "vector");
    expect(traceResult.stages.length).toBeGreaterThan(0);
    expect(traceResult.stages[0].name).toBe("vector_search");
    expect(traceResult.finalCount).toBe(1);
  });

  it("works identically without trace (no overhead)", async () => {
    const retriever = createRetriever(
      {
        hasFtsSupport: false,
        async vectorSearch() {
          return [
            {
              entry: {
                id: "m1",
                text: "test memory",
                vector: [1, 0, 0],
                category: "entities",
                scope: "project:test",
                importance: 0.8,
                timestamp: Date.now(),
                metadata: "{}",
              },
              score: 0.8,
            },
          ];
        },
      } as any,
      {
        async embedQuery() { return [1, 0, 0]; },
        async embedPassage() { return [1, 0, 0]; },
      } as any,
      {
        mode: "vector",
        rerank: "none",
        filterNoise: false,
        hardMinScore: 0,
        minScore: 0,
        recencyWeight: 0,
        timeDecayHalfLifeDays: 0,
        lengthNormAnchor: 0,
      },
    );

    // No trace passed — should work exactly as before
    const results = await retriever.retrieve({
      query: "authentication middleware config",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0].entry.id).toBe("m1");
  });

  it("trace captures hard_min_score drops", async () => {
    const trace = new TraceCollector();

    const retriever = createRetriever(
      {
        hasFtsSupport: false,
        async vectorSearch() {
          return [
            {
              entry: { id: "high", text: "good", vector: [1, 0, 0], category: "entities", scope: "p:t", importance: 0.8, timestamp: Date.now(), metadata: "{}" },
              score: 0.9,
            },
            {
              entry: { id: "low", text: "weak", vector: [0, 1, 0], category: "entities", scope: "p:t", importance: 0.5, timestamp: Date.now(), metadata: "{}" },
              score: 0.2,
            },
          ];
        },
      } as any,
      {
        async embedQuery() { return [1, 0, 0]; },
        async embedPassage() { return [1, 0, 0]; },
      } as any,
      {
        mode: "vector",
        rerank: "none",
        filterNoise: false,
        hardMinScore: 0.35,
        minScore: 0,
        recencyWeight: 0,
        timeDecayHalfLifeDays: 0,
        lengthNormAnchor: 0,
      },
    );

    await retriever.retrieve({ query: "authentication middleware config", limit: 5, trace });

    const result = trace.finalize("test", "vector");
    const hardStage = result.stages.find(s => s.name === "hard_min_score");
    expect(hardStage).toBeDefined();
    expect(hardStage!.droppedCount).toBeGreaterThan(0);
  });
});
