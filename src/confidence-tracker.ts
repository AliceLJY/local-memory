/**
 * Confidence Tracker — Viewpoint confidence scoring.
 *
 * Agent-First reasoning: users correct AI all the time ("not Python,
 * TypeScript"). The original wrong memory and the correction both exist
 * in the store. Without confidence tracking, both compete equally in
 * retrieval. Confidence scoring ensures corrections outrank originals,
 * and confirmed facts outrank unverified ones.
 *
 * Brain-science label: "Hindsight bias" — later information reshapes
 * how earlier memories are weighted. We keep the name for branding;
 * the real mechanism is a float field + simple update rules.
 *
 * Confidence semantics:
 * - 1.0 = explicitly confirmed by user
 * - 0.7 = default (unverified)
 * - 0.3 = superseded/corrected
 * - 0.0 = explicitly contradicted
 *
 * Retrieval integration: confidence multiplies into the score pipeline
 * as `score *= (0.5 + 0.5 * confidence)` — same pattern as importance.
 *
 * Design: returns metadata patches instead of directly mutating the store.
 * Callers apply patches via their own store.update() / patchMetadata().
 * This keeps the module store-agnostic and easier to test.
 */

import type { MemoryEntry } from "./store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONFIDENCE_DEFAULT = 0.7;
export const CONFIDENCE_CONFIRMED = 1.0;
export const CONFIDENCE_CORRECTED = 0.3;
export const CONFIDENCE_CONTRADICTED = 0.0;

/** Max history entries to keep per memory (prevents unbounded growth). */
const MAX_CONFIDENCE_HISTORY = 20;

// ---------------------------------------------------------------------------
// F1: Structured Confidence Metadata
// ---------------------------------------------------------------------------

export type ConfidenceReliability = "direct" | "inferred" | "hearsay";

export interface ConfidenceMetadata {
  /** 0–1 composite confidence score. */
  score: number;
  /** Source reliability tier. */
  reliability: ConfidenceReliability;
  /** Last verification timestamp (ms). */
  verifiedAt?: number;
  /** Who verified: user / system / llm. */
  verifiedBy?: string;
}

/**
 * F1: Assign default confidence based on memory source.
 * Returns a ConfidenceMetadata object to embed in metadata JSON.
 */
