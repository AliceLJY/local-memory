/**
 * Tests for Tier 3.6: Preference Pattern Quick Matching
 *
 * Validates:
 * 1. matchPreference returns "create" when no similar preferences exist
 * 2. matchPreference returns "skip" for near-duplicate preferences (no LLM)
 * 3. matchPreference uses LLM when available for decision
 * 4. matchPreference returns "merge" with merged text from LLM
 * 5. matchPreference handles LLM failure gracefully
 * 6. applyPreferenceMatch handles merge and skip correctly
 * 7. Non-preference categories are not filtered
 */
import { describe, expect, it } from "bun:test";
import {
  matchPreference,
  applyPreferenceMatch,
  DEFAULT_PREFERENCE_MATCHER_CONFIG,
} from "../preference-matcher.js";
import type { MemoryEntry, MemorySearchResult } from "../store.js";
import type { LLMClient, DedupDecision } from "../llm-client.js";
import { parseEvolution } from "../memory-evolution.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, text: string, category = "preferences"): MemoryEntry {
  return {
    id,
    text,
    vector: [1, 0, 0],
    category,
    scope: "project:test",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: "{}",
  };
}

function createMockStore(searchResults: MemorySearchResult[] = []) {
  const updates: Array<{ id: string; text?: string; metadata?: string }> = [];
  const archived: MemoryEntry[] = [];
  const data = new Map<string, MemoryEntry>();
  for (const r of searchResults) {
    data.set(r.entry.id, { ...r.entry });
  }

  return {
    updates,
    archived,
    data,
    async vectorSearch(
      _vector: number[],
      _limit: number,
      _minScore: number,
      _scopeFilter?: string[],
    ) {
      return searchResults;
    },
    async getById(id: string) {
      return data.get(id) ?? null;
    },
    // Belief-history rows land here rather than in `data` — merging must archive the
    // version it replaces, so tests need to see what was written.
    async upsert(entry: MemoryEntry) {
      archived.push(entry);
      return entry;
    },
    async store(entry: MemoryEntry) {
      archived.push(entry);
      return entry;
    },
    async update(id: string, upd: { text?: string; metadata?: string }, _scope?: string[]) {
      const entry = data.get(id);
      if (!entry) return null;
      if (upd.text) {
        entry.text = upd.text;
      }
      if (upd.metadata) {
        entry.metadata = upd.metadata;
      }
      updates.push({ id, text: upd.text, metadata: upd.metadata });
      return entry;
    },
  };
}

const mockDeps = {
  embedder: {
    async embedPassage(text: string) {
      return [text.length, 1, 0];
    },
  },
};

function createMockLLM(dedupResult: DedupDecision, synthResult: string | null = "merged preference text"): LLMClient {
  return {
    async dedupDecision(_newText: string, _existingText: string) {
      return dedupResult;
    },
    async synthesizeFragments(_fragments: string[], _query: string) {
      return synthResult;
    },
  } as any;
}

// ---------------------------------------------------------------------------
// matchPreference tests
// ---------------------------------------------------------------------------

