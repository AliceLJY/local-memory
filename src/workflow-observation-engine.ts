import { randomUUID } from "node:crypto";

import type {
  WorkflowEvidencePack,
  WorkflowHealthDashboardItem,
  WorkflowHealthReport,
  WorkflowHealthWindow,
  WorkflowObservationInput,
  WorkflowObservationOutcome,
  WorkflowObservationRecord,
} from "./workflow-observation-schema.js";
import { WorkflowObservationInputSchema, WorkflowObservationRecordSchema } from "./workflow-observation-schema.js";
import type { WorkflowObservationStore } from "./workflow-observation-store.js";
import { buildIdempotentRecordId } from "./idempotency.js";

const DEFAULT_WINDOWS = [7, 30] as const;
const MAX_OBSERVATIONS_FOR_ANALYSIS = 1000;
const ISSUE_OUTCOMES: WorkflowObservationOutcome[] = ["failure", "corrected", "missed"];

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function countBySignal(records: WorkflowObservationRecord[]): Array<{ signal: string; count: number }> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = record.signal?.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([signal, count]) => ({ signal, count }))
    .sort((a, b) => b.count - a.count || a.signal.localeCompare(b.signal))
    .slice(0, 3);
}

function summarizeWindow(days: number, records: WorkflowObservationRecord[], nowMs: number): WorkflowHealthWindow {
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const scoped = records.filter((record) => Date.parse(record.recordedAt) >= cutoff);
  const total = scoped.length;
  const successes = scoped.filter((record) => record.outcome === "success").length;
  const failures = scoped.filter((record) => record.outcome === "failure").length;
  const corrected = scoped.filter((record) => record.outcome === "corrected").length;
  const missed = scoped.filter((record) => record.outcome === "missed").length;
  const issueCount = failures + corrected + missed;
  const latestAt = scoped[0]?.recordedAt;

  return {
    days,
    total,
    successes,
    failures,
    corrected,
    missed,
    issueCount,
    successRate: total > 0 ? successes / total : 0,
    issueRate: total > 0 ? issueCount / total : 0,
    latestAt,
    topSignals: countBySignal(scoped.filter((record) => ISSUE_OUTCOMES.includes(record.outcome))),
  };
}

function deriveStatus(window30: WorkflowHealthWindow): WorkflowHealthReport["status"] {
  if (window30.total === 0) return "no-data";
  if (
    window30.failures >= 1 ||
    window30.missed >= 2 ||
    window30.issueCount >= 3 ||
    (window30.total >= 4 && window30.successRate < 0.5)
  ) {
    return "critical";
  }
  if (
    window30.issueCount >= 1 ||
    window30.successRate < 0.75
  ) {
    return "watch";
  }
  return "healthy";
}

function buildHealthSummary(workflowId: string, status: WorkflowHealthReport["status"], window30: WorkflowHealthWindow): string {
  if (status === "no-data") {
    return `No workflow observations recorded yet for ${workflowId}.`;
  }
  const signalText = window30.topSignals.length > 0
    ? ` Top issues: ${window30.topSignals.map((item) => `${item.signal} (${item.count})`).join(", ")}.`
    : "";
  return `${workflowId} is ${status} over 30d: ${window30.total} observations, ${pct(window30.successRate)} success, ${window30.issueCount} issues.${signalText}`;
}

function uniqueStrings(values: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
}

function buildEvidenceSuggestions(
  workflowId: string,
  records: WorkflowObservationRecord[],
  health: WorkflowHealthReport,
): string[] {
  const window30 = health.windows.find((window) => window.days === 30) || health.windows[health.windows.length - 1];
  if (!window30 || window30.total === 0) {
    return [
      `Start recording ${workflowId} outcomes in real tasks before automating proactive alerts.`,
    ];
  }

  const suggestions: string[] = [];
  if (window30.missed > 0) {
    suggestions.push("Tighten trigger coverage so this workflow fires before repo exploration or user correction.");
  }
  if (window30.corrected > 0) {
    suggestions.push("Review recurring user corrections and turn them into explicit guardrails or narrower response rules.");
  }
  if (window30.failures > 0) {
    suggestions.push("Add a regression test or smoke case that reproduces the failing path.");
  }
  if (window30.topSignals.some((item) => /repo-state|git status|checkpoint/i.test(item.signal))) {
    suggestions.push("Keep volatile repo-state text out of saved checkpoints and handoff summaries unless this window verified it.");
  }
  if (workflowId === "resume_context" && window30.issueCount > 0) {
    suggestions.push("Strengthen fresh-window continuity triggers and acceptance smoke for startup recovery.");
  }
  if (workflowId === "checkpoint_session" && window30.issueCount > 0) {
    suggestions.push("Add end-of-window guards so checkpoint content is sanitized before it becomes the next handoff.");
  }
  if (window30.total < 4) {
    suggestions.push("Collect a few more observations before changing thresholds or automating proactive advice.");
  }

  return uniqueStrings(suggestions).slice(0, 4);
}

export function resolveWorkflowObservationScope(input: Pick<WorkflowObservationInput, "scope">): string {
  return input.scope || "global";
}

export function buildWorkflowObservationRecord(rawInput: unknown): WorkflowObservationRecord {
  const input = WorkflowObservationInputSchema.parse(rawInput);
  return WorkflowObservationRecordSchema.parse({
    ...input,
    observationId: buildIdempotentRecordId("wfo", input.idempotencyKey) ?? randomUUID(),
    resolvedScope: resolveWorkflowObservationScope(input),
  });
}

