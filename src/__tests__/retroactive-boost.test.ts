import { describe, expect, it } from "bun:test";

import {
  retroactiveBoost,
  DEFAULT_RETROACTIVE_BOOST_CONFIG,
  type RetroactiveBoostConfig,
} from "../retroactive-boost.js";
import type { MemoryEntry, MemorySearchResult } from "../store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, text: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    text,
    vector: [1, 0, 0],
    category: "events",
    scope: "project:test",
    importance: 0.5,
    timestamp: Date.now() - 7 * 86_400_000, // 7 days old by default
    metadata: "{}",
    ...overrides,
  };
}

function createMockStore(
  entries: MemoryEntry[],
  searchResults: MemorySearchResult[] = [],
) {
  const data = new Map(entries.map(e => [e.id, { ...e }]));
  const updates: Array<{ id: string; importance?: number; metadata?: string }> = [];

  return {
    updates,
    data,
    async vectorSearch(_vector: number[], limit = 5, minScore = 0.3, _scopeFilter?: string[]) {
      return searchResults.filter(r => r.score >= minScore).slice(0, limit);
    },
    async update(id: string, upd: any, _scopeFilter?: string[]) {
      const entry = data.get(id);
      if (!entry) return null;
      if (upd.importance !== undefined) entry.importance = upd.importance;
      if (upd.metadata !== undefined) entry.metadata = upd.metadata;
      updates.push({ id, ...upd });
      return entry;
    },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("retroactive-boost (STC)", () => {
  it("skips when new entry has low importance", async () => {
    const store = createMockStore([]);
    const newEntry = makeEntry("new-1", "low importance note", { importance: 0.5 });

    const result = await retroactiveBoost(store, newEntry);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("below_importance_threshold");
  });

  it("skips when new entry has no vector", async () => {
    const store = createMockStore([]);
    const newEntry = makeEntry("new-1", "important note", {
      importance: 0.9,
      vector: [],
    });

    const result = await retroactiveBoost(store, newEntry);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_vector");
  });

  it("boosts related low-importance old entries", async () => {
    const oldEntry = makeEntry("old-1", "Singapore weather info", {
      importance: 0.3,
      timestamp: Date.now() - 30 * 86_400_000, // 30 days old
    });
    const searchResults: MemorySearchResult[] = [
      { entry: oldEntry, score: 0.85 },
    ];
    const store = createMockStore([oldEntry], searchResults);

    const newEntry = makeEntry("new-1", "I'm moving to Singapore", {
      importance: 0.9,
      vector: [1, 0, 0],
    });

    const result = await retroactiveBoost(store, newEntry);
    expect(result.triggered).toBe(true);
    expect(result.boostedCount).toBe(1);
    expect(result.boostedIds).toContain("old-1");

    // Verify the update was applied
    expect(store.updates.length).toBe(1);
    expect(store.updates[0].importance).toBe(0.3 + 0.15); // 0.45
  });

  it("does not boost entries that are already high importance", async () => {
    const highEntry = makeEntry("high-1", "already important", {
      importance: 0.7,
      timestamp: Date.now() - 30 * 86_400_000,
    });
    const searchResults: MemorySearchResult[] = [
      { entry: highEntry, score: 0.85 },
    ];
    const store = createMockStore([highEntry], searchResults);

    const newEntry = makeEntry("new-1", "trigger", { importance: 0.9, vector: [1, 0, 0] });

    const result = await retroactiveBoost(store, newEntry);
    expect(result.triggered).toBe(true);
    expect(result.boostedCount).toBe(0); // high-1 was already above threshold
  });

  it("does not boost very recent entries", async () => {
    const recentEntry = makeEntry("recent-1", "just stored", {
      importance: 0.3,
      timestamp: Date.now() - 3_600_000, // 1 hour old
    });
    const searchResults: MemorySearchResult[] = [
      { entry: recentEntry, score: 0.85 },
    ];
    const store = createMockStore([recentEntry], searchResults);

    const newEntry = makeEntry("new-1", "trigger", { importance: 0.9, vector: [1, 0, 0] });

    const result = await retroactiveBoost(store, newEntry);
    expect(result.triggered).toBe(true);
    expect(result.boostedCount).toBe(0); // too recent
  });

  it("caps boosted importance at maxBoostedImportance", async () => {
    const oldEntry = makeEntry("old-1", "related note", {
      importance: 0.55,
      timestamp: Date.now() - 30 * 86_400_000,
    });
    const searchResults: MemorySearchResult[] = [
      { entry: oldEntry, score: 0.85 },
    ];
    const store = createMockStore([oldEntry], searchResults);

    const newEntry = makeEntry("new-1", "trigger", { importance: 0.9, vector: [1, 0, 0] });

    const config: RetroactiveBoostConfig = {
      ...DEFAULT_RETROACTIVE_BOOST_CONFIG,
      boostAmount: 0.3,           // would push to 0.85
      maxBoostedImportance: 0.75, // but capped at 0.75
    };

    const result = await retroactiveBoost(store, newEntry, config);
    expect(result.boostedCount).toBe(1);
    expect(store.updates[0].importance).toBe(0.75); // capped
  });

  it("promotes tier from peripheral to working when boosted above 0.5", async () => {
    const oldEntry = makeEntry("old-1", "peripheral memory", {
      importance: 0.3,
      timestamp: Date.now() - 30 * 86_400_000,
      metadata: JSON.stringify({ tier: "peripheral" }),
    });
    const searchResults: MemorySearchResult[] = [
      { entry: oldEntry, score: 0.85 },
    ];
    const store = createMockStore([oldEntry], searchResults);

    const newEntry = makeEntry("new-1", "important trigger", { importance: 0.9, vector: [1, 0, 0] });

    const config: RetroactiveBoostConfig = {
      ...DEFAULT_RETROACTIVE_BOOST_CONFIG,
      boostAmount: 0.25, // 0.3 + 0.25 = 0.55 > 0.5
    };

    const result = await retroactiveBoost(store, newEntry, config);
    expect(result.boostedCount).toBe(1);

    // Check metadata for tier promotion
    const updatedMeta = JSON.parse(store.updates[0].metadata);
    expect(updatedMeta.tier).toBe("working");
    expect(updatedMeta.stc_boosts).toHaveLength(1);
    expect(updatedMeta.stc_boosts[0].triggeredBy).toBe("new-1".slice(0, 8));
  });

  it("respects maxBoostPerTrigger limit", async () => {
    const entries: MemoryEntry[] = [];
    const searchResults: MemorySearchResult[] = [];

    for (let i = 0; i < 10; i++) {
      const e = makeEntry(`old-${i}`, `entry ${i}`, {
        importance: 0.3,
        timestamp: Date.now() - 30 * 86_400_000,
      });
      entries.push(e);
      searchResults.push({ entry: e, score: 0.85 - i * 0.01 });
    }

    const store = createMockStore(entries, searchResults);
    const newEntry = makeEntry("new-1", "trigger", { importance: 0.9, vector: [1, 0, 0] });

    const result = await retroactiveBoost(store, newEntry);
    expect(result.boostedCount).toBe(5); // default maxBoostPerTrigger
  });

  it("skips self in search results", async () => {
    const newEntry = makeEntry("new-1", "I'm important", {
      importance: 0.9,
      vector: [1, 0, 0],
    });
    // Search returns the new entry itself
    const searchResults: MemorySearchResult[] = [
      { entry: newEntry, score: 1.0 },
    ];
    const store = createMockStore([newEntry], searchResults);

    const result = await retroactiveBoost(store, newEntry);
    expect(result.triggered).toBe(true);
    expect(result.boostedCount).toBe(0);
  });
});
