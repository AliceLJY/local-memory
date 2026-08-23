/**
 * Evidence → durable promotion for dream-synthesized conclusions.
 *
 * The layering RecallNest works under is "evidence retained → current projection →
 * eligible for recall → ranked result", and until now a synthesized conclusion could only
 * ever occupy the first of those. `buildDerivedBoundary` stamps every cluster insight and
 * cross-memory pattern `layer: "evidence"` on purpose — a model re-reading its own
 * memories is a lead to its sources, not authority over them — but
 * `shouldUseStableMemoryResult` rejects the evidence layer outright, so there was no path
 * from a well-supported conclusion to anything downstream could lean on.
 *
 * These tests cover the road that closes that gap, and the guardrails on it: the synthesis
 * row is never touched, re-running revises instead of duplicating, and anything whose
 * support cannot be checked is abstained on rather than waved through.
 */

import { describe, expect, it } from "bun:test";

import {
  DEFAULT_SYNTHESIS_PROMOTE_CONFIG,
  MIN_PROMOTABLE_CONTRACT_VERSION,
  formatSynthesisPromoteResult,
  scanSynthesisPromotions,
  type PromoteRequest,
  type SynthesisPromoteScanDeps,
} from "../memory-promotion.js";
import { shouldUseStableMemoryResult } from "../memory-boundaries.js";
import type { MemoryEntry } from "../store.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SCOPE = "memory";

interface RowSpec {
  id: string;
  text: string;
  category?: string;
  importance?: number;
  /** Omit for a plain (non-synthesis) row. */
  synthesis?: {
    contract?: number | null;
    evidenceMemories?: unknown;
    originalCategory?: string;
  };
  status?: string;
  promotedTo?: string;
}

function row(spec: RowSpec): MemoryEntry {
  const metadata: Record<string, unknown> = {
    evolution: { status: spec.status ?? "active", version: 1, accessCount: 0 },
  };

  if (spec.synthesis) {
    metadata.boundary = {
      layer: "evidence",
      authority: "distillation",
      conflictPolicy: "append-only",
      originalCategory: spec.synthesis.originalCategory ?? "cases",
      note: "Dream-synthesized derivative: a lead to its sources, never authority over them.",
    };
    if (spec.synthesis.contract !== null) {
      metadata.synthesis_contract = spec.synthesis.contract ?? MIN_PROMOTABLE_CONTRACT_VERSION;
    }
    if (spec.synthesis.evidenceMemories !== undefined) {
      metadata.evidenceMemories = spec.synthesis.evidenceMemories;
    }
  } else {
    metadata.boundary = {
      layer: "durable",
      authority: "structured-memory",
      conflictPolicy: "latest-wins",
    };
  }

  if (spec.promotedTo) metadata.promotedTo = spec.promotedTo;

  return {
    id: spec.id,
    text: spec.text,
    vector: [],
    category: (spec.category ?? "cases") as MemoryEntry["category"],
    scope: SCOPE,
    importance: spec.importance ?? 0.8,
    timestamp: Date.parse("2026-08-20T00:00:00.000Z"),
    metadata: JSON.stringify(metadata),
  };
}

/** Two live evidence rows every well-formed synthesis in these tests points at. */
const EVIDENCE = [
  row({ id: "ev-alpha", text: "第一次踩坑：换机没 push，第二天分叉" }),
  row({ id: "ev-beta", text: "第二次：hooks symlink 化之后工作区常态脏" }),
];

function buildDeps(rows: MemoryEntry[]): {
  deps: SynthesisPromoteScanDeps;
  promoted: PromoteRequest[];
} {
  const all = [...EVIDENCE, ...rows];
  const byId = new Map(all.map((e) => [e.id, e]));
  const promoted: PromoteRequest[] = [];

  return {
    promoted,
    deps: {
      store: {
        async list() {
          return all;
        },
        async getById(id: string) {
          return byId.get(id) ?? null;
        },
      } as any,
      async promote(req) {
        promoted.push(req);
        return {
          id: `durable-${req.memoryId}`,
          text: byId.get(req.memoryId)?.text ?? "",
          category: req.category,
          importance: req.importance,
          scope: req.scope,
          resolvedScope: req.scope,
          canonicalKey: `key:${req.memoryId}`,
          storedAt: new Date().toISOString(),
          disposition: "stored",
          sourceMemoryId: req.memoryId,
          sourceCategory: "cases",
        } as any;
      },
    },
  };
}

