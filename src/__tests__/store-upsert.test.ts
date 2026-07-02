import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, deterministicId, type MemoryEntry } from "../store.js";

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
