/**
 * Belief history — copy-on-write archival for belief-changing writes.
 *
 * Problem this solves: the latest-wins and conflict-resolution paths used to call
 * store.update() on the canonical row, replacing text + vector in place. The previous
 * belief was physically gone, so no retrieval strategy could ever answer
 * "what did I believe last month?".
 *
 * Approach: before overwriting canonical row C, copy C's current content into a new
 * `superseded` history row H, then update C in place as before. C keeps its id, so the
 * `deterministicId(scope, canonicalKey)` invariant every canonical lookup depends on is
 * untouched — history lives beside it rather than replacing it.
 *
 * Chain shape (C is the stable canonical id, H1 older than H2):
 *   H1 --supersededBy--> C     C  --supersedes--> H2
 *   H2 --supersededBy--> C     H2 --supersedes--> H1
 * so traceEvolution() walks backward C → H2 → H1 to rebuild the timeline, and forward
 * from any history row to the belief that is live now.
 */

import { deterministicId, type MemoryEntry, type MemoryStore } from "./store.js";
import { parseEvolution, patchEvolution, type EvolutionMetadata } from "./memory-evolution.js";
import { detectLang, tokenizeFts } from "./language-hook.js";
import type { Embedder } from "./embedder.js";

/** Namespace for history-row ids — keeps them deterministic (retry-safe) yet distinct from C. */
const BELIEF_HISTORY_ID_PREFIX = "belief-history:";

export interface BeliefHistoryDeps {
  store: Pick<MemoryStore, "store"> & Partial<Pick<MemoryStore, "upsert" | "getById">>;
  embedder: Pick<Embedder, "embedPassage">;
}

export interface BeliefArchiveResult {
  /** Id of the newly written history row — becomes the canonical row's `supersedes`. */
  historyId: string;
  /** When the archived version stopped being the live belief. */
  validUntil: number;
}

/**
 * Resolve a usable vector for the row being archived.
 *
 * store.list() deliberately returns `vector: []` for performance, and that is where the
 * canonical-match candidates come from — so the entry handed to us usually has no vector.
 * Re-read the full row first; only re-embed if the store can't give it back.
 */
async function resolveVector(deps: BeliefHistoryDeps, current: MemoryEntry): Promise<number[]> {
  if (current.vector && current.vector.length > 0) return current.vector;

  if (deps.store.getById) {
    const full = await deps.store.getById(current.id);
    if (full?.vector && full.vector.length > 0) return full.vector;
  }

  return await deps.embedder.embedPassage(current.text);
}

/**
 * Archive the current content of a canonical memory as a `superseded` history row.
 *
 * Throws rather than degrading to a silent overwrite: a belief-changing write that cannot
 * preserve the old belief is exactly the failure this module exists to prevent, so callers
 * must not proceed with the overwrite if this rejects.
 *
 * Known limitation — archive and overwrite are two writes with no transaction around them.
 * If the caller's update() fails after this returns, the history row is already committed
 * while the canonical row still holds that same text, leaving a superseded duplicate of a
 * belief that is in fact still live. Damage is bounded: nothing is destroyed, and the
 * deterministic id means a retry reuses the same row rather than piling up copies.
 */
export async function archiveBeliefVersion(
  deps: BeliefHistoryDeps,
  current: MemoryEntry,
  options: { now?: number } = {},
): Promise<BeliefArchiveResult> {
  const now = options.now ?? Date.now();
  const currentEvo = parseEvolution(current.metadata, current.timestamp);

  // Text is part of the id, not just (id, timestamp): two belief changes landing in the
  // same millisecond would otherwise collide and the second archive would overwrite the
  // first. With the text folded in, a collision means the content is identical anyway.
  const historyId = deterministicId(
    current.scope,
    `${BELIEF_HISTORY_ID_PREFIX}${current.id}@${current.timestamp}\n${current.text}`,
  );
  if (historyId === current.id) {
    throw new Error(`Belief history id collided with canonical id ${current.id}`);
  }

  const vector = await resolveVector(deps, current);
  if (vector.length === 0) {
    throw new Error(`Cannot archive belief ${current.id}: no vector available`);
  }

  // The history row inherits the old metadata wholesale (canonicalKey, boundary, emotion…)
  // and only has its evolution block rewritten to close the interval.
  const historyMetadata = patchEvolution(current.metadata, {
    status: "superseded",
    validFrom: currentEvo.validFrom,
    validUntil: now,
    supersededBy: current.id,
    // Point at the version this one replaced, so the backward walk stays a chain.
    supersedes: currentEvo.supersedes,
  });

  const historyRow: MemoryEntry = {
    id: historyId,
    text: current.text,
    vector,
    category: current.category,
    scope: current.scope,
    importance: current.importance,
    // Keep the original timestamp: canonical matching scans the most recent
    // CANONICAL_SCAN_LIMIT rows, and stamping history rows "now" would let them crowd
    // live entries out of that window.
    timestamp: current.timestamp,
    metadata: historyMetadata,
    // Derive rather than copy: neither list() nor getById() selects these columns, so
    // `current.language` / `current.fts_text` are all but guaranteed to be undefined here.
    // Falling back to the "en" / raw-text defaults would mislabel Chinese memories and
    // store them unsegmented for FTS — so recompute them the same way live entries do.
    language: current.language || detectLang(current.text),
    fts_text: current.fts_text || tokenizeFts(current.text, current.language || detectLang(current.text)),
  };

  if (deps.store.upsert) {
    await deps.store.upsert(historyRow);
  } else {
    // Fallback for narrower store deps (mocks): store() stamps its own timestamp, which
    // only costs us the scan-window optimisation above — the history row is still written.
    await deps.store.store(historyRow);
  }

  return { historyId, validUntil: now };
}

/**
 * Build the evolution block for the canonical row that is about to be overwritten.
 *
 * Callers previously passed the incoming metadata straight to store.update(), which wiped
 * the evolution block along with the text. This merges the incoming metadata with a fresh
 * evolution block that links back to the archived version.
 */
export function buildSupersedingBeliefMetadata(
  incomingMetadata: string | undefined,
  previousEvolution: EvolutionMetadata,
  historyId: string,
  now: number,
  evolutionNote?: string | null,
): string {
  return patchEvolution(incomingMetadata, {
    status: "active",
    version: previousEvolution.version + 1,
    supersedes: historyId,
    supersededBy: null,
    validFrom: now,
    validUntil: null,
    // Access stats belong to the canonical key, not to a single version's text.
    accessCount: previousEvolution.accessCount,
    lastAccessedAt: previousEvolution.lastAccessedAt,
    ...(evolutionNote ? { evolutionNote } : {}),
  });
}
