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
import { isNoise } from "./noise-filter.js";
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
      !isNoise(e.text) &&
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

// ---------------------------------------------------------------------------
// Synthesis promotion: evidence → durable for dream-synthesized conclusions
// ---------------------------------------------------------------------------

/**
 * The layering this implements is "evidence retained → current projection → eligible for
 * recall → ranked result". `scanMemoryPromotions` above covers one road into the durable
 * layer: transcript-downgraded facts that recur often enough to be worth keeping. This
 * covers the other one, which had no road at all.
 *
 * `buildDerivedBoundary` (consolidation-engine) stamps every dream-synthesized insight and
 * cross-memory pattern as `layer: "evidence"`, deliberately — a model re-reading its own
 * memories is a lead to its sources, not authority over them. But
 * `shouldUseStableMemoryResult` refuses anything on the evidence layer, so the consequence
 * was absolute: **a synthesized conclusion could never take part in stable memory, no
 * matter how well supported it was.** The synthesis contract added in `efdb043` made those
 * conclusions checkable (a verdict may abstain, and evidence ids are validated against the
 * cluster) without giving them anywhere to go.
 *
 * ## Why the gate is not the one above
 *
 * The recurrence gate — "the same fact showed up in N separate places" — is the wrong
 * question to ask a synthesis. A synthesis is *already* a cross-entry aggregate; demanding
 * that the dream produce the same conclusion three times would be counting one thing three
 * ways. What it carries instead is its own support set, so that is what gets checked:
 * enough distinct sources, still live, under a contract version that validated them.
 *
 * ## What promotion does and does not touch
 *
 * The synthesis row is never modified — archive-first, and the evidence has to stay
 * readable as evidence. Promotion writes a *separate* durable entry through the same
 * `promoteMemory` path everything else uses, so it inherits canonicalKey dedup (re-running
 * revises rather than duplicating), secret redaction, and `promotedFrom` provenance
 * pointing back at the synthesis. The durable copy is what later recall can lean on.
 */

/** Synthesis contract version required before a derived row is eligible. */
export const MIN_PROMOTABLE_CONTRACT_VERSION = 2;

export interface SynthesisPromoteScanConfig {
  /** Min distinct, still-live evidence memories behind the conclusion (default 2). */
  minDistinctEvidence: number;
  /** Min importance of the synthesis itself (default 0.6). */
  minImportance: number;
  /** Max derived rows fetched from the store (default 2000). */
  listLimit: number;
  /** When true (default), report candidates without writing anything. */
  dryRun: boolean;
}

export const DEFAULT_SYNTHESIS_PROMOTE_CONFIG: SynthesisPromoteScanConfig = {
  minDistinctEvidence: 2,
  minImportance: 0.6,
  listLimit: 2000,
  dryRun: true,
};

/** Why an otherwise-derived row was not promoted. Reported, never silent. */
export type SynthesisSkipReason =
  | "pre_contract"
  | "already_promoted"
  | "evidence_unresolvable"
  | "too_few_distinct_evidence"
  | "below_importance";

export interface SynthesisPromoteCandidate {
  seedId: string;
  seedText: string;
  /** Durable category the conclusion is promoted into (from boundary.originalCategory). */
  category: DurableMemoryCategory;
  contractVersion: number;
  /** Distinct evidence ids that are still active in the store. */
  evidenceIds: string[];
  importance: number;
  /** Filled after a real promotion; null in dryRun mode. */
  promoted: StoredPromotedMemoryRecord | null;
}

export interface SynthesisPromoteScanResult {
  candidates: SynthesisPromoteCandidate[];
  /** Derived rows examined (carrying a distillation boundary), before gating. */
  scannedSyntheses: number;
  /** Per-reason counts for everything examined and rejected. */
  skipped: Record<SynthesisSkipReason, number>;
  promoted: number;
  dryRun: boolean;
}

export interface SynthesisPromoteScanDeps {
  store: Pick<MemoryStore, "list"> & {
    getById?(id: string): Promise<MemoryEntry | null>;
    get?(id: string): Promise<MemoryEntry | null>;
  };
  promote: PromoteFn;
}

