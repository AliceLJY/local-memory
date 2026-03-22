import { describe, expect, it } from "bun:test";

import { buildContinuityEvalObservationInput, buildContinuityEvalRequest, createContinuityEvalCheckpointStore, runContinuityEval, runRetrievalEval, scoreContinuityCase } from "../eval.js";
import type { ResumeContextResponse } from "../session-schema.js";

describe("scoreContinuityCase", () => {
  it("forwards profile and continuity fields into resume_context eval requests", () => {
    expect(buildContinuityEvalRequest({
      name: "writing_sparse",
      task: "不要让我重复前情，接着写",
      profile: "writing",
      scope: "project:recallnest",
      sessionId: "session-1",
      limitPerSection: 4,
      includeLatestCheckpoint: true,
    })).toEqual({
      task: "不要让我重复前情，接着写",
      scope: "project:recallnest",
      sessionId: "session-1",
      profile: "writing",
      limitPerSection: 4,
      includeLatestCheckpoint: true,
    });
  });

  it("falls back to the case checkpoint sessionId when the eval case omits top-level sessionId", () => {
    expect(buildContinuityEvalRequest({
      name: "project_scope_checkpoint_continuity",
      task: "继续这个项目，不要让我重复前情",
      profile: "default",
      scope: "project:recallnest",
      includeLatestCheckpoint: true,
      checkpoint: {
        sessionId: "eval-project-recallnest-checkpoint",
        scope: "project:recallnest",
        summary: "RecallNest continuity acceptance checkpoint fixture.",
      },
    })).toEqual({
      task: "继续这个项目，不要让我重复前情",
      scope: "project:recallnest",
      sessionId: "eval-project-recallnest-checkpoint",
      profile: "default",
      limitPerSection: undefined,
      includeLatestCheckpoint: true,
    });
  });

  it("scores a continuity response using section-specific expectations", () => {
    const response: ResumeContextResponse = {
      summary: "Loaded stable context with a latest checkpoint for RecallNest continuity work.",
      stableContext: [
        "Preference: User prefers concise technical replies.",
        "Entity: RecallNest is shared across Claude Code, Codex, and Gemini CLI.",
      ],
      relevantPatterns: [
        "At task start, run search_memory before coding.",
      ],
      recentCases: [
        "Keep session state in a checkpoint store instead of the durable index.",
      ],
      latestCheckpoint: {
        sessionId: "session-1",
        summary: "Continue building resume_context for fresh windows",
        updatedAt: "2026-03-16T06:00:00.000Z",
      },
      generatedAt: "2026-03-16T06:05:00.000Z",
    };

    const report = scoreContinuityCase({
      name: "continuity_case",
      task: "continue RecallNest work",
      expectStableAny: ["RecallNest", "Codex"],
      expectPatternsAny: ["search_memory"],
      expectCasesAny: ["checkpoint store"],
      expectCheckpointAny: ["resume_context"],
    }, response);

    expect(report.passed).toBe(true);
    expect(report.matchedStableAny).toEqual(["RecallNest", "Codex"]);
    expect(report.matchedPatternsAny).toEqual(["search_memory"]);
    expect(report.matchedCasesAny).toEqual(["checkpoint store"]);
    expect(report.matchedCheckpointAny).toEqual(["resume_context"]);
    expect(report.hasCheckpoint).toBe(true);
    expect(report.score).toBeGreaterThan(0.9);
  });

  it("penalizes forbidden matches", () => {
    const response: ResumeContextResponse = {
      summary: "Loaded unrelated stable context.",
      stableContext: ["Profile: unrelated memory"],
      relevantPatterns: [],
      recentCases: [],
      generatedAt: "2026-03-16T06:10:00.000Z",
    };

    const report = scoreContinuityCase({
      name: "continuity_forbid",
      task: "fresh window",
      forbid: ["unrelated"],
    }, response);

    expect(report.passed).toBe(false);
    expect(report.forbiddenMatches).toEqual(["unrelated"]);
    expect(report.score).toBeLessThan(0.8);
  });

  it("uses only case-defined checkpoint fixtures instead of live checkpoint state", async () => {
    const checkpointStore = createContinuityEvalCheckpointStore([
      {
        name: "checkpoint_case",
        scope: "recallnest",
        includeLatestCheckpoint: true,
        checkpoint: {
          sessionId: "eval-session-1",
          scope: "recallnest",
          summary: "RecallNest Phase 3/4 checkpoint fixture with resume_context and store_memory.",
          task: "Continue RecallNest continuity work",
          decisions: ["Keep checkpoints out of the durable index"],
          updatedAt: "2026-03-16T06:00:00.000Z",
        },
      },
    ]);

    const byScope = await checkpointStore.getLatest({ scope: "recallnest" });
    const bySession = await checkpointStore.getLatest({ sessionId: "eval-session-1" });
    const missing = await checkpointStore.getLatest({ scope: "other-project" });

    expect(byScope).toMatchObject({
      sessionId: "eval-session-1",
      resolvedScope: "project:recallnest",
      summary: "RecallNest Phase 3/4 checkpoint fixture with resume_context and store_memory.",
    });
    expect(bySession?.resolvedScope).toBe("project:recallnest");
    expect(missing).toBeNull();
  });

  it("builds workflow observations for continuity eval results without using regular memory", () => {
    const passed = buildContinuityEvalObservationInput({
      name: "continuity_pass",
      profile: "debug",
      scope: "project:recallnest",
    }, {
      mode: "continuity",
      name: "continuity_pass",
      task: "continue RecallNest work",
      profile: "debug",
      score: 0.94,
      passed: true,
      stableCount: 2,
      patternCount: 1,
      caseCount: 1,
      hasCheckpoint: true,
      matchedStableAny: [],
      matchedStableAll: [],
      matchedPatternsAny: [],
      matchedCasesAny: [],
      matchedCheckpointAny: [],
      forbiddenMatches: [],
      stablePreview: [],
      patternPreview: [],
      casePreview: [],
      checkpointSummary: "ok",
    });

    expect(passed).toMatchObject({
      workflowId: "resume_context",
      outcome: "success",
      scope: "project:recallnest",
      source: "eval",
      signal: "eval-pass",
      task: "continuity eval: continuity_pass",
      tools: ["resume_context"],
    });

    const failed = buildContinuityEvalObservationInput({
      name: "continuity_fail",
      expectPatternsAny: ["search_memory"],
      expectCheckpointAny: ["checkpoint"],
    }, {
      mode: "continuity",
      name: "continuity_fail",
      task: "continue",
      profile: "default",
      score: 0.42,
      passed: false,
      stableCount: 0,
      patternCount: 0,
      caseCount: 0,
      hasCheckpoint: false,
      matchedStableAny: [],
      matchedStableAll: [],
      matchedPatternsAny: [],
      matchedCasesAny: [],
      matchedCheckpointAny: [],
      forbiddenMatches: [],
      stablePreview: [],
      patternPreview: [],
      casePreview: [],
      checkpointSummary: "-",
    }, {
      scope: "eval:continuity",
      source: "eval",
    });

    expect(failed).toMatchObject({
      workflowId: "resume_context",
      outcome: "failure",
      scope: "eval:continuity",
      source: "eval",
      signal: "missing-patterns",
      task: "continuity eval: continuity_fail",
      tools: ["resume_context"],
    });
    expect(failed.summary).toContain("failed");
  });

  it("creates fresh continuity eval components for each case instead of sharing one resolver", async () => {
    let componentCreations = 0;

    const reports = await runContinuityEval([
      { name: "case-a", task: "continue A" },
      { name: "case-b", task: "continue B" },
    ], {}, {
      createEvalComponents: () => {
        componentCreations += 1;
        const instanceId = componentCreations;
        return {
          retriever: {
            instanceId,
            async retrieve() {
              return [];
            },
          } as never,
          accessTracker: {
            destroy() {},
          } as never,
        };
      },
      composeResumeContextFn: async (deps) => ({
        summary: `instance:${(deps.retriever as { instanceId: number }).instanceId}`,
        stableContext: [`instance:${(deps.retriever as { instanceId: number }).instanceId}`],
        relevantPatterns: [],
        recentCases: [],
        generatedAt: "2026-03-20T00:00:00.000Z",
      }),
    });

    expect(componentCreations).toBe(2);
    expect(reports[0]?.stablePreview[0]).toContain("instance:1");
    expect(reports[1]?.stablePreview[0]).toContain("instance:2");
  });

  it("runs retrieval eval in auto-recall mode so eval does not reinforce access counts", async () => {
    const seenSources: string[] = [];

    const reports = await runRetrievalEval([
      { name: "retrieval_case", query: "RecallNest" },
    ], {
      createEvalComponents: () => ({
        retriever: {
          async retrieve(context) {
            seenSources.push(context.source || "unset");
            return [];
          },
        } as never,
        accessTracker: {
          destroy() {},
        } as never,
      }),
    });

    expect(seenSources).toEqual(["auto-recall"]);
    expect(reports).toHaveLength(1);
  });
});
