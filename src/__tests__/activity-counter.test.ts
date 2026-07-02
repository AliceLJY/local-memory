import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import {
  incrementWriteCount,
  getWriteCount,
  resetWriteCount,
  listScopesAboveThreshold,
  getDistillTier,
  type ActivityCounterConfig,
} from "../activity-counter.js";

const TMP_DIR = join(import.meta.dir, "../../.tmp-activity-test");
const testConfig: Partial<ActivityCounterConfig> = {
  statsPath: join(TMP_DIR, "activity-stats.json"),
  lightThreshold: 3,
  standardThreshold: 10,
  deepThreshold: 20,
};
const A = "cc:project:a";
const B = "cc:project:b";

describe("activity-counter (HP-3, per-scope)", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    const p = testConfig.statsPath!;
    if (existsSync(p)) rmSync(p);
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe("incrementWriteCount", () => {
    it("starts at 0 and increments by 1 for a scope", () => {
      expect(getWriteCount(A, testConfig)).toBe(0);
      expect(incrementWriteCount(A, 1, testConfig)).toBe(1);
      expect(incrementWriteCount(A, 1, testConfig)).toBe(2);
      expect(getWriteCount(A, testConfig)).toBe(2);
    });

    it("increments by arbitrary n", () => {
      incrementWriteCount(A, 5, testConfig);
      expect(getWriteCount(A, testConfig)).toBe(5);
      incrementWriteCount(A, 3, testConfig);
      expect(getWriteCount(A, testConfig)).toBe(8);
    });

    it("counts each scope independently", () => {
      incrementWriteCount(A, 4, testConfig);
      incrementWriteCount(B, 1, testConfig);
      expect(getWriteCount(A, testConfig)).toBe(4);
      expect(getWriteCount(B, testConfig)).toBe(1);
    });
  });

  describe("resetWriteCount", () => {
    it("resets only the given scope, leaving others intact", () => {
      incrementWriteCount(A, 7, testConfig);
      incrementWriteCount(B, 5, testConfig);
      resetWriteCount(A, testConfig);
      expect(getWriteCount(A, testConfig)).toBe(0);
      expect(getWriteCount(B, testConfig)).toBe(5); // not starved by A's reset
    });
  });

  describe("listScopesAboveThreshold", () => {
    it("returns scopes at or above the threshold only", () => {
      incrementWriteCount(A, 12, testConfig);
      incrementWriteCount(B, 4, testConfig);
      incrementWriteCount("cc:project:c", 10, testConfig);
      const above = listScopesAboveThreshold(10, testConfig).sort();
      expect(above).toEqual(["cc:project:a", "cc:project:c"]);
    });

    it("returns empty when no scope qualifies", () => {
      incrementWriteCount(A, 2, testConfig);
      expect(listScopesAboveThreshold(10, testConfig)).toEqual([]);
    });
  });

  describe("getDistillTier", () => {
    it("returns 'none' when below light threshold", () => {
      incrementWriteCount(A, 2, testConfig);
      expect(getDistillTier(A, testConfig)).toBe("none");
    });

    it("returns 'light' at light threshold", () => {
      incrementWriteCount(A, 3, testConfig);
      expect(getDistillTier(A, testConfig)).toBe("light");
    });

    it("returns 'standard' at standard threshold", () => {
      incrementWriteCount(A, 10, testConfig);
      expect(getDistillTier(A, testConfig)).toBe("standard");
    });

    it("returns 'deep' at and above deep threshold", () => {
      incrementWriteCount(A, 20, testConfig);
      expect(getDistillTier(A, testConfig)).toBe("deep");
      incrementWriteCount(A, 100, testConfig);
      expect(getDistillTier(A, testConfig)).toBe("deep");
    });
  });

  describe("resilience", () => {
    it("handles missing stats file gracefully", () => {
      expect(getWriteCount(A, testConfig)).toBe(0);
      expect(getDistillTier(A, testConfig)).toBe("none");
      expect(listScopesAboveThreshold(1, testConfig)).toEqual([]);
    });

    it("handles corrupt stats file gracefully", () => {
      writeFileSync(testConfig.statsPath!, "not-json{{{");
      expect(getWriteCount(A, testConfig)).toBe(0);
    });

    it("treats the legacy global format as empty (no migration)", () => {
      writeFileSync(testConfig.statsPath!, JSON.stringify({ writesSinceLastDistill: 42, lastResetAt: 1 }));
      expect(getWriteCount(A, testConfig)).toBe(0);
      // first increment starts a fresh per-scope map
      expect(incrementWriteCount(A, 1, testConfig)).toBe(1);
    });
  });
});
