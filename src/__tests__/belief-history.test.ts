import { describe, expect, it } from "bun:test";

import { archiveBeliefVersion } from "../belief-history.js";
import { persistMemory } from "../capture-engine.js";
import { isActiveMemory, parseEvolution, traceEvolution } from "../memory-evolution.js";

const TEST_SCOPE = "project:test";
const CANONICAL_KEY = "user.reply.style";

/**
 * Store double that mirrors the real MemoryStore where belief history depends on it:
 * store() stamps its own id/timestamp, upsert() honours both, and list() strips vectors
 * (which is why archiving has to re-read or re-embed).
 */
function createDeps(options: { withUpsert?: boolean; withGetById?: boolean } = {}) {
  const { withUpsert = true, withGetById = true } = options;
  const storedEntries: any[] = [];
  const embedCalls: string[] = [];
  let seq = 1;

  const store: Record<string, unknown> = {
    async store(entry: any) {
      const stored = {
        ...entry,
        id: entry.id ?? `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
        timestamp: 1_700_000_000_000 + seq,
      };
      seq += 1;
      storedEntries.push(stored);
      return stored;
    },
    async list(_scopeFilter?: string[], category?: string, limit = 20, offset = 0) {
      return storedEntries
        .filter((entry) => !category || entry.category === category)
        // The real store drops vectors from list results for performance.
        .map((entry) => ({ ...entry, vector: [] }))
        .slice(offset, offset + limit);
    },
    async update(id: string, updates: any) {
      const index = storedEntries.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      storedEntries[index] = {
        ...storedEntries[index],
        ...updates,
        timestamp: updates.timestamp ?? storedEntries[index].timestamp,
      };
      return storedEntries[index];
    },
  };

  if (withUpsert) {
    store.upsert = async (entry: any) => {
      const index = storedEntries.findIndex((item) => item.id === entry.id);
      if (index >= 0) storedEntries[index] = { ...entry };
      else storedEntries.push({ ...entry });
      return entry;
    };
  }
  if (withGetById) {
    store.getById = async (id: string) => storedEntries.find((entry) => entry.id === id) || null;
  }

  return {
    storedEntries,
    embedCalls,
    deps: {
      store,
      embedder: {
        async embedPassage(text: string) {
          embedCalls.push(text);
          return [text.length, 1, 0];
        },
      },
    },
  };
}

async function writeBelief(deps: unknown, text: string) {
  return await persistMemory(deps as any, {
    text,
    category: "preferences",
    scope: TEST_SCOPE,
    source: "manual",
    canonicalKey: CANONICAL_KEY,
  });
}

describe("belief history", () => {
  it("keeps every superseded version when a belief changes repeatedly", async () => {
    const { deps, storedEntries } = createDeps();

    const first = await writeBelief(deps, "User prefers long, thorough replies");
    await writeBelief(deps, "User prefers concise replies");
    await writeBelief(deps, "User prefers concise, code-first replies");

    // One live canonical row + two archived versions — nothing was overwritten away.
    expect(storedEntries).toHaveLength(3);

    const canonical = storedEntries.find((entry) => entry.id === first.id);
    expect(canonical.text).toBe("User prefers concise, code-first replies");
    expect(parseEvolution(canonical.metadata).status).toBe("active");

    const archived = storedEntries.filter((entry) => entry.id !== first.id);
    expect(archived.map((entry) => entry.text).sort()).toEqual([
      "User prefers concise replies",
      "User prefers long, thorough replies",
    ].sort());

    for (const row of archived) {
      const evo = parseEvolution(row.metadata);
      expect(evo.status).toBe("superseded");
      expect(evo.supersededBy).toBe(first.id);
      // A closed interval is what makes an as-of query possible at all.
      expect(evo.validUntil).toBeGreaterThan(0);
      expect(evo.validUntil).toBeGreaterThanOrEqual(evo.validFrom);
    }
  });

  it("links versions into a chain that traceEvolution can walk back through", async () => {
    const { deps, storedEntries } = createDeps();

    const first = await writeBelief(deps, "Belief version one about reply style");
    await writeBelief(deps, "Belief version two about reply style");
    await writeBelief(deps, "Belief version three about reply style");

    const byId = new Map(storedEntries.map((entry) => [entry.id, entry]));
    const trace = await traceEvolution(first.id, async (id) => byId.get(id) ?? null);

    const texts = trace.map((entry) => byId.get(entry.id)?.text);
    expect(texts).toEqual([
      "Belief version one about reply style",
      "Belief version two about reply style",
      "Belief version three about reply style",
    ]);
    expect(trace[trace.length - 1].direction).toBe("self");
  });

  it("keeps archived versions out of default retrieval", async () => {
    const { deps, storedEntries } = createDeps();

    await writeBelief(deps, "User is based in Guangzhou");
    await writeBelief(deps, "User is based in Singapore");

    const visibleByDefault = storedEntries.filter((entry) => isActiveMemory(entry.metadata));
    expect(visibleByDefault).toHaveLength(1);
    expect(visibleByDefault[0].text).toBe("User is based in Singapore");
  });

  it("treats a revert to an earlier wording as a real change, not a duplicate", async () => {
    const { deps, storedEntries } = createDeps();

    await writeBelief(deps, "User prefers dark mode");
    await writeBelief(deps, "User prefers light mode");
    // Changing back: the archived row still carries the same canonicalKey, so without a
    // status filter on canonical matching this would be misread as a duplicate write.
    const third = await writeBelief(deps, "User prefers dark mode");

    expect(third.disposition).toBe("updated");

    const canonical = storedEntries.find((entry) => isActiveMemory(entry.metadata));
    expect(canonical.text).toBe("User prefers dark mode");
    expect(parseEvolution(canonical.metadata).version).toBe(3);
  });

  it("re-embeds the archived text when the store cannot return the original vector", async () => {
    const { deps, embedCalls, storedEntries } = createDeps({ withGetById: false });

    await writeBelief(deps, "Vectorless original");
    await writeBelief(deps, "Replacement belief");

    const archived = storedEntries.find((entry) => !isActiveMemory(entry.metadata));
    expect(archived.vector.length).toBeGreaterThan(0);
    expect(embedCalls).toContain("Vectorless original");
  });

  it("fails loudly rather than silently dropping history it cannot archive", async () => {
    const { deps } = createDeps();
    const failing = {
      store: {
        ...(deps.store as Record<string, unknown>),
        upsert: async () => { throw new Error("disk full"); },
        store: async () => { throw new Error("disk full"); },
      },
      embedder: deps.embedder,
    };

    await expect(archiveBeliefVersion(failing as any, {
      id: "00000000-0000-0000-0000-000000000001",
      text: "Belief that must not vanish",
      vector: [1, 2, 3],
      category: "preferences",
      scope: TEST_SCOPE,
      importance: 0.8,
      timestamp: 1_700_000_000_001,
      metadata: "{}",
    })).rejects.toThrow("disk full");
  });
});
