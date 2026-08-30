/**
 * Pivot Apply — dedicated structured write channel for reviewed pivot candidates.
 *
 * Purpose: apply LLM-distilled pivot candidates (reportId-keyed, reviewed via
 * allowlist) into scope `memory:pivot` with deterministic dispositions.
 *
 * Why not the normal store_memory path (mutual-review P0, 2026-08-04):
 * - persistMemory routes preferences through matchPreference (LLM semantic
 *   merge) → polymorphic dispositions the apply ledger cannot predict;
 * - A-2 supersede detection calls the LLM per write (re-judging candidates is
 *   out of contract for apply);
 * - default source=manual mislabels distilled content as 0.9/direct confidence;
 * - kind/anchor/evidence/reportId/candidateHash/batchId are dropped;
 * - the implicit preference dual-write (LME-1) is fire-and-forget, so its id
 *   can never reach the ledger.
 *
 * This channel therefore:
 * - keeps: PII scan+redact (trust boundary), rule-based admission (minus rate
 *   limiting — bulk writes always trip it and it is not a quality signal),
 *   canonicalKey supersede semantics via writeDurableEntry, audit logging,
 *   synchronous post-write verification;
 * - drops: every LLM call, F2 interference marking (must not silently mutate
 *   existing memories), async KG extraction, and the implicit preference
 *   dual-write (apply's contract is to write exactly the allowlisted entries
 *   and nothing else — a derived preference is not on the allowlist).
 */

import { z } from "zod";

import { checkAdmission } from "./admission-control.js";
import {
  buildStructuredMetadata,
  writeDurableEntry,
  type PersistMemoryDeps,
} from "./capture-engine.js";
import { assignDefaultConfidence } from "./confidence-tracker.js";
import { detectLang, tokenizeFts } from "./language-hook.js";
import { scanForPII, redactSecrets } from "./pii-detector.js";
import {
  EvidenceCoordinateSchema,
  EvidenceWindowSchema,
  PIVOT_EVIDENCE_CONTRACT_VERSION,
  PivotEvidenceProvenanceSchema,
  evidenceWindowIssues,
} from "./pivot-evidence.js";

export const PIVOT_APPLY_SOURCE = "session_distill";
export const PIVOT_APPLY_CAPTURE = "pivot_apply_v1";
export const PIVOT_APPLY_EVIDENCE_CAPTURE = "pivot_apply_v2";
export const PIVOT_SCOPE = "memory:pivot";

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const PivotKindSchema = z.enum([
  "judgment_shift",
  "decision",
  "preference_rule",
  "case",
]);
export type PivotKind = z.infer<typeof PivotKindSchema>;

/** The only kind→category pairs that exist in the corpus (verified over all 8,971 candidates). */
const KIND_CATEGORY: Record<PivotKind, "cases" | "events" | "preferences"> = {
  case: "cases",
  decision: "events",
  judgment_shift: "events",
  preference_rule: "preferences",
};

export const PivotCandidateInputSchema = z
  .object({
    kind: PivotKindSchema,
    text: z.string().min(10).max(4000),
    anchor: z.string().min(1).max(2000),
    canonicalKey: z.string().min(1).max(120),
    evidence: z.array(z.string().min(1).max(4000)).max(16),
    proposedScope: z.literal(PIVOT_SCOPE),
    proposedCategory: z.enum(["cases", "events", "preferences"]),
    // candidate tags max out at 4 in the corpus; the channel appends 2 more and
    // buildStructuredMetadata stores tags verbatim, so cap input at 6 to stay
    // within the schema-wide 8-tag budget.
    tags: z.array(z.string().min(1).max(40)).min(1).max(6),
    sessionId: z.string().min(8).max(200),
    reportId: z.string().regex(SHA256_HEX, "reportId must be 64-char sha256 hex"),
    candidateHash: z.string().regex(SHA256_HEX, "candidateHash must be 64-char sha256 hex"),
    batchId: z.string().min(1).max(64),
    importance: z.number().min(0).max(1),
    evidenceContractVersion: z.literal(PIVOT_EVIDENCE_CONTRACT_VERSION).optional(),
    sourceFingerprint: z.string().regex(SHA256_HEX).optional(),
    anchorCoordinate: EvidenceCoordinateSchema.optional(),
    evidenceWindows: z.array(EvidenceWindowSchema).max(16).optional(),
  })
  .refine((c) => KIND_CATEGORY[c.kind] === c.proposedCategory, {
    message: "proposedCategory does not match kind (corpus-verified mapping violated)",
  })
  .superRefine((candidate, context) => {
    const fields = [
      candidate.evidenceContractVersion,
      candidate.sourceFingerprint,
      candidate.anchorCoordinate,
      candidate.evidenceWindows,
    ];
    if (fields.every((field) => field === undefined)) return;
    const provenance = PivotEvidenceProvenanceSchema.safeParse({
      evidenceContractVersion: candidate.evidenceContractVersion,
      sourceFingerprint: candidate.sourceFingerprint,
      anchorCoordinate: candidate.anchorCoordinate,
      evidenceWindows: candidate.evidenceWindows,
    });
    if (!provenance.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "evidence provenance must be complete and match contract version 1",
      });
      return;
    }
    for (const issue of evidenceWindowIssues(provenance.data, candidate.evidence.length, candidate.sessionId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: issue });
    }
  });
