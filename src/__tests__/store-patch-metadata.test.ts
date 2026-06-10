/**
 * Tests for the store-level metadata write channel (P0 Track A):
 * - update() atomic upsert via mergeInsert (no delete+add vanish window)
 * - patchMetadata() per-id serial queue: no lost increments under concurrency,
 *   rejection isolation, queue self-cleanup, prefix/full-id queue sharing
 * - listPage() true DB-level pagination with category filter and includeVector
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, type MemoryEntry } from "../store.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function createStore(): MemoryStore {
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-patch-meta-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({ dbPath, vectorDim: 3 });
}

async function seed(store: MemoryStore, overrides: Partial<MemoryEntry> = {}): Promise<MemoryEntry> {
  return store.store({
    text: "patch metadata target",
    vector: [1, 0, 0],
    category: "cases",
    scope: "project:patch-test",
    importance: 0.6,
    metadata: "{}",
    ...overrides,
  });
}

describe("MemoryStore.update (mergeInsert upsert)", () => {
  it("keeps the row continuously visible and intact after update", async () => {
    const store = createStore();
    const entry = await seed(store);

    const updated = await store.update(entry.id, { metadata: JSON.stringify({ marker: 1 }) });
    expect(updated).not.toBeNull();

    // Immediately readable by id, by list, and by vector search
    const byId = await store.getById(entry.id);
    expect(byId?.id).toBe(entry.id);
    expect(JSON.parse(byId?.metadata || "{}").marker).toBe(1);

    const listed = await store.list(["project:patch-test"]);
    expect(listed.map(e => e.id)).toContain(entry.id);

    const hits = await store.vectorSearch([1, 0, 0], 5, 0, ["project:patch-test"]);
    expect(hits.map(h => h.entry.id)).toContain(entry.id);

    // Vector column survived the upsert
    const vectors = await store.getVectors([entry.id]);
    expect(vectors.get(entry.id)).toEqual([1, 0, 0]);

    // No duplicate row was created
    const all = await store.list(["project:patch-test"], undefined, 100, 0);
    expect(all.filter(e => e.id === entry.id)).toHaveLength(1);
  });
});

describe("MemoryStore.patchMetadata", () => {
  it("does not lose increments under 20 concurrent mixed patches on one id", async () => {
    const store = createStore();
    const entry = await seed(store);

    const jobs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i++) {
      jobs.push(store.patchMetadata(entry.id, meta => {
        const usage = (meta.usage as Record<string, unknown> | undefined) ?? {};
        const count = typeof usage.useCount === "number" ? usage.useCount : 0;
        meta.usage = { ...usage, useCount: count + 1 };
        return meta;
      }));
      jobs.push(store.patchMetadata(entry.id, meta => {
        const count = typeof meta.accessCount === "number" ? meta.accessCount : 0;
        meta.accessCount = count + 1;
        return meta;
      }));
    }
    await Promise.all(jobs);

    const after = await store.getById(entry.id);
    const meta = JSON.parse(after?.metadata || "{}");
    expect(meta.usage.useCount).toBe(10);
    expect(meta.accessCount).toBe(10);
  });

  it("rejects the failing patch only; later patches still run; queue self-cleans", async () => {
    const store = createStore();
    const entry = await seed(store);

    const first = store.patchMetadata(entry.id, meta => {
      meta.step = 1;
      return meta;
    });
    const failing = store.patchMetadata(entry.id, () => {
      throw new Error("boom");
    });
    const third = store.patchMetadata(entry.id, meta => {
      meta.step = 3;
      return meta;
    });

    await expect(failing).rejects.toThrow("boom");
    await first;
    await third;

    const after = await store.getById(entry.id);
    expect(JSON.parse(after?.metadata || "{}").step).toBe(3);
    expect(store.pendingMetadataPatchCount).toBe(0);
  });

  it("routes prefix and full-id callers through the same queue", async () => {
    const store = createStore();
    const entry = await seed(store);
    // getById prefix semantics = string prefix (LIKE 'xxx%'), so take the
    // first 8 hex chars (the segment before the first hyphen).
    const prefix = entry.id.slice(0, 8);

    const jobs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i++) {
      jobs.push(store.patchMetadata(entry.id, meta => {
        const count = typeof meta.n === "number" ? meta.n : 0;
        meta.n = count + 1;
        return meta;
      }));
      jobs.push(store.patchMetadata(prefix, meta => {
        const count = typeof meta.n === "number" ? meta.n : 0;
        meta.n = count + 1;
        return meta;
      }));
    }
    await Promise.all(jobs);

    const after = await store.getById(entry.id);
    expect(JSON.parse(after?.metadata || "{}").n).toBe(20);
    expect(store.pendingMetadataPatchCount).toBe(0);
  });

  it("returns null for a missing id without queue residue", async () => {
    const store = createStore();
    await seed(store); // initialize table
    const result = await store.patchMetadata("00000000-0000-4000-8000-000000000000", meta => meta);
    expect(result).toBeNull();
    // settle the no-op queue entry
    await Promise.resolve();
    await Promise.resolve();
    expect(store.pendingMetadataPatchCount).toBe(0);
  });

  it("enforces scope permissions like update()", async () => {
    const store = createStore();
    const entry = await seed(store);
    await expect(
      store.patchMetadata(entry.id, meta => meta, ["project:other"]),
    ).rejects.toThrow(/outside accessible scopes/);
  });
});

describe("MemoryStore.listPage", () => {
  it("paginates at the DB level with category pushdown", async () => {
    const store = createStore();
    for (let i = 0; i < 7; i++) {
      await seed(store, { text: `case ${i}`, category: "cases" });
    }
    for (let i = 0; i < 3; i++) {
      await seed(store, { text: `pattern ${i}`, category: "patterns", vector: [0, 1, 0] });
    }

    const page1 = await store.listPage({ scopeFilter: ["project:patch-test"], category: "cases", limit: 4, offset: 0 });
    const page2 = await store.listPage({ scopeFilter: ["project:patch-test"], category: "cases", limit: 4, offset: 4 });
    expect(page1).toHaveLength(4);
    expect(page2).toHaveLength(3);
    expect([...page1, ...page2].every(e => e.category === "cases")).toBe(true);
    // No overlap between pages
    const ids = new Set([...page1, ...page2].map(e => e.id));
    expect(ids.size).toBe(7);

    const patterns = await store.listPage({ scopeFilter: ["project:patch-test"], category: "patterns", limit: 100 });
    expect(patterns).toHaveLength(3);
  });

  it("omits vectors by default and returns them with includeVector", async () => {
    const store = createStore();
    await seed(store);

    const [bare] = await store.listPage({ scopeFilter: ["project:patch-test"], limit: 1 });
    expect(bare.vector).toEqual([]);

    const [withVec] = await store.listPage({ scopeFilter: ["project:patch-test"], limit: 1, includeVector: true });
    expect(withVec.vector).toEqual([1, 0, 0]);
  });
});
