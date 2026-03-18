import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { buildLegacyScopeKeepReview, suppressesLegacyScopeIssue } from "./legacy-scope-review.js";
import { classifyLegacyScope } from "./store.js";

export interface WorkflowObservationScopeCue {
  needle: string;
  scope: string;
}

export interface WorkflowObservationScopeReviewEntry {
  observationId: string;
  workflowId: string;
  source?: string;
  currentScope: string;
  suggestedScope?: string;
  reason: string;
  task?: string;
  summary: string;
  recordedAt?: string;
  path: string;
}

export interface WorkflowObservationScopeReview {
  generatedAt: string;
  currentScope: string;
  totalCount: number;
  suggestedCount: number;
  manualReviewCount: number;
  invalidCount: number;
  cues: WorkflowObservationScopeCue[];
  entries: WorkflowObservationScopeReviewEntry[];
}

export interface WorkflowObservationScopeRewriteResult {
  updatedCount: number;
  skippedCount: number;
  updated: Array<{
    observationId: string;
    fromScope: string;
    toScope: string;
    path: string;
  }>;
}

export interface WorkflowObservationScopeKeepResult {
  reviewedCount: number;
  skippedCount: number;
  reviewed: Array<{
    observationId: string;
    path: string;
    reason: string;
  }>;
  unmatchedIds: string[];
  ambiguousIds: string[];
}

export interface WorkflowObservationScopeReviewOptions {
  dir?: string;
  currentScope?: string;
  source?: string;
  workflowId?: string;
  cues?: WorkflowObservationScopeCue[];
  neighborWindowSeconds?: number;
}

function defaultDir(): string {
  return resolve(import.meta.dir, "../data/workflow-observations");
}

function clip(text: string, maxLen = 72): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "-";
  return compact.length <= maxLen ? compact : `${compact.slice(0, maxLen - 3)}...`;
}

function normalizedHaystack(record: Record<string, unknown>): string {
  return `${typeof record.task === "string" ? record.task : ""}\n${typeof record.summary === "string" ? record.summary : ""}`
    .toLowerCase();
}

function normalizeRecordedAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

interface ParsedObservationRecord {
  observationId: string;
  workflowId?: string;
  source?: string;
  resolvedScope?: string;
  task?: string;
  summary?: string;
  recordedAt?: string;
  path: string;
  raw: Record<string, unknown>;
}

function parseObservationRecord(path: string, raw: Record<string, unknown>): ParsedObservationRecord {
  return {
    observationId: typeof raw.observationId === "string" ? raw.observationId : basename(path, ".json"),
    workflowId: typeof raw.workflowId === "string" ? raw.workflowId : undefined,
    source: typeof raw.source === "string" ? raw.source : undefined,
    resolvedScope: typeof raw.resolvedScope === "string" ? raw.resolvedScope : undefined,
    task: typeof raw.task === "string" ? raw.task : undefined,
    summary: typeof raw.summary === "string" ? raw.summary : undefined,
    recordedAt: normalizeRecordedAt(raw.recordedAt),
    path,
    raw,
  };
}

function inferNeighborScope(
  entry: ParsedObservationRecord,
  records: ParsedObservationRecord[],
  currentScope: string,
  windowSeconds: number,
): { scope?: string; reason?: string } {
  const entryMs = Date.parse(entry.recordedAt || "");
  if (!Number.isFinite(entryMs) || windowSeconds <= 0) return {};

  const windowMs = windowSeconds * 1000;
  const neighbors = records
    .filter((record) => record.observationId !== entry.observationId)
    .filter((record) => record.resolvedScope && record.resolvedScope !== currentScope)
    .filter((record) => record.source === entry.source)
    .filter((record) => {
      const recordMs = Date.parse(record.recordedAt || "");
      return Number.isFinite(recordMs) && Math.abs(recordMs - entryMs) <= windowMs;
    });

  const scopes = [...new Set(neighbors.map((record) => record.resolvedScope!).filter(Boolean))];
  if (scopes.length !== 1) return {};

  const nearest = [...neighbors]
    .sort((a, b) => {
      const aDiff = Math.abs(Date.parse(a.recordedAt || "") - entryMs);
      const bDiff = Math.abs(Date.parse(b.recordedAt || "") - entryMs);
      return aDiff - bDiff;
    })[0];
  if (!nearest) return {};

  return {
    scope: scopes[0],
    reason: `matched nearby ${nearest.workflowId || "workflow"} ${nearest.observationId.slice(0, 8)} within ${windowSeconds}s`,
  };
}

