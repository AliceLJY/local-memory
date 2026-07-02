import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyWorkflowObservationScopeSuggestions,
  formatWorkflowObservationScopeReview,
  keepWorkflowObservationScopesGlobal,
  parseWorkflowObservationScopeCue,
  reviewWorkflowObservationScopes,
} from "../workflow-observation-scope-review.js";
import {
  buildWorkflowEvidence,
  buildWorkflowHealthDashboard,
  buildWorkflowObservationRecord,
  inspectWorkflowHealth,
  resolveWorkflowObservationScope,
} from "../workflow-observation-engine.js";
import { collectScopeInventory } from "../scope-inventory.js";
import { buildSessionCheckpointResult } from "../session-engine.js";
import { MemoryStore } from "../store.js";
import { buildManagedCheckpointObservation, buildManagedResumeObservation } from "../workflow-observation-managed.js";
import { WorkflowObservationStore } from "../workflow-observation-store.js";

describe("workflow observation engine", () => {
  it("defaults observation scope to global", () => {
    const record = buildWorkflowObservationRecord({
      workflowId: "resume_context",
      outcome: "missed",
      summary: "Fresh window skipped resume_context before repo exploration.",
    });

    expect(resolveWorkflowObservationScope(record)).toBe("global");
    expect(record.resolvedScope).toBe("global");
  });

  it("aggregates workflow health and evidence from append-only observations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recallnest-workflow-observations-"));
    try {
      const store = new WorkflowObservationStore(dir);
      const records = [
        {
          workflowId: "resume_context",
          scope: "project:recallnest",
          outcome: "missed",
          summary: "Fresh window explored the repo before continuity recovery.",
          signal: "missed-startup-trigger",
          source: "smoke",
          recordedAt: "2026-03-15T03:00:00.000Z",
        },
        {
          workflowId: "resume_context",
          scope: "project:recallnest",
          outcome: "corrected",
          summary: "User had to remind the agent to recover continuity first.",
          signal: "user-correction",
          source: "agent",
          recordedAt: "2026-03-16T03:00:00.000Z",
        },
        {
          workflowId: "resume_context",
          scope: "project:recallnest",
          outcome: "success",
          summary: "Fresh window recovered RecallNest continuity before coding.",
          signal: "startup-recovered",
          source: "smoke",
          recordedAt: "2026-03-17T03:00:00.000Z",
        },
        {
          workflowId: "checkpoint_session",
          scope: "project:recallnest",
          outcome: "failure",
          summary: "Checkpoint still carried repo-state text before the product-side guard landed.",
          signal: "repo-state-contamination",
          source: "smoke",
          recordedAt: "2026-03-17T04:00:00.000Z",
        },
      ];

      for (const record of records) {
        await store.save(buildWorkflowObservationRecord(record));
      }

      const health = await inspectWorkflowHealth(store, {
        workflowId: "resume_context",
        scope: "project:recallnest",
        now: new Date("2026-03-17T12:00:00.000Z"),
      });
      expect(health.status).toBe("watch");
      expect(health.windows[1]?.total).toBe(3);
      expect(health.windows[1]?.missed).toBe(1);
      expect(health.windows[1]?.corrected).toBe(1);
      expect(health.windows[1]?.successRate).toBeCloseTo(1 / 3, 5);

      const dashboard = buildWorkflowHealthDashboard(
        await store.listRecent({ scope: "project:recallnest", limit: 50 }),
        { scope: "project:recallnest", now: new Date("2026-03-17T12:00:00.000Z") },
      );
      expect(dashboard[0]?.workflowId).toBe("checkpoint_session");
      expect(dashboard[0]?.status).toBe("critical");

      const evidence = await buildWorkflowEvidence(store, {
        workflowId: "checkpoint_session",
        scope: "project:recallnest",
        now: new Date("2026-03-17T12:00:00.000Z"),
      });
      expect(evidence.topSignals[0]?.signal).toBe("repo-state-contamination");
      expect(evidence.suggestions).toContain(
        "Keep volatile repo-state text out of saved checkpoints and handoff summaries unless this window verified it.",
      );
      expect(evidence.suggestions).toContain(
        "Add end-of-window guards so checkpoint content is sanitized before it becomes the next handoff.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses idempotencyKey to replace retried workflow observation files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recallnest-workflow-idempotency-"));
    try {
      const store = new WorkflowObservationStore(dir);
      const baseInput = {
        workflowId: "checkpoint_session",
        outcome: "success" as const,
        summary: "Checkpoint saved after task handoff.",
        scope: "project:recallnest",
        source: "agent",
        idempotencyKey: "workflow-observation-request-123",
      };

      const first = await store.save(buildWorkflowObservationRecord({
        ...baseInput,
        recordedAt: "2026-06-26T01:00:00.000Z",
      }));
      const retried = await store.save(buildWorkflowObservationRecord({
        ...baseInput,
        recordedAt: "2026-06-26T01:01:00.000Z",
      }));

      expect(retried.observationId).toBe(first.observationId);
      expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(1);

      const recent = await store.listRecent({ workflowId: "checkpoint_session", scope: "project:recallnest" });
      expect(recent).toHaveLength(1);
      expect(recent[0]?.recordedAt).toBe("2026-06-26T01:01:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds managed continuity observations without routing them into regular memory", () => {
    const resumeObservation = buildManagedResumeObservation({
      sessionId: "session-123",
      task: "Continue RecallNest continuity work",
    }, {
      stableContext: ["Entity: RecallNest continuity revolves around three primitives."],
      relevantPatterns: ["Call resume_context before coding."],
      recentCases: ["Case: RecallNest sparse startup context cleanup"],
      latestCheckpoint: {
        sessionId: "session-123",
        summary: "Checkpoint summary",
        updatedAt: "2026-03-17T11:00:00.000Z",
      },
      responseMode: "default",
    });

    expect(resumeObservation.workflowId).toBe("resume_context");
    expect(resumeObservation.outcome).toBe("success");
    expect(resumeObservation.scope).toBe("session:session-123");
    expect(resumeObservation.source).toBe("managed");
    expect(resumeObservation.signal).toBe("managed-resume-resolved");
    expect(resumeObservation.tags).toContain("managed");
    expect(resumeObservation.tools).toEqual(["resume_context"]);

    const checkpointObservation = buildManagedCheckpointObservation(buildSessionCheckpointResult({
      sessionId: "session-123",
      scope: "project:recallnest",
      summary: "Only resumed context here. git status shows modified files.",
      openLoops: ["git status still needs review"],
    }));

    expect(checkpointObservation.workflowId).toBe("checkpoint_session");
    expect(checkpointObservation.outcome).toBe("corrected");
    expect(checkpointObservation.scope).toBe("project:recallnest");
    expect(checkpointObservation.source).toBe("managed");
    expect(checkpointObservation.signal).toBe("repo-state-sanitized");
    expect(checkpointObservation.summary).toContain("summary and openLoops");
    expect(checkpointObservation.tools).toEqual(["checkpoint_session"]);
  });

  it("uses resolved scope fallback for managed resume observations when request scope is absent", () => {
    const observation = buildManagedResumeObservation({
      task: "Continue RecallNest scope cleanup",
    }, {
      resolvedScope: "project:recallnest",
      stableContext: ["Entity: RecallNest continuity revolves around three primitives."],
      relevantPatterns: [],
      recentCases: [],
      latestCheckpoint: {
        sessionId: "session-xyz",
        resolvedScope: "project:recallnest",
        summary: "Checkpoint summary",
        updatedAt: "2026-03-18T00:00:00.000Z",
      },
      responseMode: "default",
    });

    expect(observation.scope).toBe("project:recallnest");
  });

  it("reviews and applies cue-based scope suggestions for legacy global workflow observations", () => {
    const dir = mkdtempSync(join(tmpdir(), "recallnest-workflow-scope-review-"));
    try {
      const recallnestPath = join(dir, "recallnest.json");
      const externalPath = join(dir, "external.json");
      writeFileSync(recallnestPath, JSON.stringify({
        workflowId: "resume_context",
        summary: "Managed resume_context recovered 1 stable item(s), 1 pattern(s), and 1 case(s).",
        source: "managed",
        task: "Continue RecallNest scope cleanup",
        recordedAt: "2026-03-18T00:00:00.000Z",
        observationId: "obs-recallnest",
        resolvedScope: "global",
      }, null, 2) + "\n");
      writeFileSync(externalPath, JSON.stringify({
        workflowId: "resume_context",
        summary: "Managed resume_context recovered 1 stable item(s), 0 pattern(s), and 0 case(s).",
        source: "managed",
        task: "A2A code Claude SDK calling error",
        recordedAt: "2026-03-18T00:01:00.000Z",
        observationId: "obs-external",
        resolvedScope: "global",
      }, null, 2) + "\n");

      const review = reviewWorkflowObservationScopes({
        dir,
        currentScope: "global",
        source: "managed",
        workflowId: "resume_context",
        cues: [parseWorkflowObservationScopeCue("recallnest=project:recallnest")],
      });

      expect(review.totalCount).toBe(2);
      expect(review.suggestedCount).toBe(1);
      expect(review.manualReviewCount).toBe(1);
      expect(review.entries[0]?.suggestedScope).toBeUndefined();
      expect(review.entries[1]?.suggestedScope).toBe("project:recallnest");
      expect(formatWorkflowObservationScopeReview(review)).toContain("project:recallnest");

      const result = applyWorkflowObservationScopeSuggestions(review);
      expect(result.updatedCount).toBe(1);
      expect(result.skippedCount).toBe(1);

      const rewritten = JSON.parse(readFileSync(recallnestPath, "utf-8"));
      const untouched = JSON.parse(readFileSync(externalPath, "utf-8"));
      expect(rewritten.scope).toBe("project:recallnest");
      expect(rewritten.resolvedScope).toBe("project:recallnest");
      expect(untouched.resolvedScope).toBe("global");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can infer a scope from a nearby managed observation when cues are absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "recallnest-workflow-scope-neighbor-"));
    try {
      const globalPath = join(dir, "global.json");
      const neighborPath = join(dir, "neighbor.json");
      writeFileSync(globalPath, JSON.stringify({
        workflowId: "resume_context",
        summary: "Managed resume_context recovered 2 stable item(s), 1 pattern(s), and 0 case(s).",
        source: "managed",
        recordedAt: "2026-03-18T00:00:00.000Z",
        observationId: "obs-global",
        resolvedScope: "global",
      }, null, 2) + "\n");
      writeFileSync(neighborPath, JSON.stringify({
        workflowId: "checkpoint_session",
        summary: "Managed checkpoint_session sanitized repo-state text out of summary before saving the handoff.",
        source: "managed",
        recordedAt: "2026-03-18T00:00:40.000Z",
        observationId: "obs-neighbor",
        resolvedScope: "session:recallnest-2026-03-18",
      }, null, 2) + "\n");

      const review = reviewWorkflowObservationScopes({
        dir,
        currentScope: "global",
        source: "managed",
        workflowId: "resume_context",
        neighborWindowSeconds: 90,
      });

      expect(review.totalCount).toBe(1);
      expect(review.suggestedCount).toBe(1);
      expect(review.entries[0]?.suggestedScope).toBe("session:recallnest-2026-03-18");
      expect(review.entries[0]?.reason).toContain("matched nearby checkpoint_session");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can mark manual-review legacy global observations as reviewed keep-global", () => {
    const dir = mkdtempSync(join(tmpdir(), "recallnest-workflow-scope-keep-global-"));
    try {
      const externalPath = join(dir, "external.json");
      writeFileSync(externalPath, JSON.stringify({
        workflowId: "resume_context",
        summary: "Managed resume_context recovered 1 stable item(s), 0 pattern(s), and 0 case(s).",
        source: "managed",
        task: "A2A code Claude SDK calling error",
        recordedAt: "2026-03-18T00:01:00.000Z",
        observationId: "obs-external",
        resolvedScope: "global",
      }, null, 2) + "\n");

      const review = reviewWorkflowObservationScopes({
        dir,
        currentScope: "global",
        source: "managed",
        workflowId: "resume_context",
      });
      expect(review.totalCount).toBe(1);
      expect(review.manualReviewCount).toBe(1);

      const result = keepWorkflowObservationScopesGlobal(review, {
        ids: ["obs-external"],
        reason: "external-task",
        reviewedAt: "2026-03-18T00:05:00.000Z",
      });
      expect(result.reviewedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      expect(result.unmatchedIds).toEqual([]);
      expect(result.ambiguousIds).toEqual([]);

      const rewritten = JSON.parse(readFileSync(externalPath, "utf-8"));
      expect(rewritten.legacyScopeReview).toEqual({
        decision: "keep",
        kind: "global",
        reason: "external-task",
        reviewedAt: "2026-03-18T00:05:00.000Z",
      });

      const nextReview = reviewWorkflowObservationScopes({
        dir,
        currentScope: "global",
        source: "managed",
        workflowId: "resume_context",
      });
      expect(nextReview.totalCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps mixed rewrite and keep-global review flows converged on a clean second pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "recallnest-workflow-scope-mixed-"));
    try {
      const workflowDir = join(root, "workflow-observations");
      mkdirSync(workflowDir, { recursive: true });
      const recallnestPath = join(workflowDir, "recallnest.json");
      const externalPath = join(workflowDir, "external.json");
      writeFileSync(recallnestPath, JSON.stringify({
        workflowId: "resume_context",
        summary: "Managed resume_context recovered 1 stable item(s), 1 pattern(s), and 1 case(s).",
        source: "managed",
        task: "Continue RecallNest scope cleanup",
        recordedAt: "2026-03-18T00:00:00.000Z",
        observationId: "obs-recallnest",
        resolvedScope: "global",
      }, null, 2) + "\n");
      writeFileSync(externalPath, JSON.stringify({
        workflowId: "resume_context",
        summary: "Managed resume_context recovered 1 stable item(s), 0 pattern(s), and 0 case(s).",
        source: "managed",
        task: "A2A code Claude SDK calling error",
        recordedAt: "2026-03-18T00:01:00.000Z",
        observationId: "obs-external",
        resolvedScope: "global",
      }, null, 2) + "\n");

      const review = reviewWorkflowObservationScopes({
        dir: workflowDir,
        currentScope: "global",
        source: "managed",
        workflowId: "resume_context",
        cues: [parseWorkflowObservationScopeCue("recallnest=project:recallnest")],
      });
      expect(review.totalCount).toBe(2);
      expect(review.suggestedCount).toBe(1);
      expect(review.manualReviewCount).toBe(1);

      const keepResult = keepWorkflowObservationScopesGlobal(review, {
        ids: ["obs-external"],
        reason: "external-task",
        reviewedAt: "2026-03-18T00:05:00.000Z",
      });
      const rewriteResult = applyWorkflowObservationScopeSuggestions(review);
      expect(keepResult.reviewedCount).toBe(1);
      expect(rewriteResult.updatedCount).toBe(1);

      const nextReview = reviewWorkflowObservationScopes({
        dir: workflowDir,
        currentScope: "global",
        source: "managed",
        workflowId: "resume_context",
        cues: [parseWorkflowObservationScopeCue("recallnest=project:recallnest")],
      });
      expect(nextReview.totalCount).toBe(0);

      const store = new MemoryStore({
        dbPath: join(root, "db"),
        vectorDim: 3,
      });
      const inventory = await collectScopeInventory({
        store,
        sampleLimit: 5,
        workflowObservationsDir: workflowDir,
        pinsDir: join(root, "pins"),
        checkpointsDir: join(root, "checkpoints"),
      });
      const workflowLayer = inventory.layers.find((layer) => layer.layer === "workflow-observations");
      expect(inventory.totalAnomalyCount).toBe(0);
      expect(inventory.totalReviewedCount).toBe(1);
      expect(workflowLayer?.anomalyCount).toBe(0);
      expect(workflowLayer?.reviewedCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
