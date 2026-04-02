import { describe, expect, test } from "bun:test";
import {
  defaultEvolution,
  parseEvolution,
  patchEvolution,
  isActiveMemory,
  recordAccess,
  buildSupersedeMetadata,
  buildConsolidatedMetadata,
  buildArchivedMetadata,
  computeDecayScore,
  type EvolutionMetadata,
} from "../memory-evolution.js";

describe("memory-evolution", () => {
  // -----------------------------------------------------------------------
  // defaultEvolution
  // -----------------------------------------------------------------------
  describe("defaultEvolution", () => {
    test("returns active status with version 1", () => {
      const evo = defaultEvolution(1000);
      expect(evo.status).toBe("active");
      expect(evo.version).toBe(1);
      expect(evo.accessCount).toBe(0);
      expect(evo.lastAccessedAt).toBeNull();
      expect(evo.supersededBy).toBeNull();
      expect(evo.consolidatedInto).toBeNull();
      expect(evo.sourceMemories).toEqual([]);
      expect(evo.validFrom).toBe(1000);
      expect(evo.validUntil).toBeNull();
    });

    test("uses Date.now() when no timestamp provided", () => {
      const before = Date.now();
      const evo = defaultEvolution();
      expect(evo.validFrom).toBeGreaterThanOrEqual(before);
      expect(evo.validFrom).toBeLessThanOrEqual(Date.now());
    });
  });

  // -----------------------------------------------------------------------
  // parseEvolution
  // -----------------------------------------------------------------------
  describe("parseEvolution", () => {
    test("returns defaults for undefined metadata", () => {
      const evo = parseEvolution(undefined, 2000);
      expect(evo.status).toBe("active");
      expect(evo.validFrom).toBe(2000);
    });

    test("returns defaults for empty string metadata", () => {
      const evo = parseEvolution("", 2000);
      expect(evo.status).toBe("active");
    });

    test("returns defaults for metadata without evolution field", () => {
      const meta = JSON.stringify({ source: "manual", tags: [] });
      const evo = parseEvolution(meta, 3000);
      expect(evo.status).toBe("active");
      expect(evo.validFrom).toBe(3000);
    });

    test("returns defaults for invalid JSON", () => {
      const evo = parseEvolution("not json", 4000);
      expect(evo.status).toBe("active");
      expect(evo.validFrom).toBe(4000);
    });

    test("parses valid evolution metadata", () => {
      const meta = JSON.stringify({
        source: "agent",
        evolution: {
          status: "superseded",
          version: 3,
          accessCount: 42,
          lastAccessedAt: 5000,
          supersededBy: "abc-123",
          consolidatedInto: null,
          sourceMemories: ["x", "y"],
          validFrom: 1000,
          validUntil: 4000,
        },
      });
      const evo = parseEvolution(meta);
      expect(evo.status).toBe("superseded");
      expect(evo.version).toBe(3);
      expect(evo.accessCount).toBe(42);
      expect(evo.lastAccessedAt).toBe(5000);
      expect(evo.supersededBy).toBe("abc-123");
      expect(evo.sourceMemories).toEqual(["x", "y"]);
      expect(evo.validFrom).toBe(1000);
      expect(evo.validUntil).toBe(4000);
    });

    test("fills missing fields with defaults", () => {
      const meta = JSON.stringify({ evolution: { status: "archived" } });
      const evo = parseEvolution(meta, 6000);
      expect(evo.status).toBe("archived");
      expect(evo.version).toBe(1);
      expect(evo.accessCount).toBe(0);
      expect(evo.validFrom).toBe(6000);
    });
  });

  // -----------------------------------------------------------------------
  // patchEvolution
  // -----------------------------------------------------------------------
  describe("patchEvolution", () => {
    test("creates evolution on empty metadata", () => {
      const patched = patchEvolution(undefined, { status: "archived" });
      const parsed = JSON.parse(patched);
      expect(parsed.evolution.status).toBe("archived");
    });

    test("merges into existing evolution", () => {
      const original = JSON.stringify({
        source: "manual",
        evolution: { status: "active", version: 1, accessCount: 5 },
      });
      const patched = patchEvolution(original, { accessCount: 6, lastAccessedAt: 9000 });
      const parsed = JSON.parse(patched);
      expect(parsed.source).toBe("manual");
      expect(parsed.evolution.status).toBe("active");
      expect(parsed.evolution.version).toBe(1);
      expect(parsed.evolution.accessCount).toBe(6);
      expect(parsed.evolution.lastAccessedAt).toBe(9000);
    });

    test("preserves non-evolution fields", () => {
      const original = JSON.stringify({ source: "agent", tags: ["a"], canonicalKey: "k1" });
      const patched = patchEvolution(original, { status: "superseded" });
      const parsed = JSON.parse(patched);
      expect(parsed.source).toBe("agent");
      expect(parsed.tags).toEqual(["a"]);
      expect(parsed.canonicalKey).toBe("k1");
    });
  });

  // -----------------------------------------------------------------------
  // isActiveMemory
  // -----------------------------------------------------------------------
  describe("isActiveMemory", () => {
    test("true for undefined metadata (backward compat)", () => {
      expect(isActiveMemory(undefined)).toBe(true);
    });

    test("true for metadata without evolution", () => {
      expect(isActiveMemory(JSON.stringify({ source: "manual" }))).toBe(true);
    });

    test("true for active status", () => {
      const meta = JSON.stringify({ evolution: { status: "active" } });
      expect(isActiveMemory(meta)).toBe(true);
    });

    test("false for superseded", () => {
      const meta = JSON.stringify({ evolution: { status: "superseded" } });
      expect(isActiveMemory(meta)).toBe(false);
    });

    test("false for archived", () => {
      const meta = JSON.stringify({ evolution: { status: "archived" } });
      expect(isActiveMemory(meta)).toBe(false);
    });

    test("false for consolidated", () => {
      const meta = JSON.stringify({ evolution: { status: "consolidated" } });
      expect(isActiveMemory(meta)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // recordAccess
  // -----------------------------------------------------------------------
  describe("recordAccess", () => {
    test("increments count from 0 on undefined metadata", () => {
      const updated = recordAccess(undefined);
      const evo = parseEvolution(updated);
      expect(evo.accessCount).toBe(1);
      expect(evo.lastAccessedAt).toBeGreaterThan(0);
    });

    test("increments existing count", () => {
      const original = JSON.stringify({
        evolution: { accessCount: 5, lastAccessedAt: 1000 },
      });
      const updated = recordAccess(original);
      const evo = parseEvolution(updated);
      expect(evo.accessCount).toBe(6);
      expect(evo.lastAccessedAt!).toBeGreaterThan(1000);
    });
  });

  // -----------------------------------------------------------------------
  // buildSupersedeMetadata / buildConsolidatedMetadata / buildArchivedMetadata
  // -----------------------------------------------------------------------
  describe("supersede/consolidate/archive helpers", () => {
    test("buildSupersedeMetadata sets status and links", () => {
      const original = JSON.stringify({ source: "manual", evolution: defaultEvolution(1000) });
      const result = buildSupersedeMetadata(original, "new-id-123");
      const evo = parseEvolution(result);
      expect(evo.status).toBe("superseded");
      expect(evo.supersededBy).toBe("new-id-123");
      expect(evo.validUntil).toBeGreaterThan(0);
    });

    test("buildConsolidatedMetadata sets status and link", () => {
      const result = buildConsolidatedMetadata(undefined, "consolidated-id");
      const evo = parseEvolution(result);
      expect(evo.status).toBe("consolidated");
      expect(evo.consolidatedInto).toBe("consolidated-id");
    });

    test("buildArchivedMetadata sets status", () => {
      const result = buildArchivedMetadata(undefined);
      const evo = parseEvolution(result);
      expect(evo.status).toBe("archived");
    });
  });

  // -----------------------------------------------------------------------
  // computeDecayScore
  // -----------------------------------------------------------------------
  describe("computeDecayScore", () => {
    test("brand new high-importance memory scores high", () => {
      const now = Date.now();
      const evo: EvolutionMetadata = {
        ...defaultEvolution(now),
        accessCount: 0,
      };
      const score = computeDecayScore(evo, 1.0, now);
      // 0.2 * 1.0 (fresh) + 0.3 * 0 (no access) * 0.5 + 0.5 * 1.0 = 0.7 + small freq
      expect(score).toBeGreaterThan(0.6);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    test("old unaccessed low-importance memory scores low", () => {
      const now = Date.now();
      const evo: EvolutionMetadata = {
        ...defaultEvolution(now - 365 * 86_400_000), // 1 year old
        accessCount: 0,
      };
      const score = computeDecayScore(evo, 0.1, now);
      expect(score).toBeLessThan(0.2);
    });

    test("frequently accessed memory gets frequency boost", () => {
      const now = Date.now();
      const evoNoAccess: EvolutionMetadata = {
        ...defaultEvolution(now - 30 * 86_400_000),
        accessCount: 0,
      };
      const evoHighAccess: EvolutionMetadata = {
        ...defaultEvolution(now - 30 * 86_400_000),
        accessCount: 100,
        lastAccessedAt: now - 86_400_000, // yesterday
      };
      const scoreNo = computeDecayScore(evoNoAccess, 0.5, now);
      const scoreHigh = computeDecayScore(evoHighAccess, 0.5, now);
      expect(scoreHigh).toBeGreaterThan(scoreNo);
    });

    test("importance dominates scoring (0.5 weight)", () => {
      const now = Date.now();
      const evo = defaultEvolution(now);
      const lowImp = computeDecayScore(evo, 0.1, now);
      const highImp = computeDecayScore(evo, 1.0, now);
      expect(highImp - lowImp).toBeGreaterThan(0.3); // 0.5 * (1.0 - 0.1) = 0.45
    });
  });
});
