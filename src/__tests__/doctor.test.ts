import { describe, expect, it } from "bun:test";

import { assessContinuityBaseline } from "../doctor.js";
import type { MemoryEntry } from "../store.js";

function buildEntry(
  id: string,
  category: MemoryEntry["category"],
  text: string,
  scope: string,
  metadata: Record<string, unknown> = {},
): MemoryEntry {
  return {
    id,
    text,
    vector: [],
    category,
    scope,
    importance: 0.8,
    timestamp: Date.parse("2026-03-17T00:00:00.000Z"),
    metadata: JSON.stringify(metadata),
  };
}

describe("assessContinuityBaseline", () => {
  it("reports full coverage when all canonical continuity seeds are present", () => {
    const seeds = {
      patterns: [
        {
          title: "Cross-window continuity handoff",
          trigger: "When opening a fresh terminal window",
          steps: ["Call resume_context before coding."],
          outcome: "Fresh windows recover stable context.",
          tools: ["resume_context"],
          importance: 0.9,
          source: "agent",
        },
      ],
      cases: [
        {
          title: "Continuity eval checkpoint isolation",
          problem: "Eval reads live checkpoints.",
          solutionSteps: ["Use fixture checkpoints instead."],
          outcome: "Continuity eval becomes deterministic.",
          tools: ["eval:continuity"],
          source: "agent",
          scope: "recallnest",
          importance: 0.85,
        },
      ],
      memories: [
        {
          text: "RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI.",
          category: "entities",
          scope: "recallnest",
          source: "agent",
          importance: 0.9,
          canonicalKey: "entities:recallnest:shared-memory-layer",
        },
      ],
    };

    const entries: MemoryEntry[] = [
      buildEntry(
        "pattern-1",
        "patterns",
        "Workflow pattern: Cross-window continuity handoff",
        "memory:agent",
        { workflowPattern: { title: "Cross-window continuity handoff" } },
      ),
      buildEntry(
        "case-1",
        "cases",
        "Case: Continuity eval checkpoint isolation",
        "recallnest",
        { caseMemory: { title: "Continuity eval checkpoint isolation" } },
      ),
      buildEntry(
        "memory-1",
        "entities",
        "RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI.",
        "recallnest",
        { canonicalKey: "entities:recallnest:shared-memory-layer" },
      ),
    ];

    const assessment = assessContinuityBaseline(entries, seeds as any);

    expect(assessment.found).toEqual({ patterns: 1, cases: 1, memories: 1 });
    expect(assessment.missing).toEqual({ patterns: [], cases: [], memories: [] });
  });

  it("reports missing canonical seeds by category", () => {
    const seeds = {
      patterns: [
        {
          title: "Recall before repo exploration",
          trigger: "When startup context is sparse",
          steps: ["Run search_memory before local repo exploration."],
          outcome: "Fresh windows recover task-specific continuity.",
          tools: ["resume_context", "search_memory"],
          importance: 0.9,
          source: "agent",
        },
      ],
      cases: [
        {
          title: "RecallNest scope fallback cleanup",
          problem: "Project continuity prefers raw transcript notes.",
          solutionSteps: ["Prefer durable cases and patterns."],
          outcome: "Stable project continuity becomes cleaner.",
          tools: ["resume_context"],
          source: "agent",
          scope: "recallnest",
          importance: 0.85,
        },
      ],
      memories: [
        {
          text: "RecallNest continuity revolves around three primitives.",
          category: "entities",
          scope: "recallnest",
          source: "agent",
          importance: 0.9,
          canonicalKey: "entities:recallnest:continuity-primitives",
        },
      ],
    };

    const entries: MemoryEntry[] = [
      buildEntry(
        "pattern-1",
        "patterns",
        "Workflow pattern: Cross-window continuity handoff",
        "memory:agent",
        { workflowPattern: { title: "Cross-window continuity handoff" } },
      ),
    ];

    const assessment = assessContinuityBaseline(entries, seeds as any);

    expect(assessment.found).toEqual({ patterns: 0, cases: 0, memories: 0 });
    expect(assessment.missing.patterns).toEqual(["Recall before repo exploration"]);
    expect(assessment.missing.cases).toEqual(["RecallNest scope fallback cleanup"]);
    expect(assessment.missing.memories).toEqual(["entities:recallnest:continuity-primitives"]);
  });
});
