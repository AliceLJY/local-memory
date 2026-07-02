/**
 * Tests for Memory Evolution Phase B-2 (Archive Strategy),
 * B-3 (LLM Importance Assessment), and E-1 (Multi-factor Retrieval Scoring).
 */
import { describe, expect, test } from "bun:test";
import {
  parseEvolution,
  computeDecayScore,
  computeUsageAdjustedDecayScore,
  buildArchivedMetadata,
  isActiveMemory,
  patchEvolution,
  type EvolutionMetadata,
} from "../memory-evolution.js";
import {
  maybeRunGc,
  resetGcTimestamp,
  DEFAULT_AUTO_GC_CONFIG,
  type AutoGcConfig,
} from "../auto-gc.js";

// ---------------------------------------------------------------------------
// B-2: Archive Strategy Tests
// ---------------------------------------------------------------------------

describe("B-2: Archive Strategy", () => {
  test("buildArchivedMetadata sets status to archived", () => {
    const meta = JSON.stringify({ evolution: { status: "active", version: 1 } });
    const archived = buildArchivedMetadata(meta);
    const evo = parseEvolution(archived);
    expect(evo.status).toBe("archived");
  });

  test("archived memory is not active", () => {
    const meta = JSON.stringify({ evolution: { status: "archived", version: 1 } });
    expect(isActiveMemory(meta)).toBe(false);
  });

  test("active memory is active", () => {
    const meta = JSON.stringify({ evolution: { status: "active", version: 1 } });
    expect(isActiveMemory(meta)).toBe(true);
  });

  describe("auto-gc with evolution system", () => {
    function makeStore(entries: Array<{
      id: string;
      importance: number;
      timestamp: number;
      metadata: string;
    }>) {
      const data = new Map(entries.map(e => [e.id, {
        ...e,
        text: "test",
        vector: [1, 0, 0],
        category: "events",
        scope: "project:test",
      }]));
      const updates: Array<{ id: string; metadata: string }> = [];
      return {
        store: {
          stats: async () => ({ totalCount: data.size, scopeCounts: {}, categoryCounts: {} }),
          list: async () => Array.from(data.values()),
          listPage: async (opts: { limit?: number; offset?: number } = {}) => {
            const { limit = 1000, offset = 0 } = opts;
            return Array.from(data.values()).slice(offset, offset + limit);
          },
          update: async (id: string, patch: { metadata: string }) => {
            updates.push({ id, metadata: patch.metadata });
            const entry = data.get(id);
            if (!entry) return null;
            entry.metadata = patch.metadata;
            return entry;
          },
        },
        updates,
      };
    }

    test("archives low-decay-score memories", async () => {
      resetGcTimestamp();
      const now = Date.now();
      const oldTimestamp = now - 120 * 86_400_000; // 120 days ago
      const activeMeta = JSON.stringify({
        evolution: {
          status: "active",
          version: 1,
          accessCount: 0,
          lastAccessedAt: null,
          validFrom: oldTimestamp,
          validUntil: null,
        },
      });

      const { store, updates } = makeStore([
        { id: "old-low", importance: 0.1, timestamp: oldTimestamp, metadata: activeMeta },
      ]);

      const config: AutoGcConfig = {
        ...DEFAULT_AUTO_GC_CONFIG,
        minMemoryCount: 1,
        minHoursSinceLastGc: 0,
        decayScoreThreshold: 0.2,
        minAgeDays: 30,
      };

      const result = await maybeRunGc(store as any, config);
      expect(result.triggered).toBe(true);
      expect(result.archivedCount).toBe(1);
      expect(updates.length).toBe(1);

      const archivedEvo = parseEvolution(updates[0].metadata);
      expect(archivedEvo.status).toBe("archived");
    });

    test("skips pinned memories (importance >= 0.95)", async () => {
      resetGcTimestamp();
      const now = Date.now();
      const oldTimestamp = now - 120 * 86_400_000;
      const activeMeta = JSON.stringify({
        evolution: {
          status: "active",
          version: 1,
          accessCount: 0,
          lastAccessedAt: null,
          validFrom: oldTimestamp,
          validUntil: null,
        },
      });

      const { store, updates } = makeStore([
        { id: "pinned", importance: 0.95, timestamp: oldTimestamp, metadata: activeMeta },
      ]);

      const config: AutoGcConfig = {
        ...DEFAULT_AUTO_GC_CONFIG,
        minMemoryCount: 1,
        minHoursSinceLastGc: 0,
      };

      const result = await maybeRunGc(store as any, config);
      expect(result.triggered).toBe(true);
      expect(result.archivedCount).toBe(0);
      expect(updates.length).toBe(0);
    });

    test("usage-adjusted GC is gated and can archive cold high-frequency memories", async () => {
      const savedUsageDecay = process.env.RECALLNEST_USAGE_DECAY;
      const savedConstructive = process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL;
      try {
        const now = Date.now();
        const oldTimestamp = now - 180 * 86_400_000;
        const coldMeta = JSON.stringify({
          accessCount: 10,
          evolution: {
            status: "active",
            version: 1,
            accessCount: 10,
            lastAccessedAt: now,
            validFrom: oldTimestamp,
            validUntil: null,
          },
        });
        const config: AutoGcConfig = {
          ...DEFAULT_AUTO_GC_CONFIG,
          minMemoryCount: 1,
          minHoursSinceLastGc: 0,
          decayScoreThreshold: 0.15,
          minAgeDays: 30,
        };

        delete process.env.RECALLNEST_USAGE_DECAY;
        delete process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL;
        resetGcTimestamp();
        const withoutFlag = makeStore([
          { id: "cold-no-flag", importance: 0.05, timestamp: oldTimestamp, metadata: coldMeta },
        ]);
        const baseline = await maybeRunGc(withoutFlag.store as any, config);
        expect(baseline.archivedCount).toBe(0);
        expect(withoutFlag.updates).toHaveLength(0);

        process.env.RECALLNEST_USAGE_DECAY = "true";
        process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL = "true";
        resetGcTimestamp();
        const withFlag = makeStore([
          { id: "cold-with-flag", importance: 0.05, timestamp: oldTimestamp, metadata: coldMeta },
        ]);
        const adjusted = await maybeRunGc(withFlag.store as any, config);
        expect(adjusted.archivedCount).toBe(1);
        expect(withFlag.updates).toHaveLength(1);
      } finally {
        if (savedUsageDecay === undefined) delete process.env.RECALLNEST_USAGE_DECAY;
        else process.env.RECALLNEST_USAGE_DECAY = savedUsageDecay;
        if (savedConstructive === undefined) delete process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL;
        else process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL = savedConstructive;
      }
    });

    test("skips recently created memories", async () => {
      resetGcTimestamp();
      const recentMeta = JSON.stringify({
        evolution: {
          status: "active",
          version: 1,
          accessCount: 0,
          lastAccessedAt: null,
          validFrom: Date.now(),
          validUntil: null,
        },
      });

      const { store, updates } = makeStore([
        { id: "recent", importance: 0.1, timestamp: Date.now(), metadata: recentMeta },
      ]);

      const config: AutoGcConfig = {
        ...DEFAULT_AUTO_GC_CONFIG,
        minMemoryCount: 1,
        minHoursSinceLastGc: 0,
        minAgeDays: 30,
      };

      const result = await maybeRunGc(store as any, config);
      expect(result.triggered).toBe(true);
      expect(result.archivedCount).toBe(0);
    });

    test("does not trigger when below memory threshold", async () => {
      resetGcTimestamp();
      const { store } = makeStore([
        { id: "one", importance: 0.1, timestamp: Date.now() - 90 * 86_400_000, metadata: "{}" },
      ]);

      const result = await maybeRunGc(store as any, {
        ...DEFAULT_AUTO_GC_CONFIG,
        minMemoryCount: 1000,
      });
      expect(result.triggered).toBe(false);
      expect(result.reason).toBe("below_memory_threshold");
    });
  });
});

