/**
 * dream 的 scope 隔离与策略排除（2026-08-16）。
 *
 * 为什么单开一个文件而不是塞进 dream-pipeline.test.ts：那边的 mock store **吞掉 scope
 * 参数**（`list()` 无视 scopeFilter、`vectorSearch(_vec, limit, _threshold, _scopes)` 直接
 * 返回全部行），所以哪怕 exact 模式压根没传到 3a，那些测试也照样全绿 —— 互审 C3 指出的
 * 正是这一点。本文件两层：
 *   L1 真实 MemoryStore 验 store 的 family/exact 两种语义（现有 prefix 行为必须保住）
 *   L2 scope-aware mock 验 dream/3a 是否真把模式传到了每一层取数点
 * 外加 L3 策略排除、L4 派生 insight 不参与 3a。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, type MemoryEntry } from "../store.js";
import type { MemoryStorePort } from "../memory-store-port.js";
import type { ScopeMatchMode } from "../scope-policy.js";
import { matchesScopeFilter } from "../scope-policy.js";
import { cosineSimilarity } from "../multi-vector.js";
import { runDream, DEFAULT_DREAM_CONFIG } from "../dream-pipeline.js";
import { ConsolidationEngine, DEFAULT_CONSOLIDATION_CONFIG } from "../consolidation-engine.js";
import { getWriteCount, incrementWriteCount, resetWriteCount } from "../activity-counter.js";
import type { LLMClient } from "../llm-client.js";
import type { Embedder } from "../embedder.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

function tempDb(): string {
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-dream-scope-"));
  cleanupPaths.push(dbPath);
  return dbPath;
}

/**
 * ⚠️ activity-counter 的默认 statsPath 指向**生产** `data/activity-stats.json`。
 * 不传 statsPath 就调 resetWriteCount/incrementWriteCount = 直接改真库的写计数
 * （本文件初版就这么干了：把生产的 `memory: 14` 删了，已手工恢复并留 bak）。
 * 所有涉及写计数的测试一律走这个临时路径。
 */
function tempStatsPath(): { statsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "recallnest-dream-stats-"));
  cleanupPaths.push(dir);
  return { statsPath: join(dir, "activity-stats.json") };
}

// ---------------------------------------------------------------------------
// L1 — 真实 MemoryStore：family（历史行为）vs exact（新增）
// ---------------------------------------------------------------------------

