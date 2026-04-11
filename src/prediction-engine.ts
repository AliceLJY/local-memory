/**
 * Prediction Engine — HP-predictive (Phase 5)
 *
 * Pure heuristic prediction of prospective reminders.
 * Zero LLM cost — all signals are derived from existing data structures:
 * - Checkpoint openLoops (stale > 24h = high weight)
 * - High-frequency but stale memories (not accessed recently)
 * - Workflow observations with corrected/missed outcomes
 * - Query topic tags that lack recent memory coverage
 *
 * Gated by RECALLNEST_PREDICTIVE_MEMORY=true feature flag.
 */

import type { SessionCheckpointRecord } from "./session-schema.js";
import type { WorkflowObservationRecord } from "./workflow-observation-schema.js";

// ============================================================================
// Types
// ============================================================================

export interface PredictionSignal {
  type: "stale_open_loop" | "stale_high_frequency" | "workflow_issue" | "uncovered_topic";
  trigger: string;
  action: string;
  weight: number; // 0-1 raw signal strength
  evidence: string[];
}

export interface ScoredPrediction {
  trigger: string;
  action: string;
  confidence: number; // 0-1 final score
  evidence: string[];
}

export interface PredictionContext {
  /** Recent checkpoints (newest first) */
  checkpoints: SessionCheckpointRecord[];
  /** Recent workflow observations (newest first) */
  workflowObservations: WorkflowObservationRecord[];
  /** High-frequency memory texts + their last access timestamps */
  frequentMemories: Array<{ text: string; topicTag?: string; lastAccessedAt: string; accessCount: number }>;
  /** Topic tags from recent queries that had zero or few results */
  uncoveredTopics: string[];
  /** Current time for staleness calculation */
  now?: Date;
}

// ============================================================================
// Constants
// ============================================================================

const CONFIDENCE_THRESHOLD = 0.6;
const STALE_OPEN_LOOP_HOURS = 24;
const STALE_MEMORY_DAYS = 14;
const MAX_PREDICTIONS = 5;

// Signal type weights for final scoring
const SIGNAL_WEIGHTS: Record<PredictionSignal["type"], number> = {
  stale_open_loop: 0.9,
  workflow_issue: 0.85,
  stale_high_frequency: 0.7,
  uncovered_topic: 0.65,
};

// ============================================================================
// Signal Collection
// ============================================================================

/**
 * Collect raw prediction signals from available data sources.
 * Each signal represents a potential predicted reminder.
 */
export function collectSignals(context: PredictionContext): PredictionSignal[] {
  const now = context.now ?? new Date();
  const signals: PredictionSignal[] = [];

  // --- Signal 1: Stale open loops from checkpoints ---
  collectStaleOpenLoopSignals(context.checkpoints, now, signals);

  // --- Signal 2: High-frequency but stale memories ---
  collectStaleHighFrequencySignals(context.frequentMemories, now, signals);

  // --- Signal 3: Workflow observations with corrected/missed outcomes ---
  collectWorkflowIssueSignals(context.workflowObservations, signals);

  // --- Signal 4: Uncovered topic tags ---
  collectUncoveredTopicSignals(context.uncoveredTopics, signals);

  return signals;
}

function collectStaleOpenLoopSignals(
  checkpoints: SessionCheckpointRecord[],
  now: Date,
  signals: PredictionSignal[],
): void {
  const seenLoops = new Set<string>();

  for (const cp of checkpoints) {
    if (!cp.openLoops || cp.openLoops.length === 0) continue;

    const cpTime = new Date(cp.updatedAt);
    const hoursAgo = (now.getTime() - cpTime.getTime()) / (1000 * 60 * 60);

    for (const loop of cp.openLoops) {
      const normalized = loop.toLowerCase().trim();
      if (seenLoops.has(normalized)) continue;
      seenLoops.add(normalized);

      if (hoursAgo >= STALE_OPEN_LOOP_HOURS) {
        // Weight increases with staleness, capped at 1.0
        const stalenessBoost = Math.min(hoursAgo / (STALE_OPEN_LOOP_HOURS * 3), 1.0);
        signals.push({
          type: "stale_open_loop",
          trigger: loop,
          action: `Unresolved from ${Math.floor(hoursAgo)}h ago: "${loop}"`,
          weight: 0.6 + stalenessBoost * 0.4,
          evidence: [
            `Open loop from checkpoint ${cp.sessionId} (${Math.floor(hoursAgo)}h ago)`,
            `Scope: ${cp.resolvedScope ?? cp.scope ?? "unknown"}`,
          ],
        });
      }
    }
  }
}

