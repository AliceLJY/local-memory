import { describe, expect, it } from "bun:test";

import { createRetriever, type RetrievalResultSet } from "../retriever.js";

// P-omitted: 验证召回因 limit 上限截断时，对调用方暴露 omitted（提高 limit 可见）。
// 借鉴 RepoPrompt CE「剪枝必回报」——召回从黑箱变可协商。

function buildCandidate(id: string, score: number) {
  return {
    entry: {
      id,
      text: `distinct memory content number ${id}`,
      vector: [1, 0, 0],
      category: "preferences",
      scope: "memory:agent",
      importance: 0.8,
      timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
      metadata: JSON.stringify({}),
    },
    score,
  };
}

// 最小过滤 config：mode=vector 跳过 BM25/rerank；minScore/hardMinScore=0 + 高分候选避免 hard-min 截断；
// filterNoise=false；RIF/sourceDiversity 字段缺省即不启用；MMR 只重排不删。
// 于是过滤链净效果 = sort → slice(limit)，omitted = candidates - limit 可精确断言。
function makeRetriever(
  candidates: ReturnType<typeof buildCandidate>[],
  configOverride: Record<string, unknown> = {},
) {
  return createRetriever({
    hasFtsSupport: false,
    // 模拟真实 MemoryStore.vectorSearch：尊重 k 参数（按 k 截断返回）。
    // 这样测试能真实反映 over-fetch 是否生效——若 vector-only 不 over-fetch、只取 limit 条，
    // 候选池 ≤ limit、omitted 必为 0，下面断言会失败（Codex review 暴露的假绿点）。
    async vectorSearch(_vec: number[], k: number) { return candidates.slice(0, k); },
  } as any, {
    async embedQuery() { return [1, 0, 0]; },
    async embedPassage() { return [1, 0, 0]; },
  } as any, {
    mode: "vector",
    rerank: "none",
    filterNoise: false,
    hardMinScore: 0,
    minScore: 0,
    recencyWeight: 0,
    timeDecayHalfLifeDays: 0,
    ...configOverride,
  });
}

describe("retrieval omitted reporting (P-omitted)", () => {
  it("reports omitted count + reason when candidates exceed limit", async () => {
    const candidates = Array.from({ length: 8 }, (_, i) => buildCandidate(`m${i}`, 0.9 - i * 0.01));
    const retriever = makeRetriever(candidates);

    const results = await retriever.retrieve({ query: "user reply style preference detail", limit: 3, category: "preferences" }) as RetrievalResultSet;

    expect(results).toHaveLength(3);
    expect(results.omitted).toBeDefined();
    expect(results.omitted?.count).toBe(5); // 8 candidates - limit 3
    expect(results.omitted?.reason).toBe("limit");
  });

  it("leaves omitted undefined when candidates fit within limit", async () => {
    const candidates = Array.from({ length: 2 }, (_, i) => buildCandidate(`m${i}`, 0.9 - i * 0.01));
    const retriever = makeRetriever(candidates);

    const results = await retriever.retrieve({ query: "user reply style preference detail", limit: 5, category: "preferences" }) as RetrievalResultSet;

    expect(results).toHaveLength(2);
    expect(results.omitted).toBeUndefined();
  });

  it("persists omitted through the validity filter (regression: array is rebuilt downstream)", async () => {
    // retrieve() runs filterByValidity which returns a NEW array, dropping any
    // property hung on the result array. omitted must survive via the resultSet snapshot.
    const candidates = Array.from({ length: 6 }, (_, i) => buildCandidate(`m${i}`, 0.9 - i * 0.01));
    const retriever = makeRetriever(candidates);

    const results = await retriever.retrieve({ query: "user reply style preference detail", limit: 2, category: "preferences" }) as RetrievalResultSet;

    expect(results).toHaveLength(2);
    expect(results.omitted?.count).toBe(4); // 6 - 2
  });

  it("reports omitted even when sourceDiversity caps the diversified pool (P3-1)", async () => {
    // 启用 sourceDiversity 时 applySourceDiversity 先把 diversified 压到 limit；
    // omitted 必须从 source-diversity 之前的候选池(clusterDeduped)算，否则恒为 0（Codex 复审 P3-1）。
    const candidates = Array.from({ length: 8 }, (_, i) => buildCandidate(`m${i}`, 0.9 - i * 0.01));
    const retriever = makeRetriever(candidates, { sourceDiversity: 0.5 });

    const results = await retriever.retrieve({ query: "user reply style preference detail", limit: 3, category: "preferences" }) as RetrievalResultSet;

    expect(results).toHaveLength(3);
    expect(results.omitted?.count).toBe(5); // 8 - 3，即使 source diversity 压缩了 diversified
  });
});
