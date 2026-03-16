import { randomUUID } from "node:crypto";

import { summarizeConflictAdvice } from "./conflict-advisor.js";
import type { Embedder } from "./embedder.js";
import {
  extractBoundaryMetadata,
  extractPromotedFrom,
  normalizeCanonicalKey,
  parseMetadataObject,
} from "./memory-boundaries.js";
import type { MemoryStore } from "./store.js";
import {
  type ConflictCandidateInput,
  ConflictCandidateInputSchema,
  type ConflictCandidateRecord,
  ConflictCandidateRecordSchema,
  type ConflictResolutionResult,
  ConflictResolutionResultSchema,
  type ResolveConflictInput,
  ResolveConflictInputSchema,
} from "./conflict-schema.js";
import type { ConflictCandidateStore } from "./conflict-store.js";

function normalizeFingerprintPart(value: string): string {
  return normalizeCanonicalKey(value) || "na";
}

export function buildConflictFingerprint(params: {
  canonicalKey: string;
  existingMemoryId: string;
  incomingText: string;
  sourceMemoryId?: string;
}): string {
  return [
    normalizeFingerprintPart(params.canonicalKey),
    normalizeFingerprintPart(params.existingMemoryId),
    normalizeFingerprintPart(params.sourceMemoryId || "no-source"),
    normalizeFingerprintPart(params.incomingText),
  ].join("--").slice(0, 240);
}

export function buildConflictCandidateRecord(rawInput: unknown): ConflictCandidateRecord {
  const input = ConflictCandidateInputSchema.parse(rawInput);
  return ConflictCandidateRecordSchema.parse({
    ...input,
    conflictId: randomUUID(),
    status: "open",
  });
}

export function reopenConflictCandidate(record: ConflictCandidateRecord): ConflictCandidateRecord {
  const now = new Date().toISOString();
  return ConflictCandidateRecordSchema.parse({
    ...record,
    status: "open",
    reopenCount: (record.reopenCount || 0) + 1,
    lastReopenedAt: now,
    updatedAt: now,
    resolvedAt: undefined,
    resolutionNotes: undefined,
  });
}

function buildMergedConflictMetadata(
  record: ConflictCandidateRecord,
  resolvedAt: string,
  mergedText: string,
): string {
  const existingMetadata = parseMetadataObject(record.existing.metadata) ?? {};
  const incomingMetadata = parseMetadataObject(record.incoming.metadata) ?? {};
  const boundary = extractBoundaryMetadata(record.existing.metadata)
    ?? extractBoundaryMetadata(record.incoming.metadata);
  const promotedFrom = extractPromotedFrom(record.incoming.metadata)
    ?? extractPromotedFrom(record.existing.metadata);
  const source = typeof existingMetadata.source === "string"
    ? existingMetadata.source
    : typeof incomingMetadata.source === "string"
      ? incomingMetadata.source
      : record.incoming.source;

  return JSON.stringify({
    ...existingMetadata,
    ...(source ? { source } : {}),
    canonicalKey: record.canonicalKey,
    ...(boundary ? { boundary } : {}),
    ...(promotedFrom ? { promotedFrom } : {}),
    mergedFrom: {
      conflictId: record.conflictId,
      resolvedAt,
      existingMemoryId: record.existing.memoryId,
      ...(record.incoming.sourceMemoryId ? { incomingSourceMemoryId: record.incoming.sourceMemoryId } : {}),
      mergedText,
    },
  });
}

export interface ResolveConflictDeps {
  store: Pick<MemoryStore, "getById" | "update">;
  embedder: Pick<Embedder, "embedPassage">;
  conflictStore: Pick<ConflictCandidateStore, "getById" | "replace">;
}

export async function resolveConflictCandidate(
  deps: ResolveConflictDeps,
  rawInput: unknown,
): Promise<ConflictResolutionResult> {
  const input = ResolveConflictInputSchema.parse(rawInput);
  const record = await deps.conflictStore.getById(input.conflictId);

  if (!record) {
    throw new Error(`Conflict ${input.conflictId} not found`);
  }
  if (record.status !== "open") {
    throw new Error(`Conflict ${input.conflictId} is already ${record.status}`);
  }

  const now = new Date().toISOString();
  let updatedMemoryId: string | undefined;

  if (input.resolution === "accept_incoming" || input.resolution === "merge") {
    const existing = await deps.store.getById(record.existing.memoryId);
    if (!existing) {
      throw new Error(`Existing memory ${record.existing.memoryId} not found`);
    }

    let nextText = record.incoming.text;
    let nextCategory = record.incoming.category;
    let nextImportance = record.incoming.importance;
    let nextMetadata = record.incoming.metadata;

    if (input.resolution === "merge") {
      if (record.existing.category !== record.incoming.category) {
        throw new Error("Merge resolution only supports same-category durable conflicts");
      }
      const mergeSuggestion = summarizeConflictAdvice(record).mergeSuggestion;
      const mergedText = input.mergedText || mergeSuggestion;
      if (!mergedText) {
        throw new Error("Merge resolution requires mergedText or an available merge suggestion");
      }
      nextText = mergedText;
      nextCategory = record.existing.category;
      nextImportance = Math.max(existing.importance, record.incoming.importance);
      nextMetadata = buildMergedConflictMetadata(record, now, mergedText);
    }

    const vector = await deps.embedder.embedPassage(nextText);
    const updated = await deps.store.update(existing.id, {
      text: nextText,
      vector,
      importance: nextImportance,
      category: nextCategory,
      metadata: nextMetadata,
      timestamp: Date.now(),
    });
    if (!updated) {
      throw new Error(`Failed to update durable memory ${existing.id}`);
    }
    updatedMemoryId = updated.id;
  }

  const resolved = ConflictCandidateRecordSchema.parse({
    ...record,
    status: input.resolution === "accept_incoming"
      ? "accepted-incoming"
      : input.resolution === "merge"
        ? "merged"
        : "kept-existing",
    updatedAt: now,
    resolvedAt: now,
    ...(input.notes ? { resolutionNotes: input.notes } : {}),
  });
  await deps.conflictStore.replace(resolved);

  return ConflictResolutionResultSchema.parse({
    conflictId: resolved.conflictId,
    status: resolved.status,
    updatedAt: resolved.updatedAt,
    resolvedAt: resolved.resolvedAt,
    ...(updatedMemoryId ? { updatedMemoryId } : {}),
  });
}
