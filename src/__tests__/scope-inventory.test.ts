import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectScopeInventory, formatScopeInventoryReport } from "../scope-inventory.js";
import { MemoryStore } from "../store.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recallnest-scope-inventory-"));
  cleanupPaths.push(root);
  return root;
}

function writeJson(dir: string, name: string, payload: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(payload, null, 2) + "\n");
}

describe("collectScopeInventory", () => {
  it("audits memories, pins, checkpoints, and workflow observations separately", async () => {
    const root = createTempRoot();
    const store = new MemoryStore({
      dbPath: join(root, "db"),
      vectorDim: 3,
    });

    await store.store({
      text: "Scoped durable memory.",
      vector: [1, 0, 0],
      category: "entities",
      scope: "project:recallnest",
      importance: 0.8,
      metadata: "{}",
    });
    await store.store({
      text: "Historical global memory row.",
      vector: [0, 1, 0],
      category: "events",
      scope: "global",
      importance: 0.5,
      metadata: "{}",
    });

    const pinsDir = join(root, "pins");
    writeJson(pinsDir, "pin-legacy.json", {
      id: "pin-legacy",
      type: "pinned-memory",
      title: "Legacy pin",
      summary: "Pinned from an old global row.",
      source: {
        memoryId: "memory-1",
        scope: "global",
        timestamp: Date.now(),
        metadata: {},
      },
      createdAt: "2026-03-18T00:00:00.000Z",
      updatedAt: "2026-03-18T00:00:00.000Z",
      snippet: "Legacy pin snippet.",
    });

    const checkpointsDir = join(root, "session-checkpoints");
    writeJson(checkpointsDir, "checkpoint-legacy.json", {
      checkpointId: "checkpoint-legacy",
      sessionId: "session-1",
      resolvedScope: "   ",
      summary: "Old checkpoint that never got a real resolved scope.",
      updatedAt: "2026-03-18T00:01:00.000Z",
    });

    const workflowDir = join(root, "workflow-observations");
    writeJson(workflowDir, "workflow-legacy.json", {
      observationId: "workflow-legacy",
      workflowId: "resume_context",
      resolvedScope: null,
      summary: "Legacy workflow observation missing scope.",
      recordedAt: "2026-03-18T00:02:00.000Z",
    });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(workflowDir, "broken.json"), "{not-json");

    const report = await collectScopeInventory({
      store,
      sampleLimit: 10,
      pinsDir,
      checkpointsDir,
      workflowObservationsDir: workflowDir,
    });

    expect(report.totalScannedCount).toBe(6);
    expect(report.totalAnomalyCount).toBe(4);
    expect(report.totalInvalidCount).toBe(1);
    expect(report.totalReviewedCount).toBe(0);

    const memoryLayer = report.layers.find((layer) => layer.layer === "memories");
    const pinLayer = report.layers.find((layer) => layer.layer === "pins");
    const checkpointLayer = report.layers.find((layer) => layer.layer === "session-checkpoints");
    const workflowLayer = report.layers.find((layer) => layer.layer === "workflow-observations");

    expect(memoryLayer?.anomalyCount).toBe(1);
    expect(memoryLayer?.counts.global).toBe(1);
    expect(pinLayer?.anomalyCount).toBe(1);
    expect(pinLayer?.counts.global).toBe(1);
    expect(checkpointLayer?.anomalyCount).toBe(1);
    expect(checkpointLayer?.counts.empty).toBe(1);
    expect(workflowLayer?.anomalyCount).toBe(1);
    expect(workflowLayer?.counts.missing).toBe(1);
    expect(workflowLayer?.invalidCount).toBe(1);
    expect(workflowLayer?.reviewedCount).toBe(0);

    const output = formatScopeInventoryReport(report);
    expect(output).toContain("Scope inventory");
    expect(output).toContain("[memories]");
    expect(output).toContain("[pins]");
    expect(output).toContain("[session-checkpoints]");
    expect(output).toContain("[workflow-observations]");
  });

  it("returns a clean report when every layer is scoped correctly", async () => {
    const root = createTempRoot();
    const store = new MemoryStore({
      dbPath: join(root, "db"),
      vectorDim: 3,
    });

    await store.store({
      text: "Scoped memory.",
      vector: [1, 0, 0],
      category: "entities",
      scope: "project:recallnest",
      importance: 0.9,
      metadata: "{}",
    });

    const report = await collectScopeInventory({
      store,
      sampleLimit: 5,
      pinsDir: join(root, "missing-pins"),
      checkpointsDir: join(root, "missing-checkpoints"),
      workflowObservationsDir: join(root, "missing-workflows"),
    });

    expect(report.totalScannedCount).toBe(1);
    expect(report.totalAnomalyCount).toBe(0);
    expect(report.totalInvalidCount).toBe(0);
    expect(report.totalReviewedCount).toBe(0);
    expect(report.layers.every((layer) => layer.samples.length === 0)).toBe(true);
    expect(formatScopeInventoryReport(report)).toContain("No unresolved legacy scope anomalies found");
  });

  it("suppresses reviewed keep-global workflow observations from unresolved anomaly counts", async () => {
    const root = createTempRoot();
    const store = new MemoryStore({
      dbPath: join(root, "db"),
      vectorDim: 3,
    });

    const workflowDir = join(root, "workflow-observations");
    writeJson(workflowDir, "workflow-reviewed.json", {
      observationId: "workflow-reviewed",
      workflowId: "resume_context",
      resolvedScope: "global",
      summary: "Legacy workflow observation intentionally left global.",
      recordedAt: "2026-03-18T00:02:00.000Z",
      legacyScopeReview: {
        decision: "keep",
        kind: "global",
        reason: "external-task",
        reviewedAt: "2026-03-18T00:03:00.000Z",
      },
    });

    const report = await collectScopeInventory({
      store,
      sampleLimit: 5,
      workflowObservationsDir: workflowDir,
      pinsDir: join(root, "missing-pins"),
      checkpointsDir: join(root, "missing-checkpoints"),
    });

    const workflowLayer = report.layers.find((layer) => layer.layer === "workflow-observations");
    expect(report.totalAnomalyCount).toBe(0);
    expect(report.totalReviewedCount).toBe(1);
    expect(workflowLayer?.anomalyCount).toBe(0);
    expect(workflowLayer?.reviewedCount).toBe(1);
    expect(workflowLayer?.samples).toHaveLength(0);
    expect(formatScopeInventoryReport(report)).toContain("Reviewed keeps : 1");
  });
});
