import { describe, expect, it, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDream, formatDreamResult, type DreamResult } from "../dream-pipeline.js";
import { isDerivedInsight } from "../consolidation-engine.js";
import type { MemoryEntry, MemoryStore } from "../store.js";
import type { LLMClient } from "../llm-client.js";
import type { Embedder } from "../embedder.js";
import { resetWriteCount } from "../activity-counter.js";

// Isolate the activity-counter (default path = <dataDir>/activity-stats.json) to a temp
// dir so these tests never read/write the repo's data/activity-stats.json that the
// production dream scheduler uses.
let __origDataDir: string | undefined;
beforeAll(() => {
  __origDataDir = process.env.RECALLNEST_DATA_DIR;
  process.env.RECALLNEST_DATA_DIR = mkdtempSync(join(tmpdir(), "rn-dp-datadir-"));
});
afterAll(() => {
  if (__origDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
  else process.env.RECALLNEST_DATA_DIR = __origDataDir;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "test memory",
    vector: [1, 0, 0, 0, 0],
    category: "events",
    scope: "project:test",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: JSON.stringify({
      evolution: {
        status: "active",
        version: 1,
        accessCount: 0,
        lastAccessedAt: null,
        supersededBy: null,
        consolidatedInto: null,
        contributedToPattern: null,
        sourceMemories: [],
        validFrom: Date.now(),
        validUntil: null,
      },
    }),
    ...overrides,
  };
}

function createMockStore(entries: MemoryEntry[]): MemoryStore {
  const stored: MemoryEntry[] = [...entries];
  let storeCounter = 0;

  return {
    // 忠实复刻生产行为：list() 恒返回 vector:[]（性能优化的假空数组）。
    // 旧 mock 直接返回带真向量的 stored，把「聚类消费者必须 getVectors 回填」
    // 这个坑遮了两年——promote_scan 与 dream 3b 都在生产栽过、单测全绿。
    async list() { return stored.map(e => ({ ...e, vector: [] as number[] })); },
    async getVectors(ids: string[]) {
      const m = new Map<string, number[]>();
      for (const id of ids) {
        const e = stored.find(x => x.id === id);
        if (e && e.vector?.length) m.set(id, e.vector);
      }
      return m;
    },
    async stats() {
      return {
        totalCount: stored.length,
        scopeCounts: {},
        categoryCounts: {},
      };
    },
    async store(entry: Partial<MemoryEntry>) {
      const full = {
        id: entry.id || `dream-${storeCounter++}`,
        text: entry.text || "",
        vector: entry.vector || [],
        category: entry.category || "events",
        scope: entry.scope || "project:test",
        importance: entry.importance || 0.5,
        timestamp: Date.now(),
        metadata: entry.metadata || "{}",
      } as MemoryEntry;
      stored.push(full);
      return full;
    },
    async update(id: string, upd: Partial<MemoryEntry>) {
      const entry = stored.find(e => e.id === id);
      if (entry && upd.metadata) entry.metadata = upd.metadata;
      return entry || { id, text: "", vector: [], category: "events", scope: "project:test", importance: 0.5, timestamp: Date.now(), metadata: "{}" } as MemoryEntry;
    },
    async getById(id: string) {
      return stored.find(e => e.id === id) || null;
    },
    // 模拟 store.patchMetadata 单写通道:读最新 metadata → patchFn → 写回。
    async patchMetadata(
      id: string,
      patchFn: (meta: Record<string, unknown>, entry: MemoryEntry) => Record<string, unknown>,
      _scopeFilter?: string[],
    ) {
      const entry = stored.find(e => e.id === id);
      if (!entry) return null;
      let meta: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(entry.metadata || "{}");
        meta = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        meta = {};
      }
      entry.metadata = JSON.stringify(patchFn(meta, entry));
      return entry;
    },
    async vectorSearch(_vec: number[], limit: number, _threshold: number, _scopes?: string[]) {
      return stored.slice(0, limit).map(e => ({ entry: e, score: 0.85 }));
    },
  } as unknown as MemoryStore;
}

function createMockLLM(): LLMClient {
  return {
    async generateL0() { return "consolidated insight"; },
    async extractPattern() { return "discovered pattern"; },
  } as unknown as LLMClient;
}