export function assignDefaultConfidence(
  source: string,
  explicitConfidence?: Partial<ConfidenceMetadata>,
): ConfidenceMetadata {
  // If caller provided explicit values, use them (fill in defaults for missing fields)
  if (explicitConfidence?.score != null) {
    return {
      score: explicitConfidence.score,
      reliability: explicitConfidence.reliability ?? "inferred",
      verifiedAt: explicitConfidence.verifiedAt,
      verifiedBy: explicitConfidence.verifiedBy,
    };
  }
  switch (source) {
    case "manual":
      return { score: 0.9, reliability: "direct" };
    case "agent":
    case "api":
      return { score: 0.7, reliability: "inferred" };
    case "session_distill":
      return { score: 0.6, reliability: "inferred" };
    case "conversation_import":
      return { score: 0.5, reliability: "hearsay" };
    default:
      return { score: CONFIDENCE_DEFAULT, reliability: "inferred" };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfidenceUpdate {
  entryId: string;
  oldConfidence: number;
  newConfidence: number;
}

export interface ConfidencePatch {
  /** The metadata object to merge/write back. */
  metadata: Record<string, unknown>;
  /** Summary of what changed. */
  update: ConfidenceUpdate;
}

interface ConfidenceHistoryEntry {
  action: "confirmed" | "corrected" | "contradicted";
  from: number;
  to: number;
  date: string;
  correctedBy?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMeta(entry: MemoryEntry): Record<string, unknown> {
  try { return JSON.parse(entry.metadata || "{}"); } catch { return {}; }
}

/**
 * Read confidence score from metadata. Handles both flat number (legacy)
 * and structured ConfidenceMetadata object (F1).
 * Returns default (0.7) if not set.
 */
export function getConfidence(entry: MemoryEntry): number {
  const meta = parseMeta(entry);
  if (typeof meta.confidence === "number") return meta.confidence;
  if (meta.confidence && typeof meta.confidence === "object") {
    const obj = meta.confidence as Record<string, unknown>;
    if (typeof obj.score === "number") return obj.score;
  }
  return CONFIDENCE_DEFAULT;
}

/**
 * F1: Read full ConfidenceMetadata from entry. Returns null if not set.
 */
export function getConfidenceMetadata(entry: MemoryEntry): ConfidenceMetadata | null {
  const meta = parseMeta(entry);
  if (meta.confidence && typeof meta.confidence === "object") {
    const obj = meta.confidence as Record<string, unknown>;
    if (typeof obj.score === "number") {
      return {
        score: obj.score,
        reliability: (obj.reliability as ConfidenceReliability) ?? "inferred",
        verifiedAt: typeof obj.verifiedAt === "number" ? obj.verifiedAt : undefined,
        verifiedBy: typeof obj.verifiedBy === "string" ? obj.verifiedBy : undefined,
      };
    }
  }
  // Legacy flat number → wrap
  if (typeof meta.confidence === "number") {
    return { score: meta.confidence, reliability: "inferred" };
  }
  return null;
}

function appendHistory(
  meta: Record<string, unknown>,
  entry: ConfidenceHistoryEntry,
): void {
  if (!Array.isArray(meta.confidence_history)) meta.confidence_history = [];
  const history = meta.confidence_history as ConfidenceHistoryEntry[];
  history.push(entry);
  // Cap history length
  if (history.length > MAX_CONFIDENCE_HISTORY) {
    meta.confidence_history = history.slice(-MAX_CONFIDENCE_HISTORY);
  }
}

// ---------------------------------------------------------------------------
// Patch builders (store-agnostic — return patches, don't write)
// ---------------------------------------------------------------------------

/**
 * Build a patch to mark a memory as confirmed (user validated it).
 * Returns null if entry is null (not found).
 */
export function buildConfirmPatch(
  entry: MemoryEntry | null,
): ConfidencePatch | null {
  if (!entry) return null;

  const meta = parseMeta(entry);
  const oldConfidence = typeof meta.confidence === "number" ? meta.confidence : CONFIDENCE_DEFAULT;

  meta.confidence = CONFIDENCE_CONFIRMED;
  appendHistory(meta, {
    action: "confirmed",
    from: oldConfidence,
    to: CONFIDENCE_CONFIRMED,
    date: new Date().toISOString().slice(0, 10),
  });

  return {
    metadata: meta,
    update: { entryId: entry.id, oldConfidence, newConfidence: CONFIDENCE_CONFIRMED },
  };
}

/**
 * Build a patch to mark a memory as corrected (user provided updated info).
 * Returns null if entry is null (not found).
 */
export function buildCorrectPatch(
  entry: MemoryEntry | null,
  correctedById?: string,
): ConfidencePatch | null {
  if (!entry) return null;

  const meta = parseMeta(entry);
  const oldConfidence = typeof meta.confidence === "number" ? meta.confidence : CONFIDENCE_DEFAULT;

  meta.confidence = CONFIDENCE_CORRECTED;
  if (correctedById) meta.corrected_by = correctedById;
  appendHistory(meta, {
    action: "corrected",
    from: oldConfidence,
    to: CONFIDENCE_CORRECTED,
    ...(correctedById ? { correctedBy: correctedById.slice(0, 8) } : {}),
    date: new Date().toISOString().slice(0, 10),
  });

  return {
    metadata: meta,
    update: { entryId: entry.id, oldConfidence, newConfidence: CONFIDENCE_CORRECTED },
  };
}

/**
 * Build a patch to mark a memory as contradicted (explicitly wrong).
 * Returns null if entry is null (not found).
 */
export function buildContradictPatch(
  entry: MemoryEntry | null,
): ConfidencePatch | null {
  if (!entry) return null;

  const meta = parseMeta(entry);
  const oldConfidence = typeof meta.confidence === "number" ? meta.confidence : CONFIDENCE_DEFAULT;

  meta.confidence = CONFIDENCE_CONTRADICTED;
  appendHistory(meta, {
    action: "contradicted",
    from: oldConfidence,
    to: CONFIDENCE_CONTRADICTED,
    date: new Date().toISOString().slice(0, 10),
  });

  return {
    metadata: meta,
    update: { entryId: entry.id, oldConfidence, newConfidence: CONFIDENCE_CONTRADICTED },
  };
}

// ---------------------------------------------------------------------------
// Convenience wrappers (for callers who DO have a store)
// ---------------------------------------------------------------------------

/** 单写通道端口：读改写经 store.patchMetadata per-id 队列，防并发覆盖。 */
type ConfidenceStorePort = {
  patchMetadata(
    id: string,
    patchFn: (meta: Record<string, unknown>, entry: MemoryEntry) => Record<string, unknown>,
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null>;
};

function applyConfidencePatch(
  store: ConfidenceStorePort,
  entryId: string,
  scope: string,
  build: (entry: MemoryEntry) => ConfidencePatch | null,
): Promise<ConfidenceUpdate | null> {
  let update: ConfidenceUpdate | null = null;
  return store
    .patchMetadata(
      entryId,
      (meta, entry) => {
        const patch = build(entry);
        if (!patch) return meta;
        update = patch.update;
        return patch.metadata;
      },
      [scope],
    )
    .then(result => (result === null ? null : update));
}

/**
 * Confirm a memory and write back to store. Convenience wrapper.
 */
export async function confirmMemory(
  store: ConfidenceStorePort,
  entryId: string,
  scope: string,
): Promise<ConfidenceUpdate | null> {
  return applyConfidencePatch(store, entryId, scope, entry => buildConfirmPatch(entry));
}

/**
 * Correct a memory and write back to store. Convenience wrapper.
 */
export async function correctMemory(
  store: ConfidenceStorePort,
  entryId: string,
  scope: string,
  correctedById?: string,
): Promise<ConfidenceUpdate | null> {
  return applyConfidencePatch(store, entryId, scope, entry => buildCorrectPatch(entry, correctedById));
}

/**
 * Contradict a memory and write back to store. Convenience wrapper.
 */
export async function contradictMemory(
  store: ConfidenceStorePort,
  entryId: string,
  scope: string,
): Promise<ConfidenceUpdate | null> {
  return applyConfidencePatch(store, entryId, scope, entry => buildContradictPatch(entry));
}

// ---------------------------------------------------------------------------
// Retrieval integration (unchanged — already store-agnostic)
// ---------------------------------------------------------------------------

/**
 * Apply confidence weighting to retrieval scores.
 * Formula: score *= (0.5 + 0.5 * confidence)
 *
 * At confidence=1.0 → ×1.0 (no penalty)
 * At confidence=0.7 → ×0.85 (slight penalty)
 * At confidence=0.3 → ×0.65 (significant penalty)
 * At confidence=0.0 → ×0.50 (heavy penalty)
 */
export function applyConfidenceWeight(
  score: number,
  entry: MemoryEntry,
): number {
  const confidence = getConfidence(entry);
  return score * (0.5 + 0.5 * confidence);
}
