/**
 * Version Manager — Tier 3.3
 *
 * Replaces the "archive loser" SUPERSEDE model with version coexistence:
 * - Entries that would have been merged are instead grouped by version_group
 * - Each version has a rank (confidence × log1p(accessCount + 1))
 * - During retrieval, only the top-ranked version per group is returned
 * - All versions remain in DB for history/audit
 *
 * Brain science inspiration: Imprint Competition — competing memory traces
 * can coexist; the stronger one dominates recall but the weaker remains
 * available for re-evaluation.
 */

import type { MemoryEntry } from "./store.js";
import type { MemoryStorePort } from "./memory-store-port.js";
import { logInfo } from "./stderr-log.js";

// ============================================================================
// Types
// ============================================================================

export interface VersionGroupMetadata {
  /** Shared UUID for all versions in this group */
  version_group: string;
  /** Rank within group (higher = preferred for retrieval) */
  version_rank: number;
  /** When this version was created/grouped */
  version_created: string;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Create a version group from two entries that would otherwise be merged.
 * Instead of archiving the weaker one, both get tagged with the same group.
 *
 * @param store      Memory store
 * @param canonical  The stronger entry (higher canonicalScore)
 * @param member     The weaker entry
 * @param scope      Scope filter for updates
 * @returns The version_group ID
 */
export async function createVersionGroup(
  store: Pick<MemoryStorePort, "update">,
  canonical: MemoryEntry,
  member: MemoryEntry,
  scope: string,
): Promise<string> {
  // Check if canonical already has a version_group
  const canonMeta = parseMetadata(canonical.metadata);
  const existingGroup = typeof canonMeta.version_group === "string" ? canonMeta.version_group : null;
  const groupId = existingGroup ?? generateGroupId();
  const now = new Date().toISOString();

  // Update canonical
  const canonRank = computeVersionRank(canonical);
  canonMeta.version_group = groupId;
  canonMeta.version_rank = canonRank;
  if (!canonMeta.version_created) canonMeta.version_created = now;
  await store.update(canonical.id, { metadata: JSON.stringify(canonMeta) }, [scope]);

  // Update member
  const memberMeta = parseMetadata(member.metadata);
  const memberRank = computeVersionRank(member);
  memberMeta.version_group = groupId;
  memberMeta.version_rank = memberRank;
  memberMeta.version_created = now;
  await store.update(member.id, { metadata: JSON.stringify(memberMeta) }, [scope]);

  logInfo(
    `[INFO] Version group ${groupId.slice(0, 8)}: ` +
    `${canonical.id.slice(0, 8)} (rank=${canonRank.toFixed(2)}) + ` +
    `${member.id.slice(0, 8)} (rank=${memberRank.toFixed(2)})`,
  );

  return groupId;
}

/**
 * Compute version rank for an entry.
 * Formula: (0.5 * importance + 0.5 * confidence) × (1 + log1p(accessCount))
 * Combines both importance (from extraction) and confidence (from user feedback)
 * with access frequency to determine which version wins.
 * Higher = preferred for retrieval.
 */
export function computeVersionRank(entry: MemoryEntry): number {
  const meta = parseMetadata(entry.metadata);
  const confidence = typeof meta.confidence === "number" ? meta.confidence : 0.7;
  const accessCount = typeof meta.accessCount === "number" ? meta.accessCount : 0;
  const importance = typeof entry.importance === "number" ? entry.importance : 0.5;
  const quality = 0.5 * importance + 0.5 * confidence;
  return quality * (1 + Math.log1p(accessCount));
}

/**
 * Deduplicate retrieval results by version group.
 * For each version_group, keep only the entry with the highest version_rank.
 * Entries without a version_group pass through unchanged.
 *
 * @param results  Array of retrieval results (must have entry.metadata)
 * @returns Filtered array with at most one entry per version group
 */
export function deduplicateByVersionGroup<T extends { entry: MemoryEntry; score: number }>(
  results: T[],
): T[] {
  // First pass: find the best entry per version group
  const groupBest = new Map<string, T>();

  for (const r of results) {
    const meta = parseMetadata(r.entry.metadata);
    const group = typeof meta.version_group === "string" ? meta.version_group : null;
    if (!group) continue;

    const existing = groupBest.get(group);
    if (!existing) {
      groupBest.set(group, r);
    } else {
      const existingRank = getVersionRank(existing.entry);
      const newRank = getVersionRank(r.entry);
      if (newRank > existingRank) {
        groupBest.set(group, r);
      }
    }
  }

  // Second pass: emit results preserving order, replacing groups with their winner
  const groupWinnerIds = new Set([...groupBest.values()].map(r => r.entry.id));
  const seenGroups = new Set<string>();
  const output: T[] = [];

  for (const r of results) {
    const meta = parseMetadata(r.entry.metadata);
    const group = typeof meta.version_group === "string" ? meta.version_group : null;

    if (!group) {
      // No version group → pass through
      output.push(r);
    } else if (!seenGroups.has(group) && groupWinnerIds.has(r.entry.id)) {
      // First appearance of this group's winner
      output.push(r);
      seenGroups.add(group);
    }
    // Skip non-winners and duplicate group appearances
  }

  return output;
}

// ============================================================================
// Helpers
// ============================================================================

function getVersionRank(entry: MemoryEntry): number {
  const meta = parseMetadata(entry.metadata);
  return typeof meta.version_rank === "number" ? meta.version_rank : computeVersionRank(entry);
}

function parseMetadata(raw?: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function generateGroupId(): string {
  // Simple UUID v4-like (no crypto needed for grouping)
  const hex = () => Math.random().toString(16).slice(2, 6);
  return `vg-${hex()}${hex()}`;
}
