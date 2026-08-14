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

describe("activity-counter (HP-3, per-scope)", async () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    const p = testConfig.statsPath!;
    if (existsSync(p)) rmSync(p);
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe("incrementWriteCount", async () => {
    it("starts at 0 and increments by 1 for a scope", async () => {
      expect(getWriteCount(A, testConfig)).toBe(0);
      expect(await incrementWriteCount(A, 1, testConfig)).toBe(1);
      expect(await incrementWriteCount(A, 1, testConfig)).toBe(2);
      expect(getWriteCount(A, testConfig)).toBe(2);
    });

    it("increments by arbitrary n", async () => {
      await incrementWriteCount(A, 5, testConfig);
      expect(getWriteCount(A, testConfig)).toBe(5);
      await incrementWriteCount(A, 3, testConfig);
      expect(getWriteCount(A, testConfig)).toBe(8);
    });

    it("counts each scope independently", async () => {
      await incrementWriteCount(A, 4, testConfig);
      await incrementWriteCount(B, 1, testConfig);
      expect(getWriteCount(A, testConfig)).toBe(4);
      expect(getWriteCount(B, testConfig)).toBe(1);
    });
  });

  describe("resetWriteCount", async () => {
    it("resets only the given scope, leaving others intact", async () => {
      await incrementWriteCount(A, 7, testConfig);
      await incrementWriteCount(B, 5, testConfig);
      await resetWriteCount(A, testConfig);
      expect(getWriteCount(A, testConfig)).toBe(0);
      expect(getWriteCount(B, testConfig)).toBe(5); // not starved by A's reset
    });
  });

  describe("listScopesAboveThreshold", async () => {
    it("returns scopes at or above the threshold only", async () => {
      await incrementWriteCount(A, 12, testConfig);
      await incrementWriteCount(B, 4, testConfig);
      await incrementWriteCount("cc:project:c", 10, testConfig);
      const above = listScopesAboveThreshold(10, testConfig).sort();
      expect(above).toEqual(["cc:project:a", "cc:project:c"]);
    });

    it("returns empty when no scope qualifies", async () => {
      await incrementWriteCount(A, 2, testConfig);
      expect(listScopesAboveThreshold(10, testConfig)).toEqual([]);
    });
  });

  describe("getDistillTier", async () => {
    it("returns 'none' when below light threshold", async () => {
      await incrementWriteCount(A, 2, testConfig);
      expect(getDistillTier(A, testConfig)).toBe("none");
    });

    it("returns 'light' at light threshold", async () => {
      await incrementWriteCount(A, 3, testConfig);
      expect(getDistillTier(A, testConfig)).toBe("light");
    });

    it("returns 'standard' at standard threshold", async () => {
      await incrementWriteCount(A, 10, testConfig);
      expect(getDistillTier(A, testConfig)).toBe("standard");
    });

    it("returns 'deep' at and above deep threshold", async () => {
      await incrementWriteCount(A, 20, testConfig);
      expect(getDistillTier(A, testConfig)).toBe("deep");
      await incrementWriteCount(A, 100, testConfig);
      expect(getDistillTier(A, testConfig)).toBe("deep");
    });
  });

  describe("resilience", async () => {
    it("handles missing stats file gracefully", async () => {
      expect(getWriteCount(A, testConfig)).toBe(0);
      expect(getDistillTier(A, testConfig)).toBe("none");
      expect(listScopesAboveThreshold(1, testConfig)).toEqual([]);
    });

    it("handles corrupt stats file gracefully", async () => {
      writeFileSync(testConfig.statsPath!, "not-json{{{");
      expect(getWriteCount(A, testConfig)).toBe(0);
    });

    it("treats the legacy global format as empty (no migration)", async () => {
      writeFileSync(testConfig.statsPath!, JSON.stringify({ writesSinceLastDistill: 42, lastResetAt: 1 }));
      expect(getWriteCount(A, testConfig)).toBe(0);
      // first increment starts a fresh per-scope map
      expect(await incrementWriteCount(A, 1, testConfig)).toBe(1);
    });
  });
});