describe("matchPreference", () => {
  const vector = [1, 0, 0];
  const scope = "project:test";

  it("returns create when no similar preferences found", async () => {
    const store = createMockStore([]);
    const result = await matchPreference("I prefer dark mode", vector, scope, store as any, null);

    expect(result.action).toBe("create");
    expect(result.reason).toBe("no-similar-preferences");
  });

  it("ignores superseded belief-history rows as match candidates", async () => {
    // store.vectorSearch() filters by scope only, so archived versions of a preference
    // surface here alongside live ones. Matching against one would drop the incoming
    // preference as a duplicate of a belief that is no longer held.
    const archivedRow = makeEntry("p-old", "I prefer dark mode");
    archivedRow.metadata = JSON.stringify({
      evolution: { status: "superseded", validUntil: Date.now(), supersededBy: "p-live" },
    });
    const store = createMockStore([{ entry: archivedRow, score: 0.99 }]);

    const result = await matchPreference("I prefer dark mode", vector, scope, store as any, null);

    expect(result.action).toBe("create");
    expect(result.reason).toBe("no-similar-preferences");
  });

  it("returns create when matches are non-preference category", async () => {
    const store = createMockStore([
      { entry: makeEntry("e1", "some entity", "entities"), score: 0.85 },
    ]);
    const result = await matchPreference("I prefer dark mode", vector, scope, store as any, null);

    expect(result.action).toBe("create");
    expect(result.reason).toBe("no-similar-preferences");
  });

  it("returns skip for high similarity without LLM", async () => {
    const store = createMockStore([
      { entry: makeEntry("p1", "User prefers dark mode"), score: 0.95 },
    ]);
    const result = await matchPreference("I like dark mode", vector, scope, store as any, null);

    expect(result.action).toBe("skip");
    expect(result.reason).toContain("no-llm");
  });

  it("returns create for moderate similarity without LLM", async () => {
    const store = createMockStore([
      { entry: makeEntry("p1", "User prefers dark mode"), score: 0.82 },
    ]);
    const result = await matchPreference("I like vim keybindings", vector, scope, store as any, null);

    expect(result.action).toBe("create");
    expect(result.reason).toContain("no-llm");
  });

  it("uses LLM to decide SKIP", async () => {
    const store = createMockStore([
      { entry: makeEntry("p1", "User prefers dark mode"), score: 0.85 },
    ]);
    const llm = createMockLLM({ action: "SKIP", reason: "same preference" });

    const result = await matchPreference("I like dark mode", vector, scope, store as any, llm);

    expect(result.action).toBe("skip");
    expect(result.reason).toContain("llm-skip");
  });

  it("uses LLM to decide MERGE and generates merged text", async () => {
    const store = createMockStore([
      { entry: makeEntry("p1", "User prefers dark mode"), score: 0.85 },
    ]);
    const llm = createMockLLM(
      { action: "MERGE", reason: "compatible preferences" },
      "User prefers dark mode and compact layout",
    );

    const result = await matchPreference("I also like compact layout", vector, scope, store as any, llm);

    expect(result.action).toBe("merge");
    expect(result.mergeTargetId).toBe("p1");
    expect(result.mergedText).toBe("User prefers dark mode and compact layout");
  });

  it("uses LLM to decide CREATE", async () => {
    const store = createMockStore([
      { entry: makeEntry("p1", "User prefers dark mode"), score: 0.80 },
    ]);
    const llm = createMockLLM({ action: "CREATE", reason: "different preference" });

    const result = await matchPreference("I prefer vim keybindings", vector, scope, store as any, llm);

    expect(result.action).toBe("create");
    expect(result.reason).toContain("llm-create");
  });

  it("falls back to create on LLM failure", async () => {
    const store = createMockStore([
      { entry: makeEntry("p1", "User prefers dark mode"), score: 0.85 },
    ]);
    const llm = {
      async dedupDecision() { throw new Error("LLM down"); },
      async synthesizeFragments() { return null; },
    } as any;

    const result = await matchPreference("test pref", vector, scope, store as any, llm);

    expect(result.action).toBe("create");
    expect(result.reason).toBe("llm-error");
  });
});

// ---------------------------------------------------------------------------
// applyPreferenceMatch tests
// ---------------------------------------------------------------------------

describe("applyPreferenceMatch", () => {
  it("handles skip action", async () => {
    const store = createMockStore([]);
    const result = await applyPreferenceMatch(
      { action: "skip", reason: "duplicate" },
      store as any,
      "project:test",
      mockDeps,
    );

    expect(result.handled).toBe(true);
    expect(result.entry).toBeUndefined();
  });

  it("handles merge action — updates existing entry text", async () => {
    const existing = makeEntry("p1", "old preference text");
    const store = createMockStore([{ entry: existing, score: 0.9 }]);

    const result = await applyPreferenceMatch(
      {
        action: "merge",
        mergeTargetId: "p1",
        mergedText: "merged preference text",
        reason: "llm-merge",
      },
      store as any,
      "project:test",
      mockDeps,
    );

    expect(result.handled).toBe(true);
    expect(result.entry).toBeDefined();
    expect(store.updates.length).toBe(1);
    expect(store.updates[0].text).toBe("merged preference text");

    // Merging replaces the target's wording — the pre-merge version must survive.
    expect(store.archived).toHaveLength(1);
    expect(store.archived[0].text).toBe("old preference text");
    expect(parseEvolution(store.archived[0].metadata).status).toBe("superseded");
    expect(parseEvolution(store.updates[0].metadata).supersedes).toBe(store.archived[0].id);
  });

  it("returns not handled for create action", async () => {
    const store = createMockStore([]);
    const result = await applyPreferenceMatch(
      { action: "create", reason: "new" },
      store as any,
      "project:test",
      mockDeps,
    );

    expect(result.handled).toBe(false);
  });
});
