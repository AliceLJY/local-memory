import type { ConflictCandidateRecord } from "./conflict-schema.js";

export const CONFLICT_ATTENTION_LEVELS = [
  "fresh",
  "aging",
  "stale",
  "escalated",
  "resolved",
] as const;

export type ConflictAttention = (typeof CONFLICT_ATTENTION_LEVELS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ConflictLifecycleSummary {
  attention: ConflictAttention;
  openAgeDays: number;
  reopenCount: number;
  isOpen: boolean;
  needsAttention: boolean;
}

export function parseConflictAttention(value?: string | null): ConflictAttention | undefined {
  if (!value) return undefined;
  return CONFLICT_ATTENTION_LEVELS.includes(value as ConflictAttention)
    ? value as ConflictAttention
    : undefined;
}

export function summarizeConflictLifecycle(
  record: ConflictCandidateRecord,
  now = new Date(),
): ConflictLifecycleSummary {
  const isOpen = record.status === "open";
  const reopenCount = Math.max(0, record.reopenCount || 0);
  if (!isOpen) {
    return {
      attention: "resolved",
      openAgeDays: 0,
      reopenCount,
      isOpen: false,
      needsAttention: false,
    };
  }

  const openedAtRaw = record.lastReopenedAt || record.createdAt;
  const openedAtMs = Date.parse(openedAtRaw);
  const ageMs = Number.isFinite(openedAtMs) ? Math.max(0, now.getTime() - openedAtMs) : 0;
  const openAgeDays = Math.floor(ageMs / DAY_MS);

  let attention: ConflictAttention = "fresh";
  if (openAgeDays >= 7 || reopenCount >= 3) {
    attention = "escalated";
  } else if (openAgeDays >= 3 || reopenCount >= 2) {
    attention = "stale";
  } else if (openAgeDays >= 1 || reopenCount >= 1) {
    attention = "aging";
  }

  return {
    attention,
    openAgeDays,
    reopenCount,
    isOpen: true,
    needsAttention: attention === "stale" || attention === "escalated",
  };
}
