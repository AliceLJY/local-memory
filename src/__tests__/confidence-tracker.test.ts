import { describe, expect, it } from "bun:test";

import {
  confirmMemory,
  correctMemory,
  contradictMemory,
  buildConfirmPatch,
  buildCorrectPatch,
  buildContradictPatch,
  getConfidence,
  applyConfidenceWeight,
  CONFIDENCE_DEFAULT,
  CONFIDENCE_CONFIRMED,
  CONFIDENCE_CORRECTED,
  CONFIDENCE_CONTRADICTED,
} from "../confidence-tracker.js";
import type { MemoryEntry } from "../store.js";

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
  const updates: Array<{ id: string; metadata?: string }> = [];

  return {
    updates,
    data,
    async getById(id: string) {
      return data.get(id) ?? null;
    },
    async update(id: string, upd: any, _scopeFilter?: string[]) {
      const entry = data.get(id);
      if (!entry) return null;
      if (upd.metadata !== undefined) entry.metadata = upd.metadata;
      updates.push({ id, ...upd });
      return entry;
    },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("confidence-tracker", () => {
  describe("getConfidence", () => {
    it("returns default for entries without confidence", () => {
      const entry = makeEntry("e1", "test");
      expect(getConfidence(entry)).toBe(CONFIDENCE_DEFAULT);
    });

    it("returns stored confidence", () => {
      const entry = makeEntry("e1", "test", {
        metadata: JSON.stringify({ confidence: 0.9 }),
      });
      expect(getConfidence(entry)).toBe(0.9);
    });

    it("returns default for malformed metadata", () => {
      const entry = makeEntry("e1", "test", { metadata: "not-json" });
      expect(getConfidence(entry)).toBe(CONFIDENCE_DEFAULT);
    });
  });

  describe("confirmMemory", () => {
    it("sets confidence to 1.0", async () => {
      const entry = makeEntry("e1", "user likes TypeScript");
      const store = createMockStore([entry]);

      const result = await confirmMemory(store, "e1", "project:test");
      expect(result).not.toBeNull();
      expect(result!.newConfidence).toBe(CONFIDENCE_CONFIRMED);
      expect(result!.oldConfidence).toBe(CONFIDENCE_DEFAULT);

      const meta = JSON.parse(store.data.get("e1")!.metadata!);
      expect(meta.confidence).toBe(1.0);
      expect(meta.confidence_history).toHaveLength(1);
      expect(meta.confidence_history[0].action).toBe("confirmed");
    });

    it("returns null for missing entry", async () => {
      const store = createMockStore([]);
      const result = await confirmMemory(store, "missing", "project:test");
      expect(result).toBeNull();
    });
  });

  describe("correctMemory", () => {
    it("drops confidence to 0.3", async () => {
      const entry = makeEntry("e1", "user uses Python");
      const store = createMockStore([entry]);

      const result = await correctMemory(store, "e1", "project:test", "new-entry-id");
      expect(result).not.toBeNull();
      expect(result!.newConfidence).toBe(CONFIDENCE_CORRECTED);

      const meta = JSON.parse(store.data.get("e1")!.metadata!);
      expect(meta.confidence).toBe(0.3);
      expect(meta.corrected_by).toBe("new-entry-id");
      expect(meta.confidence_history[0].correctedBy).toBe("new-entr"); // 8 chars
    });

    it("works without correctedById", async () => {
      const entry = makeEntry("e1", "old info");
      const store = createMockStore([entry]);

      const result = await correctMemory(store, "e1", "project:test");
      expect(result!.newConfidence).toBe(CONFIDENCE_CORRECTED);

      const meta = JSON.parse(store.data.get("e1")!.metadata!);
      expect(meta.corrected_by).toBeUndefined();
    });
  });

  describe("contradictMemory", () => {
    it("drops confidence to 0.0", async () => {
      const entry = makeEntry("e1", "wrong fact");
      const store = createMockStore([entry]);

      const result = await contradictMemory(store, "e1", "project:test");
      expect(result).not.toBeNull();
      expect(result!.newConfidence).toBe(CONFIDENCE_CONTRADICTED);

      const meta = JSON.parse(store.data.get("e1")!.metadata!);
      expect(meta.confidence).toBe(0.0);
    });
  });

  describe("applyConfidenceWeight", () => {
    it("no penalty at confidence=1.0", () => {
      const entry = makeEntry("e1", "test", {
        metadata: JSON.stringify({ confidence: 1.0 }),
      });
      expect(applyConfidenceWeight(1.0, entry)).toBe(1.0);
    });

    it("slight penalty at default confidence=0.7", () => {
      const entry = makeEntry("e1", "test");
      const weighted = applyConfidenceWeight(1.0, entry);
      expect(weighted).toBeCloseTo(0.85, 2);
    });

    it("significant penalty at corrected confidence=0.3", () => {
      const entry = makeEntry("e1", "test", {
        metadata: JSON.stringify({ confidence: 0.3 }),
      });
      const weighted = applyConfidenceWeight(1.0, entry);
      expect(weighted).toBeCloseTo(0.65, 2);
    });

    it("heavy penalty at contradicted confidence=0.0", () => {
      const entry = makeEntry("e1", "test", {
        metadata: JSON.stringify({ confidence: 0.0 }),
      });
      const weighted = applyConfidenceWeight(1.0, entry);
      expect(weighted).toBe(0.5);
    });

    it("scales with input score", () => {
      const entry = makeEntry("e1", "test", {
        metadata: JSON.stringify({ confidence: 0.3 }),
      });
      const weighted = applyConfidenceWeight(0.8, entry);
      expect(weighted).toBeCloseTo(0.8 * 0.65, 2);
    });
  });

  describe("patch builders (store-agnostic)", () => {
    it("buildConfirmPatch returns metadata patch without touching store", () => {
      const entry = makeEntry("e1", "test fact");
      const patch = buildConfirmPatch(entry);
      expect(patch).not.toBeNull();
      expect(patch!.metadata.confidence).toBe(CONFIDENCE_CONFIRMED);
      expect(patch!.update.entryId).toBe("e1");
      expect(patch!.update.newConfidence).toBe(CONFIDENCE_CONFIRMED);
      // Original entry metadata should NOT be mutated
      expect(JSON.parse(entry.metadata!).confidence).toBeUndefined();
    });

    it("buildCorrectPatch includes correctedBy in history", () => {
      const entry = makeEntry("e1", "old info");
      const patch = buildCorrectPatch(entry, "new-id-123");
      expect(patch).not.toBeNull();
      expect(patch!.metadata.confidence).toBe(CONFIDENCE_CORRECTED);
      expect(patch!.metadata.corrected_by).toBe("new-id-123");
      const history = patch!.metadata.confidence_history as Array<{ correctedBy?: string }>;
      expect(history[0].correctedBy).toBe("new-id-1"); // 8 chars
    });

    it("buildContradictPatch returns zero confidence", () => {
      const entry = makeEntry("e1", "wrong");
      const patch = buildContradictPatch(entry);
      expect(patch!.metadata.confidence).toBe(CONFIDENCE_CONTRADICTED);
    });

    it("all patch builders return null for null entry", () => {
      expect(buildConfirmPatch(null)).toBeNull();
      expect(buildCorrectPatch(null)).toBeNull();
      expect(buildContradictPatch(null)).toBeNull();
    });

    it("caps confidence history at 20 entries", () => {
      const longHistory = Array.from({ length: 25 }, (_, i) => ({
        action: "confirmed",
        from: 0.5,
        to: 1.0,
        date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      }));
      const entry = makeEntry("e1", "test", {
        metadata: JSON.stringify({ confidence: 0.5, confidence_history: longHistory }),
      });
      const patch = buildConfirmPatch(entry);
      const history = patch!.metadata.confidence_history as unknown[];
      expect(history.length).toBeLessThanOrEqual(20);
    });
  });

  describe("confidence history", () => {
    it("accumulates multiple changes", async () => {
      const entry = makeEntry("e1", "evolving fact");
      const store = createMockStore([entry]);

      await correctMemory(store, "e1", "project:test");
      await confirmMemory(store, "e1", "project:test");

      const meta = JSON.parse(store.data.get("e1")!.metadata!);
      expect(meta.confidence_history).toHaveLength(2);
      expect(meta.confidence_history[0].action).toBe("corrected");
      expect(meta.confidence_history[1].action).toBe("confirmed");
      expect(meta.confidence).toBe(CONFIDENCE_CONFIRMED);
    });
  });
});
