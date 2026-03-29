/**
 * Tests for Tier 3.3: Version Coexistence + Competition
 *
 * Validates:
 * 1. computeVersionRank formula
 * 2. createVersionGroup tags both entries with same group
 * 3. deduplicateByVersionGroup keeps top-ranked per group
 * 4. Entries without version_group pass through unchanged
 * 5. Multiple version groups are handled independently
 * 6. Existing version_group is reused (not duplicated)
 */
import { describe, expect, it } from "bun:test";
import {
  computeVersionRank,
  deduplicateByVersionGroup,
  createVersionGroup,
} from "../version-manager.js";
import type { MemoryEntry } from "../store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  id: string,
  overrides: {
    confidence?: number;
    accessCount?: number;
    version_group?: string;
    version_rank?: number;
  } = {},
): MemoryEntry {
  const meta: Record<string, unknown> = {
    confidence: overrides.confidence ?? 0.7,
    accessCount: overrides.accessCount ?? 0,
  };
  if (overrides.version_group) meta.version_group = overrides.version_group;
  if (overrides.version_rank !== undefined) meta.version_rank = overrides.version_rank;

  return {
    id,
    text: `memory-${id}`,
    vector: [1, 0, 0],
    category: "events",
    scope: "project:test",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: JSON.stringify(meta),
  };
}

function createMockStore(entries: MemoryEntry[]) {
  const data = new Map(entries.map(e => [e.id, { ...e }]));
  const updates: Array<{ id: string; metadata: string }> = [];

  return {
    data,
    updates,
    async getById(id: string) {
      return data.get(id) ?? null;
    },
    async update(id: string, upd: { metadata?: string }, _scope?: string[]) {
      const entry = data.get(id);
      if (!entry) return null;
      if (upd.metadata) {
        entry.metadata = upd.metadata;
        updates.push({ id, metadata: upd.metadata });
      }
      return entry;
    },
  };
}

// ---------------------------------------------------------------------------
// computeVersionRank
// ---------------------------------------------------------------------------

describe("computeVersionRank", () => {
  it("computes rank from importance, confidence, and accessCount", () => {
    const entry = makeEntry("a", { confidence: 1.0, accessCount: 10 });
    const rank = computeVersionRank(entry);
    // quality = 0.5*0.7 + 0.5*1.0 = 0.85 (importance=0.7 from makeEntry)
    // rank = 0.85 * (1 + ln(11)) ≈ 0.85 * 3.398 = 2.888
    expect(rank).toBeGreaterThan(2.8);
    expect(rank).toBeLessThan(3.0);
  });

  it("returns baseline for default confidence and zero access", () => {
    const entry = makeEntry("b", { confidence: 0.7, accessCount: 0 });
    const rank = computeVersionRank(entry);
    // quality = 0.5*0.7 + 0.5*0.7 = 0.7
    // rank = 0.7 * (1 + 0) = 0.7
    expect(rank).toBeCloseTo(0.7, 5);
  });

  it("higher confidence wins over lower with same access", () => {
    const high = computeVersionRank(makeEntry("h", { confidence: 1.0, accessCount: 5 }));
    const low = computeVersionRank(makeEntry("l", { confidence: 0.3, accessCount: 5 }));
    expect(high).toBeGreaterThan(low);
  });

  it("higher access wins over lower with same confidence", () => {
    const frequent = computeVersionRank(makeEntry("f", { confidence: 0.7, accessCount: 20 }));
    const rare = computeVersionRank(makeEntry("r", { confidence: 0.7, accessCount: 1 }));
    expect(frequent).toBeGreaterThan(rare);
  });
});

// ---------------------------------------------------------------------------
// createVersionGroup
// ---------------------------------------------------------------------------

