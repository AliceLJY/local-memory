import { describe, expect, it } from "bun:test";

import {
  assessContinuityBaseline,
  assessScopeInventoryReport,
  formatDoctorResults,
  loadContinuityBaselineEntries,
} from "../doctor.js";
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

  it("loads enough entries for baseline checks when the index is larger than the legacy 5000-entry window", async () => {
    const targetEntry = buildEntry(
      "pattern-target",
      "patterns",
      "Workflow pattern: RecallNest MCP transport rollout",
      "project:recallnest",
      { workflowPattern: { title: "RecallNest MCP transport rollout" } },
    );
    const entries: MemoryEntry[] = [
      ...Array.from({ length: 5000 }, (_, index) => buildEntry(
        `noise-${index}`,
        "patterns",
        `Workflow pattern: Noise ${index}`,
        "memory:agent",
        { workflowPattern: { title: `Noise ${index}` } },
      )),
      targetEntry,
    ];
    const listCalls: Array<[string[] | undefined, string | undefined, number | undefined, number | undefined]> = [];
    const store = {
      async list(scopeFilter?: string[], category?: string, limit = 20, offset = 0): Promise<MemoryEntry[]> {
        listCalls.push([scopeFilter, category, limit, offset]);
        return entries.slice(offset, offset + limit);
      },
    };

    const loaded = await loadContinuityBaselineEntries(store as any, entries.length);
    const assessment = assessContinuityBaseline(loaded, {
      patterns: [
        {
          title: "RecallNest MCP transport rollout",
          trigger: "When RecallNest continuity work touches MCP transport wiring under project scope",
          steps: ["Call resume_context with project:recallnest before transport changes."],
          outcome: "RecallNest transport changes stay project-scoped.",
          tools: ["resume_context", "search_memory", "eval:continuity"],
          source: "agent",
          scope: "project:recallnest",
          importance: 0.87,
        },
      ],
      cases: [],
      memories: [],
    } as any);

    expect(listCalls).toEqual([[undefined, undefined, 5001, 0]]);
    expect(assessment.found.patterns).toBe(1);
    expect(assessment.missing.patterns).toEqual([]);
  });
});

describe("assessScopeInventoryReport", () => {
  it("reports a clean scope inventory when no unresolved anomalies remain", () => {
    const result = assessScopeInventoryReport({
      generatedAt: "2026-03-19T08:20:00.000Z",
      sampleLimit: 5,
      totalScannedCount: 42,
      totalAnomalyCount: 0,
      totalInvalidCount: 0,
      totalReviewedCount: 1,
      layers: [
        {
          layer: "memories",
          scannedCount: 40,
          anomalyCount: 0,
          invalidCount: 0,
          reviewedCount: 0,
          counts: { missing: 0, empty: 0, global: 0 },
          samples: [],
          recommendation: "ok",
        },
        {
          layer: "workflow-observations",
          scannedCount: 2,
          anomalyCount: 0,
          invalidCount: 0,
          reviewedCount: 1,
          counts: { missing: 0, empty: 0, global: 0 },
          samples: [],
          recommendation: "ok",
        },
      ],
    });

    expect(result).toEqual({
      name: "Scope inventory",
      status: "pass",
      message: "0 unresolved anomalies across 42 records; reviewed keeps 1",
    });
  });

  it("warns when scope inventory still has unresolved anomalies or invalid files", () => {
    const result = assessScopeInventoryReport({
      generatedAt: "2026-03-19T08:20:00.000Z",
      sampleLimit: 5,
      totalScannedCount: 12,
      totalAnomalyCount: 2,
      totalInvalidCount: 1,
      totalReviewedCount: 0,
      layers: [
        {
          layer: "pins",
          scannedCount: 4,
          anomalyCount: 1,
          invalidCount: 0,
          reviewedCount: 0,
          counts: { missing: 0, empty: 0, global: 1 },
          samples: [{
            layer: "pins",
            id: "pin-legacy-1234",
            kind: "global",
            scope: "global",
            context: "pin",
            preview: "Legacy pin",
            recordedAt: "2026-03-19T08:00:00.000Z",
          }],
          recommendation: "re-pin",
        },
        {
          layer: "workflow-observations",
          scannedCount: 8,
          anomalyCount: 1,
          invalidCount: 1,
          reviewedCount: 0,
          counts: { missing: 1, empty: 0, global: 0 },
          samples: [],
          recommendation: "review",
        },
      ],
    });

    expect(result.status).toBe("warn");
    expect(result.name).toBe("Scope inventory");
    expect(result.message).toContain("2 unresolved anomalies, 1 invalid file(s) across 12 records");
    expect(result.message).toContain("pins:1");
    expect(result.message).toContain("workflow-observations:1 invalid 1");
    expect(result.message).toContain("sample pins:global:pin-lega");
    expect(result.fix).toBe("bun run scope-inventory");
  });
});

describe("formatDoctorResults", () => {
  it("does not claim all clear when warnings are present", () => {
    const output = formatDoctorResults([
      { name: "Bun runtime", status: "pass", message: "ok" },
      { name: "Scope inventory", status: "warn", message: "1 unresolved anomaly", fix: "bun run scope-inventory" },
    ]);

    expect(output).toContain("Review the ⚠️ items above before relying on this environment as a clean baseline.");
    expect(output).not.toContain("All clear.");
  });
});
