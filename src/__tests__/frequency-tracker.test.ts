import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { FrequencyTracker } from "../frequency-tracker.js";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, "../../.test-data");
const TEST_FILE = join(TEST_DIR, "freq-test.json");

function cleanup() {
  try { if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE); } catch {}
}

describe("FrequencyTracker", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    cleanup();
  });
  afterEach(cleanup);

  it("records hits and increments count", () => {
    const tracker = new FrequencyTracker({ filePath: TEST_FILE });
    tracker.recordHits(["mem-1", "mem-2"]);
    tracker.recordHits(["mem-1"]);

    expect(tracker.getStats("mem-1")?.hitCount).toBe(2);
    expect(tracker.getStats("mem-2")?.hitCount).toBe(1);
    expect(tracker.getStats("mem-3")).toBeUndefined();
    tracker.dispose();
  });

  it("returns 1.0 boost below minHitsForBoost", () => {
    const tracker = new FrequencyTracker({ filePath: TEST_FILE, minHitsForBoost: 3 });
    tracker.recordHits(["mem-1"]);
    tracker.recordHits(["mem-1"]);
    expect(tracker.getBoostMultiplier("mem-1")).toBe(1.0);
    tracker.dispose();
  });

  it("returns >1.0 boost at or above minHitsForBoost", () => {
    const tracker = new FrequencyTracker({ filePath: TEST_FILE, minHitsForBoost: 2 });
    tracker.recordHits(["mem-1"]);
    tracker.recordHits(["mem-1"]);
    tracker.recordHits(["mem-1"]);

    const boost = tracker.getBoostMultiplier("mem-1");
    expect(boost).toBeGreaterThan(1.0);
    // log2(3) * 0.15 = ~0.238 → boost ≈ 1.238
    expect(boost).toBeLessThan(1.5);
    tracker.dispose();
  });

  it("shouldPromoteToCore respects threshold", () => {
    const tracker = new FrequencyTracker({
      filePath: TEST_FILE,
      corePromotionThreshold: 3,
    });
    tracker.recordHits(["mem-1"]);
    tracker.recordHits(["mem-1"]);
    expect(tracker.shouldPromoteToCore("mem-1")).toBe(false);

    tracker.recordHits(["mem-1"]);
    expect(tracker.shouldPromoteToCore("mem-1")).toBe(true);
    tracker.dispose();
  });

  it("persists and loads from file", () => {
    const tracker1 = new FrequencyTracker({ filePath: TEST_FILE });
    tracker1.recordHits(["mem-a"]);
    tracker1.recordHits(["mem-a"]);
    tracker1.recordHits(["mem-a"]);
    tracker1.flush();
    tracker1.dispose();

    const tracker2 = new FrequencyTracker({ filePath: TEST_FILE });
    expect(tracker2.getStats("mem-a")?.hitCount).toBe(3);
    tracker2.dispose();
  });

  it("tracks size correctly", () => {
    const tracker = new FrequencyTracker({ filePath: TEST_FILE });
    expect(tracker.size).toBe(0);
    tracker.recordHits(["a", "b", "c"]);
    expect(tracker.size).toBe(3);
    tracker.dispose();
  });

  it("applies time decay to effective hit count", () => {
    const tracker = new FrequencyTracker({
      filePath: TEST_FILE,
      decayHalfLifeDays: 30,
      minHitsForBoost: 1,
    });
    // Simulate old hits by manipulating stats directly
    tracker.recordHits(["old-mem"]);
    tracker.recordHits(["old-mem"]);
    tracker.recordHits(["old-mem"]);
    tracker.recordHits(["old-mem"]);
    tracker.recordHits(["old-mem"]);

    // Fresh entry should have full boost
    const freshBoost = tracker.getBoostMultiplier("old-mem");
    expect(freshBoost).toBeGreaterThan(1.0);

    // Manually set lastHitAt to 60 days ago
    const stats = tracker.getStats("old-mem")!;
    stats.lastHitAt = Date.now() - 60 * 86_400_000;

    // Decayed boost should be lower
    const decayedBoost = tracker.getBoostMultiplier("old-mem");
    expect(decayedBoost).toBeLessThan(freshBoost);
    tracker.dispose();
  });
});
