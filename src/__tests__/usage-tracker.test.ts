import { describe, expect, it } from "bun:test";

import {
  getUsageMetadata,
  computeUsageStatus,
  buildUsagePatch,
  recordMemoryUsage,
  recordReconstructionUsage,
  deriveUsageStatus,
  USAGE_COLD_INJECTION_THRESHOLD,
  type UsageMetadata,
  type UsageStorePort,
} from "../usage-tracker.js";
import type { MemoryEntry } from "../store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ID = "11111111-1111-1111-1111-111111111111";

function makeEntry(id: string, meta: Record<string, unknown> = {}): MemoryEntry {
  return {
    id,
    text: "t",
    vector: [1, 0, 0],
    category: "events",
    scope: "project:test",
    importance: 0.7,
    timestamp: 1000,
    metadata: JSON.stringify(meta),
  };
}

function createMockStore(entries: MemoryEntry[]): {
  store: UsageStorePort;
  data: Map<string, MemoryEntry>;
  updates: Array<{ id: string; metadata: string }>;
} {
  const data = new Map(entries.map(e => [e.id, { ...e }]));
  const updates: Array<{ id: string; metadata: string }> = [];
  const store: UsageStorePort = {
    async getById(id: string) {
      return data.get(id) ?? null;
    },
    async update(id: string, upd: { metadata: string }, _scopeFilter?: string[]) {
      const entry = data.get(id);
      if (!entry) return null;
      entry.metadata = upd.metadata;
      updates.push({ id, metadata: upd.metadata });
      return entry;
    },
  };
  return { store, data, updates };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("usage-tracker", () => {
  describe("getUsageMetadata", () => {
    it("returns useCount 0 for entry without usage", () => {
      expect(getUsageMetadata(makeEntry(ID)).useCount).toBe(0);
    });

    it("returns 0 for malformed metadata", () => {
      const e: MemoryEntry = { ...makeEntry(ID), metadata: "not-json" };
      expect(getUsageMetadata(e).useCount).toBe(0);
    });

    it("reads stored usage fields", () => {
      const e = makeEntry(ID, { usage: { useCount: 3, firstUsedAt: 1, lastUsedAt: 5, usageStatus: "warm" } });
      const u = getUsageMetadata(e);
      expect(u.useCount).toBe(3);
      expect(u.lastUsedAt).toBe(5);
      expect(u.usageStatus).toBe("warm");
    });

    it("ignores invalid usageStatus value", () => {
      const e = makeEntry(ID, { usage: { useCount: 1, usageStatus: "bogus" } });
      expect(getUsageMetadata(e).usageStatus).toBeUndefined();
    });

    it("malformed metadata='null' does not crash", () => {
      const e: MemoryEntry = { ...makeEntry(ID), metadata: "null" };
      expect(getUsageMetadata(e).useCount).toBe(0);
      expect(() => buildUsagePatch(e, 100)).not.toThrow();
    });

    it("malformed array metadata does not crash", () => {
      const e: MemoryEntry = { ...makeEntry(ID), metadata: "[1,2,3]" };
      expect(getUsageMetadata(e).useCount).toBe(0);
      expect(deriveUsageStatus(e)).toBe("unused");
    });
  });

  describe("computeUsageStatus (复刻 Orb decay_tick)", () => {
    it("unused: no injections, no uses", () => {
      expect(computeUsageStatus(0, 0)).toBe("unused");
    });

    it("unused: just below cold threshold, zero uses", () => {
      expect(computeUsageStatus(USAGE_COLD_INJECTION_THRESHOLD - 1, 0)).toBe("unused");
    });

    it("cold: AT injection threshold with zero uses (核心边界 inj=6 & use=0)", () => {
      expect(computeUsageStatus(USAGE_COLD_INJECTION_THRESHOLD, 0)).toBe("cold");
    });

    it("cold: well above threshold, zero uses", () => {
      expect(computeUsageStatus(20, 0)).toBe("cold");
    });

    it("warm: used but ratio below hot (1/10=0.1)", () => {
      expect(computeUsageStatus(10, 1)).toBe("warm");
    });

    it("hot: use/injection ratio meets HOT_RATIO (3/10=0.3)", () => {
      expect(computeUsageStatus(10, 3)).toBe("hot");
    });

    it("warm: used with zero injections (no div-by-zero → hot)", () => {
      expect(computeUsageStatus(0, 2)).toBe("warm");
    });
  });

  describe("buildUsagePatch", () => {
    it("returns null for null entry", () => {
      expect(buildUsagePatch(null, 100)).toBeNull();
    });

    it("first use: 0 -> 1, sets first/lastUsedAt", () => {
      const patch = buildUsagePatch(makeEntry(ID), 100);
      expect(patch).not.toBeNull();
      const usage = patch!.metadata.usage as UsageMetadata;
      expect(usage.useCount).toBe(1);
      expect(usage.firstUsedAt).toBe(100);
      expect(usage.lastUsedAt).toBe(100);
      expect(patch!.update.oldUseCount).toBe(0);
      expect(patch!.update.newUseCount).toBe(1);
    });

    it("accumulates useCount, preserves firstUsedAt, updates lastUsedAt", () => {
      const e = makeEntry(ID, { usage: { useCount: 2, firstUsedAt: 50 } });
      const patch = buildUsagePatch(e, 200);
      const usage = patch!.metadata.usage as UsageMetadata;
      expect(usage.useCount).toBe(3);
      expect(usage.firstUsedAt).toBe(50);
      expect(usage.lastUsedAt).toBe(200);
    });

    it("双计数互不污染：不动 accessCount / confidence / evolution / tier", () => {
      const e = makeEntry(ID, {
        accessCount: 9,
        confidence: 0.9,
        evolution: { accessCount: 4 },
        tier: "core",
      });
      const m = buildUsagePatch(e, 100)!.metadata;
      expect(m.accessCount).toBe(9);
      expect(m.confidence).toBe(0.9);
      expect((m.evolution as { accessCount: number }).accessCount).toBe(4);
      expect(m.tier).toBe("core");
    });

    it("不写 usageStatus（status 留 deriveUsageStatus 离线算，避免假 cold）", () => {
      const e = makeEntry(ID, { accessCount: 8 });
      const patch = buildUsagePatch(e, 100);
      const usage = patch!.metadata.usage as UsageMetadata;
      expect(usage.usageStatus).toBeUndefined();
      expect("status" in patch!.update).toBe(false);
    });

    it("does not emit any ranking multiplier / score field (影子定位)", () => {
      const patch = buildUsagePatch(makeEntry(ID), 100);
      const update = patch!.update as Record<string, unknown>;
      expect(update.scoreMultiplier).toBeUndefined();
      expect(update.weight).toBeUndefined();
    });
  });

  describe("deriveUsageStatus (离线按需，cold 可达)", () => {
    it("cold: accessCount>=6 且从未被引用（无 usage 字段）", () => {
      expect(deriveUsageStatus(makeEntry(ID, { accessCount: 8 }))).toBe("cold");
    });
    it("cold: accessCount=6 边界 + useCount 0", () => {
      expect(deriveUsageStatus(makeEntry(ID, { accessCount: 6, usage: { useCount: 0 } }))).toBe("cold");
    });
    it("unused: 低 injection 从未被引用", () => {
      expect(deriveUsageStatus(makeEntry(ID, { accessCount: 2 }))).toBe("unused");
    });
    it("warm: 被引用但比例低", () => {
      expect(deriveUsageStatus(makeEntry(ID, { accessCount: 10, usage: { useCount: 1 } }))).toBe("warm");
    });
    it("hot: use/injection 达标", () => {
      expect(deriveUsageStatus(makeEntry(ID, { accessCount: 10, usage: { useCount: 3 } }))).toBe("hot");
    });
  });

  describe("recordMemoryUsage", () => {
    it("returns null and skips update when entry not found", async () => {
      const { store, updates } = createMockStore([]);
      const res = await recordMemoryUsage(store, "missing", 100);
      expect(res).toBeNull();
      expect(updates.length).toBe(0);
    });

    it("writes full metadata back with usage, preserving other fields", async () => {
      const e = makeEntry(ID, { accessCount: 3, confidence: 0.8 });
      const { store, updates, data } = createMockStore([e]);
      const res = await recordMemoryUsage(store, ID, 100);
      expect(res!.newUseCount).toBe(1);
      expect(updates.length).toBe(1);
      const written = JSON.parse(updates[0].metadata) as Record<string, unknown>;
      expect((written.usage as UsageMetadata).useCount).toBe(1);
      expect(written.accessCount).toBe(3);
      expect(written.confidence).toBe(0.8);
      const persisted = JSON.parse(data.get(ID)!.metadata ?? "{}") as Record<string, unknown>;
      expect((persisted.usage as UsageMetadata).useCount).toBe(1);
    });

    it("second call accumulates useCount to 2", async () => {
      const { store } = createMockStore([makeEntry(ID)]);
      await recordMemoryUsage(store, ID, 100);
      const res2 = await recordMemoryUsage(store, ID, 200);
      expect(res2!.newUseCount).toBe(2);
    });

    it("passes scope through to store.update when provided", async () => {
      const captured: Array<string[] | undefined> = [];
      const base = createMockStore([makeEntry(ID)]);
      const store: UsageStorePort = {
        getById: base.store.getById,
        async update(id: string, upd: { metadata: string }, scopeFilter?: string[]) {
          captured.push(scopeFilter);
          return base.store.update(id, upd, scopeFilter);
        },
      };
      await recordMemoryUsage(store, ID, 100, "project:test");
      expect(captured[0]).toEqual(["project:test"]);
    });
  });

  describe("recordReconstructionUsage (批量影子)", () => {
    it("no-op on empty array", async () => {
      const { store, updates } = createMockStore([]);
      await recordReconstructionUsage(store, [], 100);
      expect(updates.length).toBe(0);
    });

    it("records useCount=1 for each distinct cited id", async () => {
      const { store, data } = createMockStore([makeEntry("mem-a"), makeEntry("mem-b")]);
      await recordReconstructionUsage(store, ["mem-a", "mem-b"], 100);
      const a = JSON.parse(data.get("mem-a")!.metadata ?? "{}") as Record<string, unknown>;
      const b = JSON.parse(data.get("mem-b")!.metadata ?? "{}") as Record<string, unknown>;
      expect((a.usage as UsageMetadata).useCount).toBe(1);
      expect((b.usage as UsageMetadata).useCount).toBe(1);
    });

    it("dedupes repeated ids within one call (writes once)", async () => {
      const { store, updates } = createMockStore([makeEntry(ID)]);
      await recordReconstructionUsage(store, [ID, ID, ID], 100);
      expect(updates.length).toBe(1);
    });

    it("one failing id does not block others (allSettled, no throw)", async () => {
      const base = createMockStore([makeEntry(ID)]);
      const store: UsageStorePort = {
        async getById(id: string) {
          if (id === "bad") throw new Error("boom");
          return base.data.get(id) ?? null;
        },
        update: base.store.update,
      };
      await recordReconstructionUsage(store, ["bad", ID], 100);
      const good = JSON.parse(base.data.get(ID)!.metadata ?? "{}") as Record<string, unknown>;
      expect((good.usage as UsageMetadata).useCount).toBe(1);
    });
  });
});