export function parseWorkflowObservationScopeCue(raw: string): WorkflowObservationScopeCue {
  const separator = raw.indexOf("=");
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error(`Invalid cue "${raw}". Use needle=scope, for example recallnest=project:recallnest.`);
  }
  const needle = raw.slice(0, separator).trim().toLowerCase();
  const scope = raw.slice(separator + 1).trim();
  if (!needle || !scope) {
    throw new Error(`Invalid cue "${raw}". Use needle=scope, for example recallnest=project:recallnest.`);
  }
  return { needle, scope };
}

function reviewEntry(
  entry: ParsedObservationRecord,
  currentScope: string,
  cues: WorkflowObservationScopeCue[],
  allRecords: ParsedObservationRecord[],
  neighborWindowSeconds: number,
): WorkflowObservationScopeReviewEntry {
  const haystack = normalizedHaystack(entry.raw);
  const matches = cues.filter((cue) => haystack.includes(cue.needle));
  const matchedScopes = [...new Set(matches.map((cue) => cue.scope))];

  let suggestedScope: string | undefined;
  let reason = "no cue match";
  if (matchedScopes.length === 1) {
    suggestedScope = matchedScopes[0];
    const cue = matches.find((item) => item.scope === suggestedScope)?.needle || suggestedScope;
    reason = `matched cue "${cue}"`;
  } else if (matchedScopes.length > 1) {
    reason = `conflicting cues: ${matchedScopes.join(", ")}`;
  } else if (cues.length === 0) {
    reason = "no cues configured";
  }

  if (!suggestedScope) {
    const neighbor = inferNeighborScope(entry, allRecords, currentScope, neighborWindowSeconds);
    if (neighbor.scope) {
      suggestedScope = neighbor.scope;
      reason = neighbor.reason || "matched nearby observation";
    }
  }

  return {
    observationId: entry.observationId,
    workflowId: entry.workflowId || "workflow",
    source: entry.source,
    currentScope,
    suggestedScope,
    reason,
    task: entry.task,
    summary: entry.summary || "",
    recordedAt: entry.recordedAt,
    path: entry.path,
  };
}

export function reviewWorkflowObservationScopes(
  options: WorkflowObservationScopeReviewOptions = {},
): WorkflowObservationScopeReview {
  const dir = options.dir || defaultDir();
  const currentScope = options.currentScope || "global";
  const cues = options.cues || [];

  if (!existsSync(dir)) {
    return {
      generatedAt: new Date().toISOString(),
      currentScope,
      totalCount: 0,
      suggestedCount: 0,
      manualReviewCount: 0,
      invalidCount: 0,
      cues,
      entries: [],
    };
  }

  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name));

  const parsedRecords: ParsedObservationRecord[] = [];
  const entries: WorkflowObservationScopeReviewEntry[] = [];
  let invalidCount = 0;

  for (const path of files) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      invalidCount += 1;
      continue;
    }
    parsedRecords.push(parseObservationRecord(path, raw));
  }

  const neighborWindowSeconds = Math.max(0, Math.trunc(options.neighborWindowSeconds ?? 90));
  for (const record of parsedRecords) {
    if (record.resolvedScope !== currentScope) continue;
    if (options.source && record.source !== options.source) continue;
    if (options.workflowId && record.workflowId !== options.workflowId) continue;
    const kind = classifyLegacyScope(record.resolvedScope);
    if (kind && suppressesLegacyScopeIssue(record.raw.legacyScopeReview, kind)) continue;
    entries.push(reviewEntry(record, currentScope, cues, parsedRecords, neighborWindowSeconds));
  }

  entries.sort((a, b) => {
    const timeDiff = Date.parse(b.recordedAt || "") - Date.parse(a.recordedAt || "");
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
    return a.observationId.localeCompare(b.observationId);
  });

  const suggestedCount = entries.filter((entry) => entry.suggestedScope).length;
  return {
    generatedAt: new Date().toISOString(),
    currentScope,
    totalCount: entries.length,
    suggestedCount,
    manualReviewCount: entries.length - suggestedCount,
    invalidCount,
    cues,
    entries,
  };
}

