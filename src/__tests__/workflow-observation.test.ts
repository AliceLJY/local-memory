import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildWorkflowEvidence,
  buildWorkflowHealthDashboard,
  buildWorkflowObservationRecord,
  inspectWorkflowHealth,
  resolveWorkflowObservationScope,
} from "../workflow-observation-engine.js";
import { buildSessionCheckpointResult } from "../session-engine.js";
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
        { scope: "project:recallnest" },
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
});
