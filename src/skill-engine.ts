/**
 * D-1: Skill Memory — store and retrieve executable skills.
 *
 * Skills are stored as "patterns" category entries with structured metadata,
 * using the same LanceDB vector search infrastructure as regular memories.
 */

import type { Embedder } from "./embedder.js";
import type { MemoryStore, MemoryEntry } from "./store.js";
import { deterministicId } from "./store.js";
import { SkillInputSchema, type SkillInput, type StoredSkillRecord } from "./skill-schema.js";
import { defaultEvolution } from "./memory-evolution.js";
import { generateAnchor } from "./anchor-generator.js";
import { buildStructuredMemoryBoundary } from "./memory-boundaries.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StoreDeps = Pick<MemoryStore, "store" | "update" | "getById">;
type EmbedDeps = Pick<Embedder, "embedPassage">;
type SearchDeps = Pick<MemoryStore, "vectorSearch">;

const SKILL_IMPORTANCE = 0.85;
const SKILL_CATEGORY = "patterns" as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEmbeddingText(input: SkillInput): string {
  return `${input.description} ${input.triggerPattern}`;
}

function buildFullText(input: SkillInput): string {
  return [
    `Skill: ${input.name}`,
    `Description: ${input.description}`,
    `Trigger: ${input.triggerPattern}`,
    `Type: ${input.implementationType}`,
    `Implementation: ${input.implementation}`,
  ].join("\n");
}

function buildSkillMetadata(input: SkillInput, anchor: string | undefined): string {
  return JSON.stringify({
    source: input.source,
    tags: input.tags,
    capture: "skill_schema_v1",
    boundary: buildStructuredMemoryBoundary("patterns"),
    canonicalKey: `patterns:skill:${input.name.toLowerCase().replace(/\s+/g, "-")}`,
    evolution: defaultEvolution(),
    ...(anchor ? { anchor } : {}),
    skill: {
      name: input.name,
      description: input.description,
      triggerPattern: input.triggerPattern,
      implementationType: input.implementationType,
      implementation: input.implementation,
      ...(input.inputSchema ? { inputSchema: input.inputSchema } : {}),
      ...(input.verification ? { verification: input.verification } : {}),
      successCount: 0,
      failureCount: 0,
    },
  });
}

