/**
 * 2026-08-14 dream 写爆库根治的写入层回归：
 * - store.patchMetadataBatch：真 LanceDB 实例上的批量读改写语义（锁内最新行起底、
 *   按序应用、scope 过滤、单条失败跳过）
 * - activity-counter.pruneWriteCounts：transcript 计数清扫（含未达标条目）
 * - auto-gc 批量归档：maxArchivePerRun 命中时不弃单（flush 后再停）
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, type MemoryEntry } from "../store.js";
import { incrementWriteCount, getWriteCount, pruneWriteCounts, listScopesAboveThreshold } from "../activity-counter.js";
import { isTranscriptScope } from "../memory-boundaries.js";
import { maybeRunGc, resetGcTimestamp } from "../auto-gc.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function makeIsolatedStore(): { store: MemoryStore; statsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rn-batch-"));
  tmpDirs.push(dir);
  return { store: new MemoryStore({ dbPath: join(dir, "lancedb"), vectorDim: 3 }), statsPath: join(dir, "activity-stats.json") };
}

describe("store.patchMetadataBatch（真 LanceDB）", () => {
  it("一次调用批量写 N 行，最终态各自生效", async () => {
    const { store } = makeIsolatedStore();
    const scope = "project:batch";
    const a = await store.store({ text: "row a", vector: [1, 0, 0], category: "events", scope, importance: 0.5, metadata: "{}" });
    const b = await store.store({ text: "row b", vector: [0, 1, 0], category: "events", scope, importance: 0.5, metadata: "{}" });

    const written = await store.patchMetadataBatch([
      { id: a.id, patchFn: meta => ({ ...meta, marker: "A" }) },
      { id: b.id, patchFn: meta => ({ ...meta, marker: "B" }) },
    ], [scope]);

    expect(written).toBe(2);
    expect(JSON.parse((await store.getById(a.id))!.metadata!).marker).toBe("A");
    expect(JSON.parse((await store.getById(b.id))!.metadata!).marker).toBe("B");
  });

  it("patchFn 以库中最新行起底：批量写不吞前一次独立 update 写入的键", async () => {
    const { store } = makeIsolatedStore();
    const scope = "project:fresh";
    const a = await store.store({ text: "row", vector: [1, 0, 0], category: "events", scope, importance: 0.5, metadata: "{}" });
    // 先经独立通道写入一个键（模拟 3a 已提交的 version_group）
    await store.update(a.id, { metadata: JSON.stringify({ version_group: "vg-keep" }) }, [scope]);
    // 批量 patch 只声明自己的键 —— 旧"预物化整串"接口在这里会把 version_group 抹掉
    await store.patchMetadataBatch([
      { id: a.id, patchFn: meta => ({ ...meta, consolidatedInto: "x" }) },
    ], [scope]);
    const final = JSON.parse((await store.getById(a.id))!.metadata!);
    expect(final.version_group).toBe("vg-keep");
    expect(final.consolidatedInto).toBe("x");
  });

  it("同批 patchFn 按数组序执行（闭包可传递决策）", async () => {
    const { store } = makeIsolatedStore();
    const scope = "project:seq";
    const a = await store.store({ text: "first", vector: [1, 0, 0], category: "events", scope, importance: 0.5, metadata: "{}" });
    const b = await store.store({ text: "second", vector: [0, 1, 0], category: "events", scope, importance: 0.5, metadata: "{}" });
    let decided: string | null = null;
    await store.patchMetadataBatch([
      { id: a.id, patchFn: meta => { decided = "from-first"; return { ...meta, tag: "lead" }; } },
      { id: b.id, patchFn: meta => ({ ...meta, tag: decided }) },
    ], [scope]);
    expect(JSON.parse((await store.getById(b.id))!.metadata!).tag).toBe("from-first");
  });

  it("scope 过滤拒绝越权行、不存在的 id 跳过、空数组返回 0", async () => {
    const { store } = makeIsolatedStore();
    const a = await store.store({ text: "in scope", vector: [1, 0, 0], category: "events", scope: "project:x", importance: 0.5, metadata: "{}" });
    const written = await store.patchMetadataBatch([
      { id: a.id, patchFn: meta => ({ ...meta, touched: true }) },
      { id: "00000000-0000-4000-8000-000000000000", patchFn: meta => meta },
    ], ["project:other"]); // a 不在此 scope
    expect(written).toBe(0);
    expect(JSON.parse((await store.getById(a.id))!.metadata!).touched).toBeUndefined();
    expect(await store.patchMetadataBatch([], ["project:x"])).toBe(0);
  });

  it("单条 patchFn 抛错跳过该条，其余照写", async () => {
    const { store } = makeIsolatedStore();
    const scope = "project:err";
    const a = await store.store({ text: "bad", vector: [1, 0, 0], category: "events", scope, importance: 0.5, metadata: "{}" });
    const b = await store.store({ text: "good", vector: [0, 1, 0], category: "events", scope, importance: 0.5, metadata: "{}" });
    const written = await store.patchMetadataBatch([
      { id: a.id, patchFn: () => { throw new Error("boom"); } },
      { id: b.id, patchFn: meta => ({ ...meta, ok: true }) },
    ], [scope]);
    expect(written).toBe(1);
    expect(JSON.parse((await store.getById(b.id))!.metadata!).ok).toBe(true);
    expect(JSON.parse((await store.getById(a.id))!.metadata!).ok).toBeUndefined();
  });
});

describe("pruneWriteCounts（transcript 计数清扫）", () => {
  it("清掉全部 transcript 条目（达标与未达标），durable 一律保留", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rn-prune-"));
    tmpDirs.push(dir);
    const cfg = { statsPath: join(dir, "activity-stats.json") };
    await incrementWriteCount("codex:aaaa1111", 15, cfg); // transcript 达标
    await incrementWriteCount("kimi:bbbb2222", 3, cfg);   // transcript 未达标
    await incrementWriteCount("project:harness", 12, cfg); // durable 达标
    await incrementWriteCount("memory", 2, cfg);           // durable 未达标

    const removed = await pruneWriteCounts(isTranscriptScope, cfg);

    expect(removed.sort()).toEqual(["codex:aaaa1111", "kimi:bbbb2222"]);
    expect(getWriteCount("codex:aaaa1111", cfg)).toBe(0);
    expect(getWriteCount("kimi:bbbb2222", cfg)).toBe(0);
    expect(getWriteCount("project:harness", cfg)).toBe(12);
    expect(getWriteCount("memory", cfg)).toBe(2);
    expect(listScopesAboveThreshold(10, cfg)).toEqual(["project:harness"]);
  });
});

describe("auto-gc 批量归档的上限语义", () => {
  it("maxArchivePerRun 命中时已选中的候选照常提交（flush 不弃单）", async () => {
    resetGcTimestamp();
    const oldTs = Date.now() - 120 * 86_400_000;
    const activeMeta = (): string => JSON.stringify({
      evolution: { status: "active", version: 1, accessCount: 0, lastAccessedAt: null, validFrom: oldTs, validUntil: null },
    });
    const rows: Array<{ id: string; text: string; importance: number; timestamp: number; metadata: string; category: string; scope: string }> = [
      { id: "g1", text: "old1", importance: 0.1, timestamp: oldTs, metadata: activeMeta(), category: "events", scope: "project:gc" },
      { id: "g2", text: "old2", importance: 0.1, timestamp: oldTs, metadata: activeMeta(), category: "events", scope: "project:gc" },
      { id: "g3", text: "old3", importance: 0.1, timestamp: oldTs, metadata: activeMeta(), category: "events", scope: "project:gc" },
    ];
    const batchCalls: number[] = [];
    const store = {
      async stats() { return { totalCount: 100, scopeCounts: {}, categoryCounts: {} }; },
      async repairSingletonVersionGroups() { return 0; },
      async list() { return rows; },
      async listPage(opts: { limit?: number; offset?: number } = {}) {
        const { limit = 1000, offset = 0 } = opts;
        return rows.slice(offset, offset + limit);
      },
      async update() { return null; },
      async patchMetadataBatch(
        patches: Array<{ id: string; patchFn: (meta: Record<string, unknown>, entry: unknown) => Record<string, unknown> }>,
      ) {
        batchCalls.push(patches.length);
        for (const { id, patchFn } of patches) {
          const row = rows.find(r => r.id === id);
          if (!row) continue;
          row.metadata = JSON.stringify(patchFn(JSON.parse(row.metadata) as Record<string, unknown>, row));
        }
        return patches.length;
      },
    };

    const result = await maybeRunGc(
      store as unknown as Parameters<typeof maybeRunGc>[0],
      { minMemoryCount: 1, minHoursSinceLastGc: 0, decayScoreThreshold: 0.99, maxArchivePerRun: 2, minAgeDays: 30 },
    );

    expect(result.archivedCount).toBe(2); // 上限生效
    const archived = rows.filter(r => (JSON.parse(r.metadata) as { evolution: { status: string } }).evolution.status === "archived");
    expect(archived.length).toBe(2); // 且真的写进去了（break 前 flush，不弃单）
    expect(batchCalls.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("即使低于归档数量门槛也会自愈 singleton version-group", async () => {
    resetGcTimestamp();
    let repairCalls = 0;
    const store = {
      async stats() { return { totalCount: 100, scopeCounts: {}, categoryCounts: {} }; },
      async repairSingletonVersionGroups() { repairCalls++; return 1; },
      async listPage() { return []; },
      async patchMetadataBatch() { return 0; },
    };

    const result = await maybeRunGc(
      store as unknown as Parameters<typeof maybeRunGc>[0],
      { minMemoryCount: 1000, minHoursSinceLastGc: 0, decayScoreThreshold: 0.15, maxArchivePerRun: 100, minAgeDays: 30 },
    );

    expect(repairCalls).toBe(1);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("below_memory_threshold");
    expect(result.dissolvedVersionGroups).toBe(1);
  });

  it("单成员组自愈有独立节流，不会被每个 dream scope 重复全库扫描", async () => {
    resetGcTimestamp();
    let repairCalls = 0;
    const store = {
      async stats() { return { totalCount: 100, scopeCounts: {}, categoryCounts: {} }; },
      async repairSingletonVersionGroups() { repairCalls++; return 0; },
      async listPage() { return []; },
      async patchMetadataBatch() { return 0; },
    };
    const config = {
      minMemoryCount: 1000,
      minHoursSinceLastGc: 24,
      decayScoreThreshold: 0.15,
      maxArchivePerRun: 100,
      minAgeDays: 30,
    };

    await maybeRunGc(store as unknown as Parameters<typeof maybeRunGc>[0], config);
    await maybeRunGc(store as unknown as Parameters<typeof maybeRunGc>[0], config);

    expect(repairCalls).toBe(1);
  });
});