function createMockEmbedder(): Pick<Embedder, "embedPassage"> {
  return {
    async embedPassage() { return [0.5, 0.5, 0, 0, 0]; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDream", () => {
  beforeEach(() => {
    // Reset the activity counter for the test scope between tests (per-scope API).
    resetWriteCount("project:test");
  });

  it("skips when write count is below threshold", async () => {
    const store = createMockStore([makeEntry({ id: "a" })]);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      config: { minWritesForDream: 10 },
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toContain("insufficient_writes");
    expect(result.phases.length).toBe(1);
    expect(result.phases[0].phase).toBe("orient");
  });

  it("persists usageStatus snapshots during gather (P0 B-1, flag on)", async () => {
    process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL = "true";
    try {
    const coldMeta = JSON.stringify({
      accessCount: 8, // injection >= 6, useCount 0 -> cold
      evolution: { status: "active", version: 1 },
    });
    const entries = [
      makeEntry({ id: "cold-1", metadata: coldMeta }),
      makeEntry({ id: "fresh-1" }), // unused 默认态:不写快照,防全库写放大
    ];
    const store = createMockStore(entries);

    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    const cold = await store.getById("cold-1");
    expect(JSON.parse(cold!.metadata!).usage.usageStatus).toBe("cold");
    const fresh = await store.getById("fresh-1");
    expect(JSON.parse(fresh!.metadata!).usage).toBeUndefined();
    const gather = result.phases.find(p => p.phase === "gather");
    expect(gather!.detail).toContain("usage snapshot: 1");
    } finally {
      delete process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL;
    }
  });

  it("skips usageStatus snapshots when use signal is inactive (flag off)", async () => {
    delete process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL;
    const coldMeta = JSON.stringify({
      accessCount: 8,
      evolution: { status: "active", version: 1 },
    });
    const store = createMockStore([makeEntry({ id: "cold-1", metadata: coldMeta })]);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });
    expect(result.ran).toBe(true);
    const cold = await store.getById("cold-1");
    expect(JSON.parse(cold!.metadata!).usage).toBeUndefined();
    const gather = result.phases.find(p => p.phase === "gather");
    expect(gather!.detail).not.toContain("usage snapshot");
  });

  it("runs when forced despite low write count", async () => {
    const entries = [
      makeEntry({ id: "a", vector: [0.9, 0.1, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [0.88, 0.12, 0, 0, 0] }),
      makeEntry({ id: "c", vector: [0.92, 0.08, 0, 0, 0] }),
    ];
    const store = createMockStore(entries);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    expect(result.phases.length).toBe(4);
    expect(result.phases.map(p => p.phase)).toEqual(["orient", "gather", "consolidate", "prune"]);
  });

  it("completes early with too few active entries", async () => {
    const store = createMockStore([
      makeEntry({ id: "a" }),
    ]);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
      config: { minClusterSize: 3 },
    });

    expect(result.ran).toBe(true);
    expect(result.reason).toBe("completed_early");
  });

  it("works without LLM (null) — only deterministic consolidation", async () => {
    const entries = [
      makeEntry({ id: "a", vector: [0.9, 0.1, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [0.88, 0.12, 0, 0, 0] }),
      makeEntry({ id: "c", vector: [0.92, 0.08, 0, 0, 0] }),
    ];
    const store = createMockStore(entries);
    const result = await runDream({
      store,
      llm: null,
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    expect(result.stats.insightsGenerated).toBe(0); // No LLM = no insights
    expect(result.stats.patternsExtracted).toBe(0);
  });

  it("reports correct stats structure", async () => {
    const entries = [
      makeEntry({ id: "a", vector: [0.9, 0.1, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [0.88, 0.12, 0, 0, 0] }),
      makeEntry({ id: "c", vector: [0.92, 0.08, 0, 0, 0] }),
    ];
    const store = createMockStore(entries);
    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.stats.totalMemories).toBeGreaterThanOrEqual(0);
    expect(result.stats.activeMemories).toBeGreaterThanOrEqual(0);
    expect(typeof result.stats.clustersFound).toBe("number");
    expect(typeof result.stats.insightsGenerated).toBe("number");
    expect(typeof result.stats.patternsExtracted).toBe("number");
    expect(typeof result.stats.mergedCount).toBe("number");
    expect(typeof result.stats.archivedCount).toBe("number");
  });

  it("excludes its own derivatives from the gather, so insights are not re-consolidated", async () => {
    const derivedMeta = (flag: "cluster_insight" | "cross_memory_pattern") => JSON.stringify({
      evolution: { status: "active", version: 1, sourceMemories: ["real-1", "real-2"] },
      [flag]: true,
    });

    const store = createMockStore([
      makeEntry({ id: "real-1" }),
      makeEntry({ id: "real-2" }),
      makeEntry({ id: "insight-1", metadata: derivedMeta("cluster_insight") }),
      makeEntry({ id: "pattern-1", metadata: derivedMeta("cross_memory_pattern") }),
    ]);

    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);
    // All four stay visible to stats and usage observation...
    expect(result.stats.activeMemories).toBe(4);
    // ...but the insight and the pattern are derivatives of the other two and
    // must not feed the next round of consolidation.
    const gather = result.phases.find(p => p.phase === "gather");
    expect(gather!.detail).toContain("4 active entries gathered from 4 total");
    expect(gather!.detail).toContain("2 derivatives held back from consolidation");
  });

  it("does not hold anything back when there are no derivatives", async () => {
    // Guard against the exclusion being too greedy: the metadata flags are what
    // matter, not the words. A memory that merely talks about insights stays in.
    const store = createMockStore([
      makeEntry({ id: "real-1", text: "a note about cluster_insight and patterns" }),
      makeEntry({ id: "real-2" }),
    ]);

    const result = await runDream({
      store,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.stats.activeMemories).toBe(2);
    const gather = result.phases.find(p => p.phase === "gather");
    expect(gather!.detail).not.toContain("held back");
  });
});

describe("isDerivedInsight", () => {
  it("flags cluster insights and cross-memory patterns", () => {
    expect(isDerivedInsight(JSON.stringify({ cluster_insight: true }))).toBe(true);
    expect(isDerivedInsight(JSON.stringify({ cross_memory_pattern: true }))).toBe(true);
  });

  it("leaves ordinary memories alone", () => {
    expect(isDerivedInsight(JSON.stringify({ evolution: { status: "active" } }))).toBe(false);
    expect(isDerivedInsight(JSON.stringify({ cluster_insight: false }))).toBe(false);
    expect(isDerivedInsight("{}")).toBe(false);
  });

  it("treats missing or malformed metadata as not derived", () => {
    expect(isDerivedInsight(undefined)).toBe(false);
    expect(isDerivedInsight("{ not json")).toBe(false);
  });
});

describe("formatDreamResult", () => {
  it("formats skipped dream", () => {
    const result: DreamResult = {
      ran: false,
      reason: "insufficient_writes (3/10)",
      phases: [{ phase: "orient", detail: "50 memories, 3 writes" }],
      stats: { totalMemories: 50, activeMemories: 0, writesSinceLastDream: 3, clustersFound: 0, dedupeClustersFound: 0, semanticClustersFound: 0, insightsGenerated: 0, patternsExtracted: 0, mergedCount: 0, archivedCount: 0 },
    };
    const output = formatDreamResult(result);
    expect(output).toContain("skipped");
    expect(output).toContain("insufficient_writes");
  });

  it("formats completed dream with all phases", () => {
    const result: DreamResult = {
      ran: true,
      phases: [
        { phase: "orient", detail: "100 memories, 15 writes" },
        { phase: "gather", detail: "80 active entries" },
        { phase: "consolidate", detail: "3 clusters, 1 merged, 2 insights, 1 pattern" },
        { phase: "prune", detail: "5 entries archived" },
      ],
      stats: { totalMemories: 100, activeMemories: 80, writesSinceLastDream: 15, clustersFound: 3, dedupeClustersFound: 2, semanticClustersFound: 1, insightsGenerated: 2, patternsExtracted: 1, mergedCount: 1, archivedCount: 5 },
    };
    const output = formatDreamResult(result);
    expect(output).toContain("Dream completed");
    expect(output).toContain("[orient]");
    expect(output).toContain("[consolidate]");
    expect(output).toContain("[prune]");
    expect(output).toContain("Patterns: 1");
    // 总数仍在，但两条路径要能分辨
    expect(output).toContain("Clusters: 3 (dedupe 2 + semantic 1)");
  });

  it("区分「语义聚类一个都没凑出来」和「凑出来了但没产出 insight」", () => {
    // 这两种情况在合并成一个 clusters 数字时长得一模一样，但含义完全相反：
    // 前者是门槛太高压根没调 LLM，后者是调了 LLM 但没拿到结果。
    // 2026-07 排查 insight 长期零产出时，正是被合并后的数字带偏了方向。
    const base = {
      ran: true as const,
      phases: [],
      stats: {
        totalMemories: 40, activeMemories: 40, writesSinceLastDream: 40,
        insightsGenerated: 0, patternsExtracted: 0, mergedCount: 1, archivedCount: 0,
      },
    };

    // A：dedupe 找到 2 个并合了 1 个，语义聚类一个合格簇都没有 —— LLM 根本没被调用
    const noSemanticCluster: DreamResult = {
      ...base,
      stats: { ...base.stats, clustersFound: 2, dedupeClustersFound: 2, semanticClustersFound: 0 },
    };
    // B：语义聚类找到 2 个合格簇，却一条 insight 都没产出 —— 问题在 LLM 那一侧
    const llmYieldedNothing: DreamResult = {
      ...base,
      stats: { ...base.stats, clustersFound: 2, dedupeClustersFound: 0, semanticClustersFound: 2 },
    };

    expect(formatDreamResult(noSemanticCluster)).toContain("semantic 0");
    expect(formatDreamResult(llmYieldedNothing)).toContain("semantic 2");
    // 两者的 clustersFound 相同，仅凭它无法区分——这正是拆开的理由
    expect(noSemanticCluster.stats.clustersFound).toBe(llmYieldedNothing.stats.clustersFound);
    expect(formatDreamResult(noSemanticCluster)).not.toBe(formatDreamResult(llmYieldedNothing));
  });
});

// ---------------------------------------------------------------------------
// semanticClusterThreshold（2026-07-23 零 insight 根因修复）
// ---------------------------------------------------------------------------

import { DEFAULT_DREAM_CONFIG } from "../dream-pipeline.js";

describe("semanticClusterThreshold default", () => {
  it("is an independent config at 0.68 (not clusterThreshold - 0.07)", () => {
    // 三 scope 真实数据造影：相似度 p99≈0.74，旧 offset 值 0.75 卡在 p99 之上
    // → semantic 簇恒 0、2716 次运行零 insight。0.68 落在实测甜点区。
    expect(DEFAULT_DREAM_CONFIG.semanticClusterThreshold).toBe(0.68);
    expect(DEFAULT_DREAM_CONFIG.semanticClusterThreshold).toBeLessThan(
      DEFAULT_DREAM_CONFIG.clusterThreshold,
    );
  });
});

// ---------------------------------------------------------------------------
// --auto 失败分诊 + wall-clock 预算（2026-07-29 dream blocked 根因修复）
// ---------------------------------------------------------------------------

import { classifyDreamFailure, shouldBlockDreamRun, DREAM_TRANSIENT_BLOCK_RATIO } from "../dream-pipeline.js";

describe("classifyDreamFailure", () => {
  // 下面三条都是 dream-consolidation-launchd.log 里的生产原文，不是构造的样本。
  it("treats the store-write lock contention as transient", () => {
    expect(
      classifyDreamFailure(
        `Failed to store memory in "/Users/x/recallnest/data/lancedb":  lock 'store-write' timed out after 10000ms (held by another process)`,
      ),
    ).toBe("transient");
  });

  it("treats the LLM abort as transient", () => {
    // llm-client.ts:757 的 15s AbortController 超时
    expect(classifyDreamFailure("Request was aborted.")).toBe("transient");
  });

  it("treats the null-vector TypeError as fatal", () => {
    // 07-18~07-23 的真凶（store.ts 病行，d1a2a9c 已修）。这类必须一票否决——
    // 判成 transient 会让代码缺陷被静默。
    expect(
      classifyDreamFailure("Array.from requires an array-like object - not null or undefined"),
    ).toBe("fatal");
  });

  it("defaults unknown errors to fatal rather than silencing them", () => {
    expect(classifyDreamFailure("something nobody has seen before")).toBe("fatal");
    expect(classifyDreamFailure("")).toBe("fatal");
  });

  it("does not classify on scope ids that merely contain digits", () => {
    // 回归：4 天 15 小时那次的根因是 shell 层在整个输出（含全部 hex scope id）上 grep
    // "403"，被 cc:44036269 假命中。分类器只看错误消息，绝不能被 id 里的数字带跑。
    expect(classifyDreamFailure("[scope=cc:44036269] unexpected failure")).toBe("fatal");
  });
});

describe("shouldBlockDreamRun", () => {
  it("blocks on any fatal failure", () => {
    expect(shouldBlockDreamRun({ totalScopes: 475, fatalFailures: 1, transientFailures: 0 })).toBe(true);
  });

  it("does not block on a handful of transient failures", () => {
    // 旧语义下这就是「475 个里 1 个撞锁 → 整轮红 → 脚本重试 → 重跑全量」的起点。
    expect(shouldBlockDreamRun({ totalScopes: 475, fatalFailures: 0, transientFailures: 5 })).toBe(false);
  });

  it("still blocks when transient failures are widespread", () => {
    // 全被锁挡住不能判假绿。
    const over = Math.ceil(475 * DREAM_TRANSIENT_BLOCK_RATIO) + 1;
    expect(shouldBlockDreamRun({ totalScopes: 475, fatalFailures: 0, transientFailures: over })).toBe(true);
  });

  it("is clean when nothing failed, and safe on an empty sweep", () => {
    expect(shouldBlockDreamRun({ totalScopes: 475, fatalFailures: 0, transientFailures: 0 })).toBe(false);
    expect(shouldBlockDreamRun({ totalScopes: 0, fatalFailures: 0, transientFailures: 0 })).toBe(false);
  });
});

describe("autoRunBudgetMs default", () => {
  it("caps one --auto sweep well below a day", () => {
    // 07-24 那轮 4 天 15 小时，堵死三天调度。预算是防跨天的兜底闸。
    expect(DEFAULT_DREAM_CONFIG.autoRunBudgetMs).toBe(6 * 60 * 60 * 1000);
    expect(DEFAULT_DREAM_CONFIG.autoRunBudgetMs).toBeLessThan(24 * 60 * 60 * 1000);
  });
});
