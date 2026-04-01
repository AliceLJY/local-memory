import type { Embedder } from "./embedder.js";
import { generateAnchor } from "./anchor-generator.js";
import { defaultEvolution, buildSupersedeMetadata, isActiveMemory } from "./memory-evolution.js";
import {
  type CaseMemoryInput,
  CaseMemoryInputSchema,
  type CaptureMemoryInput,
  CaptureMemoryInputSchema,
  type PromoteMemoryInput,
  PromoteMemoryInputSchema,
  type StoredCaseMemoryRecord,
  type StoredPromotedMemoryRecord,
  type StoredWorkflowPatternRecord,
  type StoredMemoryRecord,
  type StoreMemoryInput,
  StoreMemoryInputSchema,
  type WorkflowPatternInput,
  WorkflowPatternInputSchema,
  type DurableMemoryCategory,
  DURABLE_MEMORY_CATEGORIES,
  type WriteDisposition,
} from "./memory-schema.js";
import { deterministicId, type MemoryEntry, type MemoryStore } from "./store.js";
import {
  buildDefaultCanonicalKey,
  buildStructuredMemoryBoundary,
  extractBoundaryMetadata,
  extractCanonicalKey,
  extractPromotedFrom,
  extractProvenanceHistory,
  getConflictPolicyForCategory,
  isDurableMemoryScope,
  isTranscriptScope,
  normalizeCanonicalKey,
  parseMetadataObject,
} from "./memory-boundaries.js";
import { buildConflictCandidateRecord, buildConflictFingerprint, reopenConflictCandidate } from "./conflict-engine.js";
import type { ConflictCandidateStore } from "./conflict-store.js";
import {
  inferPreferenceSlot,
  samePreferenceSlot,
  type AtomicBrandItemPreferenceSlot,
  type PreferenceSlot,
  type ReplyStylePreferenceSlot,
  type ToolChoicePreferenceSlot,
} from "./preference-slots.js";
import { matchPreference, applyPreferenceMatch } from "./preference-matcher.js";
import type { LLMClient } from "./llm-client.js";
import type { KGExtractor } from "./kg-extractor.js";

type StoreDeps = Pick<MemoryStore, "store"> & Partial<Pick<MemoryStore, "list" | "update" | "getById" | "get" | "vectorSearch">>;
type ConflictStoreDeps = Pick<ConflictCandidateStore, "save" | "replace" | "getOpenByFingerprint" | "getLatestByFingerprint">;

interface PersistMemoryDeps {
  store: StoreDeps;
  embedder: Pick<Embedder, "embedPassage">;
  conflictStore?: ConflictStoreDeps;
  /** Tier 3.6: Optional LLM for preference matching */
  llm?: LLMClient | null;
  /** Tier 4.1: Optional KG triple extractor (async, non-blocking) */
  kgExtractor?: KGExtractor | null;
}

interface DurableWriteInput {
  text: string;
  vector: number[];
  category: DurableMemoryCategory;
  scope: string;
  importance: number;
  metadata: string;
  canonicalKey: string;
  promotedFrom?: string;
  source: "manual" | "agent" | "api";
  sourceCategory?: string;
  sourceBoundary?: ReturnType<typeof extractBoundaryMetadata>;
}

const CANONICAL_SCAN_LIMIT = 1000;
const PROVENANCE_HISTORY_LIMIT = 20;
const DURABLE_CATEGORY_SET = new Set<string>(DURABLE_MEMORY_CATEGORIES);

function resolveScope(input: { scope?: string; source: string }): string {
  if (!input.scope) {
    throw new Error("scope is required for durable memory writes");
  }
  return input.scope;
}

function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveCanonicalKey(params: {
  category: DurableMemoryCategory;
  text?: string;
  title?: string;
  canonicalKey?: string;
}): string {
  const explicit = params.canonicalKey ? normalizeCanonicalKey(params.canonicalKey) : "";
  if (explicit) return explicit;
  return buildDefaultCanonicalKey({
    category: params.category,
    text: params.text,
    title: params.title,
  });
}

