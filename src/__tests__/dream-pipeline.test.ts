import { describe, expect, it, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDream, formatDreamResult, formatDreamMetrics, assertDreamSweepHealth, classifyDreamOutput, countDreamEffects,
  type DreamResult,
} from "../dream-pipeline.js";
import { isDerivedInsight } from "../consolidation-engine.js";
import type { MemoryEntry, MemoryStore } from "../store.js";
import type { LLMClient } from "../llm-client.js";
import type { Embedder } from "../embedder.js";
import { resetWriteCount, incrementWriteCount, getWriteCount, listScopesAboveThreshold } from "../activity-counter.js";

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
    async repairSingletonVersionGroups() { return 0; },
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
    // 2026-08-14 批量通道：语义同上面的单条 patchMetadata，按序逐条以最新行起底
    async patchMetadataBatch(
      patches: Array<{ id: string; patchFn: (meta: Record<string, unknown>, entry: MemoryEntry) => Record<string, unknown> }>,
      _scopeFilter?: string[],
    ) {
      let written = 0;
      for (const { id, patchFn } of patches) {
        const entry = stored.find(e => e.id === id);
        if (!entry) continue;
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
        written++;
      }
      return written;
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

  // 2026-08-12 回归：dream 完整跑完后必须清掉该 scope 的写计数，否则它永远留在
  // listScopesAboveThreshold 的队列里 —— 每轮从头重扫同一批最老的 scope，
  // 6h 预算耗尽后排在后面的永远轮不到（生产日志：已处理 167/563，剩余 396 跳过）。
  // 根因：dream-pipeline.ts 末尾 resetWriteCount() 漏传 scope，运行时 delete stats.scopes[undefined]，
  // 目标计数纹丝不动；早退路径 (:226) 传对了。源于 d269159（2026-07-02 per-scope 写计数重构）漏改一处，
  // 该 commit message 自己写着「reset 在末尾清该 scope」——意图对、实现漏，活了 41 天。
  // 由 codex + kimi 双路独立冷读查出（2026-08-12），互相隔离、收敛到同一行。
  it("清空已处理 scope 的写计数，使它退出 dream 队列", async () => {
    const statsPath = join(mkdtempSync(join(tmpdir(), "dream-reset-")), "activity-stats.json");
    const statsCfg = { statsPath };

    incrementWriteCount("project:test", 12, statsCfg);
    expect(getWriteCount("project:test", statsCfg)).toBe(12);
    expect(listScopesAboveThreshold(10, statsCfg)).toEqual(["project:test"]);

    const entries = [
      makeEntry({ id: "a", vector: [0.9, 0.1, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [0.88, 0.12, 0, 0, 0] }),
      makeEntry({ id: "c", vector: [0.92, 0.08, 0, 0, 0] }),
    ];
    const result = await runDream({
      store: createMockStore(entries),
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      activityStatsPath: statsPath,
    });

    // 走的是完整路径（不是 too-few-entries 早退），早退路径本来就传对了参数
    expect(result.ran).toBe(true);
    expect(result.reason).toBeUndefined();

    expect(getWriteCount("project:test", statsCfg)).toBe(0);
    expect(listScopesAboveThreshold(10, statsCfg)).toEqual([]);
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

// ---------------------------------------------------------------------------
// P1（2026-08-12）：产出断言 —— 让 ok 只表示「确有副作用」
// ---------------------------------------------------------------------------

describe("dream 产出断言", () => {
  beforeEach(() => {
    resetWriteCount("project:test");
  });

  // 必红端到端：精确复现 2026-07-23 第二真凶的形状（store.list() 恒返回假空向量，
  // getVectors 回填也拿不到东西 → 84/84 全被 clusterAndConsolidate 的
  // `vector?.length > 0` 滤光 → semantic 簇恒 0 → LLM 从未被调 → 2716 次零 insight）。
  // 在加 output 之前，这个场景返回的是一个看起来完全正常的成功结果 ——
  // 这条测试就是把「跑完了」和「做成了」分开的那道断言。
  it("向量管线断裂时不报成功，而是 noop + vector_pipeline_empty", async () => {
    const entries = [
      makeEntry({ id: "a", vector: [0.9, 0.1, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [0.88, 0.12, 0, 0, 0] }),
      makeEntry({ id: "c", vector: [0.92, 0.08, 0, 0, 0] }),
    ];
    const healthy = createMockStore(entries);
    // 唯一的改动：getVectors 返回空 Map（向量管线断裂），其余一切正常
    const broken = { ...healthy, getVectors: async () => new Map<string, number[]>() };

    const result = await runDream({
      store: broken as unknown as MemoryStore,
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.ran).toBe(true);              // 没崩 —— 这正是它以前能蒙混过关的原因
    expect(result.stats.consolidatableCount).toBeGreaterThan(0);
    expect(result.stats.semanticVectorFed).toBe(0);
    // 注意断的是 degraded 而不是 kind：3a 确定性去重不需要向量，它照样合并、照样
    // 产出副作用，effects > 0 会把 kind 顶成 produced —— 这条测试第一次跑时正是这样
    // 红的，暴露出「一条路径的产出会掩盖另一条路径的断裂」，degraded 字段因此单列。
    expect(result.output.degraded).toBe("vector_pipeline_empty");
    expect(formatDreamResult(result)).toContain("DEGRADED");
  });

  it("向量管线正常时，同一批数据报 produced", async () => {
    const entries = [
      makeEntry({ id: "a", vector: [0.9, 0.1, 0, 0, 0] }),
      makeEntry({ id: "b", vector: [0.88, 0.12, 0, 0, 0] }),
      makeEntry({ id: "c", vector: [0.92, 0.08, 0, 0, 0] }),
    ];
    const result = await runDream({
      store: createMockStore(entries),
      llm: createMockLLM(),
      embedder: createMockEmbedder(),
      scope: "project:test",
      force: true,
    });

    expect(result.stats.semanticVectorFed).toBe(result.stats.consolidatableCount);
    expect(result.output.effectsWritten).toBeGreaterThan(0);
    expect(result.output.kind).toBe("produced");
    expect(result.output.degraded).toBeUndefined();
  });
});

describe("assertDreamSweepHealth", () => {
  it("没配 LLM = 结构性故障（3b 整段不跑，insight 恒为 0）", () => {
    expect(assertDreamSweepHealth({ llmPresent: false, consolidatable: 10, vectorFed: 10 }))
      .toEqual({ healthy: false, reason: "no_llm_configured" });
  });

  it("有素材可聚却一条带向量的都没有 = 向量管线断了", () => {
    expect(assertDreamSweepHealth({ llmPresent: true, consolidatable: 84, vectorFed: 0 }))
      .toEqual({ healthy: false, reason: "vector_pipeline_empty" });
  });

  it("素材本来就是 0 时不算故障（合法空转，不是断裂）", () => {
    expect(assertDreamSweepHealth({ llmPresent: true, consolidatable: 0, vectorFed: 0 }))
      .toEqual({ healthy: true });
  });

  it("不拿 insight 数量做判据 —— 那会是第三个阈值陷阱", () => {
    // 有素材、向量齐、LLM 在位，但一条 insight 都没产出：数据真不成簇时这是合法的，
    // 必须判 healthy。若这里返回 unhealthy，就等于偷偷设了「insight ≥ 1」的下限。
    expect(assertDreamSweepHealth({ llmPresent: true, consolidatable: 40, vectorFed: 40 }))
      .toEqual({ healthy: true });
  });
});

describe("classifyDreamOutput", () => {
  const healthy = { healthy: true } as const;

  it("硬不变量：produced <=> effects > 0", () => {
    expect(classifyDreamOutput({ consolidateRan: true, effects: 3, health: healthy }).kind).toBe("produced");
    expect(classifyDreamOutput({ consolidateRan: true, effects: 0, health: healthy }).kind).toBe("noop");
  });

  it("健康的零产出叫 no_qualified_work（合法，不是失败）", () => {
    expect(classifyDreamOutput({ consolidateRan: true, effects: 0, health: healthy }))
      .toEqual({ kind: "noop", reason: "no_qualified_work", effectsWritten: 0 });
  });

  it("不健康的零产出带出具体故障原因", () => {
    expect(classifyDreamOutput({
      consolidateRan: true, effects: 0,
      health: { healthy: false, reason: "vector_pipeline_empty" },
    }).reason).toBe("vector_pipeline_empty");
  });

  it("有产出也可以是 degraded —— 3a 的产出不许掩盖 3b 的断裂", () => {
    const out = classifyDreamOutput({
      consolidateRan: true, effects: 5,
      health: { healthy: false, reason: "vector_pipeline_empty" },
    });
    expect(out.kind).toBe("produced");            // 确实写入了东西，不撒谎
    expect(out.degraded).toBe("vector_pipeline_empty");  // 但语义路径整段断了
  });

  it("必经阶段没跑 = partial，不能混进 noop", () => {
    // partial 同时是「不要清写计数」的信号：这个 scope 并没有被真正处理完。
    expect(classifyDreamOutput({ consolidateRan: false, effects: 0, health: healthy }))
      .toEqual({ kind: "partial", reason: "consolidate_lock_held", effectsWritten: 0 });
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
      output: { kind: "skipped", reason: "insufficient_writes", effectsWritten: 0 },
      phases: [{ phase: "orient", detail: "50 memories, 3 writes" }],
      stats: { totalMemories: 50, activeMemories: 0, writesSinceLastDream: 3, clustersFound: 0, dedupeClustersFound: 0, semanticClustersFound: 0, insightsGenerated: 0, patternsExtracted: 0, mergedCount: 0, archivedCount: 0, relationsAdded: 0, consolidatableCount: 0, semanticVectorFed: 0 },
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
      output: { kind: "produced", effectsWritten: 9 },
      stats: { totalMemories: 100, activeMemories: 80, writesSinceLastDream: 15, clustersFound: 3, dedupeClustersFound: 2, semanticClustersFound: 1, insightsGenerated: 2, patternsExtracted: 1, mergedCount: 1, archivedCount: 5, relationsAdded: 0, consolidatableCount: 80, semanticVectorFed: 80 },
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
      output: { kind: "produced" as const, effectsWritten: 1 },
      stats: {
        totalMemories: 40, activeMemories: 40, writesSinceLastDream: 40,
        insightsGenerated: 0, patternsExtracted: 0, mergedCount: 1, archivedCount: 0,
        relationsAdded: 0, consolidatableCount: 40, semanticVectorFed: 40,
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

import { classifyDreamFailure, shouldBlockDreamRun, DREAM_TRANSIENT_BLOCK_RATIO, partitionAutoDreamScopes } from "../dream-pipeline.js";

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

  // 2026-08-14: transcript 出队后队列缩到个位数，1/1 = 100% > 20% 曾把单个瞬态锁竞争
  // 判成整轮红（当天验证轮实测）。绝对量豁免：transient ≤ 2 不算「成规模」。
  it("小队列豁免：个位数队列里 1-2 个瞬态失败不判 blocked", () => {
    expect(shouldBlockDreamRun({ totalScopes: 1, fatalFailures: 0, transientFailures: 1 })).toBe(false);
    expect(shouldBlockDreamRun({ totalScopes: 2, fatalFailures: 0, transientFailures: 2 })).toBe(false);
    expect(shouldBlockDreamRun({ totalScopes: 3, fatalFailures: 0, transientFailures: 2 })).toBe(false);
  });

  it("小队列豁免不放过 fatal，也不放过超出绝对量的比例失败", () => {
    expect(shouldBlockDreamRun({ totalScopes: 1, fatalFailures: 1, transientFailures: 0 })).toBe(true);
    // 3 个 transient 超出绝对豁免（2），且 3/5 = 60% > 20% → 该红还是红
    expect(shouldBlockDreamRun({ totalScopes: 5, fatalFailures: 0, transientFailures: 3 })).toBe(true);
  });
});

describe("autoRunBudgetMs default", () => {
  it("caps one --auto sweep well below a day", () => {
    // 07-24 那轮 4 天 15 小时，堵死三天调度。预算是防跨天的兜底闸。
    // 2026-08-14: 6h→2h —— transcript 出队后 inline 队列只剩个位数 durable scope，
    // 典型轮次分钟级，2h 是纯兜底（单 scope 路径不走本预算）。
    expect(DEFAULT_DREAM_CONFIG.autoRunBudgetMs).toBe(2 * 60 * 60 * 1000);
    expect(DEFAULT_DREAM_CONFIG.autoRunBudgetMs).toBeLessThan(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 巨型 scope 移交专用 schedule（2026-07-30 预算被单个 scope 吃光的修复）
// ---------------------------------------------------------------------------

describe("autoExcludeScopes / partitionAutoDreamScopes", () => {
  it("hands memory off by default", () => {
    // 07-30 实测：6h 的 --auto 只跑完 15/507，而 memory 一个 scope 占 3075/3891 条（79%）。
    // 它留在日常轮次里，等于每天拿整个预算巩固同一个 scope，靠后的 492 个永远排不到。
    expect(DEFAULT_DREAM_CONFIG.autoExcludeScopes).toContain("memory");
  });

  it("splits the sweep list without reordering either side", () => {
    // 顺序必须原样保留：调用方靠列表顺序决定谁先跑，排序策略不该藏在这个函数里。
    const { run, deferred } = partitionAutoDreamScopes(
      ["cc:82a919ea", "cc:f23f3893", "memory", "global", "cc:b11f3d48"],
      ["memory"],
    );
    expect(run).toEqual(["cc:82a919ea", "cc:f23f3893", "global", "cc:b11f3d48"]);
    expect(deferred).toEqual(["memory"]);
  });

  it("matches exactly, never by prefix", () => {
    // 前缀规则会顺手吞掉将来的 memory-* / memory:* scope —— 那是静默失效：它们既不在
    // 日常轮次里跑，也没有专用 job 负责，谁都不会发现。
    const { run, deferred } = partitionAutoDreamScopes(
      ["memory", "memory-archive", "memory:cc", "cc:memory"],
      ["memory"],
    );
    expect(deferred).toEqual(["memory"]);
    expect(run).toEqual(["memory-archive", "memory:cc", "cc:memory"]);
  });

  it("is a no-op when nothing is excluded", () => {
    const scopes = ["cc:aaa", "global"];
    const { run, deferred } = partitionAutoDreamScopes(scopes, []);
    expect(run).toEqual(scopes);
    expect(deferred).toEqual([]);
  });

  it("can defer every eligible scope, which is not the same as an empty sweep", () => {
    // cli.ts 靠 eligible.length 区分「真没人达标」和「达标的全被挪走了」——两种空混成
    // 一句话，排障会从第一步就跑偏。
    const { run, deferred } = partitionAutoDreamScopes(["memory"], ["memory"]);
    expect(run).toEqual([]);
    expect(deferred).toEqual(["memory"]);
  });
});

describe("formatDreamMetrics", () => {
  // 这行有个进程外消费者：dream-consolidation.sh 的存在性闸按字面量匹配
  // `[[DREAM_METRICS]]`，报了 ok 却没有它就判整轮失败。所以格式本身要锁住。
  it("产出的前缀必须是 shell 闸认的字面量", () => {
    const line = formatDreamMetrics({
      tally: { produced: 0, noop: 0, partial: 0, skipped: 0 },
      degraded: 0, effects: 0, processed: 0, total: 0,
    });
    expect(line.startsWith("[[DREAM_METRICS]] ")).toBe(true);
  });

  it("--auto 场景：六个字段与 processed/total 都如实带出", () => {
    const line = formatDreamMetrics({
      tally: { produced: 54, noop: 7, partial: 0, skipped: 0 },
      degraded: 0, effects: 1142, processed: 61, total: 166,
    });
    expect(line).toBe(
      "[[DREAM_METRICS]] produced=54 noop=7 partial=0 skipped=0 degraded=0 effects=1142 processed=61/166",
    );
  });

  it("单 scope 场景：tally 只有一格是 1，processed 恒为 1/1", () => {
    const line = formatDreamMetrics({
      tally: { produced: 1, noop: 0, partial: 0, skipped: 0 },
      degraded: 0, effects: 12, processed: 1, total: 1,
    });
    expect(line).toBe(
      "[[DREAM_METRICS]] produced=1 noop=0 partial=0 skipped=0 degraded=0 effects=12 processed=1/1",
    );
  });

  it("degraded 非零时照实报，不被 produced 掩盖", () => {
    // DreamOutput.degraded 与 kind 正交：produced 也可以是 degraded 的。
    const line = formatDreamMetrics({
      tally: { produced: 1, noop: 0, partial: 0, skipped: 0 },
      degraded: 1, effects: 3, processed: 1, total: 1,
    });
    expect(line).toContain("degraded=1");
    expect(line).toContain("produced=1");
  });
});
