/**
 * Autobiographical Narrative Architecture — orthogonal metadata layer.
 *
 * Adds a three-level narrative hierarchy (life-period / general-event / specific-event)
 * on top of the existing 6 durable memory categories. This enables temporal grouping
 * and narrative retrieval without disrupting category logic.
 *
 * Philosophy: Conway's theory of autobiographical memory — memories organize
 * hierarchically from life themes → general events → specific episodes.
 *
 * Feature flag: RECALLNEST_NARRATIVE_MODE=true
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Feature Flag
// ---------------------------------------------------------------------------

export function isNarrativeModeEnabled(): boolean {
  return process.env.RECALLNEST_NARRATIVE_MODE === "true";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NarrativeMetadata {
  /** Life period identifier (auto-generated from scope prefix + quarterly time window) */
  lifePeriodId: string;
  /** Human-readable label for the life period */
  lifePeriodLabel: string;
  /** General event identifier (groups related memories within a day/session) */
  generalEventId: string;
  /** Human-readable label for the general event */
  generalEventLabel: string;
  /** Specific event identifier (unique episode) */
  specificEventId: string;
  /** Human-readable label for the specific event */
  specificEventLabel: string;
  /** Event start timestamp (epoch ms) */
  startAt: number;
  /** Event end timestamp (epoch ms, null if ongoing) */
  endAt: number | null;
  /** Sequence number within the general event for ordering */
  sequence: number;
}

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

export const NarrativeMetadataSchema = z.object({
  lifePeriodId: z.string().min(1).max(120),
  lifePeriodLabel: z.string().min(1).max(120),
  generalEventId: z.string().min(1).max(120),
  generalEventLabel: z.string().min(1).max(200),
  specificEventId: z.string().min(1).max(120),
  specificEventLabel: z.string().min(1).max(200),
  startAt: z.number(),
  endAt: z.number().nullable(),
  sequence: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Parse narrative metadata from metadata JSON string, returns null if absent */
export function parseNarrative(metadata: string | undefined): NarrativeMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.narrative && typeof parsed.narrative.lifePeriodId === "string") {
      return NarrativeMetadataSchema.parse(parsed.narrative);
    }
  } catch { /* malformed metadata — safe to ignore */ }
  return null;
}