function collectStaleHighFrequencySignals(
  memories: PredictionContext["frequentMemories"],
  now: Date,
  signals: PredictionSignal[],
): void {
  for (const mem of memories) {
    const lastAccess = new Date(mem.lastAccessedAt);
    const daysSinceAccess = (now.getTime() - lastAccess.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceAccess >= STALE_MEMORY_DAYS && mem.accessCount >= 3) {
      const stalenessRatio = Math.min(daysSinceAccess / (STALE_MEMORY_DAYS * 3), 1.0);
      const frequencyBoost = Math.min(mem.accessCount / 10, 1.0);
      const weight = 0.5 + (stalenessRatio * 0.3) + (frequencyBoost * 0.2);

      const topicLabel = mem.topicTag ? ` [${mem.topicTag}]` : "";
      const shortText = mem.text.length > 80 ? mem.text.slice(0, 77) + "..." : mem.text;

      signals.push({
        type: "stale_high_frequency",
        trigger: mem.topicTag ?? shortText,
        action: `Revisit frequently-used memory${topicLabel}: "${shortText}"`,
        weight: Math.min(weight, 1.0),
        evidence: [
          `Accessed ${mem.accessCount} times but not in ${Math.floor(daysSinceAccess)} days`,
          ...(mem.topicTag ? [`Topic: ${mem.topicTag}`] : []),
        ],
      });
    }
  }
}

function collectWorkflowIssueSignals(
  observations: WorkflowObservationRecord[],
  signals: PredictionSignal[],
): void {
  // Group by workflowId, count corrected/missed
  const issueMap = new Map<string, { count: number; summaries: string[]; latestAt: string }>();

  for (const obs of observations) {
    if (obs.outcome !== "corrected" && obs.outcome !== "missed") continue;

    const existing = issueMap.get(obs.workflowId);
    if (existing) {
      existing.count++;
      if (existing.summaries.length < 3) existing.summaries.push(obs.summary);
    } else {
      issueMap.set(obs.workflowId, {
        count: 1,
        summaries: [obs.summary],
        latestAt: obs.recordedAt,
      });
    }
  }

  for (const [workflowId, data] of issueMap) {
    if (data.count < 1) continue; // Even a single correction is worth noting

    const weight = Math.min(0.6 + data.count * 0.1, 1.0);
    signals.push({
      type: "workflow_issue",
      trigger: workflowId,
      action: `Workflow "${workflowId}" had ${data.count} issue(s): ${data.summaries[0]}`,
      weight,
      evidence: [
        `${data.count} corrected/missed observations for workflow "${workflowId}"`,
        `Latest: ${data.latestAt}`,
        ...data.summaries.slice(0, 2),
      ],
    });
  }
}

function collectUncoveredTopicSignals(
  uncoveredTopics: string[],
  signals: PredictionSignal[],
): void {
  for (const topic of uncoveredTopics) {
    signals.push({
      type: "uncovered_topic",
      trigger: topic,
      action: `No recent memories for queried topic "${topic}" — consider storing relevant context`,
      weight: 0.65,
      evidence: [`Topic "${topic}" appeared in queries but has no recent memory coverage`],
    });
  }
}

// ============================================================================
// Scoring
// ============================================================================

/**
 * Score and rank prediction signals.
 * Returns top predictions above the confidence threshold.
 */
export function scorePredictions(signals: PredictionSignal[]): ScoredPrediction[] {
  const scored: ScoredPrediction[] = signals.map(signal => {
    const typeWeight = SIGNAL_WEIGHTS[signal.type];
    const confidence = Math.round(signal.weight * typeWeight * 100) / 100;

    return {
      trigger: signal.trigger,
      action: signal.action,
      confidence,
      evidence: signal.evidence,
    };
  });

  return scored
    .filter(p => p.confidence >= CONFIDENCE_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_PREDICTIONS);
}

// ============================================================================
// Exports for testing
// ============================================================================

export const _testConstants = {
  CONFIDENCE_THRESHOLD,
  STALE_OPEN_LOOP_HOURS,
  STALE_MEMORY_DAYS,
  MAX_PREDICTIONS,
  SIGNAL_WEIGHTS,
} as const;