export function summarizeWorkflowHealthRecords(
  workflowId: string,
  records: WorkflowObservationRecord[],
  options: { scope?: string; now?: Date | number; windows?: number[] } = {},
): WorkflowHealthReport {
  const nowMs = options.now instanceof Date
    ? options.now.getTime()
    : typeof options.now === "number"
      ? options.now
      : Date.now();
  const windows = (options.windows && options.windows.length > 0 ? options.windows : [...DEFAULT_WINDOWS])
    .map((value) => Math.max(1, Math.trunc(value)));
  const filtered = records
    .filter((record) => record.workflowId === workflowId)
    .filter((record) => !options.scope || record.resolvedScope === options.scope)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));

  const summarized = windows.map((days) => summarizeWindow(days, filtered, nowMs));
  const primary = summarized.find((window) => window.days === 30) || summarized[summarized.length - 1];
  const status = deriveStatus(primary);

  return {
    workflowId,
    scope: options.scope,
    status,
    summary: buildHealthSummary(workflowId, status, primary),
    latestObservationAt: filtered[0]?.recordedAt,
    windows: summarized,
  };
}

export function buildWorkflowHealthDashboard(
  records: WorkflowObservationRecord[],
  options: { scope?: string; limit?: number; now?: Date | number } = {},
): WorkflowHealthDashboardItem[] {
  const grouped = new Map<string, WorkflowObservationRecord[]>();
  for (const record of records) {
    if (options.scope && record.resolvedScope !== options.scope) continue;
    const key = options.scope ? record.workflowId : `${record.resolvedScope}::${record.workflowId}`;
    const bucket = grouped.get(key) || [];
    bucket.push(record);
    grouped.set(key, bucket);
  }

  const items = [...grouped.values()].map((bucket) => {
    const workflowId = bucket[0].workflowId;
    const scope = options.scope || bucket[0].resolvedScope;
    const report = summarizeWorkflowHealthRecords(workflowId, bucket, {
      scope,
      now: options.now,
    });
    const primary = report.windows.find((window) => window.days === 30) || report.windows[report.windows.length - 1];
    return {
      workflowId,
      scope,
      status: report.status,
      total: primary.total,
      issueCount: primary.issueCount,
      successRate: primary.successRate,
      latestObservationAt: report.latestObservationAt,
      summary: report.summary,
    } satisfies WorkflowHealthDashboardItem;
  });

  const priority = { critical: 0, watch: 1, healthy: 2, "no-data": 3 } as const;
  const limit = options.limit || 10;
  return items
    .sort((a, b) => {
      const byStatus = priority[a.status] - priority[b.status];
      if (byStatus !== 0) return byStatus;
      const byIssues = b.issueCount - a.issueCount;
      if (byIssues !== 0) return byIssues;
      return (Date.parse(b.latestObservationAt || "1970-01-01T00:00:00.000Z") -
        Date.parse(a.latestObservationAt || "1970-01-01T00:00:00.000Z"));
    })
    .slice(0, limit);
}

export function generateWorkflowEvidencePack(
  workflowId: string,
  records: WorkflowObservationRecord[],
  options: { scope?: string; now?: Date | number; limit?: number } = {},
): WorkflowEvidencePack {
  const filtered = records
    .filter((record) => record.workflowId === workflowId)
    .filter((record) => !options.scope || record.resolvedScope === options.scope)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
  const health = summarizeWorkflowHealthRecords(workflowId, filtered, {
    scope: options.scope,
    now: options.now,
  });
  const issues = filtered
    .filter((record) => ISSUE_OUTCOMES.includes(record.outcome))
    .slice(0, options.limit || 5)
    .map((record) => ({
      observationId: record.observationId,
      outcome: record.outcome,
      summary: record.summary,
      signal: record.signal,
      recordedAt: record.recordedAt,
      task: record.task,
    }));
  const issueRecords = filtered.filter((record) => ISSUE_OUTCOMES.includes(record.outcome));
  const suggestions = buildEvidenceSuggestions(workflowId, issueRecords, health);
  const topSignals = countBySignal(issueRecords);
  const summary = issues.length === 0
    ? `No issue observations recorded yet for ${workflowId}.`
    : `${workflowId} has ${issues.length} recent issue observation(s) ready for review.`;

  return {
    workflowId,
    scope: options.scope,
    generatedAt: new Date(
      options.now instanceof Date
        ? options.now.getTime()
        : typeof options.now === "number"
          ? options.now
          : Date.now(),
    ).toISOString(),
    summary,
    health,
    topSignals,
    recentIssues: issues,
    suggestions,
  };
}

export async function inspectWorkflowHealth(
  store: WorkflowObservationStore,
  params: { workflowId: string; scope?: string; now?: Date | number },
): Promise<WorkflowHealthReport> {
  const records = await store.listRecent({
    workflowId: params.workflowId,
    scope: params.scope,
    limit: MAX_OBSERVATIONS_FOR_ANALYSIS,
  });
  return summarizeWorkflowHealthRecords(params.workflowId, records, params);
}

export async function inspectWorkflowDashboard(
  store: WorkflowObservationStore,
  params: { scope?: string; limit?: number; now?: Date | number } = {},
): Promise<WorkflowHealthDashboardItem[]> {
  const records = await store.listRecent({
    scope: params.scope,
    limit: MAX_OBSERVATIONS_FOR_ANALYSIS,
  });
  return buildWorkflowHealthDashboard(records, params);
}

export async function buildWorkflowEvidence(
  store: WorkflowObservationStore,
  params: { workflowId: string; scope?: string; limit?: number; now?: Date | number },
): Promise<WorkflowEvidencePack> {
  const records = await store.listRecent({
    workflowId: params.workflowId,
    scope: params.scope,
    limit: MAX_OBSERVATIONS_FOR_ANALYSIS,
  });
  return generateWorkflowEvidencePack(params.workflowId, records, params);
}