export type PivotCandidateInput = z.infer<typeof PivotCandidateInputSchema>;

export const PivotEvidenceCandidateInputSchema = PivotCandidateInputSchema.refine(
  (candidate) => candidate.evidenceContractVersion === PIVOT_EVIDENCE_CONTRACT_VERSION,
  { message: "evidence-coordinate apply requires contract version 1 provenance" },
);

export type PivotApplyDisposition =
  | "stored"
  | "updated"
  | "deduped"
  | "promoted"
  | "conflict"
  | "rejected";

/**
 * The stock embedder only retries connection-class errors; HTTP 429/5xx throw
 * straight through (embedder.ts isTransientEmbeddingError). A bulk apply makes
 * thousands of calls, so rate-limit blips must not void a whole batch — retry
 * with backoff here, and only here (single-write callers keep stock behavior).
 */
async function embedWithRetry(
  embedder: PersistMemoryDeps["embedder"],
  text: string,
  delaysMs: readonly number[] = [1000, 5000, 15000],
): Promise<number[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await embedder.embedPassage(text);
    } catch (err) {
      lastErr = err;
      const msg = String((err as Error)?.message ?? err);
      const retriable = /\b(429|500|502|503|504)\b|rate.?limit|overloaded/i.test(msg);
      if (!retriable || attempt === delaysMs.length) throw err;
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
  throw lastErr;
}

export interface PivotApplyOutcome {
  candidateHash: string;
  batchId: string;
  /** null when the write never reached the store (admission rejection). */
  memoryId: string | null;
  disposition: PivotApplyDisposition;
  conflictId?: string;
  rejectionReason?: string;
  supersededOldId?: string;
  piiRedactedCount: number;
  canonicalKey: string;
  category: "cases" | "events" | "preferences";
  verified: boolean;
  verifyIssues: string[];
}

export interface PivotBatchReport {
  batchId: string;
  total: number;
  written: number;
  halted: boolean;
  haltReason?: string;
  outcomes: PivotApplyOutcome[];
}

/**
 * Persist one reviewed pivot candidate. Deterministic: no LLM calls, no writes
 * outside the candidate itself (plus the audit log line).
 */
