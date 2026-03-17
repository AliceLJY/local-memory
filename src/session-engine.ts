import { randomUUID } from "node:crypto";

import {
  type SessionCheckpointInput,
  SessionCheckpointInputSchema,
  type SessionCheckpointRecord,
  SessionCheckpointRecordSchema,
} from "./session-schema.js";

const REPO_STATE_PATTERN = /\bgit status\b|未提交|staged|uncommitted|已修改文件|modified files?|untracked|新增文件|dirty repo|dirty worktree/iu;
const SENTENCE_SPLIT_PATTERN = /(?:\r?\n)+|(?<=[。！？!?;；])\s+/u;
const CHECKPOINT_SANITIZABLE_FIELDS = ["summary", "task", "decisions", "openLoops", "nextActions"] as const;

type CheckpointSanitizableField = typeof CHECKPOINT_SANITIZABLE_FIELDS[number];

interface SanitizedStringResult {
  value: string;
  changed: boolean;
}

interface SanitizedListResult {
  value: string[];
  changed: boolean;
}

export interface SessionCheckpointSanitizationReport {
  changed: boolean;
  changedFields: CheckpointSanitizableField[];
}

export interface SessionCheckpointBuildResult {
  record: SessionCheckpointRecord;
  sanitization: SessionCheckpointSanitizationReport;
}

function hasRepoStateText(text: string): boolean {
  return REPO_STATE_PATTERN.test(text);
}

function normalizeCheckpointText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sanitizeCheckpointSummary(summary: string): SanitizedStringResult {
  const parts = summary
    .split(SENTENCE_SPLIT_PATTERN)
    .map(normalizeCheckpointText)
    .filter(Boolean);
  const kept = parts.filter((part) => !hasRepoStateText(part));
  const value = kept[0] ? kept.join(" ") : "Checkpoint captured current task state without repo-state details.";
  return {
    value,
    changed: kept.length !== parts.length,
  };
}

function sanitizeCheckpointList(items: string[], fallbackWhenRemoved?: string): SanitizedListResult {
  const kept = items
    .map(normalizeCheckpointText)
    .filter(Boolean)
    .filter((item) => !hasRepoStateText(item));

  if (kept.length > 0) {
    return {
      value: kept,
      changed: kept.length !== items.length,
    };
  }
  if (fallbackWhenRemoved && items.some((item) => hasRepoStateText(String(item)))) {
    return {
      value: [fallbackWhenRemoved],
      changed: true,
    };
  }
  return {
    value: kept,
    changed: kept.length !== items.length,
  };
}

export function resolveCheckpointScope(input: Pick<SessionCheckpointInput, "sessionId" | "scope">): string {
  return input.scope || `session:${input.sessionId}`;
}

export function buildSessionCheckpointResult(rawInput: unknown): SessionCheckpointBuildResult {
  const input = SessionCheckpointInputSchema.parse(rawInput);
  const summary = sanitizeCheckpointSummary(input.summary);
  const taskChanged = Boolean(input.task && hasRepoStateText(input.task));
  const decisions = sanitizeCheckpointList(input.decisions);
  const openLoops = sanitizeCheckpointList(
    input.openLoops,
    "Current repo state still needs local verification if it matters for the next task.",
  );
  const nextActions = sanitizeCheckpointList(
    input.nextActions,
    "Verify current repo state locally if it matters for the next task.",
  );
  const sanitizedInput: SessionCheckpointInput = {
    ...input,
    summary: summary.value,
    task: taskChanged ? undefined : input.task,
    decisions: decisions.value,
    openLoops: openLoops.value,
    nextActions: nextActions.value,
  };
  const changedFields = CHECKPOINT_SANITIZABLE_FIELDS.filter((field) => {
    switch (field) {
      case "summary":
        return summary.changed;
      case "task":
        return taskChanged;
      case "decisions":
        return decisions.changed;
      case "openLoops":
        return openLoops.changed;
      case "nextActions":
        return nextActions.changed;
      default:
        return false;
    }
  });

  return {
    record: SessionCheckpointRecordSchema.parse({
      ...sanitizedInput,
      checkpointId: randomUUID(),
      resolvedScope: resolveCheckpointScope(sanitizedInput),
    }),
    sanitization: {
      changed: changedFields.length > 0,
      changedFields,
    },
  };
}

export function buildSessionCheckpointRecord(rawInput: unknown): SessionCheckpointRecord {
  return buildSessionCheckpointResult(rawInput).record;
}
