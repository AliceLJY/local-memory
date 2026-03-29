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
 */

import type { MemoryStore, MemoryEntry } from "./store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONFIDENCE_DEFAULT = 0.7;
export const CONFIDENCE_CONFIRMED = 1.0;
export const CONFIDENCE_CORRECTED = 0.3;
export const CONFIDENCE_CONTRADICTED = 0.0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMeta(entry: MemoryEntry): Record<string, any> {
  try { return JSON.parse(entry.metadata || "{}"); } catch { return {}; }
}

/**
 * Read confidence from metadata. Returns default (0.7) if not set.
 */
export function getConfidence(entry: MemoryEntry): number {
  const meta = parseMeta(entry);
  return typeof meta.confidence === "number" ? meta.confidence : CONFIDENCE_DEFAULT;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

export interface ConfidenceUpdate {
  entryId: string;
  oldConfidence: number;
  newConfidence: number;
}

/**
 * Mark a memory as confirmed (user validated it).
 * Bumps confidence to CONFIRMED (1.0).
 */
export async function confirmMemory(
  store: MemoryStore,
  entryId: string,
  scope: string,
): Promise<ConfidenceUpdate | null> {
  const entry = await store.getById(entryId);
  if (!entry) return null;

  const meta = parseMeta(entry);
  const oldConfidence = typeof meta.confidence === "number" ? meta.confidence : CONFIDENCE_DEFAULT;

  meta.confidence = CONFIDENCE_CONFIRMED;
  if (!Array.isArray(meta.confidence_history)) meta.confidence_history = [];
  meta.confidence_history.push({
    action: "confirmed",
    from: oldConfidence,
    to: CONFIDENCE_CONFIRMED,
    date: new Date().toISOString().slice(0, 10),
  });

  await store.update(entryId, { metadata: JSON.stringify(meta) }, [scope]);

  return { entryId, oldConfidence, newConfidence: CONFIDENCE_CONFIRMED };
}

/**
 * Mark a memory as corrected (user provided updated info).
 * Drops confidence to CORRECTED (0.3).
 */
export async function correctMemory(
  store: MemoryStore,
  entryId: string,
  scope: string,
  correctedById?: string,
): Promise<ConfidenceUpdate | null> {
  const entry = await store.getById(entryId);
  if (!entry) return null;

  const meta = parseMeta(entry);
  const oldConfidence = typeof meta.confidence === "number" ? meta.confidence : CONFIDENCE_DEFAULT;

  meta.confidence = CONFIDENCE_CORRECTED;
  if (correctedById) meta.corrected_by = correctedById;
  if (!Array.isArray(meta.confidence_history)) meta.confidence_history = [];
  meta.confidence_history.push({
    action: "corrected",
    from: oldConfidence,
    to: CONFIDENCE_CORRECTED,
    ...(correctedById ? { correctedBy: correctedById.slice(0, 8) } : {}),
    date: new Date().toISOString().slice(0, 10),
  });

  await store.update(entryId, { metadata: JSON.stringify(meta) }, [scope]);

  return { entryId, oldConfidence, newConfidence: CONFIDENCE_CORRECTED };
}

/**
 * Mark a memory as contradicted (explicitly wrong).
 * Drops confidence to CONTRADICTED (0.0).
 */
export async function contradictMemory(
  store: MemoryStore,
  entryId: string,
  scope: string,
): Promise<ConfidenceUpdate | null> {
  const entry = await store.getById(entryId);
  if (!entry) return null;

  const meta = parseMeta(entry);
  const oldConfidence = typeof meta.confidence === "number" ? meta.confidence : CONFIDENCE_DEFAULT;

  meta.confidence = CONFIDENCE_CONTRADICTED;
  if (!Array.isArray(meta.confidence_history)) meta.confidence_history = [];
  meta.confidence_history.push({
    action: "contradicted",
    from: oldConfidence,
    to: CONFIDENCE_CONTRADICTED,
    date: new Date().toISOString().slice(0, 10),
  });

  await store.update(entryId, { metadata: JSON.stringify(meta) }, [scope]);

  return { entryId, oldConfidence, newConfidence: CONFIDENCE_CONTRADICTED };
}

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
