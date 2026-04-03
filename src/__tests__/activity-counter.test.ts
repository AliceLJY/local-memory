import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import {
  incrementWriteCount,
  getWriteCount,
  resetWriteCount,
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

describe("activity-counter (HP-3)", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    // Ensure clean state
    const p = testConfig.statsPath!;
    if (existsSync(p)) rmSync(p);
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe("incrementWriteCount", () => {
    it("starts at 0 and increments by 1", () => {
      expect(getWriteCount(testConfig)).toBe(0);
      expect(incrementWriteCount(1, testConfig)).toBe(1);
      expect(incrementWriteCount(1, testConfig)).toBe(2);
      expect(getWriteCount(testConfig)).toBe(2);
    });

    it("increments by arbitrary n", () => {
      incrementWriteCount(5, testConfig);
      expect(getWriteCount(testConfig)).toBe(5);
      incrementWriteCount(3, testConfig);
      expect(getWriteCount(testConfig)).toBe(8);
    });
  });

  describe("resetWriteCount", () => {
    it("resets count to 0", () => {
      incrementWriteCount(7, testConfig);
      expect(getWriteCount(testConfig)).toBe(7);
      resetWriteCount(testConfig);
      expect(getWriteCount(testConfig)).toBe(0);
    });
  });

  describe("getDistillTier", () => {
    it("returns 'none' when below light threshold", () => {
      incrementWriteCount(2, testConfig);
      expect(getDistillTier(testConfig)).toBe("none");
    });

    it("returns 'light' at light threshold", () => {
      incrementWriteCount(3, testConfig);
      expect(getDistillTier(testConfig)).toBe("light");
    });

    it("returns 'standard' at standard threshold", () => {
      incrementWriteCount(10, testConfig);
      expect(getDistillTier(testConfig)).toBe("standard");
    });

    it("returns 'deep' at deep threshold", () => {
      incrementWriteCount(20, testConfig);
      expect(getDistillTier(testConfig)).toBe("deep");
    });

    it("returns 'deep' well above deep threshold", () => {
      incrementWriteCount(100, testConfig);
      expect(getDistillTier(testConfig)).toBe("deep");
    });
  });

  describe("resilience", () => {
    it("handles missing stats file gracefully", () => {
      expect(getWriteCount(testConfig)).toBe(0);
      expect(getDistillTier(testConfig)).toBe("none");
    });

    it("handles corrupt stats file gracefully", () => {
      const { writeFileSync } = require("node:fs");
      writeFileSync(testConfig.statsPath!, "not-json{{{");
      expect(getWriteCount(testConfig)).toBe(0);
    });
  });
});