// ---------------------------------------------------------------------------
// E-1: Access Count Boost Tests (via computeDecayScore)
// ---------------------------------------------------------------------------

describe("E-1: Multi-factor Retrieval Scoring", () => {
  test("higher accessCount produces higher decay score", () => {
    const base: EvolutionMetadata = {
      status: "active",
      version: 1,
      accessCount: 0,
      lastAccessedAt: null,
      supersededBy: null,
      consolidatedInto: null,
      sourceMemories: [],
      validFrom: Date.now() - 30 * 86_400_000,
      validUntil: null,
    };
    const lowAccess = computeDecayScore(base, 0.5);
    const highAccess = computeDecayScore({ ...base, accessCount: 10, lastAccessedAt: Date.now() }, 0.5);
    expect(highAccess).toBeGreaterThan(lowAccess);
  });

  test("higher importance produces higher decay score", () => {
    const base: EvolutionMetadata = {
      status: "active",
      version: 1,
      accessCount: 2,
      lastAccessedAt: Date.now() - 86_400_000,
      supersededBy: null,
      consolidatedInto: null,
      sourceMemories: [],
      validFrom: Date.now() - 30 * 86_400_000,
      validUntil: null,
    };
    const lowImportance = computeDecayScore(base, 0.3);
    const highImportance = computeDecayScore(base, 0.9);
    expect(highImportance).toBeGreaterThan(lowImportance);
  });

  test("older memories without access have lower decay scores", () => {
    const recent: EvolutionMetadata = {
      status: "active",
      version: 1,
      accessCount: 0,
      lastAccessedAt: null,
      supersededBy: null,
      consolidatedInto: null,
      sourceMemories: [],
      validFrom: Date.now() - 7 * 86_400_000,
      validUntil: null,
    };
    const old: EvolutionMetadata = {
      ...recent,
      validFrom: Date.now() - 180 * 86_400_000,
    };
    expect(computeDecayScore(recent, 0.5)).toBeGreaterThan(computeDecayScore(old, 0.5));
  });
});

