import type { LegacyScopeIssueKind } from "./store.js";

export interface LegacyScopeReviewRecord {
  decision: "keep";
  kind: LegacyScopeIssueKind;
  reason: string;
  reviewedAt: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function parseLegacyScopeReview(raw: unknown): LegacyScopeReviewRecord | undefined {
  const record = asObject(raw);
  if (!record) return undefined;
  if (record.decision !== "keep") return undefined;
  if (record.kind !== "missing" && record.kind !== "empty" && record.kind !== "global") return undefined;
  if (typeof record.reason !== "string" || !record.reason.trim()) return undefined;
  if (typeof record.reviewedAt !== "string" || !Number.isFinite(Date.parse(record.reviewedAt))) return undefined;
  return {
    decision: "keep",
    kind: record.kind,
    reason: record.reason.trim(),
    reviewedAt: record.reviewedAt,
  };
}

export function buildLegacyScopeKeepReview(
  kind: LegacyScopeIssueKind,
  reason: string,
  reviewedAt = new Date().toISOString(),
): LegacyScopeReviewRecord {
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    throw new Error("legacy scope keep review reason must not be empty.");
  }
  return {
    decision: "keep",
    kind,
    reason: normalizedReason,
    reviewedAt,
  };
}

export function suppressesLegacyScopeIssue(
  raw: unknown,
  kind: LegacyScopeIssueKind,
): boolean {
  const review = parseLegacyScopeReview(raw);
  return review?.decision === "keep" && review.kind === kind;
}