describe("createVersionGroup", () => {
  it("tags both entries with the same version_group", async () => {
    const canonical = makeEntry("canon", { confidence: 1.0, accessCount: 5 });
    const member = makeEntry("member", { confidence: 0.5, accessCount: 1 });
    const store = createMockStore([canonical, member]);

    const groupId = await createVersionGroup(store as any, canonical, member, "project:test");

    expect(groupId).toBeTruthy();
    expect(store.updates.length).toBe(2);

    const canonMeta = JSON.parse(store.data.get("canon")!.metadata);
    const memberMeta = JSON.parse(store.data.get("member")!.metadata);

    expect(canonMeta.version_group).toBe(groupId);
    expect(memberMeta.version_group).toBe(groupId);
    expect(canonMeta.version_rank).toBeGreaterThan(memberMeta.version_rank);
  });

  it("reuses existing version_group from canonical", async () => {
    const canonical = makeEntry("canon", {
      confidence: 1.0,
      accessCount: 5,
      version_group: "vg-existing",
      version_rank: 3.0,
    });
    const member = makeEntry("new", { confidence: 0.5, accessCount: 0 });
    const store = createMockStore([canonical, member]);

    const groupId = await createVersionGroup(store as any, canonical, member, "project:test");

    expect(groupId).toBe("vg-existing");
    const memberMeta = JSON.parse(store.data.get("new")!.metadata);
    expect(memberMeta.version_group).toBe("vg-existing");
  });
});

// ---------------------------------------------------------------------------
// deduplicateByVersionGroup
// ---------------------------------------------------------------------------

describe("deduplicateByVersionGroup", () => {
  it("keeps only the top-ranked entry per version group", () => {
    const results = [
      { entry: makeEntry("a", { version_group: "vg1", version_rank: 3.0 }), score: 0.9, sources: {} },
      { entry: makeEntry("b", { version_group: "vg1", version_rank: 1.0 }), score: 0.85, sources: {} },
      { entry: makeEntry("c"), score: 0.8, sources: {} },
    ];

    const deduped = deduplicateByVersionGroup(results);

    expect(deduped.length).toBe(2);
    expect(deduped.map(r => r.entry.id)).toContain("a");
    expect(deduped.map(r => r.entry.id)).toContain("c");
    expect(deduped.map(r => r.entry.id)).not.toContain("b");
  });

  it("passes through entries without version_group", () => {
    const results = [
      { entry: makeEntry("x"), score: 0.9, sources: {} },
      { entry: makeEntry("y"), score: 0.8, sources: {} },
    ];

    const deduped = deduplicateByVersionGroup(results);

    expect(deduped.length).toBe(2);
  });

  it("handles multiple independent version groups", () => {
    const results = [
      { entry: makeEntry("a1", { version_group: "vg1", version_rank: 3.0 }), score: 0.95, sources: {} },
      { entry: makeEntry("a2", { version_group: "vg1", version_rank: 1.0 }), score: 0.90, sources: {} },
      { entry: makeEntry("b1", { version_group: "vg2", version_rank: 2.0 }), score: 0.85, sources: {} },
      { entry: makeEntry("b2", { version_group: "vg2", version_rank: 4.0 }), score: 0.80, sources: {} },
      { entry: makeEntry("solo"), score: 0.75, sources: {} },
    ];

    const deduped = deduplicateByVersionGroup(results);

    expect(deduped.length).toBe(3);
    const ids = deduped.map(r => r.entry.id);
    expect(ids).toContain("a1"); // vg1 winner (rank 3.0)
    expect(ids).toContain("b2"); // vg2 winner (rank 4.0)
    expect(ids).toContain("solo");
  });

  it("handles empty array", () => {
    expect(deduplicateByVersionGroup([])).toEqual([]);
  });

  it("handles single entry in a version group", () => {
    const results = [
      { entry: makeEntry("only", { version_group: "vg1", version_rank: 2.0 }), score: 0.9, sources: {} },
    ];

    const deduped = deduplicateByVersionGroup(results);

    expect(deduped.length).toBe(1);
    expect(deduped[0].entry.id).toBe("only");
  });
});
