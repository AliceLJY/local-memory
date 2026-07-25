import { describe, it, expect } from "bun:test";
import { computeHotnessScore, parseAccessMetadata } from "../access-tracker.js";
import { TraceCollector } from "../retrieval-trace.js";
import {
  createRetriever,
  DEFAULT_CATEGORY_MIN_SCORES,
} from "../retriever.js";

function applyHotnessBlend(
  score: number,
  accessCount: number,
  lastAccessedAt: number,
): number {
  const retriever = createRetriever({} as any, {} as any, { hotnessWeight: 0.15 });
  retriever.setAccessTracker({} as any);
  const results = [{
    entry: {
      id: "hotness-test",
      text: "hotness test",
      vector: [],
      category: "events",
      scope: "test:hotness",
      importance: 0.5,
      timestamp: Date.now(),
      metadata: JSON.stringify({ accessCount, lastAccessedAt }),
    },
    score,
    sources: {},
  }];
  return (retriever as any).applyHotnessBlend(results)[0].score;
}

describe("computeHotnessScore", () => {
  it("returns 0 for zero accesses", () => {
    expect(computeHotnessScore(0, Date.now())).toBe(0);
  });

  it("returns positive score for accessed memories", () => {
    const score = computeHotnessScore(5, Date.now());
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("higher access count yields higher score", () => {
    const now = Date.now();
    const low = computeHotnessScore(1, now);
    const mid = computeHotnessScore(5, now);
    const high = computeHotnessScore(50, now);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it("recent access yields higher score than old access", () => {
    const now = Date.now();
    const recent = computeHotnessScore(5, now);
    const weekAgo = computeHotnessScore(5, now - 7 * 86_400_000);
    const monthAgo = computeHotnessScore(5, now - 30 * 86_400_000);
    expect(recent).toBeGreaterThan(weekAgo);
    expect(weekAgo).toBeGreaterThan(monthAgo);
  });

  it("decays to near-zero for very old accesses", () => {
    const score = computeHotnessScore(5, Date.now() - 365 * 86_400_000);
    expect(score).toBeLessThan(0.01);
  });

  it("caps at 1.0 even with extreme access counts", () => {
    const score = computeHotnessScore(10_000, Date.now());
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("respects custom decay rate", () => {
    const now = Date.now();
    const fast = computeHotnessScore(5, now - 7 * 86_400_000, 0.5);
    const slow = computeHotnessScore(5, now - 7 * 86_400_000, 0.01);
    expect(slow).toBeGreaterThan(fast);
  });
});

describe("parseAccessMetadata", () => {
  it("parses valid metadata", () => {
    const meta = JSON.stringify({ accessCount: 5, lastAccessedAt: 1234567890 });
    const result = parseAccessMetadata(meta);
    expect(result.accessCount).toBe(5);
    expect(result.lastAccessedAt).toBe(1234567890);
  });

  it("returns defaults for missing fields", () => {
    const result = parseAccessMetadata("{}");
    expect(result.accessCount).toBe(0);
    expect(result.lastAccessedAt).toBe(0);
  });

  it("handles undefined input", () => {
    const result = parseAccessMetadata(undefined);
    expect(result.accessCount).toBe(0);
    expect(result.lastAccessedAt).toBe(0);
  });

  it("handles malformed JSON", () => {
    const result = parseAccessMetadata("not-json");
    expect(result.accessCount).toBe(0);
    expect(result.lastAccessedAt).toBe(0);
  });
});

describe("applyHotnessBlend", () => {
  it("does not penalize a zero-access row", () => {
    expect(applyHotnessBlend(0.6, 0, 0)).toBe(0.6);
  });

  it("preserves the existing blend formula for an accessed row", () => {
    const futureAccess = Date.now() + 60_000;
    const hotness = computeHotnessScore(5, futureAccess);
    expect(applyHotnessBlend(0.6, 5, futureAccess)).toBeCloseTo(
      0.6 * 0.85 + hotness * 0.15,
      12,
    );
  });

  it("still applies the existing penalty when an accessed row's hotness decays to zero", () => {
    expect(computeHotnessScore(1, 1)).toBe(0);
    expect(applyHotnessBlend(0.6, 1, 1)).toBeCloseTo(0.6 * 0.85, 12);
  });
});

describe("cold-start hotness pipeline regression", () => {
  it("recalls a78ad478 without dropping control dd05b422", async () => {
    const query = "owner 模型 任务锁 并发 谁在干活 责任层 资源层";
    const now = Date.now();
    const text = `${query} `.repeat(80).slice(0, 1900);

    expect(text).toHaveLength(1900);

    function metadata(
      source: "agent" | "manual",
      confidence: number,
      accessCount: number,
    ): string {
      const lastAccessedAt = accessCount > 0 ? now : 0;

      return JSON.stringify({
        source,
        confidence: {
          score: confidence,
          reliability: source === "manual" ? "direct" : "inferred",
        },
        accessCount,
        lastAccessedAt,
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "patterns",
        },
        evolution: {
          status: "active",
          version: 1,
          accessCount,
          lastAccessedAt: accessCount > 0 ? lastAccessedAt : null,
          validFrom: now,
          validUntil: null,
        },
      });
    }

    const candidates = [
      {
        entry: {
          id: "a78ad478",
          text,
          vector: [1, 0, 0],
          category: "patterns",
          scope: "project:hippo-wiki",
          importance: 0.8,
          timestamp: now,
          metadata: metadata("agent", 0.7, 0),
        },
        score: 0.8628,
      },
      {
        entry: {
          id: "dd05b422",
          text,
          vector: [0.99, 0.01, 0],
          category: "patterns",
          scope: "project:hippo-wiki",
          importance: 0.8,
          timestamp: now,
          metadata: metadata("manual", 0.9, 4),
        },
        score: 0.8579,
      },
    ];

    let vectorSearchCalls = 0;

    const store = {
      hasFtsSupport: false,
      async vectorSearch(
        _queryVector: number[],
        limit: number,
        minScore: number,
        scopeFilter?: string[],
      ) {
        vectorSearchCalls += 1;
        return candidates
          .filter(candidate => candidate.score >= minScore)
          .filter(candidate =>
            !scopeFilter || scopeFilter.includes(candidate.entry.scope),
          )
          .slice(0, limit);
      },
    };

    const embedder = {
      async embedQuery() {
        return [1, 0, 0];
      },
      async embedPassage() {
        return [1, 0, 0];
      },
    };

    const retriever = createRetriever(
      store as any,
      embedder as any,
      {
        mode: "vector",
        rerank: "none",
        candidatePoolSize: 5,
        minScore: 0.3,
        hardMinScore: 0.38,
        recencyHalfLifeDays: 14,
        recencyWeight: 0.15,
        lengthNormAnchor: 700,
        timeDecayHalfLifeDays: 60,
        hotnessWeight: 0.15,
        filterNoise: false,
        enableRIF: false,
        sourceDiversity: 0,
        multiHop: false,
      },
    );

    retriever.setAccessTracker({
      computeEffectiveHalfLife(baseHalfLife: number) {
        return baseHalfLife;
      },
      recordAccess() {
        throw new Error("pipeline regression must not record access");
      },
    } as any);

    const trace = new TraceCollector();
    const results = await retriever.retrieve({
      query,
      limit: 5,
      scopeFilter: ["project:hippo-wiki"],
      category: "patterns",
      source: "auto-recall",
      trace,
    });

    const ids = results.map(result => result.entry.id);
    const cold = results.find(result => result.entry.id === "a78ad478");
    const hardMin = trace
      .finalize(query, "vector")
      .stages.find(stage => stage.name === "hard_min_score");

    expect(ids).toContain("a78ad478");
    expect(ids).toContain("dd05b422");
    expect(cold?.score).toBeGreaterThanOrEqual(
      DEFAULT_CATEGORY_MIN_SCORES.patterns,
    );
    expect(hardMin).toMatchObject({
      inputCount: 2,
      outputCount: 2,
      droppedCount: 0,
    });
    expect(vectorSearchCalls).toBe(1);
  });
});
