/**
 * Promote-Scan: auto-promotion pipeline for transcript-downgraded stable facts.
 *
 * Transcript ingest downgrades profile/preferences into `events` evidence
 * (memory-boundaries.ts:resolveIngestBoundary), tagging boundary.downgradedFrom.
 * Without an automatic promotion path those high-signal facts stay sparse in
 * durable memory. This module clusters recurring downgraded evidence and, when a
 * cluster recurs often enough at high enough importance, promotes the seed back
 * to its original durable category via the injected `promote` callback.
 *
 * Idempotency is delegated to promoteMemory -> writeDurableEntry's canonicalKey
 * dedup, so re-scanning is safe (we do not mutate source evidence — see #19
 * non-atomic store.update — and rely on dedup instead of a promotedTo marker).
 */

import type { MemoryEntry, MemoryStore } from "./store.js";
import type { DurableMemoryCategory, StoredPromotedMemoryRecord } from "./memory-schema.js";
import { isActiveMemory } from "./memory-evolution.js";
import { extractBoundaryMetadata, parseMetadataObject } from "./memory-boundaries.js";
import { greedyCluster } from "./skill-promotion.js";
import { promoteMemory, type PersistMemoryDeps } from "./capture-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Categories that transcript ingest downgrades into evidence. */
type PromotableDowngrade = "profile" | "preferences";

export interface PromoteRequest {
  memoryId: string;
  category: DurableMemoryCategory;
  scope: string;
  importance: number;
}

export type PromoteFn = (req: PromoteRequest) => Promise<StoredPromotedMemoryRecord>;

export interface PromoteScanDeps {
  store: Pick<MemoryStore, "list" | "getVectors">;
  /** Injected so the scan unit-tests without the full persist pipeline. */
  promote: PromoteFn;
}

export interface PromoteScanConfig {
  /** Min cluster members before a downgraded fact is promoted (default 3). */
  minOccurrences: number;
  /** Min average cluster importance to promote (default 0.6). */
  minImportance: number;
  /** Cosine similarity threshold for greedy clustering (default 0.82). */
  clusterThreshold: number;
  /** Max events fetched from the store (default 2000). */
  listLimit: number;
  /** When true (default), find candidates without writing anything. */
  dryRun: boolean;
}

export const DEFAULT_PROMOTE_SCAN_CONFIG: PromoteScanConfig = {
  minOccurrences: 3,
  minImportance: 0.6,
  clusterThreshold: 0.82,
  listLimit: 2000,
  dryRun: true,
};

export interface PromoteCandidate {
  downgradedFrom: PromotableDowngrade;
  seedId: string;
  seedText: string;
  memberIds: string[];
  occurrences: number;
  avgImportance: number;
  /** Filled after a real promotion; null in dryRun mode. */
  promoted: StoredPromotedMemoryRecord | null;
}

