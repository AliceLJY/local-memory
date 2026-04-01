/**
 * Memory Evolution — lifecycle tracking for memory entries.
 *
 * Adds status, version, access tracking, supersede/consolidation links,
 * and decay scoring to each memory. Fields live inside the existing
 * metadata JSON so the LanceDB schema is unchanged.
 *
 * Design principles (from arXiv 2512.13564 survey):
 * - Archive-first, delete-never
 * - Supersede-on-conflict (old stays, new links to it)
 * - Composite decay = 0.2 time + 0.3 frequency + 0.5 importance
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvolutionStatus = "active" | "superseded" | "archived" | "consolidated";

export interface EvolutionMetadata {
  status: EvolutionStatus;
  version: number;
  accessCount: number;
  lastAccessedAt: number | null;
  supersededBy: string | null;
  consolidatedInto: string | null;
  sourceMemories: string[];
  validFrom: number;
  validUntil: number | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function defaultEvolution(now?: number): EvolutionMetadata {
  const ts = now ?? Date.now();
  return {
    status: "active",
    version: 1,
    accessCount: 0,
    lastAccessedAt: null,
    supersededBy: null,
    consolidatedInto: null,
    sourceMemories: [],
    validFrom: ts,
    validUntil: null,
  };
}

// ---------------------------------------------------------------------------
// Parse / Serialize
// ---------------------------------------------------------------------------

/**
 * Extract evolution metadata from a memory's metadata JSON string.
 * Returns sensible defaults when the field is absent (backward compat).
 */
export function parseEvolution(metadata: string | undefined, fallbackTimestamp?: number): EvolutionMetadata {
  if (!metadata) return defaultEvolution(fallbackTimestamp);
  try {
    const parsed = JSON.parse(metadata);
    const evo = parsed?.evolution;
    if (!evo) return defaultEvolution(fallbackTimestamp);
    return {
      status: evo.status ?? "active",
      version: evo.version ?? 1,
      accessCount: evo.accessCount ?? 0,
      lastAccessedAt: evo.lastAccessedAt ?? null,
      supersededBy: evo.supersededBy ?? null,
      consolidatedInto: evo.consolidatedInto ?? null,
      sourceMemories: Array.isArray(evo.sourceMemories) ? evo.sourceMemories : [],
      validFrom: evo.validFrom ?? fallbackTimestamp ?? Date.now(),
      validUntil: evo.validUntil ?? null,
    };
  } catch {
    return defaultEvolution(fallbackTimestamp);
  }
}

/**
 * Patch evolution fields into an existing metadata JSON string.
 * Merges with existing evolution — does not wipe unset fields.
 */
export function patchEvolution(
  metadata: string | undefined,
  patch: Partial<EvolutionMetadata>,
): string {
  let parsed: Record<string, unknown> = {};
  if (metadata) {
    try { parsed = JSON.parse(metadata); } catch { /* keep empty */ }
  }
  const existing = parsed.evolution as Partial<EvolutionMetadata> | undefined;
  parsed.evolution = { ...existing, ...patch };
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** Is this memory currently active (not superseded/archived/consolidated)? */
export function isActiveMemory(metadata: string | undefined): boolean {
  const evo = parseEvolution(metadata);
  return evo.status === "active";
}

// ---------------------------------------------------------------------------
// Access Tracking
// ---------------------------------------------------------------------------

/**
 * Record a retrieval hit: increment accessCount and update lastAccessedAt.
 * Returns updated metadata JSON string.
 */
export function recordAccess(metadata: string | undefined): string {
  const evo = parseEvolution(metadata);
  return patchEvolution(metadata, {
    accessCount: evo.accessCount + 1,
    lastAccessedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Supersede / Consolidate helpers
// ---------------------------------------------------------------------------

/**
 * Mark a memory as superseded by a newer memory.
 * Sets status, validUntil, and supersededBy link.
 */
export function buildSupersedeMetadata(
  oldMetadata: string | undefined,
  newMemoryId: string,
): string {
  return patchEvolution(oldMetadata, {
    status: "superseded",
    validUntil: Date.now(),
    supersededBy: newMemoryId,
  });
}

/**
 * Mark a memory as consolidated into a higher-level memory.
 * The original is kept (archive-first) but linked to the consolidated entry.
 */
export function buildConsolidatedMetadata(
  oldMetadata: string | undefined,
  consolidatedMemoryId: string,
): string {
  return patchEvolution(oldMetadata, {
    status: "consolidated",
    consolidatedInto: consolidatedMemoryId,
  });
}

/**
 * Mark a memory as archived (low decay score for extended period).
 */
export function buildArchivedMetadata(oldMetadata: string | undefined): string {
  return patchEvolution(oldMetadata, { status: "archived" });
}

// ---------------------------------------------------------------------------
// Decay Scoring
// ---------------------------------------------------------------------------

const TIME_HALF_LIFE_DAYS = 90;
const TIME_WEIGHT = 0.2;
const FREQUENCY_WEIGHT = 0.3;
const IMPORTANCE_WEIGHT = 0.5;

/**
 * Compute composite decay score (0–1, higher = more valuable to keep).
 *
 *   decay = 0.2 × timeDecay + 0.3 × frequencyScore + 0.5 × importance
 *
 * Time decay: exponential with 90-day half-life.
 * Frequency: log(1 + accessCount) × recencyBoost, capped at 1.
 * Importance: as-stored (0–1).
 */
export function computeDecayScore(
  evo: EvolutionMetadata,
  importance: number,
  now?: number,
): number {
  const ts = now ?? Date.now();

  // Time decay (Weibull-ish exponential)
  const daysSinceCreation = Math.max(0, (ts - evo.validFrom) / 86_400_000);
  const timeDecay = Math.pow(0.5, daysSinceCreation / TIME_HALF_LIFE_DAYS);

  // Frequency score
  const rawFreq = Math.log2(1 + evo.accessCount);
  const recencyBoost = evo.lastAccessedAt
    ? Math.pow(0.5, Math.max(0, (ts - evo.lastAccessedAt) / 86_400_000) / 30) // 30-day half-life for recency
    : 0.5; // never accessed → neutral
  const frequencyScore = Math.min(1, rawFreq * recencyBoost);

  return (
    TIME_WEIGHT * timeDecay +
    FREQUENCY_WEIGHT * frequencyScore +
    IMPORTANCE_WEIGHT * Math.max(0, Math.min(1, importance))
  );
}