export async function persistPivotCandidate(
  deps: PersistMemoryDeps,
  rawInput: unknown,
): Promise<PivotApplyOutcome> {
  const input = PivotCandidateInputSchema.parse(rawInput);

  // F-3b ordering (same as persistMemory): scan first so piiWarning reflects
  // the raw text, then redact before the text reaches embedding/storage.
  const piiScan = scanForPII(input.text);
  const redaction = redactSecrets(input.text);
  const text = redaction.redacted > 0 ? redaction.text : input.text;

  // Rule-based admission only. No rateLimiter on purpose: a bulk apply always
  // exceeds per-scope write rates, which says nothing about entry quality.
  const admission = checkAdmission(text, input.importance, PIVOT_SCOPE, undefined, deps.admissionConfig);
  if (admission.verdict === "rejected") {
    try {
      deps.auditLogger?.log({
        operation: "reject",
        scope: PIVOT_SCOPE,
        actor: PIVOT_APPLY_SOURCE,
        details: `pivot-apply ${input.kind} ${input.candidateHash.slice(0, 12)}: ${admission.reason ?? "unknown"}`,
      });
    } catch {
      // Audit must never block the outcome report.
    }
    return {
      candidateHash: input.candidateHash,
      batchId: input.batchId,
      memoryId: null,
      disposition: "rejected",
      rejectionReason: admission.reason,
      piiRedactedCount: redaction.redacted,
      canonicalKey: input.canonicalKey,
      category: input.proposedCategory,
      verified: false,
      verifyIssues: [],
    };
  }

  const vector = await embedWithRetry(deps.embedder, text);
  // The store layer never validates vector shape (only importEntry does), so an
  // empty/short vector would land silently and poison retrieval — assert here.
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`embedding returned an empty vector for candidate ${input.candidateHash.slice(0, 12)}`);
  }
  const language = detectLang(text);
  const fts_text = tokenizeFts(text, language);

  const evidenceProvenance = input.evidenceContractVersion === PIVOT_EVIDENCE_CONTRACT_VERSION
    ? PivotEvidenceProvenanceSchema.parse({
      evidenceContractVersion: input.evidenceContractVersion,
      sourceFingerprint: input.sourceFingerprint,
      anchorCoordinate: input.anchorCoordinate,
      evidenceWindows: input.evidenceWindows,
    })
    : null;
  let metadata = buildStructuredMetadata({
    source: PIVOT_APPLY_SOURCE,
    tags: [...input.tags, "pivot-apply", `batch:${input.batchId}`],
    capture: evidenceProvenance ? PIVOT_APPLY_EVIDENCE_CAPTURE : PIVOT_APPLY_CAPTURE,
    category: input.proposedCategory,
    canonicalKey: input.canonicalKey,
    extra: {
      anchor: input.anchor,
      pivotApply: {
        kind: input.kind,
        evidence: input.evidence,
        sessionId: input.sessionId,
        reportId: input.reportId,
        candidateHash: input.candidateHash,
        batchId: input.batchId,
        ...(evidenceProvenance ?? {}),
      },
    },
  });
  {
    // Same post-build patch pattern persistMemory uses for confidence/PII.
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    parsed.confidence = assignDefaultConfidence(PIVOT_APPLY_SOURCE);
    if (piiScan.hasPII) {
      parsed.piiWarning = {
        summary: piiScan.summary,
        detections: piiScan.detections.length,
        severity: piiScan.detections.some((d) => d.severity === "high") ? "high" : "medium",
        ...(redaction.redacted > 0 ? { redacted: redaction.redacted } : {}),
      };
    }
    metadata = JSON.stringify(parsed);
  }

  const { entry, disposition, conflictId } = await writeDurableEntry(deps, {
    text,
    vector,
    category: input.proposedCategory,
    scope: PIVOT_SCOPE,
    importance: input.importance,
    metadata,
    canonicalKey: input.canonicalKey,
    source: PIVOT_APPLY_SOURCE,
    language,
    fts_text,
  });

  try {
    deps.auditLogger?.log({
      operation: "store",
      scope: PIVOT_SCOPE,
      memoryId: entry.id,
      actor: PIVOT_APPLY_SOURCE,
      details: `pivot-apply ${input.kind} ${input.candidateHash.slice(0, 12)} → ${disposition}`,
    });
  } catch {
    // Audit must never block the outcome report.
  }

  // Post-write verification, synchronous on purpose: a bulk apply needs the
  // verdict inside the ledger row, not on a console later. Deliberately NOT
  // verifyWrite(): its checkEntry expects scope/importance inside metadata,
  // which buildStructuredMetadata-shaped rows never carry (a pre-existing
  // mismatch its async caller silently swallows). This check asserts the claim
  // that matters instead: the row at entry.id holds THIS candidate's content.
  let verified = true;
  let verifyIssues: string[] = [];
  if ((disposition === "stored" || disposition === "updated") && deps.store.get) {
    verifyIssues = await verifyPivotRow(deps.store.get.bind(deps.store), entry.id, {
      candidateHash: input.candidateHash,
      text,
    });
    verified = verifyIssues.length === 0;
  }

  return {
    candidateHash: input.candidateHash,
    batchId: input.batchId,
    memoryId: entry.id,
    disposition,
    ...(conflictId ? { conflictId } : {}),
    piiRedactedCount: redaction.redacted,
    canonicalKey: input.canonicalKey,
    category: input.proposedCategory,
    verified,
    verifyIssues,
  };
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Read the row back and assert it is this candidate's write, not merely a well-formed row. */
async function verifyPivotRow(
  get: (id: string) => Promise<{ text: string; scope: string; metadata: string } | null>,
  id: string,
  expected: { candidateHash: string; text: string },
): Promise<string[]> {
  const issues: string[] = [];
  let row: { text: string; scope: string; metadata: string } | null = null;
  try {
    row = await get(id);
  } catch (err) {
    return [`readback threw: ${(err as Error).message}`];
  }
  if (!row) return ["row missing on readback"];
  if (row.scope !== PIVOT_SCOPE) issues.push(`scope is "${row.scope}", expected "${PIVOT_SCOPE}"`);
  if (normalizeForCompare(row.text) !== normalizeForCompare(expected.text)) {
    issues.push("text on readback differs from written text");
  }
  try {
    const meta = JSON.parse(row.metadata || "{}") as Record<string, unknown>;
    const pivotApply = meta.pivotApply as Record<string, unknown> | undefined;
    if (pivotApply?.candidateHash !== expected.candidateHash) {
      issues.push("pivotApply.candidateHash on readback does not match this candidate");
    }
  } catch {
    issues.push("metadata unparseable on readback");
  }
  return issues;
}

