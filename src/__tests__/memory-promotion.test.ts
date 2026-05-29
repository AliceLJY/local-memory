import { describe, expect, it } from "bun:test";

import {
  scanMemoryPromotions,
  type PromoteScanDeps,
  type PromoteRequest,
} from "../memory-promotion.js";
import type { MemoryEntry } from "../store.js";
import type { StoredPromotedMemoryRecord } from "../memory-schema.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

let idSeq = 0;

const ACTIVE_EVOLUTION = {
  status: "active",
  version: 1,
  accessCount: 0,
  lastAccessedAt: null,
  supersededBy: null,
  consolidatedInto: null,
  sourceMemories: [],
  validFrom: 1_700_000_000_000,
  validUntil: null,
};

/**
 * Build a transcript-downgraded evidence entry (category=events) with an EMPTY
 * vector, faithfully reproducing store.list — which never returns vectors.
 */
function makeDowngradedEvent(
  downgradedFrom: "profile" | "preferences",
  overrides: Partial<MemoryEntry> = {},
): MemoryEntry {
  idSeq += 1;
  return {
    id: `ev-${String(idSeq).padStart(4, "0")}`,
    text: `${downgradedFrom} hint #${idSeq}`,
    vector: [], // list() never returns vectors
    category: "events",
    scope: "cc:project:test",
    importance: 0.7,
    timestamp: 1_700_000_000_000 + idSeq,
    metadata: JSON.stringify({
      boundary: {
        layer: "evidence",
        authority: "transcript-ingest",
        conflictPolicy: "append-only",
        originalCategory: downgradedFrom,
        downgradedFrom,
      },
      evolution: ACTIVE_EVOLUTION,
    }),
    ...overrides,
  };
}

interface MockOptions {
  /** Per-id vector overrides; ids absent from the map get no vector. */
  vectorMap?: Map<string, number[]>;
  /** Fallback vector handed to every listed id when vectorMap is omitted. */
  defaultVector?: number[];
}

