import { describe, expect, it } from "bun:test";

import {
  cascadeForget,
  DEFAULT_CASCADE_FORGET_CONFIG,
  type CascadeForgetConfig,
} from "../cascade-forget.js";
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
    importance: 0.6,
    timestamp: Date.now() - 7 * 86_400_000,
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

describe("cascade-forget", () => {
  it("returns empty when forgotten entry has no vector", async () => {
    const store = createMockStore([]);
    const result = await cascadeForget(store, {
      id: "forgotten-1",
      vector: [],
      scope: "project:test",
    });
    expect(result.demotedCount).toBe(0);
  });

  it("demotes related entries proportional to similarity", async () => {
    const related1 = makeEntry("rel-1", "high similarity", { importance: 0.6 });
    const related2 = makeEntry("rel-2", "medium similarity", { importance: 0.6 });

    const searchResults: MemorySearchResult[] = [
      { entry: related1, score: 0.95 }, // high sim → big demotion
      { entry: related2, score: 0.75 }, // lower sim → small demotion
    ];
    const store = createMockStore([related1, related2], searchResults);

    const result = await cascadeForget(store, {
      id: "forgotten-1",
      vector: [1, 0, 0],
      scope: "project:test",
    });

    expect(result.demotedCount).toBe(2);

    // High similarity (0.95): demotion = 0.3 * (0.95-0.70)/0.30 = 0.25
    // New importance: 0.6 - 0.25 = 0.35
    expect(store.data.get("rel-1")!.importance).toBeCloseTo(0.35, 1);

    // Medium similarity (0.75): demotion = 0.3 * (0.75-0.70)/0.30 = 0.05
    // New importance: 0.6 - 0.05 = 0.55
    expect(store.data.get("rel-2")!.importance).toBeCloseTo(0.55, 1);
  });

  it("skips the forgotten entry itself", async () => {
    const forgotten = makeEntry("forgotten-1", "to be forgotten", { importance: 0.6 });
    const searchResults: MemorySearchResult[] = [
      { entry: forgotten, score: 1.0 },
    ];
    const store = createMockStore([forgotten], searchResults);

    const result = await cascadeForget(store, {
      id: "forgotten-1",
      vector: [1, 0, 0],
      scope: "project:test",
    });

    expect(result.demotedCount).toBe(0);
  });

  it("skips already-archived entries", async () => {
    const archived = makeEntry("arch-1", "archived", {
      importance: 0.6,
      metadata: JSON.stringify({ state: "archived" }),
    });
    const searchResults: MemorySearchResult[] = [
      { entry: archived, score: 0.9 },
    ];
    const store = createMockStore([archived], searchResults);

    const result = await cascadeForget(store, {
      id: "forgotten-1",
      vector: [1, 0, 0],
      scope: "project:test",
    });

    expect(result.demotedCount).toBe(0);
  });

  it("respects importance floor", async () => {
    const lowEntry = makeEntry("low-1", "already low", { importance: 0.1 });
    const searchResults: MemorySearchResult[] = [
      { entry: lowEntry, score: 0.95 },
    ];
    const store = createMockStore([lowEntry], searchResults);

    const result = await cascadeForget(store, {
      id: "forgotten-1",
      vector: [1, 0, 0],
      scope: "project:test",
    });

    expect(result.demotedCount).toBe(1);
    // 0.1 - 0.25 = -0.15 → clamped to floor 0.05
    expect(store.data.get("low-1")!.importance).toBe(0.05);
  });

  it("demotes tier when importance drops below threshold", async () => {
    const workingEntry = makeEntry("w-1", "working tier", {
      importance: 0.6,
      metadata: JSON.stringify({ tier: "working" }),
    });
    const searchResults: MemorySearchResult[] = [
      { entry: workingEntry, score: 0.95 },
    ];
    const store = createMockStore([workingEntry], searchResults);

    const result = await cascadeForget(store, {
      id: "forgotten-1",
      vector: [1, 0, 0],
      scope: "project:test",
    });

    expect(result.demotedCount).toBe(1);
    const updatedMeta = JSON.parse(store.data.get("w-1")!.metadata!);
    // Importance drops to ~0.35, below 0.5 → demoted to peripheral
    expect(updatedMeta.tier).toBe("peripheral");
    expect(updatedMeta.cascade_forget).toHaveLength(1);
  });

  it("respects maxDemotePerForget limit", async () => {
    const entries: MemoryEntry[] = [];
    const searchResults: MemorySearchResult[] = [];

    for (let i = 0; i < 20; i++) {
      const e = makeEntry(`rel-${i}`, `entry ${i}`, { importance: 0.6 });
      entries.push(e);
      searchResults.push({ entry: e, score: 0.85 });
    }

    const store = createMockStore(entries, searchResults);

    const result = await cascadeForget(store, {
      id: "forgotten-1",
      vector: [1, 0, 0],
      scope: "project:test",
    });

    expect(result.demotedCount).toBe(10); // default maxDemotePerForget
  });

  it("writes audit trail in metadata", async () => {
    const related = makeEntry("rel-1", "related note", { importance: 0.6 });
    const searchResults: MemorySearchResult[] = [
      { entry: related, score: 0.85 },
    ];
    const store = createMockStore([related], searchResults);

    await cascadeForget(store, {
      id: "forgotten-1",
      vector: [1, 0, 0],
      scope: "project:test",
    });

    const meta = JSON.parse(store.data.get("rel-1")!.metadata!);
    expect(meta.cascade_forget).toHaveLength(1);
    expect(meta.cascade_forget[0].forgottenId).toBe("forgotte"); // first 8 chars
    expect(meta.cascade_forget[0].from).toBe(0.6);
    expect(typeof meta.cascade_forget[0].to).toBe("number");
  });
});