export interface PivotBatchOptions {
  /** Dispositions that do NOT halt the batch. Default: only "stored". */
  expectedDispositions?: readonly PivotApplyDisposition[];
}

/**
 * Persist a physical batch sequentially, fail-closed.
 *
 * Pre-screening guarantees the incoming batch has no key collisions with the
 * live pool (R5) and no identical-text duplicates (R3 folding), so every
 * disposition other than "stored" is unexpected by default and halts the batch
 * immediately. Rows already written before the halt stay in the store — the
 * caller reconciles via the returned outcomes (ledger) and the table snapshot
 * taken before the batch.
 */
export async function persistPivotBatch(
  deps: PersistMemoryDeps,
  batchId: string,
  rawInputs: readonly unknown[],
  options?: PivotBatchOptions,
): Promise<PivotBatchReport> {
  const expected = new Set<PivotApplyDisposition>(options?.expectedDispositions ?? ["stored"]);
  const outcomes: PivotApplyOutcome[] = [];
  let written = 0;

  for (const raw of rawInputs) {
    // Halt before the write when the row belongs to a different batch: the
    // ledger keys every side effect by batchId, so a mixed batch would corrupt
    // snapshot/rollback bookkeeping.
    const claimed =
      typeof raw === "object" && raw !== null && "batchId" in raw
        ? String((raw as Record<string, unknown>).batchId)
        : "(missing)";
    if (claimed !== batchId) {
      return {
        batchId,
        total: rawInputs.length,
        written,
        halted: true,
        haltReason: `candidate claims batchId "${claimed}" but batch is "${batchId}"`,
        outcomes,
      };
    }

    const outcome = await persistPivotCandidate(deps, raw);
    outcomes.push(outcome);
    if (outcome.memoryId !== null && (outcome.disposition === "stored" || outcome.disposition === "updated")) {
      written += 1;
    }

    if (!expected.has(outcome.disposition)) {
      return {
        batchId,
        total: rawInputs.length,
        written,
        halted: true,
        haltReason: `unexpected disposition "${outcome.disposition}" for candidate ${outcome.candidateHash.slice(0, 12)}`,
        outcomes,
      };
    }
    if (!outcome.verified && (outcome.disposition === "stored" || outcome.disposition === "updated")) {
      return {
        batchId,
        total: rawInputs.length,
        written,
        halted: true,
        haltReason: `post-write verification failed for ${outcome.candidateHash.slice(0, 12)}: ${outcome.verifyIssues.join("; ")}`,
        outcomes,
      };
    }
  }

  return {
    batchId,
    total: rawInputs.length,
    written,
    halted: false,
    outcomes,
  };
}
