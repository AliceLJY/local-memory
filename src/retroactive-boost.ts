/**
 * Retroactive Association Boost (STC — Synaptic Tagging & Capture)
 *
 * Agent-First reasoning: when a new high-importance memory is stored
 * (e.g. "I'm moving to Singapore"), older weak fragments that are
 * semantically related (e.g. "Singapore weather notes") become more
 * valuable. Without this, those old fragments stay buried at low
 * importance and never surface in relevant retrievals.
 *
 * Brain-science label: STC hypothesis — a strong event "captures"
 * weakly tagged memories and promotes them. We keep the name for
 * branding; the real mechanism is a vector similarity search +
 * importance bump on related old entries.
 *
 * Rules:
 * - Only triggers on high-importance writes (≥ threshold)
 * - Only boosts entries that are currently low-importance (below cap)
 * - Boost is additive with a ceiling — never exceeds maxBoostedImportance
 * - Writes metadata breadcrumb for auditability
 * - No LLM calls — pure vector search + arithmetic
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import { isActiveMemory } from "./memory-evolution.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RetroactiveBoostConfig {
  /** Minimum importance of the NEW memory to trigger a boost sweep (default: 0.8) */
  triggerImportanceMin: number;
  /** Only boost entries whose current importance is below this (default: 0.6) */
  boostCandidateMaxImportance: number;
  /** Additive importance bump (default: 0.15) */
  boostAmount: number;
  /** Ceiling: boosted importance never exceeds this (default: 0.75) */
  maxBoostedImportance: number;
  /** Minimum vector similarity to consider "related" (default: 0.72) */
  similarityThreshold: number;
  /** Maximum entries to boost per trigger (default: 5) */
  maxBoostPerTrigger: number;
  /** Minimum age in days for a candidate (avoid boosting very recent entries) (default: 1) */
  minAgeDays: number;
}

export const DEFAULT_RETROACTIVE_BOOST_CONFIG: RetroactiveBoostConfig = {
  triggerImportanceMin: 0.8,
  boostCandidateMaxImportance: 0.6,
  boostAmount: 0.15,
  maxBoostedImportance: 0.75,
  similarityThreshold: 0.72,
  maxBoostPerTrigger: 5,
  minAgeDays: 1,
};

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export interface BoostResult {
  triggered: boolean;
  reason?: string;
  boostedCount: number;
  boostedIds: string[];
}

/**
 * After a high-importance memory is stored, search for related older
 * low-importance entries and boost them.
 *
 * Call this right after store.add() for the new entry.
 */
export async function retroactiveBoost(
  store: MemoryStore,
  newEntry: Pick<MemoryEntry, "id" | "text" | "vector" | "importance" | "scope" | "timestamp">,
  config: RetroactiveBoostConfig = DEFAULT_RETROACTIVE_BOOST_CONFIG,
): Promise<BoostResult> {
  // Gate: only trigger for high-importance new memories
  if (newEntry.importance < config.triggerImportanceMin) {
    return { triggered: false, reason: "below_importance_threshold", boostedCount: 0, boostedIds: [] };
  }

  if (!newEntry.vector?.length) {
    return { triggered: false, reason: "no_vector", boostedCount: 0, boostedIds: [] };
  }

  // Find related entries in the same scope
  // Superseded belief-history rows come back from vectorSearch too. Boosting one is wasted
  // — they are excluded from retrieval anyway — and it burns maxBoostPerTrigger budget that
  // live entries should be getting.
  const candidates = (await store.vectorSearch(
    newEntry.vector,
    config.maxBoostPerTrigger * 3, // fetch more, filter down
    config.similarityThreshold,
    [newEntry.scope],
  )).filter((candidate) => isActiveMemory(candidate.entry.metadata));

  const now = Date.now();
  const minAgeMs = config.minAgeDays * 86_400_000;
  const boostedIds: string[] = [];

  for (const candidate of candidates) {
    if (boostedIds.length >= config.maxBoostPerTrigger) break;

    const entry = candidate.entry;

    // Skip self
    if (entry.id === newEntry.id) continue;

    // Skip entries that are already high importance
    if (entry.importance >= config.boostCandidateMaxImportance) continue;

    // Skip very recent entries (they'll get their own natural scoring)
    const ageDays = (now - entry.timestamp) / 86_400_000;
    if (ageDays < config.minAgeDays) continue;

    // Compute boost: additive, capped
    const newImportance = Math.min(
      entry.importance + config.boostAmount,
      config.maxBoostedImportance,
    );

    // Skip if no actual change
    if (newImportance <= entry.importance) continue;

    // Update metadata with audit trail
    let meta: Record<string, any> = {};
    try { meta = JSON.parse(entry.metadata || "{}"); } catch { /* skip */ }

    if (!Array.isArray(meta.stc_boosts)) meta.stc_boosts = [];
    meta.stc_boosts.push({
      triggeredBy: newEntry.id.slice(0, 8),
      from: entry.importance,
      to: newImportance,
      similarity: candidate.score,
      date: new Date().toISOString().slice(0, 10),
    });

    // Promote tier if appropriate
    if (meta.tier === "peripheral" && newImportance >= 0.5) {
      meta.tier = "working";
    }

    await store.update(entry.id, {
      importance: newImportance,
      metadata: JSON.stringify(meta),
    }, [newEntry.scope]);

    boostedIds.push(entry.id);
  }

  return {
    triggered: true,
    boostedCount: boostedIds.length,
    boostedIds,
  };
}