function mergeTags(...groups: string[][]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group) {
      const normalized = item.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(item.trim());
    }
  }
  return merged.slice(0, 8);
}

function buildStructuredMetadata(params: {
  source: string;
  tags: string[];
  capture: string;
  category: DurableMemoryCategory;
  canonicalKey: string;
  extra?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    source: params.source,
    tags: params.tags,
    capture: params.capture,
    boundary: buildStructuredMemoryBoundary(params.category),
    canonicalKey: params.canonicalKey,
    evolution: defaultEvolution(),
    ...params.extra,
  });
}

function buildPreferenceSlotExtra(
  category: DurableMemoryCategory,
  text: string,
): Record<string, unknown> | undefined {
  if (category !== "preferences") return undefined;
  const slot = inferPreferenceSlot(text);
  return slot ? { preferenceSlot: slot } : undefined;
}

function mergeExtra(...extras: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  const merged = Object.assign({}, ...extras.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function extractPreferenceSlot(metadata?: string): PreferenceSlot | null {
  const parsed = parseMetadataObject(metadata);
  const slot = parsed?.preferenceSlot;
  if (!slot || typeof slot !== "object") return null;

  const record = slot as Record<string, unknown>;
  if (
    record.type === "brand-item" &&
    typeof record.brand === "string" &&
    typeof record.item === "string"
  ) {
    return {
      type: "brand-item",
      brand: record.brand,
      item: record.item,
    };
  }

  if (
    record.type === "reply-style" &&
    Array.isArray(record.traits)
  ) {
    const traits = record.traits
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (traits.length === 0) return null;
    return {
      type: "reply-style",
      traits: Array.from(new Set(traits)).sort(),
    } satisfies ReplyStylePreferenceSlot;
  }

  if (
    record.type === "tool-choice" &&
    typeof record.preferredTool === "string" &&
    typeof record.avoidedTool === "string"
  ) {
    const preferredTool = record.preferredTool.trim().toLowerCase();
    const avoidedTool = record.avoidedTool.trim().toLowerCase();
    if (!preferredTool || !avoidedTool || preferredTool === avoidedTool) return null;
    return {
      type: "tool-choice",
      preferredTool,
      avoidedTool,
    } satisfies ToolChoicePreferenceSlot;
  }

  return null;
}

function parsePreferenceSlotFromCanonicalKey(canonicalKey?: string | null): PreferenceSlot | null {
  if (!canonicalKey || !canonicalKey.startsWith("preferences:")) return null;

  if (canonicalKey.startsWith("preferences:brand-item:")) {
    const [, , brand, ...rest] = canonicalKey.split(":");
    const item = rest.join(":");
    if (!brand || !item) return null;
    return {
      type: "brand-item",
      brand,
      item,
    } satisfies AtomicBrandItemPreferenceSlot;
  }

  if (canonicalKey.startsWith("preferences:reply-style:")) {
    const [, , ...traits] = canonicalKey.split(":");
    const normalizedTraits = traits
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (normalizedTraits.length === 0) return null;
    return {
      type: "reply-style",
      traits: Array.from(new Set(normalizedTraits)).sort(),
    } satisfies ReplyStylePreferenceSlot;
  }

  if (canonicalKey.startsWith("preferences:tool-choice:")) {
    const [, , preferredTool, marker, ...rest] = canonicalKey.split(":");
    const avoidedTool = rest.join(":").trim().toLowerCase();
    if (marker !== "over" || !preferredTool || !avoidedTool) return null;
    return {
      type: "tool-choice",
      preferredTool: preferredTool.trim().toLowerCase(),
      avoidedTool,
    } satisfies ToolChoicePreferenceSlot;
  }

  return null;
}

function shouldAutoCollapsePromotionConflict(
  params: DurableWriteInput,
  existing: MemoryEntry,
): boolean {
  if (!params.promotedFrom || params.category !== "preferences") {
    return false;
  }

  const incomingSlot =
    extractPreferenceSlot(params.metadata) ||
    inferPreferenceSlot(params.text) ||
    parsePreferenceSlotFromCanonicalKey(params.canonicalKey);

  const existingSlot =
    extractPreferenceSlot(existing.metadata) ||
    inferPreferenceSlot(existing.text) ||
    parsePreferenceSlotFromCanonicalKey(extractCanonicalKey(existing.metadata));

  return samePreferenceSlot(existingSlot, incomingSlot);
}

function mergePromotionObservationMetadata(
  existingMetadata: string | undefined,
  incomingMetadata: string,
  observedAt: string,
): {
  metadata: string;
  changed: boolean;
} {
  const parsed = parseMetadataObject(existingMetadata) ?? {};
  const incomingObservation = extractPromotedFrom(incomingMetadata);
  if (!incomingObservation) {
    return {
      metadata: existingMetadata || JSON.stringify(parsed),
      changed: false,
    };
  }

  const mergedHistory = [...extractProvenanceHistory(existingMetadata)];
  const existingIndex = mergedHistory.findIndex((item) => item.memoryId === incomingObservation.memoryId);

  if (existingIndex >= 0) {
    const current = mergedHistory[existingIndex];
    mergedHistory[existingIndex] = {
      ...incomingObservation,
      ...current,
      observedAt: current?.observedAt || observedAt,
    };
  } else {
    mergedHistory.push({
      ...incomingObservation,
      observedAt,
    });
  }

  const nextMetadata = JSON.stringify({
    ...parsed,
    provenanceHistory: mergedHistory.slice(-PROVENANCE_HISTORY_LIMIT),
    provenanceHistoryCount: mergedHistory.length,
  });

  return {
    metadata: nextMetadata,
    changed: nextMetadata !== (existingMetadata || "{}"),
  };
}

async function appendPromotionObservationToExistingEntry(
  store: StoreDeps,
  existing: MemoryEntry,
  incomingMetadata: string,
): Promise<MemoryEntry> {
  if (!store.update) return existing;

  const timestamp = Date.now();
  const observedAt = new Date(timestamp).toISOString();
  const merged = mergePromotionObservationMetadata(existing.metadata, incomingMetadata, observedAt);
  if (!merged.changed) {
    return existing;
  }

  const updated = await store.update(existing.id, {
    metadata: merged.metadata,
    timestamp,
  });
  if (!updated) {
    throw new Error(`Failed to append promotion provenance to durable memory ${existing.id}`);
  }
  return updated;
}

function buildWorkflowPatternText(input: WorkflowPatternInput): string {
  const lines = [
    `Workflow pattern: ${input.title}`,
    `Use when: ${input.trigger}`,
    "Steps:",
    ...input.steps.map((step, index) => `${index + 1}. ${step}`),
  ];
  if (input.tools.length > 0) {
    lines.push(`Tools: ${input.tools.join(", ")}`);
  }
  if (input.outcome) {
    lines.push(`Outcome: ${input.outcome}`);
  }
  return lines.join("\n");
}

function buildCaseMemoryText(input: CaseMemoryInput): string {
  const lines = [
    `Case: ${input.title}`,
    `Problem: ${input.problem}`,
  ];
  if (input.context) {
    lines.push(`Context: ${input.context}`);
  }
  lines.push("Solution:");
  lines.push(...input.solutionSteps.map((step, index) => `${index + 1}. ${step}`));
  if (input.tools.length > 0) {
    lines.push(`Tools: ${input.tools.join(", ")}`);
  }
  if (input.outcome) {
    lines.push(`Outcome: ${input.outcome}`);
  }
  return lines.join("\n");
}

function toStoredRecord(
  input: StoreMemoryInput,
  entry: { id: string; timestamp: number; scope: string },
  disposition: WriteDisposition,
  canonicalKey: string,
  conflictId?: string,
): StoredMemoryRecord {
  return {
    ...input,
    canonicalKey,
    resolvedScope: entry.scope,
    id: entry.id,
    storedAt: new Date(entry.timestamp).toISOString(),
    disposition,
    ...(conflictId ? { conflictId } : {}),
  };
}

function ensureDurableCategory(value: string): DurableMemoryCategory {
  if (!DURABLE_CATEGORY_SET.has(value)) {
    return "events";
  }
  return value as DurableMemoryCategory;
}

async function findCanonicalMatches(
  store: StoreDeps,
  canonicalKey: string,
): Promise<MemoryEntry[]> {
  if (!store.list) return [];
  const entries = await store.list(undefined, undefined, CANONICAL_SCAN_LIMIT, 0);
  return entries.filter((entry) => {
    const boundary = extractBoundaryMetadata(entry.metadata);
    if (boundary?.layer !== "durable") return false;
    return extractCanonicalKey(entry.metadata) === canonicalKey;
  });
}

async function writeDurableEntry(
  deps: PersistMemoryDeps,
  params: DurableWriteInput,
): Promise<{
  entry: MemoryEntry;
  disposition: "stored" | "updated" | "deduped" | "promoted" | "conflict";
  conflictId?: string;
}> {
  const matches = await findCanonicalMatches(deps.store, params.canonicalKey);
  const categoryMatches = matches.filter((entry) => entry.category === params.category);
  const crossCategoryMatches = matches.filter((entry) => entry.category !== params.category);
  const normalizedIncoming = normalizeMemoryText(params.text);
  const exact = categoryMatches.find((entry) => normalizeMemoryText(entry.text) === normalizedIncoming);

  if (crossCategoryMatches.length > 0 && deps.conflictStore) {
    const latest = [...crossCategoryMatches].sort((a, b) => b.timestamp - a.timestamp)[0];
    const fingerprint = buildConflictFingerprint({
      canonicalKey: params.canonicalKey,
      existingMemoryId: latest.id,
      incomingText: params.text,
      sourceMemoryId: params.promotedFrom,
    });
    const conflict = await ensureConflictCandidate(deps.conflictStore, {
      canonicalKey: params.canonicalKey,
      category: params.category,
      fingerprint,
      reason: "canonical_key_conflicts_with_existing_durable",
      existing: {
        memoryId: latest.id,
        text: latest.text,
        category: latest.category,
        scope: latest.scope,
        importance: latest.importance,
        metadata: latest.metadata || "{}",
        boundary: extractBoundaryMetadata(latest.metadata),
        canonicalKey: extractCanonicalKey(latest.metadata) || params.canonicalKey,
      },
      incoming: {
        text: params.text,
        category: params.category,
        scope: params.scope,
        importance: params.importance,
        metadata: params.metadata,
        source: params.source,
        ...(params.promotedFrom ? { sourceMemoryId: params.promotedFrom } : {}),
        ...(params.sourceCategory ? { sourceCategory: params.sourceCategory } : {}),
        ...(params.sourceBoundary ? { sourceBoundary: params.sourceBoundary } : {}),
      },
    });

    return {
      entry: latest,
      disposition: "conflict",
      conflictId: conflict.conflictId,
    };
  }

  if (exact) {
    const entry = params.promotedFrom
      ? await appendPromotionObservationToExistingEntry(deps.store, exact, params.metadata)
      : exact;
    return {
      entry,
      disposition: params.promotedFrom ? "promoted" : "deduped",
    };
  }

  const conflictPolicy = getConflictPolicyForCategory(params.category);
  if (conflictPolicy === "latest-wins" && categoryMatches.length > 0 && deps.store.update) {
    const latest = [...categoryMatches].sort((a, b) => b.timestamp - a.timestamp)[0];
    if (params.promotedFrom) {
      if (shouldAutoCollapsePromotionConflict(params, latest)) {
        const entry = await appendPromotionObservationToExistingEntry(deps.store, latest, params.metadata);
        return {
          entry,
          disposition: "promoted",
        };
      }

      if (deps.conflictStore) {
        const fingerprint = buildConflictFingerprint({
          canonicalKey: params.canonicalKey,
          existingMemoryId: latest.id,
          incomingText: params.text,
          sourceMemoryId: params.promotedFrom,
        });
        const conflict = await ensureConflictCandidate(deps.conflictStore, {
          canonicalKey: params.canonicalKey,
          category: params.category,
          fingerprint,
          reason: "promotion_conflicts_with_existing_durable",
          existing: {
            memoryId: latest.id,
            text: latest.text,
            category: latest.category,
            scope: latest.scope,
            importance: latest.importance,
            metadata: latest.metadata || "{}",
            boundary: extractBoundaryMetadata(latest.metadata),
            canonicalKey: extractCanonicalKey(latest.metadata) || params.canonicalKey,
          },
          incoming: {
            text: params.text,
            category: params.category,
            scope: params.scope,
            importance: params.importance,
            metadata: params.metadata,
            source: params.source,
            sourceMemoryId: params.promotedFrom,
            sourceCategory: params.sourceCategory,
            sourceBoundary: params.sourceBoundary,
          },
        });

        return {
          entry: latest,
          disposition: "conflict",
          conflictId: conflict.conflictId,
        };
      }
    }

    const updated = await deps.store.update(latest.id, {
      text: params.text,
      vector: params.vector,
      importance: params.importance,
      category: params.category,
      metadata: params.metadata,
      timestamp: Date.now(),
    });
    if (!updated) {
      throw new Error(`Failed to update canonical memory ${latest.id}`);
    }
    return {
      entry: updated,
      disposition: params.promotedFrom ? "promoted" : "updated",
    };
  }

  const stored = await deps.store.store({
    id: params.canonicalKey
      ? deterministicId(params.scope, params.canonicalKey)
      : undefined,
    text: params.text,
    vector: params.vector,
    category: params.category,
    scope: params.scope,
    importance: params.importance,
    metadata: params.metadata,
  });

  return {
    entry: stored,
    disposition: params.promotedFrom ? "promoted" : "stored",
  };
}

async function ensureConflictCandidate(
  conflictStore: ConflictStoreDeps,
  input: Parameters<typeof buildConflictCandidateRecord>[0],
) {
  const parsed = buildConflictCandidateRecord(input);
  const open = await conflictStore.getOpenByFingerprint(parsed.fingerprint);
  if (open) {
    return open;
  }

  const latest = await conflictStore.getLatestByFingerprint(parsed.fingerprint);
  if (latest) {
    return conflictStore.replace(reopenConflictCandidate({
      ...latest,
      category: parsed.category,
      reason: parsed.reason,
      existing: parsed.existing,
      incoming: parsed.incoming,
      updatedAt: parsed.updatedAt,
    }));
  }

  return conflictStore.save(parsed);
}

function inferPromotedCategory(
  input: PromoteMemoryInput,
  sourceEntry: MemoryEntry,
): DurableMemoryCategory {
  if (input.category) return input.category;

  const boundary = extractBoundaryMetadata(sourceEntry.metadata);
  if (boundary?.originalCategory) return boundary.originalCategory;

  return ensureDurableCategory(sourceEntry.category);
}

function buildStoreMemoryMetadata(input: StoreMemoryInput, canonicalKey: string): string {
  const anchor = generateAnchor(input.text);
  const anchorExtra = anchor ? { anchor } : undefined;
  return buildStructuredMetadata({
    source: input.source,
    tags: input.tags,
    capture: "store_memory_schema_v1",
    category: input.category,
    canonicalKey,
    extra: mergeExtra(buildPreferenceSlotExtra(input.category, input.text), anchorExtra),
  });
}

function buildWorkflowPatternMetadata(
  input: WorkflowPatternInput,
  tags: string[],
  canonicalKey: string,
): string {
  const wpExtra: Record<string, unknown> = {
    workflowPattern: {
      title: input.title,
      trigger: input.trigger,
      steps: input.steps,
      outcome: input.outcome,
      tools: input.tools,
    },
  };
  const anchor = generateAnchor(input.title + ": " + input.trigger, wpExtra);
  if (anchor) wpExtra.anchor = anchor;
  return buildStructuredMetadata({
    source: input.source,
    tags,
    capture: "workflow_pattern_schema_v1",
    category: "patterns",
    canonicalKey,
    extra: wpExtra,
  });
}

function buildCaseMemoryMetadata(
  input: CaseMemoryInput,
  tags: string[],
  canonicalKey: string,
): string {
  const cmExtra: Record<string, unknown> = {
    caseMemory: {
      title: input.title,
      problem: input.problem,
      context: input.context,
      solutionSteps: input.solutionSteps,
      outcome: input.outcome,
      tools: input.tools,
    },
  };
  const anchor = generateAnchor(input.title + ": " + input.problem, cmExtra);
  if (anchor) cmExtra.anchor = anchor;
  return buildStructuredMetadata({
    source: input.source,
    tags,
    capture: "case_memory_schema_v1",
    category: "cases",
    canonicalKey,
    extra: cmExtra,
  });
}

function buildPromotionMetadata(
  input: PromoteMemoryInput,
  canonicalKey: string,
  category: DurableMemoryCategory,
  sourceEntry: MemoryEntry,
  text: string,
): string {
  const sourceMetadata = parseMetadataObject(sourceEntry.metadata);
  return buildStructuredMetadata({
    source: input.source,
    tags: input.tags,
    capture: "promote_memory_schema_v1",
    category,
    canonicalKey,
    extra: mergeExtra(
      buildPreferenceSlotExtra(category, text),
      {
        promotedFrom: {
          memoryId: sourceEntry.id,
          scope: sourceEntry.scope,
          category: sourceEntry.category,
          boundary: extractBoundaryMetadata(sourceEntry.metadata),
          source: sourceMetadata?.source,
        },
      },
    ),
  });
}

export async function persistMemory(
  deps: PersistMemoryDeps,
  rawInput: unknown,
): Promise<StoredMemoryRecord> {
  const input = StoreMemoryInputSchema.parse(rawInput);
  const vector = await deps.embedder.embedPassage(input.text);
  const resolvedScope = resolveScope(input);
  const canonicalKey = resolveCanonicalKey({
    category: input.category,
    text: input.text,
    canonicalKey: input.canonicalKey,
  });

  // Tier 3.6: For preferences, check if similar preference already exists.
  // If matched, merge into existing or skip — avoids duplicate accumulation.
  if (
    input.category === "preferences" &&
    deps.store.vectorSearch
  ) {
    const matchResult = await matchPreference(
      input.text,
      vector,
      resolvedScope,
      deps.store as MemoryStore,
      deps.llm ?? null,
    );
    if (matchResult.action !== "create") {
      const applied = await applyPreferenceMatch(
        matchResult,
        deps.store as MemoryStore,
        resolvedScope,
      );
      if (applied.handled) {
        const entry = applied.entry ?? {
          id: "skipped",
          text: input.text,
          vector,
          category: input.category,
          scope: resolvedScope,
          importance: input.importance,
          timestamp: Date.now(),
          metadata: "{}",
        };
        return toStoredRecord(
          input,
          entry,
          matchResult.action === "merge" ? "updated" : "deduped",
          canonicalKey,
        );
      }
    }
  }

  // A-2: Evolution-aware semantic conflict detection.
  // For non-preferences categories, check if a semantically similar memory
  // already exists in the same scope. If so, use LLM to decide whether the
  // old memory should be superseded.
  // Requires both vectorSearch (for candidate lookup) and LLM (for judgment).
  // Graceful fallback: if either is unavailable, skip detection entirely.
  if (
    input.category !== "preferences" &&
    deps.store.vectorSearch &&
    deps.llm &&
    deps.store.update
  ) {
    try {
      const candidates = await deps.store.vectorSearch(vector, 3, 0.85, [resolvedScope]);
      // Only consider same-category, active memories as supersede targets
      const supersedeTargets = candidates.filter(
        c => c.entry.category === input.category &&
             c.entry.id !== deterministicId(resolvedScope, input.text) &&
             isActiveMemory(c.entry.metadata),
      );
      if (supersedeTargets.length > 0) {
        const decision = await deps.llm.dedupDecision(input.text, supersedeTargets[0].entry.text);
        if (decision.action === "MERGE" || decision.action === "SKIP") {
          // LLM says new info overlaps with existing → supersede the old one
          // (MERGE = new has extra info → store new, mark old superseded)
          // (SKIP  = identical → just dedup, handled by writeDurableEntry)
          if (decision.action === "MERGE") {
            const oldEntry = supersedeTargets[0].entry;
            const supersededMeta = buildSupersedeMetadata(oldEntry.metadata, deterministicId(resolvedScope, input.text));
            await deps.store.update(oldEntry.id, { metadata: supersededMeta });
          }
        }
        // CREATE or error → proceed normally (store new memory as-is)
      }
    } catch {
      // Evolution conflict detection must never block memory writes
    }
  }

  const { entry, disposition, conflictId } = await writeDurableEntry(deps, {
    text: input.text,
    vector,
    category: input.category,
    scope: resolvedScope,
    importance: input.importance,
    metadata: buildStoreMemoryMetadata(input, canonicalKey),
    canonicalKey,
    source: input.source,
  });

  // Tier 4.1: Async KG triple extraction (non-blocking)
  if (deps.kgExtractor && disposition !== "deduped") {
    deps.kgExtractor
      .extractAndStore(input.text, entry.id, resolvedScope)
      .catch(() => {}); // Silently ignore — KG extraction must never block memory writes
  }

  return toStoredRecord(input, entry, disposition, canonicalKey, conflictId);
}

export async function persistWorkflowPattern(
  deps: PersistMemoryDeps,
  rawInput: unknown,
): Promise<StoredWorkflowPatternRecord> {
  const input = WorkflowPatternInputSchema.parse(rawInput);
  const resolvedScope = resolveScope(input);
  const tags = mergeTags(input.tags, ["workflow", "pattern"]);
  const text = buildWorkflowPatternText(input);
  const vector = await deps.embedder.embedPassage(text);
  const canonicalKey = resolveCanonicalKey({
    category: "patterns",
    title: input.title,
    text,
    canonicalKey: input.canonicalKey,
  });
  const { entry, disposition, conflictId } = await writeDurableEntry(deps, {
    text,
    vector,
    category: "patterns",
    scope: resolvedScope,
    importance: input.importance,
    metadata: buildWorkflowPatternMetadata(input, tags, canonicalKey),
    canonicalKey,
    source: input.source,
  });

  return {
    ...input,
    tags,
    canonicalKey,
    category: "patterns",
    text,
    resolvedScope: entry.scope,
    id: entry.id,
    storedAt: new Date(entry.timestamp).toISOString(),
    disposition,
    ...(conflictId ? { conflictId } : {}),
  };
}

export async function persistCaseMemory(
  deps: PersistMemoryDeps,
  rawInput: unknown,
): Promise<StoredCaseMemoryRecord> {
  const input = CaseMemoryInputSchema.parse(rawInput);
  const resolvedScope = resolveScope(input);
  const tags = mergeTags(input.tags, ["case", "solution"]);
  const text = buildCaseMemoryText(input);
  const vector = await deps.embedder.embedPassage(text);
  const canonicalKey = resolveCanonicalKey({
    category: "cases",
    title: input.title,
    text,
    canonicalKey: input.canonicalKey,
  });
  const { entry, disposition, conflictId } = await writeDurableEntry(deps, {
    text,
    vector,
    category: "cases",
    scope: resolvedScope,
    importance: input.importance,
    metadata: buildCaseMemoryMetadata(input, tags, canonicalKey),
    canonicalKey,
    source: input.source,
  });

  return {
    ...input,
    tags,
    canonicalKey,
    category: "cases",
    text,
    resolvedScope: entry.scope,
    id: entry.id,
    storedAt: new Date(entry.timestamp).toISOString(),
    disposition,
    ...(conflictId ? { conflictId } : {}),
  };
}

export async function promoteMemory(
  deps: PersistMemoryDeps,
  rawInput: unknown,
): Promise<StoredPromotedMemoryRecord> {
  const input = PromoteMemoryInputSchema.parse(rawInput);
  const sourceEntry = deps.store.get
    ? await deps.store.get(input.memoryId)
    : deps.store.getById
      ? await deps.store.getById(input.memoryId)
      : null;

  if (!sourceEntry) {
    throw new Error(`Memory ${input.memoryId} not found`);
  }

  const boundary = extractBoundaryMetadata(sourceEntry.metadata);
  const looksDurableWithoutBoundary = !boundary && isDurableMemoryScope(sourceEntry.scope);
  if ((boundary?.layer && boundary.layer !== "evidence") || (looksDurableWithoutBoundary && !isTranscriptScope(sourceEntry.scope))) {
    const currentLayer = boundary?.layer || "durable";
    throw new Error(`Memory ${input.memoryId} is already ${currentLayer}; promote_memory is only for evidence entries.`);
  }

  const category = inferPromotedCategory(input, sourceEntry);
  const text = input.text || sourceEntry.text;
  const canonicalKey = resolveCanonicalKey({
    category,
    text,
    canonicalKey: input.canonicalKey,
  });
  const vector = await deps.embedder.embedPassage(text);
  const resolvedScope = resolveScope(input);
  const { entry, disposition, conflictId } = await writeDurableEntry(deps, {
    text,
    vector,
    category,
    scope: resolvedScope,
    importance: input.importance,
    metadata: buildPromotionMetadata(input, canonicalKey, category, sourceEntry, text),
    canonicalKey,
    promotedFrom: sourceEntry.id,
    source: input.source,
    sourceCategory: sourceEntry.category,
    sourceBoundary: boundary,
  });

  return {
    text,
    category,
    importance: input.importance,
    scope: input.scope,
    source: input.source,
    tags: input.tags,
    canonicalKey,
    resolvedScope: entry.scope,
    id: entry.id,
    storedAt: new Date(entry.timestamp).toISOString(),
    disposition,
    sourceMemoryId: sourceEntry.id,
    sourceCategory: sourceEntry.category,
    ...(conflictId ? { conflictId } : {}),
  };
}

export async function persistMemoryBatch(
  deps: PersistMemoryDeps,
  rawInput: unknown,
): Promise<StoredMemoryRecord[]> {
  const input = CaptureMemoryInputSchema.parse(rawInput);
  const normalizedItems = input.memories.map((memory) =>
    StoreMemoryInputSchema.parse({
      text: memory.text,
      category: memory.category,
      importance: memory.importance ?? input.defaultImportance,
      scope: memory.scope ?? input.scope,
      source: memory.source ?? input.source,
      tags: memory.tags ?? [],
      canonicalKey: memory.canonicalKey,
    }),
  );

  const persisted: StoredMemoryRecord[] = [];
  for (const memory of normalizedItems) {
    persisted.push(await persistMemory(deps, memory));
  }
  return persisted;
}

export function normalizeCaptureInput(rawInput: unknown): CaptureMemoryInput {
  return CaptureMemoryInputSchema.parse(rawInput);
}
