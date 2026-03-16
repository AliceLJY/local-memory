import { describe, expect, it } from "bun:test";

import { scoreContinuityCase } from "../eval.js";
import type { ResumeContextResponse } from "../session-schema.js";

describe("scoreContinuityCase", () => {
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
});