describe("P0 B-2: usage-adjusted GC scoring", () => {
  const now = Date.now();
  const oldColdEvo: EvolutionMetadata = {
    status: "active",
    version: 1,
    accessCount: 10,
    lastAccessedAt: now,
    supersededBy: null,
    supersedes: null,
    evolutionNote: null,
    consolidatedInto: null,
    contributedToPattern: null,
    sourceMemories: [],
    validFrom: now - 180 * 86_400_000,
    validUntil: null,
    eventTime: null,
  };

  test("discounts frequency only for cold memories in GC scoring", () => {
    const metadata = JSON.stringify({ accessCount: 10 });
    const base = computeDecayScore(oldColdEvo, 0.05, now, metadata);
    const adjusted = computeUsageAdjustedDecayScore(oldColdEvo, 0.05, now, metadata);

    expect(base).toBeGreaterThan(0.15);
    expect(adjusted).toBeLessThan(base);
    expect(adjusted).toBeLessThan(0.15);
  });

  test("does not discount pending reminders or promoted memories", () => {
    const pendingReminder = JSON.stringify({
      accessCount: 10,
      prospective: { status: "pending" },
    });
    const promoted = JSON.stringify({
      accessCount: 10,
      promotedTo: "memory:durable-target",
    });

    expect(computeUsageAdjustedDecayScore(oldColdEvo, 0.05, now, pendingReminder))
      .toBe(computeDecayScore(oldColdEvo, 0.05, now, pendingReminder));
    expect(computeUsageAdjustedDecayScore(oldColdEvo, 0.05, now, promoted))
      .toBe(computeDecayScore(oldColdEvo, 0.05, now, promoted));
  });
});
