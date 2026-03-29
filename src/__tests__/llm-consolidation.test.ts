/**
 * Tests for Tier 3.7: LLM-Driven Consolidation
 *
 * Validates:
 * 1. evaluateCluster returns merge decisions from LLM
 * 2. evaluateCluster falls back conservatively on LLM failure
 * 3. executeMergeDecisions creates version groups for merge groups
 * 4. executeMergeDecisions handles empty merge groups
 * 5. isLLMConsolidationEnabled respects env var
 */
import { describe, expect, it, afterEach } from "bun:test";
import {
  evaluateCluster,
  executeMergeDecisions,
  isLLMConsolidationEnabled,
} from "../llm-consolidation.js";
import type { MemoryEntry } from "../store.js";
import type { LLMClient } from "../llm-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, text: string, importance = 0.7): MemoryEntry {
  return {
    id,
    text,
    vector: [1, 0, 0],
    category: "preferences",
    scope: "project:test",
    importance,
    timestamp: Date.now(),
    metadata: JSON.stringify({ confidence: 0.7, accessCount: 0 }),
  };
}

function createMockStore(entries: MemoryEntry[]) {
  const data = new Map(entries.map(e => [e.id, { ...e }]));
  const updates: Array<{ id: string; metadata: string }> = [];

  return {
    data,
    updates,
    async getById(id: string) { return data.get(id) ?? null; },
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

function createMockLLM(response: string): LLMClient {
  return {
    async synthesizeFragments() {
      return response;
    },
  } as any;
}

// ---------------------------------------------------------------------------
// evaluateCluster
// ---------------------------------------------------------------------------

describe("evaluateCluster", () => {
  it("returns merge groups from LLM response", async () => {
    const entries = [
      makeEntry("a", "User prefers dark mode"),
      makeEntry("b", "User likes dark theme"),
      makeEntry("c", "User uses vim keybindings"),
    ];

    const llm = createMockLLM(JSON.stringify({
      mergeGroups: [[0, 1]],
      keepSeparate: [2],
      reasoning: "0 and 1 express same preference, 2 is different",
    }));

    const decision = await evaluateCluster(llm, entries);

    expect(decision.mergeGroups.length).toBe(1);
    expect(decision.mergeGroups[0]).toEqual([0, 1]);
    expect(decision.keepSeparate).toEqual([2]);
  });

  it("returns conservative fallback on LLM failure", async () => {
    const entries = [makeEntry("a", "text a"), makeEntry("b", "text b")];
    const llm = {
      async synthesizeFragments() { throw new Error("LLM down"); },
    } as any;

    const decision = await evaluateCluster(llm, entries);

    expect(decision.mergeGroups.length).toBe(0);
    expect(decision.keepSeparate.length).toBe(2);
  });

  it("returns conservative fallback on null response", async () => {
    const entries = [makeEntry("a", "text a"), makeEntry("b", "text b")];
    const llm = createMockLLM("");

    // Empty string → null synthesis → fallback
    const decision = await evaluateCluster({ async synthesizeFragments() { return null; } } as any, entries);

    expect(decision.mergeGroups.length).toBe(0);
  });

  it("handles single entry", async () => {
    const entries = [makeEntry("a", "only one")];
    const llm = createMockLLM("{}");

    const decision = await evaluateCluster(llm, entries);

    expect(decision.mergeGroups.length).toBe(0);
    expect(decision.keepSeparate).toEqual([0]);
  });

  it("filters invalid indices from LLM response", async () => {
    const entries = [makeEntry("a", "text a"), makeEntry("b", "text b")];
    const llm = createMockLLM(JSON.stringify({
      mergeGroups: [[0, 5]], // index 5 out of range
      keepSeparate: [0, 1],
      reasoning: "test",
    }));

    const decision = await evaluateCluster(llm, entries);

    // Invalid group should be filtered out
    expect(decision.mergeGroups.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// executeMergeDecisions
// ---------------------------------------------------------------------------

describe("executeMergeDecisions", () => {
  it("creates version groups for merge groups", async () => {
    const entries = [
      makeEntry("a", "dark mode pref", 0.9),
      makeEntry("b", "dark theme pref", 0.5),
      makeEntry("c", "vim pref", 0.7),
    ];
    const store = createMockStore(entries);

    const decision = {
      mergeGroups: [[0, 1]],
      keepSeparate: [2],
      reasoning: "similar preferences",
    };

    const mergeCount = await executeMergeDecisions(store as any, entries, decision, "project:test");

    expect(mergeCount).toBe(1);
    // Both a and b should now have version_group
    const metaA = JSON.parse(store.data.get("a")!.metadata);
    const metaB = JSON.parse(store.data.get("b")!.metadata);
    expect(metaA.version_group).toBeTruthy();
    expect(metaB.version_group).toBe(metaA.version_group);
  });

  it("handles empty merge groups", async () => {
    const entries = [makeEntry("a", "text a")];
    const store = createMockStore(entries);

    const decision = {
      mergeGroups: [],
      keepSeparate: [0],
      reasoning: "nothing to merge",
    };

    const mergeCount = await executeMergeDecisions(store as any, entries, decision, "project:test");

    expect(mergeCount).toBe(0);
  });

  it("handles multi-entry merge group", async () => {
    const entries = [
      makeEntry("a", "pref 1", 0.9),
      makeEntry("b", "pref 2", 0.7),
      makeEntry("c", "pref 3", 0.5),
    ];
    const store = createMockStore(entries);

    const decision = {
      mergeGroups: [[0, 1, 2]],
      keepSeparate: [],
      reasoning: "all same",
    };

    const mergeCount = await executeMergeDecisions(store as any, entries, decision, "project:test");

    // a is canonical, b and c are members → 2 merges
    expect(mergeCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// isLLMConsolidationEnabled
// ---------------------------------------------------------------------------

describe("isLLMConsolidationEnabled", () => {
  const originalEnv = process.env.RECALLNEST_LLM_CONSOLIDATION;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.RECALLNEST_LLM_CONSOLIDATION = originalEnv;
    } else {
      delete process.env.RECALLNEST_LLM_CONSOLIDATION;
    }
  });

  it("returns false when not set", () => {
    delete process.env.RECALLNEST_LLM_CONSOLIDATION;
    expect(isLLMConsolidationEnabled()).toBe(false);
  });

  it("returns true when set to 'true'", () => {
    process.env.RECALLNEST_LLM_CONSOLIDATION = "true";
    expect(isLLMConsolidationEnabled()).toBe(true);
  });
});
