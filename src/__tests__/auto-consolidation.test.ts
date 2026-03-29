import { describe, expect, it, beforeEach } from "bun:test";

import {
  maybeConsolidate,
  resetConsolidationState,
  DEFAULT_AUTO_CONSOLIDATION_CONFIG,
  type AutoConsolidationConfig,
} from "../auto-consolidation.js";
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
    importance: 0.7,
    timestamp: Date.now(),
    metadata: "{}",
    ...overrides,
  };
}

function createMockStore(entries: MemoryEntry[]) {
  const data = new Map(entries.map(e => [e.id, { ...e }]));
  return {
    async list(scopeFilter?: string[], _category?: string, limit = 500, _offset = 0) {
      return [...data.values()]
        .filter(e => !scopeFilter || scopeFilter.some(s => e.scope === s))
        .slice(0, limit);
    },
    async getById(id: string) {
      return data.get(id) ?? null;
    },
    async vectorSearch(_vector: number[], _limit = 5, _minScore = 0.3, _scopeFilter?: string[]) {
      return [] as MemorySearchResult[];
    },
    async update(id: string, updates: any, _scopeFilter?: string[]) {
      const entry = data.get(id);
      if (!entry) return null;
      Object.assign(entry, updates);
      return entry;
    },
    async stats(scopeFilter?: string[]) {
      const filtered = [...data.values()].filter(
        e => !scopeFilter || scopeFilter.some(s => e.scope === s),
      );
      return { total: filtered.length, byCategory: {}, byScope: {} };
    },
    hasFtsSupport: false,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auto-consolidation", () => {
  beforeEach(() => {
    resetConsolidationState();
  });

  it("skips when not enough new memories", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry(`id-${i}`, `memory ${i}`),
    );
    const store = createMockStore(entries);

    const result = await maybeConsolidate(store, "project:test");
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("insufficient_new_memories");
  });

  it("skips when too soon since last run", async () => {
    // Start with 60 entries, trigger first run, then grow to 120 so
    // the memory-count gate passes but the time gate blocks.
    const data: MemoryEntry[] = Array.from({ length: 60 }, (_, i) =>
      makeEntry(`id-${i}`, `memory ${i}`),
    );
    const store = createMockStore(data);

    const config: AutoConsolidationConfig = {
      minNewMemories: 50,
      minHoursSinceLastRun: 12,
      consolidation: DEFAULT_AUTO_CONSOLIDATION_CONFIG.consolidation,
    };

    // First run: triggers (never run before, 60 > 50 new memories)
    const first = await maybeConsolidate(store, "project:test", config);
    expect(first.triggered).toBe(true);

    // Grow the store so memory-count gate would pass
    for (let i = 60; i < 120; i++) {
      data.push(makeEntry(`id-${i}`, `memory ${i}`));
    }
    const bigStore = createMockStore(data);

    // Second run immediately: time gate blocks (< 12 hours)
    const second = await maybeConsolidate(bigStore, "project:test", config);
    expect(second.triggered).toBe(false);
    expect(second.reason).toBe("too_soon");
  });

  it("triggers when both conditions met", async () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      makeEntry(`id-${i}`, `memory ${i}`),
    );
    const store = createMockStore(entries);

    const config: AutoConsolidationConfig = {
      minNewMemories: 50,
      minHoursSinceLastRun: 0, // disable time gate for test
      consolidation: {
        clusterThreshold: 0.82,
        mergeThreshold: 0.92,
        maxEntriesPerRun: 500,
      },
    };

    const result = await maybeConsolidate(store, "project:test", config);
    expect(result.triggered).toBe(true);
    expect(result.consolidation).toBeDefined();
    expect(result.consolidation!.scope).toBe("project:test");
  });

  it("returns consolidation result when triggered", async () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      makeEntry(`id-${i}`, `memory ${i}`),
    );
    const store = createMockStore(entries);

    const config: AutoConsolidationConfig = {
      minNewMemories: 50,
      minHoursSinceLastRun: 0,
      consolidation: {
        clusterThreshold: 0.82,
        mergeThreshold: 0.92,
        maxEntriesPerRun: 500,
      },
    };

    const result = await maybeConsolidate(store, "project:test", config);
    expect(result.triggered).toBe(true);
    expect(result.consolidation!.originalCount).toBe(60);
  });

  it("respects custom thresholds", async () => {
    const entries = Array.from({ length: 200 }, (_, i) =>
      makeEntry(`id-${i}`, `memory ${i}`),
    );
    const store = createMockStore(entries);

    const config: AutoConsolidationConfig = {
      minNewMemories: 300, // higher than available
      minHoursSinceLastRun: 0,
      consolidation: DEFAULT_AUTO_CONSOLIDATION_CONFIG.consolidation,
    };

    const result = await maybeConsolidate(store, "project:test", config);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("insufficient_new_memories");
  });
});
