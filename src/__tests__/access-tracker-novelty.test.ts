/**
 * Tests for Tier 3.2: Conditional access reinforcement (prediction error gating).
 *
 * Validates that:
 * 1. High-similarity (low-novelty) results are NOT reinforced
 * 2. Low-similarity (high-novelty) results ARE reinforced
 * 3. Cooldown prevents duplicate reinforcement within the window
 * 4. When no scores provided, all entries are reinforced (backward compat)
 * 5. shouldReinforce() logic is correct in isolation
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { AccessTracker, DEFAULT_ACCESS_TRACKER_CONFIG } from "../access-tracker.js";
import type { MemoryEntry } from "../store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    text: `memory-${id}`,
    vector: [1, 0, 0],
    category: "events",
    scope: "project:test",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: JSON.stringify({ accessCount: 0, lastAccessedAt: 0 }),
    ...overrides,
  };
}

function createMockStore(entries: MemoryEntry[]) {
  const data = new Map(entries.map(e => [e.id, { ...e }]));
  const updates: Array<{ id: string; metadata?: string }> = [];

  return {
    updates,
    data,
    async getById(id: string) {
      return data.get(id) ?? null;
    },
    async update(id: string, upd: { metadata?: string }) {
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
// shouldReinforce() unit tests
// ---------------------------------------------------------------------------

describe("shouldReinforce", () => {
  let tracker: AccessTracker;

  beforeEach(() => {
    tracker = new AccessTracker(
      createMockStore([]) as any,
      { ...DEFAULT_ACCESS_TRACKER_CONFIG, noveltyThreshold: 0.35, cooldownMs: 300_000 },
    );
  });

  it("rejects high-similarity (low-novelty) results", () => {
    // similarity 0.90 → novelty 0.10 < threshold 0.35 → reject
    expect(tracker.shouldReinforce("a", 0.90)).toBe(false);
  });

  it("rejects exact match (similarity 1.0)", () => {
    expect(tracker.shouldReinforce("a", 1.0)).toBe(false);
  });

  it("accepts low-similarity (high-novelty) results", () => {
    // similarity 0.50 → novelty 0.50 > threshold 0.35 → accept
    expect(tracker.shouldReinforce("a", 0.50)).toBe(true);
  });

  it("accepts borderline novelty (exactly at threshold)", () => {
    // similarity 0.65 → novelty 0.35 = threshold 0.35 → accept (not strictly less)
    expect(tracker.shouldReinforce("a", 0.65)).toBe(true);
  });

  it("rejects same entry within cooldown window", () => {
    // First call: accepted
    expect(tracker.shouldReinforce("a", 0.50)).toBe(true);
    // Simulate recording to set cooldown
    tracker.recordAccess(["a"], [0.50]);
    // Second call within cooldown: rejected
    expect(tracker.shouldReinforce("a", 0.50)).toBe(false);
  });

  it("accepts different entry even if another is on cooldown", () => {
    tracker.recordAccess(["a"], [0.50]);
    expect(tracker.shouldReinforce("b", 0.50)).toBe(true);
  });

  it("bypasses novelty gate when threshold is 0", () => {
    const noGateTracker = new AccessTracker(
      createMockStore([]) as any,
      { ...DEFAULT_ACCESS_TRACKER_CONFIG, noveltyThreshold: 0, cooldownMs: 0 },
    );
    // Even high similarity passes
    expect(noGateTracker.shouldReinforce("a", 0.99)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recordAccess() with scores
// ---------------------------------------------------------------------------

describe("recordAccess with novelty gating", () => {
  it("only queues novel entries for flush", async () => {
    const entries = [makeEntry("a"), makeEntry("b"), makeEntry("c")];
    const store = createMockStore(entries);
    const tracker = new AccessTracker(store as any, {
      ...DEFAULT_ACCESS_TRACKER_CONFIG,
      flushIntervalMs: 0, // immediate flush for testing
      noveltyThreshold: 0.35,
      cooldownMs: 0,
    });

    // scores: a=0.90 (low novelty, reject), b=0.50 (novel, accept), c=0.40 (novel, accept)
    tracker.recordAccess(["a", "b", "c"], [0.90, 0.50, 0.40]);

    await tracker.flush();

    // Only b and c should have been updated
    const updatedIds = store.updates.map(u => u.id);
    expect(updatedIds).not.toContain("a");
    expect(updatedIds).toContain("b");
    expect(updatedIds).toContain("c");
  });

  it("reinforces all entries when no scores provided (backward compat)", async () => {
    const entries = [makeEntry("a"), makeEntry("b")];
    const store = createMockStore(entries);
    const tracker = new AccessTracker(store as any, {
      ...DEFAULT_ACCESS_TRACKER_CONFIG,
      flushIntervalMs: 0,
      noveltyThreshold: 0.35,
      cooldownMs: 0,
    });

    // No scores → all reinforced
    tracker.recordAccess(["a", "b"]);
    await tracker.flush();

    const updatedIds = store.updates.map(u => u.id);
    expect(updatedIds).toContain("a");
    expect(updatedIds).toContain("b");
  });

  it("respects cooldown across multiple recordAccess calls", async () => {
    const entries = [makeEntry("x")];
    const store = createMockStore(entries);
    const tracker = new AccessTracker(store as any, {
      ...DEFAULT_ACCESS_TRACKER_CONFIG,
      flushIntervalMs: 0,
      noveltyThreshold: 0.35,
      cooldownMs: 600_000, // 10 min cooldown
    });

    // First call: novel enough → queued
    tracker.recordAccess(["x"], [0.50]);
    await tracker.flush();
    expect(store.updates.length).toBe(1);

    // Second call: same entry within cooldown → not queued
    tracker.recordAccess(["x"], [0.50]);
    await tracker.flush();
    // Still only 1 update (no new flush)
    expect(store.updates.length).toBe(1);
  });

  it("skips flush scheduling when all entries are gated out", () => {
    const store = createMockStore([]);
    const tracker = new AccessTracker(store as any, {
      ...DEFAULT_ACCESS_TRACKER_CONFIG,
      flushIntervalMs: 5000,
      noveltyThreshold: 0.35,
      cooldownMs: 0,
    });

    // All scores too high (low novelty) → nothing queued
    tracker.recordAccess(["a", "b"], [0.95, 0.90]);
    expect(tracker.pendingCount).toBe(0);
  });

  it("accessCount increments correctly after novelty-gated flush", async () => {
    const entries = [makeEntry("m1")];
    const store = createMockStore(entries);
    const tracker = new AccessTracker(store as any, {
      ...DEFAULT_ACCESS_TRACKER_CONFIG,
      flushIntervalMs: 0,
      noveltyThreshold: 0.35,
      cooldownMs: 0,
    });

    tracker.recordAccess(["m1"], [0.40]); // novel → accepted
    await tracker.flush();

    const updated = store.data.get("m1")!;
    const meta = JSON.parse(updated.metadata);
    expect(meta.accessCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// destroy() cleans cooldown
// ---------------------------------------------------------------------------

describe("destroy cleans cooldown", () => {
  it("clears cooldown map on destroy", () => {
    const tracker = new AccessTracker(
      createMockStore([]) as any,
      { ...DEFAULT_ACCESS_TRACKER_CONFIG, cooldownMs: 600_000 },
    );
    tracker.recordAccess(["a"], [0.40]);
    tracker.destroy();
    // After destroy, same entry should be reinforceable again
    expect(tracker.shouldReinforce("a", 0.40)).toBe(true);
  });
});