function createScanDeps(entries: MemoryEntry[], options: MockOptions = {}) {
  const promoteCalls: PromoteRequest[] = [];
  const deps: PromoteScanDeps = {
    store: {
      async list(
        _scopeFilter?: string[],
        category?: string,
        _limit?: number,
        _offset?: number,
      ): Promise<MemoryEntry[]> {
        return category ? entries.filter((e) => e.category === category) : entries;
      },
      async getVectors(ids: string[]): Promise<Map<string, number[]>> {
        const map = new Map<string, number[]>();
        for (const id of ids) {
          if (options.vectorMap?.has(id)) {
            map.set(id, options.vectorMap.get(id)!);
          } else if (options.defaultVector && !options.vectorMap) {
            map.set(id, options.defaultVector);
          }
        }
        return map;
      },
    },
    async promote(req: PromoteRequest): Promise<StoredPromotedMemoryRecord> {
      promoteCalls.push(req);
      return {
        text: "promoted text",
        category: req.category,
        importance: req.importance,
        scope: req.scope,
        source: "agent",
        tags: [],
        canonicalKey: `${req.category}:k${promoteCalls.length}`,
        id: `durable-${req.memoryId}`,
        resolvedScope: req.scope,
        storedAt: "2026-05-29T00:00:00.000Z",
        disposition: "promoted",
        sourceMemoryId: req.memoryId,
        sourceCategory: "events",
      };
    },
  };
  return { deps, promoteCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scanMemoryPromotions", () => {
  it("promotes a cluster once it has >= minOccurrences similar members", async () => {
    const entries = [
      makeDowngradedEvent("preferences"),
      makeDowngradedEvent("preferences"),
      makeDowngradedEvent("preferences"),
    ];
    const { deps, promoteCalls } = createScanDeps(entries, { defaultVector: [1, 0, 0] });

    const result = await scanMemoryPromotions(deps, "cc:project:test", { dryRun: false });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].occurrences).toBe(3);
    expect(result.candidates[0].downgradedFrom).toBe("preferences");
    expect(result.promoted).toBe(1);
    expect(promoteCalls.length).toBe(1);
    expect(promoteCalls[0].category).toBe("preferences");
    expect(promoteCalls[0].scope).toBe("cc:project:test");
  });

  it("does not promote when occurrences are below minOccurrences", async () => {
    const entries = [makeDowngradedEvent("preferences"), makeDowngradedEvent("preferences")];
    const { deps, promoteCalls } = createScanDeps(entries, { defaultVector: [1, 0, 0] });

    const result = await scanMemoryPromotions(deps, "cc:project:test", { dryRun: false });

    expect(result.candidates.length).toBe(0);
    expect(promoteCalls.length).toBe(0);
  });

  it("does not promote a cluster whose average importance is below minImportance", async () => {
    const entries = [
      makeDowngradedEvent("preferences", { importance: 0.4 }),
      makeDowngradedEvent("preferences", { importance: 0.4 }),
      makeDowngradedEvent("preferences", { importance: 0.4 }),
    ];
    const { deps, promoteCalls } = createScanDeps(entries, { defaultVector: [1, 0, 0] });

    const result = await scanMemoryPromotions(deps, "cc:project:test", { dryRun: false });

    expect(result.candidates.length).toBe(0);
    expect(promoteCalls.length).toBe(0);
  });

  it("promotes with the target category equal to downgradedFrom (profile)", async () => {
    const entries = [
      makeDowngradedEvent("profile"),
      makeDowngradedEvent("profile"),
      makeDowngradedEvent("profile"),
    ];
    const { deps, promoteCalls } = createScanDeps(entries, { defaultVector: [1, 0, 0] });

    await scanMemoryPromotions(deps, "cc:project:test", { dryRun: false });

    expect(promoteCalls.length).toBe(1);
    expect(promoteCalls[0].category).toBe("profile");
  });

  it("finds candidates but does NOT call promote in dryRun mode", async () => {
    const entries = [
      makeDowngradedEvent("preferences"),
      makeDowngradedEvent("preferences"),
      makeDowngradedEvent("preferences"),
    ];
    const { deps, promoteCalls } = createScanDeps(entries, { defaultVector: [1, 0, 0] });

    const result = await scanMemoryPromotions(deps, "cc:project:test", { dryRun: true });

    expect(result.candidates.length).toBe(1);
    expect(result.dryRun).toBe(true);
    expect(result.promoted).toBe(0);
    expect(result.candidates[0].promoted).toBeNull();
    expect(promoteCalls.length).toBe(0);
  });

  it("keeps profile and preferences as separate candidates with their own category", async () => {
    const entries = [
      makeDowngradedEvent("preferences"),
      makeDowngradedEvent("preferences"),
      makeDowngradedEvent("preferences"),
      makeDowngradedEvent("profile"),
      makeDowngradedEvent("profile"),
      makeDowngradedEvent("profile"),
    ];
    const { deps, promoteCalls } = createScanDeps(entries, { defaultVector: [1, 0, 0] });

    const result = await scanMemoryPromotions(deps, "cc:project:test", { dryRun: false });

    expect(result.candidates.length).toBe(2);
    expect(promoteCalls.length).toBe(2);
    expect(promoteCalls.map((c) => c.category).sort()).toEqual(["preferences", "profile"]);
  });

  it("skips entries that have no vector available", async () => {
    const entries = [
      makeDowngradedEvent("preferences"),
      makeDowngradedEvent("preferences"),
      makeDowngradedEvent("preferences"),
    ];
    // Only 2 of 3 receive vectors -> the cluster has 2 members < minOccurrences.
    const vectorMap = new Map<string, number[]>();
    vectorMap.set(entries[0].id, [1, 0, 0]);
    vectorMap.set(entries[1].id, [1, 0, 0]);
    const { deps, promoteCalls } = createScanDeps(entries, { vectorMap });

    const result = await scanMemoryPromotions(deps, "cc:project:test", { dryRun: false });

    expect(result.candidates.length).toBe(0);
    expect(promoteCalls.length).toBe(0);
  });

  it("ignores events that are not downgraded from profile/preferences", async () => {
    const plain = (): MemoryEntry =>
      makeDowngradedEvent("preferences", {
        metadata: JSON.stringify({
          boundary: {
            layer: "evidence",
            authority: "transcript-ingest",
            conflictPolicy: "append-only",
          },
          evolution: ACTIVE_EVOLUTION,
        }),
      });
    const { deps, promoteCalls } = createScanDeps([plain(), plain(), plain()], {
      defaultVector: [1, 0, 0],
    });

    const result = await scanMemoryPromotions(deps, "cc:project:test", { dryRun: false });

    expect(result.candidates.length).toBe(0);
    expect(promoteCalls.length).toBe(0);
  });

  it("skips evidence already promoted (promotedTo marker present)", async () => {
    const promotedAlready = (): MemoryEntry =>
      makeDowngradedEvent("preferences", {
        metadata: JSON.stringify({
          boundary: {
            layer: "evidence",
            authority: "transcript-ingest",
            conflictPolicy: "append-only",
            originalCategory: "preferences",
            downgradedFrom: "preferences",
          },
          promotedTo: "existing-durable-id",
          evolution: ACTIVE_EVOLUTION,
        }),
      });
    const { deps, promoteCalls } = createScanDeps(
      [promotedAlready(), promotedAlready(), promotedAlready()],
      { defaultVector: [1, 0, 0] },
    );

    const result = await scanMemoryPromotions(deps, "cc:project:test", { dryRun: false });

    expect(result.candidates.length).toBe(0);
    expect(promoteCalls.length).toBe(0);
  });

  it("excludes inactive (superseded) evidence", async () => {
    const superseded = (): MemoryEntry =>
      makeDowngradedEvent("preferences", {
        metadata: JSON.stringify({
          boundary: {
            layer: "evidence",
            authority: "transcript-ingest",
            conflictPolicy: "append-only",
            originalCategory: "preferences",
            downgradedFrom: "preferences",
          },
          evolution: { ...ACTIVE_EVOLUTION, status: "superseded", supersededBy: "x" },
        }),
      });
    const { deps, promoteCalls } = createScanDeps(
      [superseded(), superseded(), superseded()],
      { defaultVector: [1, 0, 0] },
    );

    const result = await scanMemoryPromotions(deps, "cc:project:test", { dryRun: false });

    expect(result.candidates.length).toBe(0);
    expect(promoteCalls.length).toBe(0);
  });
});