function readContractVersion(metadata?: string): number | null {
  const parsed = parseMetadataObject(metadata);
  const raw = parsed?.synthesis_contract;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** Ids the model itself named as support, deduplicated and order-preserved. */
function readEvidenceIds(metadata?: string): string[] | null {
  const parsed = parseMetadataObject(metadata);
  const raw = parsed?.evidenceMemories;
  if (!Array.isArray(raw)) return null;
  const ids = raw.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return [...new Set(ids)];
}

/** A dream-synthesized derivative — evidence layer written by the distillation path. */
function isSynthesisRow(entry: MemoryEntry): boolean {
  const boundary = extractBoundaryMetadata(entry.metadata);
  return boundary?.layer === "evidence" && boundary.authority === "distillation";
}

async function loadEntry(
  deps: SynthesisPromoteScanDeps,
  id: string,
): Promise<MemoryEntry | null> {
  if (deps.store.getById) return deps.store.getById(id);
  if (deps.store.get) return deps.store.get(id);
  return null;
}

/**
 * Find synthesized conclusions whose own support set justifies a durable copy.
 *
 * Abstains rather than guesses: a row whose evidence ids cannot be resolved at all is
 * counted under `evidence_unresolvable` and left alone. That mirrors the abstention path
 * in `scanForPromotions`' cross-source check — when the provenance needed for the judgement
 * is missing, not judging is the correct answer, not judging leniently.
 */
export async function scanSynthesisPromotions(
  deps: SynthesisPromoteScanDeps,
  scope: string,
  config?: Partial<SynthesisPromoteScanConfig>,
): Promise<SynthesisPromoteScanResult> {
  const cfg: SynthesisPromoteScanConfig = { ...DEFAULT_SYNTHESIS_PROMOTE_CONFIG, ...config };

  const result: SynthesisPromoteScanResult = {
    candidates: [],
    scannedSyntheses: 0,
    skipped: {
      pre_contract: 0,
      already_promoted: 0,
      evidence_unresolvable: 0,
      too_few_distinct_evidence: 0,
      below_importance: 0,
    },
    promoted: 0,
    dryRun: cfg.dryRun,
  };

  // Synthesized insights take the cluster's majority category, so this cannot be narrowed
  // to one category the way the downgraded-evidence scan is.
  const rows = await deps.store.list([scope], undefined, cfg.listLimit, 0);
  const syntheses = rows.filter((e) => isActiveMemory(e.metadata) && isSynthesisRow(e));
  result.scannedSyntheses = syntheses.length;

  for (const entry of syntheses) {
    const contractVersion = readContractVersion(entry.metadata);
    // Derivatives written before the synthesis contract were never validated — the whole
    // point of the version stamp is that "which code produced this" stops being a guess.
    if (contractVersion === null || contractVersion < MIN_PROMOTABLE_CONTRACT_VERSION) {
      result.skipped.pre_contract += 1;
      continue;
    }

    if (hasPromotedToMarker(entry.metadata)) {
      result.skipped.already_promoted += 1;
      continue;
    }

    const declared = readEvidenceIds(entry.metadata);
    if (declared === null || declared.length === 0) {
      result.skipped.evidence_unresolvable += 1;
      continue;
    }

    // Evidence that has since been superseded or archived no longer supports anything.
    const resolved: string[] = [];
    let lookupFailed = false;
    for (const id of declared) {
      const source = await loadEntry(deps, id);
      if (source === null) {
        lookupFailed = true;
        continue;
      }
      if (isActiveMemory(source.metadata)) resolved.push(id);
    }

    // Cannot see any of the support: abstain instead of promoting on an unchecked claim.
    if (resolved.length === 0 && lookupFailed) {
      result.skipped.evidence_unresolvable += 1;
      continue;
    }

    if (resolved.length < cfg.minDistinctEvidence) {
      result.skipped.too_few_distinct_evidence += 1;
      continue;
    }

    if ((entry.importance ?? 0) < cfg.minImportance) {
      result.skipped.below_importance += 1;
      continue;
    }

    const boundary = extractBoundaryMetadata(entry.metadata);
    const category = (boundary?.originalCategory ?? "events") as DurableMemoryCategory;

    const candidate: SynthesisPromoteCandidate = {
      seedId: entry.id,
      seedText: entry.text,
      category,
      contractVersion,
      evidenceIds: resolved,
      importance: entry.importance,
      promoted: null,
    };

    if (!cfg.dryRun) {
      candidate.promoted = await deps.promote({
        memoryId: entry.id,
        category,
        scope,
        importance: entry.importance,
      });
      result.promoted += 1;
    }

    result.candidates.push(candidate);
  }

  return result;
}

export function formatSynthesisPromoteResult(result: SynthesisPromoteScanResult): string {
  const skippedTotal = Object.values(result.skipped).reduce((a, b) => a + b, 0);
  const lines = [
    `Synthesis promote-scan: ${result.scannedSyntheses} synthesized conclusion(s) examined, ${skippedTotal} skipped.`,
  ];

  // Always print the rejection breakdown: a scan that promotes nothing should still say
  // why, or "nothing found" and "everything filtered" look the same from outside.
  const reasons = (Object.entries(result.skipped) as Array<[SynthesisSkipReason, number]>)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${reason}=${n}`);
  if (reasons.length > 0) lines.push(`Skipped: ${reasons.join(", ")}`);

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
    lines.push(`### ${i + 1}. [${c.category}] ${c.seedText.split("\n")[0].slice(0, 80)}`);
    lines.push(
      `Evidence: ${c.evidenceIds.length} distinct (${c.evidenceIds.map((id) => id.slice(0, 8)).join(", ")})`,
    );
    lines.push(`Contract: v${c.contractVersion} | importance: ${c.importance.toFixed(2)} | seed: ${c.seedId.slice(0, 8)}`);
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
