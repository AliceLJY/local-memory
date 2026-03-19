import { describe, expect, it } from "bun:test";

import {
  buildMemoryHealthRebalancePlan,
  computeRebalancedImportance,
  getMemoryHealthAccessCount,
  getStoredMemoryTier,
  parseMemoryHealthMetadata,
  resolveRebalancedTier,
  summarizeMemoryHealthPlans,
} from "../memory-health-rebalance.js";

const datasetStats = {
  maxAccessCount: 19,
  minTimestamp: Date.parse("2026-03-02T00:00:00.000Z"),
  maxTimestamp: Date.parse("2026-03-19T00:00:00.000Z"),
};

describe("memory health rebalance", () => {
  it("parses metadata safely and supports both accessCount key styles", () => {
    expect(parseMemoryHealthMetadata("{")).toEqual({});
    expect(getMemoryHealthAccessCount({ accessCount: 3 })).toBe(3);
    expect(getMemoryHealthAccessCount({ access_count: 4 })).toBe(4);
    expect(getStoredMemoryTier({ tier: "working" })).toBe("working");
    expect(getStoredMemoryTier({ tier: "unknown" })).toBe("unknown");
  });

  it("demotes dead memories to peripheral even when they already had a hotter tier", () => {
    const plan = buildMemoryHealthRebalancePlan({
      id: "dead-memory",
      importance: 0.8,
      timestamp: datasetStats.minTimestamp,
      metadata: JSON.stringify({ tier: "working", accessCount: 0 }),
    }, datasetStats);

    expect(resolveRebalancedTier("working", 0)).toBe("peripheral");
    expect(plan.targetTier).toBe("peripheral");
    expect(plan.deadMemoryRow).toBe(true);
    expect(plan.deadMemoryDemoted).toBe(true);
    expect(plan.nextImportance).toBeGreaterThanOrEqual(0.3);
    expect(plan.nextImportance).toBeLessThanOrEqual(0.5);
    expect(plan.nextMetadata.tier).toBe("peripheral");
    expect(plan.nextMetadata.importance).toBe(plan.nextImportance);
  });

  it("backfills unknown tiers from access counts", () => {
    const corePlan = buildMemoryHealthRebalancePlan({
      id: "unknown-core",
      importance: 0.7,
      timestamp: datasetStats.maxTimestamp,
      metadata: JSON.stringify({ accessCount: 6 }),
    }, datasetStats);
    const workingPlan = buildMemoryHealthRebalancePlan({
      id: "unknown-working",
      importance: 0.7,
      timestamp: datasetStats.maxTimestamp,
      metadata: JSON.stringify({ accessCount: 3 }),
    }, datasetStats);

    expect(corePlan.currentTier).toBe("unknown");
    expect(corePlan.targetTier).toBe("core");
    expect(corePlan.tierBackfilled).toBe(true);
    expect(corePlan.nextImportance).toBeGreaterThanOrEqual(0.85);
    expect(corePlan.nextImportance).toBeLessThanOrEqual(0.95);

    expect(workingPlan.targetTier).toBe("working");
    expect(workingPlan.nextImportance).toBeGreaterThanOrEqual(0.6);
    expect(workingPlan.nextImportance).toBeLessThanOrEqual(0.8);
  });

  it("keeps existing non-dead tiers and only reshapes importance within the tier band", () => {
    const lowPlan = buildMemoryHealthRebalancePlan({
      id: "working-low",
      importance: 0.6,
      timestamp: datasetStats.minTimestamp,
      metadata: JSON.stringify({ tier: "working", accessCount: 2 }),
    }, datasetStats);
    const highPlan = buildMemoryHealthRebalancePlan({
      id: "working-high",
      importance: 0.8,
      timestamp: datasetStats.maxTimestamp,
      metadata: JSON.stringify({ tier: "working", accessCount: 5 }),
    }, datasetStats);

    expect(lowPlan.targetTier).toBe("working");
    expect(highPlan.targetTier).toBe("working");
    expect(lowPlan.nextImportance).toBeLessThan(highPlan.nextImportance);
    expect(lowPlan.nextImportance).toBeGreaterThanOrEqual(0.6);
    expect(highPlan.nextImportance).toBeLessThanOrEqual(0.8);
  });

  it("uses access_count and existing importance together instead of hard-overwriting values", () => {
    const cooler = computeRebalancedImportance(0.6, "core", 6, 19, 0.2);
    const hotter = computeRebalancedImportance(0.9, "core", 19, 19, 0.9);

    expect(cooler).toBeGreaterThanOrEqual(0.85);
    expect(hotter).toBeLessThanOrEqual(0.95);
    expect(hotter).toBeGreaterThan(cooler);
  });

  it("uses recency to spread dead peripheral memories within the peripheral band", () => {
    const older = buildMemoryHealthRebalancePlan({
      id: "dead-old",
      importance: 0.35,
      timestamp: datasetStats.minTimestamp,
      metadata: JSON.stringify({ accessCount: 0 }),
    }, datasetStats);
    const newer = buildMemoryHealthRebalancePlan({
      id: "dead-new",
      importance: 0.35,
      timestamp: datasetStats.maxTimestamp,
      metadata: JSON.stringify({ accessCount: 0 }),
    }, datasetStats);

    expect(older.targetTier).toBe("peripheral");
    expect(newer.targetTier).toBe("peripheral");
    expect(older.nextImportance).toBeGreaterThanOrEqual(0.3);
    expect(newer.nextImportance).toBeLessThanOrEqual(0.5);
    expect(newer.nextImportance).toBeGreaterThan(older.nextImportance);
  });

  it("summarizes rebalance plans for reporting", () => {
    const summary = summarizeMemoryHealthPlans([
      buildMemoryHealthRebalancePlan({
        id: "a",
        importance: 0.7,
        timestamp: datasetStats.minTimestamp,
        metadata: JSON.stringify({ accessCount: 0 }),
      }, datasetStats),
      buildMemoryHealthRebalancePlan({
        id: "b",
        importance: 0.7,
        timestamp: datasetStats.maxTimestamp,
        metadata: JSON.stringify({ tier: "working", accessCount: 4 }),
      }, datasetStats),
    ]);

    expect(summary.totalRows).toBe(2);
    expect(summary.changedRows).toBe(2);
    expect(summary.deadMemoryRows).toBe(1);
    expect(summary.tierBackfills).toBe(1);
    expect(summary.importanceChanges).toBe(2);
  });
});
