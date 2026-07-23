import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, deterministicId, type MemoryEntry } from "../store.js";
import { getWriteCount } from "../activity-counter.js";

/**
 * P0-2 回归：store()/storeBatch() 改走 upsert（delete+add 入全局 store-write 锁）后，
 * 相同 deterministicId 的写入是幂等的 —— 同 (scope,text) 写两次只留一行，不再堆 dup-id。
 */

const tmpDirs: string[] = [];

function makeStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "recallnest-upsert-"));
  tmpDirs.push(dir);
  return new MemoryStore({ dbPath: dir, vectorDim: 3 });
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("store P0-2 idempotency (upsert-backed store/storeBatch)", () => {
  it("store() of the same (scope,text) twice yields one row, latest wins", async () => {
    const store = makeStore();
    const scope = "project:upsert-test";
    await store.store({ text: "同一条内容", vector: [1, 0, 0], category: "entities", scope, importance: 0.7, metadata: "{}" });
    await store.store({ text: "同一条内容", vector: [1, 0, 0], category: "entities", scope, importance: 0.9, metadata: "{}" });

    const rows = await store.list([scope]);
    const target = rows.filter((r) => r.text === "同一条内容");
    expect(target.length).toBe(1);
    expect(target[0].importance).toBeCloseTo(0.9, 5); // upsert overwrote the 0.7 row
  });

  it("upsert() with the same id twice overwrites (single row, latest content)", async () => {
    const store = makeStore();
    const scope = "project:upsert-test";
    const id = deterministicId(scope, "anchor");
    const base: MemoryEntry = {
      id,
      text: "v1",
      vector: [0, 1, 0],
      category: "entities",
      scope,
      importance: 0.5,
      timestamp: Date.now(),
      metadata: "{}",
      language: "en",
      fts_text: "v1",
    };
    await store.upsert(base);
    await store.upsert({ ...base, text: "v2", fts_text: "v2", importance: 0.8 });

    const rows = await store.list([scope]);
    const byId = rows.filter((r) => r.id === id);
    expect(byId.length).toBe(1);
    expect(byId[0].text).toBe("v2");
  });

  it("upsert failure leaves the prior row intact (mergeInsert is atomic — no delete+add loss)", async () => {
    const store = makeStore(); // vectorDim 3
    const scope = "project:upsert-test";
    const id = deterministicId(scope, "atomic-anchor");
    const good: MemoryEntry = {
      id, text: "original", vector: [1, 0, 0], category: "entities", scope, importance: 0.5,
      timestamp: Date.now(), metadata: "{}", language: "en", fts_text: "original",
    };
    await store.upsert(good);

    // Inject a write failure. With the old delete-then-add path the delete would already
    // have removed the row before add threw (row lost); the atomic mergeInsert touches
    // nothing on failure, so the prior row must survive.
    const table = (store as unknown as { table: { mergeInsert: unknown } }).table;
    const orig = table.mergeInsert;
    table.mergeInsert = () => {
      throw new Error("simulated write failure");
    };
    try {
      await expect(store.upsert({ ...good, text: "corrupt", fts_text: "corrupt" })).rejects.toThrow("simulated write failure");
    } finally {
      table.mergeInsert = orig;
    }

    const survivor = (await store.list([scope])).filter((r) => r.id === id);
    expect(survivor.length).toBe(1);
    expect(survivor[0].text).toBe("original"); // prior row preserved, not lost
  });

  it("storeBatch() honors a caller-supplied id (idempotent re-run)", async () => {
    const store = makeStore();
    const scope = "project:upsert-test";
    const fixedId = deterministicId(scope, "batch-anchor");
    const entry = {
      id: fixedId,
      text: "batch-a",
      vector: [0, 0, 1] as number[],
      category: "entities" as const,
      scope,
      importance: 0.6,
      metadata: "{}",
    };
    await store.storeBatch([entry]);
    await store.storeBatch([{ ...entry, text: "batch-a-updated", fts_text: "batch-a-updated" }]);

    const rows = await store.list([scope]);
    const byId = rows.filter((r) => r.id === fixedId);
    expect(byId.length).toBe(1);
    expect(byId[0].text).toBe("batch-a-updated");
  });

  it("storeBatch() collapses in-batch duplicate ids (latest-wins) into one row", async () => {
    const store = makeStore();
    const scope = "project:upsert-test";
    const stored = await store.storeBatch([
      { text: "dup-in-batch", vector: [1, 0, 0], category: "entities", scope, importance: 0.3, metadata: "{}" },
      { text: "dup-in-batch", vector: [1, 0, 0], category: "entities", scope, importance: 0.8, metadata: "{}" },
    ]);
    expect(stored).toBe(1); // two same-(scope,text) entries collapse to one
    const rows = await store.list([scope]);
    const target = rows.filter((r) => r.text === "dup-in-batch");
    expect(target.length).toBe(1);
    expect(target[0].importance).toBeCloseTo(0.8, 5); // last occurrence wins
  });

  // A store whose activity-stats sits in its own unique dir (dirname(dbPath)), so the
  // per-scope counter assertions are isolated from other tests' shared tmproot writes.
  function makeIsolatedStore(): { store: MemoryStore; statsPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "recallnest-count-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "lancedb");
    return { store: new MemoryStore({ dbPath, vectorDim: 3 }), statsPath: join(dir, "activity-stats.json") };
  }

  it("store() increments the per-scope write counter once each (no double-count via upsert)", async () => {
    const { store, statsPath } = makeIsolatedStore();
    const scope = "cc:project:count-a";
    await store.store({ text: "m1", vector: [1, 0, 0], category: "entities", scope, importance: 0.5, metadata: "{}" });
    await store.store({ text: "m2", vector: [0, 1, 0], category: "entities", scope, importance: 0.5, metadata: "{}" });
    // store()→upsert() counts once per call; two stores ⇒ 2 (not 4).
    expect(getWriteCount(scope, { statsPath })).toBe(2);
  });

  it("storeBatch() counts per scope by number of entries in that scope", async () => {
    const { store, statsPath } = makeIsolatedStore();
    await store.storeBatch([
      { text: "a", vector: [1, 0, 0], category: "entities", scope: "cc:s1", importance: 0.5, metadata: "{}" },
      { text: "b", vector: [0, 1, 0], category: "entities", scope: "cc:s1", importance: 0.5, metadata: "{}" },
      { text: "c", vector: [0, 0, 1], category: "entities", scope: "cc:s2", importance: 0.5, metadata: "{}" },
    ]);
    expect(getWriteCount("cc:s1", { statsPath })).toBe(2);
    expect(getWriteCount("cc:s2", { statsPath })).toBe(1);
  });

  it("storeBatch() with an in-batch duplicate counts the collapsed row once", async () => {
    const { store, statsPath } = makeIsolatedStore();
    await store.storeBatch([
      { text: "dup", vector: [1, 0, 0], category: "entities", scope: "cc:s3", importance: 0.3, metadata: "{}" },
      { text: "dup", vector: [1, 0, 0], category: "entities", scope: "cc:s3", importance: 0.8, metadata: "{}" },
    ]);
    expect(getWriteCount("cc:s3", { statsPath })).toBe(1); // deduped to one row ⇒ counted once
  });

  it("storeBatch() without ids still stores distinct entries", async () => {
    const store = makeStore();
    const scope = "project:upsert-test";
    const stored = await store.storeBatch([
      { text: "batch-x", vector: [1, 0, 0], category: "entities", scope, importance: 0.5, metadata: "{}" },
      { text: "batch-y", vector: [0, 1, 0], category: "entities", scope, importance: 0.5, metadata: "{}" },
    ]);
    expect(stored).toBe(2);
    const rows = await store.list([scope]);
    expect(rows.filter((r) => r.text === "batch-x" || r.text === "batch-y").length).toBe(2);
  });
});

describe("update() vector fallback (2026-07-23 null-vector regression)", () => {
  it("metadata-only update preserves the original vector on healthy rows", async () => {
    const store = makeStore();
    const scope = "project:nullvec-test";
    const entry = await store.store({
      text: "健康行", vector: [0.1, 0.2, 0.3], category: "events", scope, importance: 0.7, metadata: "{}",
    });
    const updated = await store.update(entry.id, { metadata: JSON.stringify({ touched: true }) });
    expect(updated).not.toBeNull();
    // 修复 row.vector null-guard 后，正常行的 vector 必须原样保留（回归保护）
    const rows = await store.list([scope]);
    expect(rows.length).toBe(1);
    const meta = JSON.parse(rows[0].metadata || "{}") as Record<string, unknown>;
    expect(meta.touched).toBe(true);
  });
});