function parseSkillFromEntry(entry: MemoryEntry): StoredSkillRecord | null {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(entry.metadata || "{}");
  } catch {
    return null;
  }

  const skill = meta.skill;
  if (!skill || typeof skill !== "object") return null;

  const s = skill as Record<string, unknown>;
  if (typeof s.name !== "string" || typeof s.implementation !== "string") return null;

  return {
    name: s.name as string,
    description: (s.description as string) || "",
    triggerPattern: (s.triggerPattern as string) || "",
    implementationType: (s.implementationType as string) as StoredSkillRecord["implementationType"],
    implementation: s.implementation as string,
    inputSchema: s.inputSchema as Record<string, unknown> | undefined,
    verification: (s.verification as string) || undefined,
    scope: entry.scope,
    source: (meta.source as StoredSkillRecord["source"]) || "manual",
    tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
    id: entry.id,
    storedAt: new Date(entry.timestamp).toISOString(),
    successCount: typeof s.successCount === "number" ? s.successCount : 0,
    failureCount: typeof s.failureCount === "number" ? s.failureCount : 0,
    lastRefinedAt: typeof s.lastRefinedAt === "string" ? s.lastRefinedAt : undefined,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function persistSkill(
  store: StoreDeps,
  embedder: EmbedDeps,
  rawInput: unknown,
): Promise<StoredSkillRecord> {
  const input = SkillInputSchema.parse(rawInput);

  const embeddingText = buildEmbeddingText(input);
  const vector = await embedder.embedPassage(embeddingText);
  const fullText = buildFullText(input);
  const id = deterministicId(input.scope, input.name);
  const anchor = generateAnchor(fullText);
  const metadata = buildSkillMetadata(input, anchor);

  // Check for existing skill with same scope+name (idempotent upsert)
  const existing = await store.getById(id);

  if (existing) {
    // Update existing skill — bump version in evolution metadata
    let existingMeta: Record<string, unknown> = {};
    try {
      existingMeta = JSON.parse(existing.metadata || "{}");
    } catch { /* use fresh metadata */ }

    const existingEvolution = existingMeta.evolution as Record<string, unknown> | undefined;
    const currentVersion = typeof existingEvolution?.version === "number" ? existingEvolution.version : 1;

    const updatedMetadata = JSON.stringify({
      ...JSON.parse(metadata),
      evolution: {
        ...defaultEvolution(),
        version: currentVersion + 1,
      },
    });

    const updated = await store.update(id, {
      text: fullText,
      vector,
      metadata: updatedMetadata,
      timestamp: Date.now(),
    });

    if (!updated) {
      throw new Error(`Failed to update skill "${input.name}" (id: ${id})`);
    }

    return {
      ...input,
      id: updated.id,
      storedAt: new Date(updated.timestamp).toISOString(),
      successCount: 0,
      failureCount: 0,
    };
  }

  // Store new skill
  const stored = await store.store({
    id,
    text: fullText,
    vector,
    category: SKILL_CATEGORY,
    scope: input.scope,
    importance: SKILL_IMPORTANCE,
    metadata,
  });

  return {
    ...input,
    id: stored.id,
    storedAt: new Date(stored.timestamp).toISOString(),
    successCount: 0,
    failureCount: 0,
  };
}

type OutcomeDeps = Pick<MemoryStore, "getById" | "update">;

export type SkillOutcomeUpdate =
  | { updated: true; successCount: number; failureCount: number; lastRefinedAt: string }
  | { updated: false; reason: "skill_not_found" | "not_a_skill" | "metadata_parse_error" | "skill_metadata_missing" | "store_update_failed" };

/**
 * Record a skill usage outcome by incrementing successCount/failureCount on the skill's metadata.
 *
 * Mapping: `success` → successCount +1; everything else (`failure`/`corrected`/`missed`) → failureCount +1.
 * Returns `{ updated: false, reason }` for missing/corrupt skills without throwing — callers can log and continue.
 */
export async function recordSkillOutcome(
  store: OutcomeDeps,
  skillId: string,
  outcome: "success" | "failure" | "corrected" | "missed",
): Promise<SkillOutcomeUpdate> {
  const entry = await store.getById(skillId);
  if (!entry) {
    return { updated: false, reason: "skill_not_found" };
  }

  if (entry.category !== SKILL_CATEGORY) {
    return { updated: false, reason: "not_a_skill" };
  }

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(entry.metadata || "{}");
  } catch {
    return { updated: false, reason: "metadata_parse_error" };
  }

  const skill = meta.skill;
  if (!skill || typeof skill !== "object") {
    return { updated: false, reason: "skill_metadata_missing" };
  }

  const s = skill as Record<string, unknown>;
  const currentSuccess = typeof s.successCount === "number" ? s.successCount : 0;
  const currentFailure = typeof s.failureCount === "number" ? s.failureCount : 0;

  const nextSuccessCount = outcome === "success" ? currentSuccess + 1 : currentSuccess;
  const nextFailureCount = outcome === "success" ? currentFailure : currentFailure + 1;
  const nextLastRefinedAt = new Date().toISOString();

  const nextSkill = {
    ...s,
    successCount: nextSuccessCount,
    failureCount: nextFailureCount,
    lastRefinedAt: nextLastRefinedAt,
  };

  const updatedMetadata = JSON.stringify({
    ...meta,
    skill: nextSkill,
  });

  const updated = await store.update(skillId, {
    metadata: updatedMetadata,
  });

  if (!updated) {
    return { updated: false, reason: "store_update_failed" };
  }

  return {
    updated: true,
    successCount: nextSuccessCount,
    failureCount: nextFailureCount,
    lastRefinedAt: nextLastRefinedAt,
  };
}

export async function retrieveSkills(
  store: SearchDeps,
  embedder: EmbedDeps,
  query: string,
  scope?: string,
  limit?: number,
): Promise<Array<{ skill: StoredSkillRecord; score: number }>> {
  const vector = await embedder.embedPassage(query);
  const safeLimit = Math.min(Math.max(limit ?? 3, 1), 10);

  // Over-fetch to account for filtering
  const fetchLimit = safeLimit * 3;
  const scopeFilter = scope ? [scope] : undefined;
  const results = await store.vectorSearch(vector, fetchLimit, 0.3, scopeFilter);

  const matched: Array<{ skill: StoredSkillRecord; score: number }> = [];

  for (const result of results) {
    if (result.entry.category !== SKILL_CATEGORY) continue;

    const skill = parseSkillFromEntry(result.entry);
    if (!skill) continue;

    matched.push({ skill, score: result.score });
    if (matched.length >= safeLimit) break;
  }

  return matched;
}
