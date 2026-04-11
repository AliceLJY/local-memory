/**
 * Tests for HP-predictive Phase 5: Prediction Engine
 *
 * Validates:
 * 1. collectSignals() — each signal type is correctly extracted
 * 2. scorePredictions() — scoring, filtering by threshold, ranking
 * 3. Edge cases — empty inputs, boundary conditions
 */
import { describe, expect, it } from "bun:test";
import {
  collectSignals,
  scorePredictions,
  _testConstants,
  type PredictionContext,
  type PredictionSignal,
} from "../prediction-engine.js";
import type { SessionCheckpointRecord } from "../session-schema.js";
import type { WorkflowObservationRecord } from "../workflow-observation-schema.js";

const { CONFIDENCE_THRESHOLD, STALE_OPEN_LOOP_HOURS, STALE_MEMORY_DAYS, MAX_PREDICTIONS, SIGNAL_WEIGHTS } = _testConstants;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckpoint(overrides: Partial<SessionCheckpointRecord> & { openLoops?: string[]; updatedAt: string }): SessionCheckpointRecord {
  return {
    checkpointId: `cp-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "test-session",
    resolvedScope: "test",
    scope: "test",
    summary: "test checkpoint",
    task: "test task",
    decisions: [],
    openLoops: overrides.openLoops ?? [],
    nextActions: [],
    entities: [],
    files: [],
    updatedAt: overrides.updatedAt,
    ...overrides,
  };
}

function makeWorkflowObservation(overrides: Partial<WorkflowObservationRecord>): WorkflowObservationRecord {
  return {
    observationId: `obs-${Math.random().toString(36).slice(2, 8)}`,
    workflowId: "test-workflow",
    outcome: "corrected",
    summary: "Fixed a workflow issue",
    scope: "test",
    resolvedScope: "test",
    source: "manual",
    tags: [],
    tools: [],
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

function emptyContext(overrides?: Partial<PredictionContext>): PredictionContext {
  return {
    checkpoints: [],
    workflowObservations: [],
    frequentMemories: [],
    uncoveredTopics: [],
    now: new Date("2026-04-11T12:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// collectSignals
// ---------------------------------------------------------------------------

describe("collectSignals", () => {
  describe("stale open loop signals", () => {
    it("detects stale open loops from checkpoints older than 24h", () => {
      const now = new Date("2026-04-11T12:00:00Z");
      const staleCheckpoint = makeCheckpoint({
        openLoops: ["Fix CI pipeline", "Review PR #42"],
        updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(), // 48h ago
      });

      const signals = collectSignals(emptyContext({
        checkpoints: [staleCheckpoint],
        now,
      }));

      const openLoopSignals = signals.filter(s => s.type === "stale_open_loop");
      expect(openLoopSignals.length).toBe(2);
      expect(openLoopSignals[0].trigger).toBe("Fix CI pipeline");
      expect(openLoopSignals[0].weight).toBeGreaterThan(0.6);
      expect(openLoopSignals[0].evidence.length).toBeGreaterThan(0);
    });

    it("ignores fresh open loops (< 24h)", () => {
      const now = new Date("2026-04-11T12:00:00Z");
      const freshCheckpoint = makeCheckpoint({
        openLoops: ["In-progress task"],
        updatedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(), // 12h ago
      });

      const signals = collectSignals(emptyContext({
        checkpoints: [freshCheckpoint],
        now,
      }));

      expect(signals.filter(s => s.type === "stale_open_loop").length).toBe(0);
    });

    it("deduplicates same open loop across checkpoints", () => {
      const now = new Date("2026-04-11T12:00:00Z");
      const cp1 = makeCheckpoint({
        openLoops: ["Fix CI pipeline"],
        updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(),
      });
      const cp2 = makeCheckpoint({
        openLoops: ["fix ci pipeline"], // same but different case
        updatedAt: new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString(),
      });

      const signals = collectSignals(emptyContext({
        checkpoints: [cp1, cp2],
        now,
      }));

      expect(signals.filter(s => s.type === "stale_open_loop").length).toBe(1);
    });

    it("weights increase with staleness", () => {
      const now = new Date("2026-04-11T12:00:00Z");
      const cp24h = makeCheckpoint({
        openLoops: ["Task A"],
        updatedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
      });
      const cp72h = makeCheckpoint({
        openLoops: ["Task B"],
        updatedAt: new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString(),
      });

      const signals = collectSignals(emptyContext({
        checkpoints: [cp24h, cp72h],
        now,
      }));

      const signalA = signals.find(s => s.trigger === "Task A")!;
      const signalB = signals.find(s => s.trigger === "Task B")!;
      expect(signalB.weight).toBeGreaterThan(signalA.weight);
    });
  });

  describe("stale high-frequency memory signals", () => {
    it("detects memories accessed frequently but not recently", () => {
      const now = new Date("2026-04-11T12:00:00Z");
      const signals = collectSignals(emptyContext({
        frequentMemories: [{
          text: "Auth migration plan",
          topicTag: "auth",
          lastAccessedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
          accessCount: 5,
        }],
        now,
      }));

      const staleSignals = signals.filter(s => s.type === "stale_high_frequency");
      expect(staleSignals.length).toBe(1);
      expect(staleSignals[0].trigger).toBe("auth");
      expect(staleSignals[0].evidence).toContain("Accessed 5 times but not in 30 days");
    });

    it("ignores recently accessed memories", () => {
      const now = new Date("2026-04-11T12:00:00Z");
      const signals = collectSignals(emptyContext({
        frequentMemories: [{
          text: "Recent memory",
          lastAccessedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
          accessCount: 10,
        }],
        now,
      }));

      expect(signals.filter(s => s.type === "stale_high_frequency").length).toBe(0);
    });

    it("ignores infrequently accessed memories (< 3 accesses)", () => {
      const now = new Date("2026-04-11T12:00:00Z");
      const signals = collectSignals(emptyContext({
        frequentMemories: [{
          text: "Rarely accessed",
          lastAccessedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          accessCount: 2,
        }],
        now,
      }));

      expect(signals.filter(s => s.type === "stale_high_frequency").length).toBe(0);
    });
  });

  describe("workflow issue signals", () => {
    it("detects corrected/missed workflow observations", () => {
      const observations = [
        makeWorkflowObservation({ workflowId: "deploy", outcome: "corrected", summary: "Forgot to run tests" }),
        makeWorkflowObservation({ workflowId: "deploy", outcome: "missed", summary: "Missed the changelog update" }),
        makeWorkflowObservation({ workflowId: "deploy", outcome: "success", summary: "All good" }),
      ];

      const signals = collectSignals(emptyContext({ workflowObservations: observations }));
      const issueSignals = signals.filter(s => s.type === "workflow_issue");
      expect(issueSignals.length).toBe(1);
      expect(issueSignals[0].trigger).toBe("deploy");
      expect(issueSignals[0].evidence[0]).toContain("2 corrected/missed");
    });

    it("ignores workflows with only successes", () => {
      const observations = [
        makeWorkflowObservation({ workflowId: "deploy", outcome: "success" }),
      ];

      const signals = collectSignals(emptyContext({ workflowObservations: observations }));
      expect(signals.filter(s => s.type === "workflow_issue").length).toBe(0);
    });
  });

  describe("uncovered topic signals", () => {
    it("creates signals for uncovered topics", () => {
      const signals = collectSignals(emptyContext({
        uncoveredTopics: ["kubernetes", "migration"],
      }));

      const topicSignals = signals.filter(s => s.type === "uncovered_topic");
      expect(topicSignals.length).toBe(2);
      expect(topicSignals[0].trigger).toBe("kubernetes");
      expect(topicSignals[0].weight).toBe(0.65);
    });
  });

  describe("empty inputs", () => {
    it("returns empty array for empty context", () => {
      const signals = collectSignals(emptyContext());
      expect(signals).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// scorePredictions
// ---------------------------------------------------------------------------

describe("scorePredictions", () => {
  it("scores signals and filters by confidence threshold", () => {
    const signals: PredictionSignal[] = [
      {
        type: "stale_open_loop",
        trigger: "Fix CI",
        action: "Unresolved: Fix CI",
        weight: 0.9,
        evidence: ["48h old"],
      },
      {
        type: "uncovered_topic",
        trigger: "obscure",
        action: "No memories for obscure",
        weight: 0.5, // Below threshold after scoring
        evidence: ["No coverage"],
      },
    ];

    const predictions = scorePredictions(signals);

    // stale_open_loop: 0.9 * 0.9 = 0.81 (above 0.6)
    // uncovered_topic: 0.5 * 0.65 = 0.325 (below 0.6)
    expect(predictions.length).toBe(1);
    expect(predictions[0].trigger).toBe("Fix CI");
    expect(predictions[0].confidence).toBe(0.81);
  });

  it("sorts by confidence descending", () => {
    const signals: PredictionSignal[] = [
      { type: "uncovered_topic", trigger: "low", action: "low", weight: 1.0, evidence: [] },
      { type: "stale_open_loop", trigger: "high", action: "high", weight: 1.0, evidence: [] },
      { type: "workflow_issue", trigger: "mid", action: "mid", weight: 1.0, evidence: [] },
    ];

    const predictions = scorePredictions(signals);
    // stale_open_loop: 1.0 * 0.9 = 0.9
    // workflow_issue: 1.0 * 0.85 = 0.85
    // uncovered_topic: 1.0 * 0.65 = 0.65
    expect(predictions.length).toBe(3);
    expect(predictions[0].trigger).toBe("high");
    expect(predictions[1].trigger).toBe("mid");
    expect(predictions[2].trigger).toBe("low");
  });

  it("limits to MAX_PREDICTIONS", () => {
    const signals: PredictionSignal[] = Array.from({ length: 10 }, (_, i) => ({
      type: "stale_open_loop" as const,
      trigger: `task-${i}`,
      action: `action-${i}`,
      weight: 1.0,
      evidence: [],
    }));

    const predictions = scorePredictions(signals);
    expect(predictions.length).toBe(MAX_PREDICTIONS);
  });

  it("returns empty for all below threshold", () => {
    const signals: PredictionSignal[] = [
      { type: "uncovered_topic", trigger: "x", action: "x", weight: 0.3, evidence: [] },
    ];

    const predictions = scorePredictions(signals);
    expect(predictions.length).toBe(0);
  });

  it("returns empty for empty signals", () => {
    expect(scorePredictions([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

describe("prediction engine constants", () => {
  it("confidence threshold is 0.6", () => {
    expect(CONFIDENCE_THRESHOLD).toBe(0.6);
  });

  it("stale open loop hours is 24", () => {
    expect(STALE_OPEN_LOOP_HOURS).toBe(24);
  });

  it("stale memory days is 14", () => {
    expect(STALE_MEMORY_DAYS).toBe(14);
  });

  it("max predictions is 5", () => {
    expect(MAX_PREDICTIONS).toBe(5);
  });

  it("signal weights are all between 0 and 1", () => {
    for (const [, weight] of Object.entries(SIGNAL_WEIGHTS)) {
      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThanOrEqual(1);
    }
  });
});