function goodSynthesis(over: Partial<RowSpec> = {}): MemoryEntry {
  return row({
    id: "syn-good",
    text: "换机交接的失败都同一个形状：脏工作区被当成临时状态，真相源迁走后它变成常态",
    importance: 0.85,
    ...over,
    synthesis: {
      contract: MIN_PROMOTABLE_CONTRACT_VERSION,
      evidenceMemories: ["ev-alpha", "ev-beta"],
      originalCategory: "patterns",
      ...(over.synthesis ?? {}),
    },
  });
}

// ---------------------------------------------------------------------------

describe("synthesis promotion: what qualifies", () => {
  it("promotes a contract-compliant conclusion with enough live evidence", async () => {
    const { deps, promoted } = buildDeps([goodSynthesis()]);

    const result = await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });

    expect(result.candidates).toHaveLength(1);
    expect(result.promoted).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      seedId: "syn-good",
      category: "patterns",
      contractVersion: MIN_PROMOTABLE_CONTRACT_VERSION,
      evidenceIds: ["ev-alpha", "ev-beta"],
    });
    // Promotion goes through the shared promoteMemory path, not a private writer.
    expect(promoted).toEqual([
      { memoryId: "syn-good", category: "patterns", scope: SCOPE, importance: 0.85 },
    ]);
  });

  it("defaults to dry-run and writes nothing", async () => {
    const { deps, promoted } = buildDeps([goodSynthesis()]);

    const result = await scanSynthesisPromotions(deps, SCOPE);

    expect(DEFAULT_SYNTHESIS_PROMOTE_CONFIG.dryRun).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.promoted).toBe(0);
    expect(promoted).toEqual([]);
    expect(result.candidates[0]?.promoted).toBeNull();
  });

  it("ignores rows that are not synthesized derivatives", async () => {
    // A hand-written durable memory is already on the durable layer; promoting it would be
    // meaningless, and promoteMemory itself rejects non-evidence sources.
    const { deps } = buildDeps([
      row({ id: "handwritten", text: "Alice 用 Bun，不用 npm" }),
      goodSynthesis(),
    ]);

    const result = await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });

    expect(result.scannedSyntheses).toBe(1);
    expect(result.candidates.map((c) => c.seedId)).toEqual(["syn-good"]);
  });

  it("takes the durable category from the synthesis boundary", async () => {
    const { deps, promoted } = buildDeps([
      goodSynthesis({ synthesis: { originalCategory: "preferences" } as any }),
    ]);

    await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });

    expect(promoted[0]?.category).toBe("preferences");
  });
});