describe("MemoryStore scope matching modes", () => {
  async function seeded(): Promise<MemoryStore> {
    const store = new MemoryStore({ dbPath: tempDb(), vectorDim: 3 });
    await store.store({ text: "rule doc chunk", vector: [1, 0, 0], category: "fact", scope: "memory", importance: 0.5 });
    await store.store({ text: "hand-written pivot", vector: [1, 0, 0], category: "fact", scope: "memory:pivot", importance: 0.9 });
    await store.store({ text: "unrelated", vector: [0, 1, 0], category: "fact", scope: "project:other", importance: 0.5 });
    return store;
  }

  it("list: family 模式对无冒号 scope 按前缀（保住既有行为）", async () => {
    const store = await seeded();
    const rows = await store.list(["memory"], undefined, 100, 0);
    expect(rows.map(r => r.scope).sort()).toEqual(["memory", "memory:pivot"]);
  });

  it("list: exact 模式只命中同名 scope", async () => {
    const store = await seeded();
    const rows = await store.list(["memory"], undefined, 100, 0, "exact");
    expect(rows.map(r => r.scope)).toEqual(["memory"]);
  });

  it("stats: 两种模式的 totalCount 不同", async () => {
    const store = await seeded();
    expect((await store.stats(["memory"])).totalCount).toBe(2);
    expect((await store.stats(["memory"], "exact")).totalCount).toBe(1);
  });

  it("vectorSearch: exact 模式不返回兄弟 scope 的行", async () => {
    const store = await seeded();
    const family = await store.vectorSearch([1, 0, 0], 10, 0.1, ["memory"]);
    expect(family.map(r => r.entry.scope).sort()).toEqual(["memory", "memory:pivot"]);

    const exact = await store.vectorSearch([1, 0, 0], 10, 0.1, ["memory"], "exact");
    expect(exact.map(r => r.entry.scope)).toEqual(["memory"]);
  });

  it("含冒号的 scope 两种模式都精确（family 的隐式规则不受影响）", async () => {
    const store = await seeded();
    expect((await store.list(["memory:pivot"], undefined, 100, 0)).length).toBe(1);
    expect((await store.list(["memory:pivot"], undefined, 100, 0, "exact")).length).toBe(1);
  });

  it("exact 模式下 `memory:` 命中空集 —— 拿冒号形当修法会静默 noop", async () => {
    // 互审 K2：曾被考虑过的"让 weekly 传 memory: 绕开前缀"路线在这里被钉死为反例。
    const store = await seeded();
    expect((await store.list(["memory:"], undefined, 100, 0)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L2/L3/L4 — scope-aware mock：验模式有没有真传到每一层
// ---------------------------------------------------------------------------

/**
 * 与 dream-pipeline.test.ts 的 mock 的关键差别：**这个 mock 认 scope 也认 mode**。
 * 漏传 exact 会让下面的断言真的红，这正是它存在的理由。
 */
function createScopeAwareStore(entries: MemoryEntry[]) {
  const stored: MemoryEntry[] = entries.map(e => ({ ...e }));
  let counter = 0;
  const patchedIds: string[] = [];

  const select = (scopeFilter?: string[], mode: ScopeMatchMode = "family") =>
    stored.filter(e => matchesScopeFilter(e.scope, scopeFilter, mode));

  const store = {
    async list(scopeFilter?: string[], _category?: string, limit = 20, offset = 0, scopeMatch: ScopeMatchMode = "family") {
      // 复刻生产：list 恒返回假空向量
      return select(scopeFilter, scopeMatch).slice(offset, offset + limit).map(e => ({ ...e, vector: [] as number[] }));
    },
    async listPage(opts: { scopeFilter?: string[]; limit?: number; offset?: number } = {}) {
      const { scopeFilter, limit = 1000, offset = 0 } = opts;
      return select(scopeFilter).slice(offset, offset + limit).map(e => ({ ...e, vector: [] as number[] }));
    },
    async getVectors(ids: string[]) {
      const m = new Map<string, number[]>();
      for (const id of ids) {
        const e = stored.find(x => x.id === id);
        if (e?.vector?.length) m.set(id, e.vector);
      }
      return m;
    },
    async stats(scopeFilter?: string[], scopeMatch: ScopeMatchMode = "family") {
      return { totalCount: select(scopeFilter, scopeMatch).length, scopeCounts: {}, categoryCounts: {} };
    },
    async getById(id: string) {
      return stored.find(e => e.id === id) ?? null;
    },
    async store(entry: Partial<MemoryEntry>) {
      const full = {
        id: entry.id || `gen-${counter++}`,
        text: entry.text || "",
        vector: entry.vector || [],
        category: entry.category || "events",
        scope: entry.scope || "project:test",
        importance: entry.importance ?? 0.5,
        timestamp: Date.now(),
        metadata: entry.metadata || "{}",
      } as MemoryEntry;
      stored.push(full);
      return full;
    },
    async update(id: string, upd: Partial<MemoryEntry>) {
      const e = stored.find(x => x.id === id);
      if (e && upd.metadata) e.metadata = upd.metadata;
      return e ?? null;
    },
    async patchMetadata(id: string, patchFn: (m: Record<string, unknown>, e: MemoryEntry) => Record<string, unknown>) {
      const e = stored.find(x => x.id === id);
      if (!e) return null;
      patchedIds.push(id);
      e.metadata = JSON.stringify(patchFn(JSON.parse(e.metadata || "{}"), e));
      return e;
    },
    async patchMetadataBatch(
      patches: Array<{ id: string; patchFn: (m: Record<string, unknown>, e: MemoryEntry) => Record<string, unknown> }>,
    ) {
      let written = 0;
      for (const { id, patchFn } of patches) {
        const e = stored.find(x => x.id === id);
        if (!e) continue;
        patchedIds.push(id);
        e.metadata = JSON.stringify(patchFn(JSON.parse(e.metadata || "{}"), e));
        written++;
      }
      return written;
    },
    async vectorSearch(vec: number[], limit = 5, minScore = 0.3, scopeFilter?: string[], scopeMatch: ScopeMatchMode = "family") {
      return select(scopeFilter, scopeMatch)
        .filter(e => e.vector?.length)
        .map(e => ({ entry: e, score: cosineSimilarity(vec, e.vector) }))
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
  };

  return { store: store as unknown as MemoryStorePort, stored, patchedIds };
}

function entry(over: Partial<MemoryEntry> & { id: string; scope: string }): MemoryEntry {
  return {
    text: over.text ?? `text-${over.id}`,
    vector: over.vector ?? [1, 0, 0],
    category: over.category ?? "events",
    importance: over.importance ?? 0.7,
    timestamp: over.timestamp ?? Date.now(),
    metadata: over.metadata ?? JSON.stringify({ evolution: { status: "active", accessCount: 0 } }),
    ...over,
  } as MemoryEntry;
}

const mockLLM = {
  async generateL0() { return "an insight"; },
  async extractPattern() { return "a pattern"; },
} as unknown as LLMClient;

const mockEmbedder: Pick<Embedder, "embedPassage"> = {
  async embedPassage() { return [1, 0, 0]; },
};

describe("dream scope isolation (exact mode threading)", () => {
  it("exact 模式下 pivot 行既不进 insight 来源，也不被 patch", async () => {
    const memRows = Array.from({ length: 4 }, (_, i) =>
      entry({ id: `mem-${i}`, scope: "memory", text: `memory rule chunk ${i}`, vector: [1, 0.02 * i, 0] }));
    const pivotRows = Array.from({ length: 3 }, (_, i) =>
      entry({ id: `pivot-${i}`, scope: "memory:pivot", text: `hand-written pivot ${i}`, vector: [1, 0.01 * i, 0] }));
    const { store, stored, patchedIds } = createScopeAwareStore([...memRows, ...pivotRows]);
    const stats = tempStatsPath();

    await runDream({
      store, llm: mockLLM, embedder: mockEmbedder, scope: "memory",
      force: true, scopeMatch: "exact", activityStatsPath: stats.statsPath,
    });

    // 任何新写入的派生行，其 sourceMemories 都不许含 pivot id
    const derivedSources = stored
      .map(e => { try { return JSON.parse(e.metadata || "{}"); } catch { return {}; } })
      .filter((m: Record<string, unknown>) => m.cluster_insight === true || m.cross_memory_pattern === true)
      .flatMap((m: any) => (m?.evolution?.sourceMemories ?? []) as string[]);
    expect(derivedSources.filter(id => id.startsWith("pivot-"))).toEqual([]);

    // 也不许有任何 pivot 行被改写 metadata
    expect(patchedIds.filter(id => id.startsWith("pivot-"))).toEqual([]);
  });

  it("family 模式下 pivot 行会被卷进来 —— 这是修复前的行为，留作对照", async () => {
    const memRows = Array.from({ length: 3 }, (_, i) =>
      entry({ id: `mem-${i}`, scope: "memory", vector: [1, 0.01 * i, 0] }));
    const pivotRows = Array.from({ length: 3 }, (_, i) =>
      entry({ id: `pivot-${i}`, scope: "memory:pivot", vector: [1, 0.01 * i, 0] }));
    const { store } = createScopeAwareStore([...memRows, ...pivotRows]);

    // 只验取数面：family 下 gather 能看到 6 行，exact 下只有 3 行。
    expect((await store.list(["memory"], undefined, 500, 0)).length).toBe(6);
    expect((await store.list(["memory"], undefined, 500, 0, "exact")).length).toBe(3);
  });
});

describe("neverDreamScopes policy gate", () => {
  it("memory:pivot 被策略排除，force 也不越过", async () => {
    const { store, stored, patchedIds } = createScopeAwareStore(
      Array.from({ length: 5 }, (_, i) => entry({ id: `pivot-${i}`, scope: "memory:pivot", vector: [1, 0.01 * i, 0] })),
    );
    const before = stored.length;

    const result = await runDream({
      store, llm: mockLLM, embedder: mockEmbedder,
      scope: "memory:pivot", force: true, scopeMatch: "exact",
      activityStatsPath: tempStatsPath().statsPath,
    });

    expect(result.ran).toBe(false);
    expect(result.output.kind).toBe("skipped");
    expect(result.output.reason).toBe("policy_excluded");
    expect(result.output.effectsWritten).toBe(0);
    expect(stored.length).toBe(before);   // 一行都没新写
    expect(patchedIds).toEqual([]);       // 一行都没改
  });

  it("默认名单里就有 memory:pivot（改这条要连同 open-loops 的翻盘条件一起改）", () => {
    expect(DEFAULT_DREAM_CONFIG.neverDreamScopes).toContain("memory:pivot");
    // 与 autoExcludeScopes 是两份名单，语义不同，不许合并
    expect(DEFAULT_DREAM_CONFIG.autoExcludeScopes).not.toContain("memory:pivot");
  });

  it("不在名单里的 scope 照常跑（策略闸不误伤）", async () => {
    const { store } = createScopeAwareStore(
      Array.from({ length: 4 }, (_, i) => entry({ id: `p-${i}`, scope: "project:normal", vector: [1, 0.01 * i, 0] })),
    );
    const result = await runDream({
      store, llm: mockLLM, embedder: mockEmbedder,
      scope: "project:normal", force: true, scopeMatch: "exact",
      activityStatsPath: tempStatsPath().statsPath,
    });
    expect(result.ran).toBe(true);
    expect(result.output.reason).not.toBe("policy_excluded");
  });
});

describe("3a: derived insights never participate in dedupe", () => {
  it("LLM 派生行不当 canonical，也不把手写原件合并掉", async () => {
    // 复刻 2026-08-16 实测的形状：一条手写原件 + 一条它的 LLM 复述，向量几乎重合、
    // importance 与 accessCount 都打平 —— 修复前 canonicalScore 平局，派生行赢过原件。
    const original = entry({
      id: "hand-written",
      scope: "memory:pivot",
      text: "决定暂缓提交第二个 PR，坚持一次一个 PR 策略，理由是架构级变更需确认维护者意图。",
      vector: [1, 0, 0],
      importance: 0.7,
      metadata: JSON.stringify({
        evolution: { status: "active", accessCount: 0 },
        canonicalKey: "pivot-decision-sequential-pr-submission",
        tags: ["pinned", "src:c98b9988"],
      }),
    });
    const derived = entry({
      id: "llm-restatement",
      scope: "memory:pivot",
      text: "暂缓提交第二个 PR，等待首个 PR 审查反馈。",
      vector: [1, 0.001, 0],
      importance: 0.7,
      metadata: JSON.stringify({
        evolution: { status: "active", accessCount: 0, sourceMemories: ["hand-written"] },
        cluster_insight: true,
      }),
    });
    const { store, stored } = createScopeAwareStore([original, derived]);

    const engine = new ConsolidationEngine(store, {
      ...DEFAULT_CONSOLIDATION_CONFIG,
      scopeMatch: "exact",
    });
    const result = await engine.run("memory:pivot");

    expect(result.mergedCount).toBe(0);
    const statusOf = (id: string) => {
      const row = stored.find(e => e.id === id)!;
      return (JSON.parse(row.metadata || "{}") as any)?.evolution?.status;
    };
    expect(statusOf("hand-written")).toBe("active");   // 原件没被顶掉
    expect(statusOf("llm-restatement")).toBe("active"); // 派生行也没被动，只是不参与
  });

  it("两条同为原始记忆时仍正常合并（排除派生 ≠ 关掉去重）", async () => {
    const a = entry({
      id: "dup-a", scope: "project:dedupe", text: "构建命令是 bun run build", vector: [1, 0, 0], importance: 0.8,
    });
    const b = entry({
      id: "dup-b", scope: "project:dedupe", text: "构建命令为 bun run build", vector: [1, 0.001, 0], importance: 0.5,
    });
    const { store, stored } = createScopeAwareStore([a, b]);

    const engine = new ConsolidationEngine(store, { ...DEFAULT_CONSOLIDATION_CONFIG, scopeMatch: "exact" });
    const result = await engine.run("project:dedupe");

    expect(result.mergedCount).toBe(1);
    const loser = stored.find(e => e.id === "dup-b")!;
    expect((JSON.parse(loser.metadata || "{}") as any)?.evolution?.status).toBe("consolidated");
  });
});

describe("--auto 的 activity-stats key 一律 exact（回归锚点）", () => {
  it("无冒号 key 在 exact 下不再吞掉整个家族", async () => {
    // 实测 activity-stats 里有 11 个无冒号 key（cc / global / memory / manual …）。
    // `cc` 一旦达标，family 语义会以 LIKE 'cc%' 把 2026-08-14 刚出队的 transcript
    // 原文层整批捞回 —— 这条测试锁住"不会再发生"。
    const { store } = createScopeAwareStore([
      entry({ id: "cc-durable", scope: "cc" }),
      entry({ id: "cc-transcript-1", scope: "cc:019f0f70" }),
      entry({ id: "cc-transcript-2", scope: "cc:019f60e2" }),
    ]);
    expect((await store.list(["cc"], undefined, 100, 0)).length).toBe(3);
    expect((await store.list(["cc"], undefined, 100, 0, "exact")).map(r => r.id)).toEqual(["cc-durable"]);
  });

  it("写计数按具体 scope 记，pivot 与 memory 各记各的（不碰生产 stats 文件）", async () => {
    const cfg = tempStatsPath();
    await incrementWriteCount("memory", 3, cfg);
    await incrementWriteCount("memory:pivot", 5, cfg);
    expect(getWriteCount("memory", cfg)).toBe(3);
    expect(getWriteCount("memory:pivot", cfg)).toBe(5);
    await resetWriteCount("memory", cfg);
    expect(getWriteCount("memory", cfg)).toBe(0);
    expect(getWriteCount("memory:pivot", cfg)).toBe(5);  // 兄弟 scope 不受牵连
  });
});