export function applyWorkflowObservationScopeSuggestions(
  review: WorkflowObservationScopeReview,
): WorkflowObservationScopeRewriteResult {
  const updated: WorkflowObservationScopeRewriteResult["updated"] = [];
  let skippedCount = 0;

  for (const entry of review.entries) {
    if (!entry.suggestedScope) {
      skippedCount += 1;
      continue;
    }

    const parsed = JSON.parse(readFileSync(entry.path, "utf-8")) as Record<string, unknown>;
    parsed.scope = entry.suggestedScope;
    parsed.resolvedScope = entry.suggestedScope;
    writeFileSync(entry.path, JSON.stringify(parsed, null, 2) + "\n");
    updated.push({
      observationId: entry.observationId,
      fromScope: entry.currentScope,
      toScope: entry.suggestedScope,
      path: entry.path,
    });
  }

  return {
    updatedCount: updated.length,
    skippedCount,
    updated,
  };
}

function matchesObservationSelector(observationId: string, selector: string): boolean {
  const normalizedId = observationId.trim().toLowerCase();
  const normalizedSelector = selector.trim().toLowerCase();
  return normalizedSelector.length > 0
    && (normalizedId === normalizedSelector || normalizedId.startsWith(normalizedSelector));
}

export function keepWorkflowObservationScopesGlobal(
  review: WorkflowObservationScopeReview,
  options: {
    ids: string[];
    reason: string;
    reviewedAt?: string;
  },
): WorkflowObservationScopeKeepResult {
  const reviewed: WorkflowObservationScopeKeepResult["reviewed"] = [];
  const unmatchedIds: string[] = [];
  const ambiguousIds: string[] = [];
  let skippedCount = 0;

  const reason = options.reason.trim();
  if (!reason) {
    throw new Error("keepWorkflowObservationScopesGlobal requires a non-empty reason.");
  }

  const kind = classifyLegacyScope(review.currentScope);
  if (!kind) {
    throw new Error(`Current scope "${review.currentScope}" is not a legacy scope kind that can be kept.`);
  }

  const uniqueSelectors = [...new Set(options.ids.map((value) => value.trim()).filter(Boolean))];
  for (const selector of uniqueSelectors) {
    const matches = review.entries.filter((entry) => matchesObservationSelector(entry.observationId, selector));
    if (matches.length === 0) {
      unmatchedIds.push(selector);
      continue;
    }
    if (matches.length > 1) {
      ambiguousIds.push(selector);
      continue;
    }

    const entry = matches[0]!;
    if (entry.suggestedScope) {
      skippedCount += 1;
      continue;
    }

    const parsed = JSON.parse(readFileSync(entry.path, "utf-8")) as Record<string, unknown>;
    parsed.legacyScopeReview = buildLegacyScopeKeepReview(kind, reason, options.reviewedAt);
    writeFileSync(entry.path, JSON.stringify(parsed, null, 2) + "\n");
    reviewed.push({
      observationId: entry.observationId,
      path: entry.path,
      reason,
    });
  }

  return {
    reviewedCount: reviewed.length,
    skippedCount,
    reviewed,
    unmatchedIds,
    ambiguousIds,
  };
}

export function formatWorkflowObservationScopeReview(review: WorkflowObservationScopeReview): string {
  const lines = [
    "Workflow observation scope review",
    "",
    `  Generated at : ${review.generatedAt}`,
    `  Current scope: ${review.currentScope}`,
    `  Records      : ${review.totalCount}`,
    `  Suggested    : ${review.suggestedCount}`,
    `  Manual review: ${review.manualReviewCount}`,
    `  Invalid files: ${review.invalidCount}`,
  ];

  if (review.cues.length > 0) {
    lines.push(`  Cues         : ${review.cues.map((cue) => `${cue.needle}=${cue.scope}`).join(", ")}`);
  }

  if (review.entries.length === 0) {
    lines.push("", "No matching workflow observations found.");
    return lines.join("\n");
  }

  lines.push("", "  Review rows:");
  lines.push("    ID        Workflow            Source     Suggestion            Date        Task / Summary");
  lines.push("    --------  ------------------  ---------  --------------------  ----------  --------------");
  for (const entry of review.entries) {
    const taskOrSummary = entry.task || entry.summary;
    const suggestion = entry.suggestedScope
      ? `${entry.suggestedScope} (${entry.reason})`
      : `manual (${entry.reason})`;
    lines.push(
      `    ${entry.observationId.slice(0, 8)}  ${clip(entry.workflowId, 18).padEnd(18)}  ${clip(entry.source || "-", 9).padEnd(9)}  ${clip(suggestion, 20).padEnd(20)}  ${(entry.recordedAt || "-").slice(0, 10).padEnd(10)}  ${clip(taskOrSummary, 56)}`
    );
  }

  return lines.join("\n");
}
