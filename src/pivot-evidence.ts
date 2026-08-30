import { createHash } from "node:crypto";

import { z } from "zod";

export const PIVOT_EVIDENCE_CONTRACT_VERSION = 1 as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const EvidenceCoordinateSchema = z.object({
  sessionId: z.string().min(1).max(200),
  ordinal: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant"]),
  contentDigest: z.string().regex(SHA256_HEX),
}).strict();
export type EvidenceCoordinate = z.infer<typeof EvidenceCoordinateSchema>;

export const EvidenceWindowTurnSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant"]),
  contentDigest: z.string().regex(SHA256_HEX),
  evidenceIndexes: z.array(z.number().int().nonnegative()).min(1).max(16),
}).strict();
export type EvidenceWindowTurn = z.infer<typeof EvidenceWindowTurnSchema>;

export const EvidenceWindowSchema = z.object({
  sessionId: z.string().min(1).max(200),
  startOrdinal: z.number().int().nonnegative(),
  endOrdinal: z.number().int().nonnegative(),
  turns: z.array(EvidenceWindowTurnSchema).min(1).max(16),
}).strict();
export type EvidenceWindow = z.infer<typeof EvidenceWindowSchema>;

export const PivotEvidenceProvenanceSchema = z.object({
  evidenceContractVersion: z.literal(PIVOT_EVIDENCE_CONTRACT_VERSION),
  sourceFingerprint: z.string().regex(SHA256_HEX),
  anchorCoordinate: EvidenceCoordinateSchema,
  evidenceWindows: z.array(EvidenceWindowSchema).max(16),
}).strict();
export type PivotEvidenceProvenance = z.infer<typeof PivotEvidenceProvenanceSchema>;

export function turnContentDigest(input: {
  sessionId: string;
  ordinal: number;
  role: "user" | "assistant";
  text: string;
}): string {
  const canonical = JSON.stringify({
    schemaVersion: PIVOT_EVIDENCE_CONTRACT_VERSION,
    sessionId: input.sessionId,
    ordinal: input.ordinal,
    role: input.role,
    text: input.text.replace(/\u0000/g, "").trim(),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function evidenceWindowIssues(
  provenance: PivotEvidenceProvenance,
  evidenceCount: number,
  expectedSessionId: string,
): string[] {
  const issues: string[] = [];
  if (provenance.anchorCoordinate.sessionId !== expectedSessionId) {
    issues.push("anchor coordinate sessionId does not match candidate sessionId");
  }
  if (provenance.anchorCoordinate.role !== "user") {
    issues.push("anchor coordinate must point to a user turn");
  }

  const seenEvidence = new Set<number>();
  let previousEnd = -2;
  for (const [windowIndex, window] of provenance.evidenceWindows.entries()) {
    if (window.sessionId !== expectedSessionId) {
      issues.push(`evidence window ${windowIndex} sessionId does not match candidate sessionId`);
    }
    const first = window.turns[0];
    const last = window.turns[window.turns.length - 1];
    if (window.startOrdinal !== first.ordinal || window.endOrdinal !== last.ordinal) {
      issues.push(`evidence window ${windowIndex} bounds do not match its turns`);
    }
    if (window.startOrdinal <= previousEnd + 1) {
      issues.push(`evidence window ${windowIndex} overlaps or should be merged with the previous window`);
    }
    previousEnd = window.endOrdinal;

    for (let turnIndex = 0; turnIndex < window.turns.length; turnIndex++) {
      const turn = window.turns[turnIndex];
      if (turn.ordinal !== window.startOrdinal + turnIndex) {
        issues.push(`evidence window ${windowIndex} contains a non-contiguous ordinal range`);
      }
      const localIndexes = new Set<number>();
      for (const evidenceIndex of turn.evidenceIndexes) {
        if (localIndexes.has(evidenceIndex)) {
          issues.push(`evidence index ${evidenceIndex} is repeated inside one turn`);
        }
        localIndexes.add(evidenceIndex);
        if (evidenceIndex < 0 || evidenceIndex >= evidenceCount) {
          issues.push(`evidence index ${evidenceIndex} is outside the candidate evidence array`);
        } else if (seenEvidence.has(evidenceIndex)) {
          issues.push(`evidence index ${evidenceIndex} is mapped more than once`);
        } else {
          seenEvidence.add(evidenceIndex);
        }
      }
    }
  }
  for (let index = 0; index < evidenceCount; index++) {
    if (!seenEvidence.has(index)) issues.push(`evidence index ${index} has no source coordinate`);
  }
  return issues;
}

/**
 * Add provenance to content-addressed payloads only when the v1 evidence
 * contract is present. Historical 2026-08-03 candidates remain byte-for-byte
 * compatible; a partial or malformed new contract fails closed.
 */
export function evidenceIdentityPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  if (record.evidenceContractVersion === undefined) return {};
  return PivotEvidenceProvenanceSchema.parse({
    evidenceContractVersion: record.evidenceContractVersion,
    sourceFingerprint: record.sourceFingerprint,
    anchorCoordinate: record.anchorCoordinate,
    evidenceWindows: record.evidenceWindows,
  });
}