describe("synthesis promotion: what it refuses, and says so", () => {
  it("skips derivatives written before the synthesis contract", async () => {
    // The 4,749 rows already in the database predate validation entirely — they were never
    // checked for abstention, evidence, or prompt echo. Promoting them would launder
    // unvalidated output into durable memory.
    const { deps, promoted } = buildDeps([
      goodSynthesis({ id: "syn-legacy", synthesis: { contract: null } as any }),
      goodSynthesis({ id: "syn-v1", synthesis: { contract: 1 } as any }),
    ]);

    const result = await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });

    expect(result.skipped.pre_contract).toBe(2);
    expect(result.candidates).toHaveLength(0);
    expect(promoted).toEqual([]);
  });

  it("abstains when the declared evidence cannot be resolved at all", async () => {
    // Not judging is the right answer when the provenance needed for the judgement is
    // missing — the same abstention rule the cross-source promotion check uses.
    const { deps, promoted } = buildDeps([
      goodSynthesis({ id: "syn-dangling", synthesis: { evidenceMemories: ["gone-1", "gone-2"] } as any }),
    ]);

    const result = await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });

    expect(result.skipped.evidence_unresolvable).toBe(1);
    expect(promoted).toEqual([]);
  });

  it("abstains when the evidence field is missing or malformed", async () => {
    const { deps } = buildDeps([
      goodSynthesis({ id: "syn-noevidence", synthesis: { evidenceMemories: undefined } as any }),
      goodSynthesis({ id: "syn-badevidence", synthesis: { evidenceMemories: "not-an-array" } as any }),
    ]);

    const result = await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });

    expect(result.skipped.evidence_unresolvable).toBe(2);
    expect(result.candidates).toHaveLength(0);
  });

  it("counts duplicate evidence ids once", async () => {
    // "Three similar cases" and "three distinct episodes" differ in dimension, not degree;
    // the same source listed twice is one source.
    const { deps } = buildDeps([
      goodSynthesis({ id: "syn-dup", synthesis: { evidenceMemories: ["ev-alpha", "ev-alpha"] } as any }),
    ]);

    const result = await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });

    expect(result.skipped.too_few_distinct_evidence).toBe(1);
    expect(result.candidates).toHaveLength(0);
  });

  it("does not count evidence that is no longer active", async () => {
    const superseded = row({ id: "ev-gone", text: "已被推翻的旧结论", status: "superseded" });
    const { deps } = buildDeps([
      superseded,
      goodSynthesis({ id: "syn-stale", synthesis: { evidenceMemories: ["ev-alpha", "ev-gone"] } as any }),
    ]);

    const result = await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });

    // One live source left, below the floor of two.
    expect(result.skipped.too_few_distinct_evidence).toBe(1);
    expect(result.candidates).toHaveLength(0);
  });

  it("skips a conclusion below the importance floor", async () => {
    const { deps } = buildDeps([goodSynthesis({ id: "syn-weak", importance: 0.4 })]);

    const result = await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });

    expect(result.skipped.below_importance).toBe(1);
    expect(result.candidates).toHaveLength(0);
  });

  it("skips a conclusion already promoted", async () => {
    const { deps } = buildDeps([goodSynthesis({ id: "syn-done", promotedTo: "durable-syn-done" })]);

    const result = await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });

    expect(result.skipped.already_promoted).toBe(1);
    expect(result.candidates).toHaveLength(0);
  });

  it("reports the rejection breakdown even when nothing is promoted", async () => {
    // Otherwise "found nothing" and "filtered everything out" read identically.
    const { deps } = buildDeps([
      goodSynthesis({ id: "syn-legacy", synthesis: { contract: 1 } as any }),
      goodSynthesis({ id: "syn-weak", importance: 0.2 }),
    ]);

    const text = formatSynthesisPromoteResult(await scanSynthesisPromotions(deps, SCOPE));

    expect(text).toContain("2 synthesized conclusion(s) examined");
    expect(text).toContain("pre_contract=1");
    expect(text).toContain("below_importance=1");
    expect(text).toContain("No promotion candidates found");
  });
});

describe("synthesis promotion: the guarantees around it", () => {
  it("never modifies the synthesized row — evidence stays readable as evidence", async () => {
    const synthesis = goodSynthesis();
    const before = synthesis.metadata;
    const { deps } = buildDeps([synthesis]);

    await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });

    // Archive-first: the conclusion keeps its evidence boundary and its support set, so a
    // later reader can still tell what the durable copy was derived from.
    expect(synthesis.metadata).toBe(before);
    expect(JSON.parse(synthesis.metadata!).boundary.layer).toBe("evidence");
  });

  it("re-scanning promotes the same seed through the same idempotent path", async () => {
    // Duplicate suppression lives in promoteMemory -> writeDurableEntry's canonicalKey
    // dedup, so a second scan revises rather than piling up a parallel memory. What this
    // asserts is that the scan keeps routing through it instead of growing its own writer.
    const { deps, promoted } = buildDeps([goodSynthesis()]);

    await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });
    await scanSynthesisPromotions(deps, SCOPE, { dryRun: false });

    expect(promoted).toHaveLength(2);
    expect(new Set(promoted.map((p) => p.memoryId)).size).toBe(1);
  });

  it("makes the promoted copy eligible for stable memory while the source stays out", async () => {
    // This is the whole point. The synthesized row is refused by
    // shouldUseStableMemoryResult; the durable copy promoteMemory writes is not.
    const synthesis = goodSynthesis({ synthesis: { originalCategory: "preferences" } as any });

    expect(
      shouldUseStableMemoryResult({
        category: "preferences",
        scope: SCOPE,
        metadata: synthesis.metadata,
      }),
    ).toBe(false);

    const promotedMetadata = JSON.stringify({
      evolution: { status: "active", version: 1 },
      boundary: { layer: "durable", authority: "structured-memory", conflictPolicy: "latest-wins" },
      promotedFrom: { memoryId: synthesis.id, scope: SCOPE, category: "cases" },
    });

    expect(
      shouldUseStableMemoryResult({
        category: "preferences",
        scope: SCOPE,
        metadata: promotedMetadata,
      }),
    ).toBe(true);
  });
});