export interface PromoteScanResult {
  candidates: PromoteCandidate[];
  scannedEvidence: number;
  clusters: number;
  promoted: number;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasPromotedToMarker(metadata?: string): boolean {
  const parsed = parseMetadataObject(metadata);
  return typeof parsed?.promotedTo === "string" && parsed.promotedTo.trim().length > 0;
}

function resolveDowngrade(entry: MemoryEntry): PromotableDowngrade | null {
  const from = extractBoundaryMetadata(entry.metadata)?.downgradedFrom;
  return from === "profile" || from === "preferences" ? from : null;
}

function averageImportance(members: MemoryEntry[]): number {
  if (members.length === 0) return 0;
  return members.reduce((sum, m) => sum + (m.importance ?? 0), 0) / members.length;
}

/** Pick the highest-importance member as the promotion seed. */
function pickSeed(members: MemoryEntry[]): MemoryEntry {
  return members.reduce((best, m) => (m.importance > best.importance ? m : best), members[0]);
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

export async function scanMemoryPromotions(
  deps: PromoteScanDeps,
  scope: string,
  config?: Partial<PromoteScanConfig>,
): Promise<PromoteScanResult> {
  const cfg: PromoteScanConfig = { ...DEFAULT_PROMOTE_SCAN_CONFIG, ...config };

  // 1. Load downgraded evidence (events). list() returns empty vectors.
  const events = await deps.store.list([scope], "events", cfg.listLimit, 0);

  // 2. Keep only active, downgraded-from profile/preferences, not-yet-promoted.
  const downgraded = events.filter(
    (e) =>
      isActiveMemory(e.metadata) &&
      !hasPromotedToMarker(e.metadata) &&
      resolveDowngrade(e) !== null,
  );

  const result: PromoteScanResult = {
    candidates: [],
    scannedEvidence: downgraded.length,
    clusters: 0,
    promoted: 0,
    dryRun: cfg.dryRun,
  };

  if (downgraded.length === 0) return result;

  // 3. Backfill vectors (list omits them for performance) and drop the
  //    vectorless — they cannot be clustered.
  const vectorMap = await deps.store.getVectors(downgraded.map((e) => e.id));
  const withVectors = downgraded
    .map((e) => ({ ...e, vector: vectorMap.get(e.id) ?? [] }))
    .filter((e) => e.vector.length > 0);

  // 4. Group by downgraded category — they promote to different targets.
  const groups = new Map<PromotableDowngrade, MemoryEntry[]>();
  for (const entry of withVectors) {
    const from = resolveDowngrade(entry);
    if (!from) continue;
    const bucket = groups.get(from);
    if (bucket) bucket.push(entry);
    else groups.set(from, [entry]);
  }

  // 5. Cluster each group; qualify candidates by occurrence + importance.
  for (const [downgradedFrom, members] of groups) {
    const clusters = greedyCluster(members, cfg.clusterThreshold);
    result.clusters += clusters.length;

    for (const cluster of clusters) {
      if (cluster.members.length < cfg.minOccurrences) continue;
      const avgImportance = averageImportance(cluster.members);
      if (avgImportance < cfg.minImportance) continue;

      const seed = pickSeed(cluster.members);
      const candidate: PromoteCandidate = {
        downgradedFrom,
        seedId: seed.id,
        seedText: seed.text,
        memberIds: cluster.members.map((m) => m.id),
        occurrences: cluster.members.length,
        avgImportance,
        promoted: null,
      };

      // 6. Promote (unless dry-run). Dedup is handled by promoteMemory.
      if (!cfg.dryRun) {
        candidate.promoted = await deps.promote({
          memoryId: seed.id,
          category: downgradedFrom,
          scope,
          importance: avgImportance,
        });
        result.promoted += 1;
      }

      result.candidates.push(candidate);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

/** Build scan deps from the persist pipeline, wrapping promoteMemory. */
export function buildPromoteScanDeps(
  deps: PersistMemoryDeps & {
    store: PersistMemoryDeps["store"] & Pick<MemoryStore, "list" | "getVectors">;
  },
): PromoteScanDeps {
  return {
    store: deps.store,
    promote: (req) => promoteMemory(deps, req),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatPromoteScanResult(result: PromoteScanResult): string {
  const lines = [
    `Promote-scan: ${result.scannedEvidence} downgraded evidence, ${result.clusters} cluster(s) scanned.`,
  ];
  if (result.candidates.length === 0) {
    lines.push("No promotion candidates found.");
    return lines.join("\n");
  }
  lines.push(
    result.dryRun
      ? `Found ${result.candidates.length} candidate(s) (dry-run, nothing written):\n`
      : `Promoted ${result.promoted} of ${result.candidates.length} candidate(s):\n`,
  );
  for (const [i, c] of result.candidates.entries()) {
    lines.push(`### ${i + 1}. [${c.downgradedFrom}] ${c.seedText.split("\n")[0].slice(0, 80)}`);
    lines.push(`Occurrences: ${c.occurrences} | avg importance: ${c.avgImportance.toFixed(2)}`);
    lines.push(`Seed: ${c.seedId.slice(0, 8)} | members: ${c.memberIds.length}`);
    if (c.promoted) {
      lines.push(
        c.promoted.disposition === "conflict" && c.promoted.conflictId
          ? `-> conflict ${c.promoted.conflictId.slice(0, 8)} (manual review)`
          : `-> durable ${c.promoted.id.slice(0, 8)} (${c.promoted.disposition}, key ${c.promoted.canonicalKey})`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
