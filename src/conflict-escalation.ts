import type { ConflictSuggestedResolution, ConflictAdviceConfidence } from "./conflict-advisor.js";
import { summarizeConflictAdvice } from "./conflict-advisor.js";
import { type ConflictAttention, summarizeConflictLifecycle } from "./conflict-lifecycle.js";
import {
  type ConflictCandidateRecord,
  ConflictCandidateRecordSchema,
  type ConflictEscalationResultItem,
  ConflictEscalationResultItemSchema,
  type EscalateConflictsInput,
  EscalateConflictsInputSchema,
  type EscalateConflictsResult,
  EscalateConflictsResultSchema,
} from "./conflict-schema.js";
import type { ConflictCandidateStore } from "./conflict-store.js";

export type EscalationAttention = Extract<ConflictAttention, "stale" | "escalated">;

export interface EscalateConflictsDeps {
  conflictStore: Pick<ConflictCandidateStore, "listRecent" | "replace">;
}

function toEscalationAttention(attention: ConflictAttention): EscalationAttention | null {
  return attention === "stale" || attention === "escalated" ? attention : null;
}

export function buildConflictEscalationItem(
  record: ConflictCandidateRecord,
  now = new Date(),
): ConflictEscalationResultItem | null {
  const lifecycle = summarizeConflictLifecycle(record, now);
  const attention = toEscalationAttention(lifecycle.attention);
  if (!attention) return null;

  const advice = summarizeConflictAdvice(record);
  const alreadyEscalated = record.lastEscalationAttention === attention;
  return ConflictEscalationResultItemSchema.parse({
    conflictId: record.conflictId,
    canonicalKey: record.canonicalKey,
    attention,
    openAgeDays: lifecycle.openAgeDays,
    reopenCount: lifecycle.reopenCount,
    escalationCount: Math.max(0, record.escalationCount || 0),
    suggestedResolution: advice.suggestedResolution,
    confidence: advice.confidence,
    action: alreadyEscalated ? "already-escalated" : "pending",
    clusterKey: advice.clusterKey,
  });
}

export function markConflictEscalated(
  record: ConflictCandidateRecord,
  params: {
    attention: EscalationAttention;
    notes?: string;
    now?: Date;
  },
): ConflictCandidateRecord {
  const nowIso = (params.now || new Date()).toISOString();
  const note = params.notes?.trim();

  return ConflictCandidateRecordSchema.parse({
    ...record,
    escalationCount: Math.max(0, record.escalationCount || 0) + 1,
    lastEscalatedAt: nowIso,
    lastEscalationAttention: params.attention,
    updatedAt: nowIso,
    ...(note ? { resolutionNotes: note } : {}),
  });
}

function sortEscalationItems(items: ConflictEscalationResultItem[]): ConflictEscalationResultItem[] {
  return [...items].sort((a, b) => {
    const attentionRankA = a.attention === "escalated" ? 2 : 1;
    const attentionRankB = b.attention === "escalated" ? 2 : 1;
    if (attentionRankB !== attentionRankA) return attentionRankB - attentionRankA;
    if (b.openAgeDays !== a.openAgeDays) return b.openAgeDays - a.openAgeDays;
    if (b.reopenCount !== a.reopenCount) return b.reopenCount - a.reopenCount;
    return a.conflictId.localeCompare(b.conflictId);
  });
}

export async function escalateConflicts(
  deps: EscalateConflictsDeps,
  rawInput: unknown,
  { now: nowOverride }: { now?: Date } = {},
): Promise<EscalateConflictsResult> {
  const input = EscalateConflictsInputSchema.parse(rawInput);
  const now = nowOverride ?? new Date();
  const records = await deps.conflictStore.listRecent({
    status: "open",
    canonicalKey: input.canonicalKey,
    limit: input.limit,
  });

  const eligibleItems = sortEscalationItems(
    records
      .map((record) => buildConflictEscalationItem(record, now))
      .filter((item): item is ConflictEscalationResultItem => Boolean(item))
      .filter((item) => !input.attention || item.attention === input.attention)
      .slice(0, input.top),
  );

  const items: ConflictEscalationResultItem[] = [];
  let escalated = 0;

  for (const item of eligibleItems) {
    const record = records.find((candidate) => candidate.conflictId === item.conflictId);
    if (!record) continue;

    if (!input.apply || item.action === "already-escalated") {
      items.push(item);
      continue;
    }

    const updated = markConflictEscalated(record, {
      attention: item.attention,
      notes: input.notes,
      now,
    });
    await deps.conflictStore.replace(updated);
    escalated += 1;
    items.push(ConflictEscalationResultItemSchema.parse({
      ...item,
      escalationCount: updated.escalationCount,
      action: "escalated",
    }));
  }

  return EscalateConflictsResultSchema.parse({
    apply: input.apply,
    scanned: records.length,
    eligible: eligibleItems.length,
    escalated,
    skipped: eligibleItems.filter((item) => item.action === "already-escalated").length,
    items,
  });
}

