import { describe, expect, it } from "bun:test";

import { createRetriever } from "../retriever.js";

/**
 * 回归：retrieve() 在分派前必须等 store 完成惰性初始化。
 *
 * 真实 MemoryStore 的 hasFtsSupport 在 ensureInitialized() 跑完前恒为 false
 * （ftsIndexCreated 初值 false，建索引发生在 doInitialize 里）。retriever.ts 的
 * 分派条件是 `mode === "vector" || !this.store.hasFtsSupport`，若不先 await
 * store.ready()，hybrid 模式的**首次**检索会读到初始化前的 false 并静默落回
 * vector 路径——同一实例第二次才正常。
 *
 * 该缺陷自 c10607a（2026-03-03 初始版本）就在，长期未暴露：生产 mode 一直是
 * "vector"，第一个条件短路；而 eval 每 case 新建组件，每个 case 都停在"首次"，
 * 于是 eval 从未测到过 hybrid 路径。
 *
 * 下面的 fake store 用 getter + ready() 精确复现这个时序：不修复则 bm25Search
 * 不会被调用。
 */
function buildResult(id: string, text: string) {
  return {
    entry: {
      id,
      text,
      vector: [1, 0, 0],
      category: "preferences",
      scope: "memory:test",
      importance: 0.8,
      timestamp: Date.parse("2026-08-07T00:00:00.000Z"),
      metadata: JSON.stringify({}),
    },
    score: 0.8,
  };
}

const fakeEmbedder = {
  async embedQuery() {
    return [1, 0, 0];
  },
  async embedPassage() {
    return [1, 0, 0];
  },
} as any;

function buildLazyStore() {
  const calls = { bm25: 0, vector: 0, ready: 0 };
  let initialized = false;

  const store = {
    // 复现真实时序：初始化完成前恒 false
    get hasFtsSupport() {
      return initialized;
    },
    async ready() {
      calls.ready += 1;
      initialized = true;
    },
    async vectorSearch() {
      calls.vector += 1;
      return [buildResult("vec-1", "vector hit")];
    },
    async bm25Search() {
      calls.bm25 += 1;
      return [buildResult("bm25-1", "bm25 hit")];
    },
  };

  return { store, calls };
}

const LOOSE_CONFIG = {
  rerank: "none" as const,
  filterNoise: false,
  hardMinScore: 0,
  minScore: 0,
  recencyWeight: 0,
  timeDecayHalfLifeDays: 0,
};

describe("retrieve() 分派与 store 惰性初始化的时序", () => {
  it("hybrid 模式的首次检索不因惰性初始化落回 vector 路径", async () => {
    const { store, calls } = buildLazyStore();
    const retriever = createRetriever(store as any, fakeEmbedder, {
      ...LOOSE_CONFIG,
      mode: "hybrid",
    });

    await retriever.retrieve({ query: "双机契约 同步", limit: 5 });

    // 修复前：hasFtsSupport 读到初始化前的 false → 落回 vectorOnly → bm25 为 0。
    expect(calls.ready).toBeGreaterThan(0);
    expect(calls.bm25).toBeGreaterThan(0);
  });

  it("vector 模式不受影响——短路在第一个条件，不走 BM25", async () => {
    const { store, calls } = buildLazyStore();
    const retriever = createRetriever(store as any, fakeEmbedder, {
      ...LOOSE_CONFIG,
      mode: "vector",
    });

    await retriever.retrieve({ query: "双机契约 同步", limit: 5 });

    // 这条守的是"修复不得改变生产行为"：生产 mode 就是 vector。
    expect(calls.bm25).toBe(0);
    expect(calls.vector).toBeGreaterThan(0);
  });

  it("琐碎 query 走 skip 分支时不触发初始化", async () => {
    const { store, calls } = buildLazyStore();
    const retriever = createRetriever(store as any, fakeEmbedder, {
      ...LOOSE_CONFIG,
      mode: "hybrid",
    });

    // shouldSkipRetrieval 在分派之前提前 return，await ready() 不该被执行到。
    await retriever.retrieve({ query: "ok", limit: 5 });

    expect(calls.ready).toBe(0);
    expect(calls.vector).toBe(0);
  });
});
