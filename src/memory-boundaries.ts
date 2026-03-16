import type { DurableMemoryCategory } from "./memory-schema.js";

export const MEMORY_LAYERS = [
  "canonical",
  "durable",
  "session",
  "evidence",
] as const;

export const MEMORY_AUTHORITIES = [
  "manual-document",
  "structured-memory",
  "document-ingest",
  "transcript-ingest",
  "session-checkpoint",
] as const;

export const MEMORY_CONFLICT_POLICIES = [
  "latest-wins",
  "append-only",
  "manual-review",
] as const;

export type MemoryLayer = (typeof MEMORY_LAYERS)[number];
export type MemoryAuthority = (typeof MEMORY_AUTHORITIES)[number];
export type MemoryConflictPolicy = (typeof MEMORY_CONFLICT_POLICIES)[number];

export interface MemoryBoundaryMetadata {
  layer: MemoryLayer;
  authority: MemoryAuthority;
  conflictPolicy: MemoryConflictPolicy;
  originalCategory?: DurableMemoryCategory;
  downgradedFrom?: DurableMemoryCategory;
  note?: string;
}

export interface PromotedFromMetadata {
  memoryId: string;
  scope?: string;
  category?: string;
  source?: string;
  boundary?: MemoryBoundaryMetadata | null;
}

export interface MemoryProvenance {
  boundary: MemoryBoundaryMetadata | null;
  canonicalKey: string | null;
  promotedFrom: PromotedFromMetadata | null;
}

export interface IngestBoundaryResolution {
  category: DurableMemoryCategory;
  boundary: MemoryBoundaryMetadata;
}

const TRANSCRIPT_SOURCES = new Set(["cc", "codex", "gemini"]);
const TRANSCRIPT_SCOPE_PREFIXES = ["cc:", "codex:", "gemini:"];

export function getConflictPolicyForCategory(category: DurableMemoryCategory): MemoryConflictPolicy {
  return category === "events" || category === "cases"
    ? "append-only"
    : "latest-wins";
}

export function isTranscriptIngestSource(source: string): boolean {
  return TRANSCRIPT_SOURCES.has(source);
}

export function isTranscriptScope(scope: string): boolean {
  return TRANSCRIPT_SCOPE_PREFIXES.some((prefix) => scope.startsWith(prefix));
}

export function isDurableMemoryScope(scope: string): boolean {
  return scope.startsWith("memory:") || scope.startsWith("asset:");
}

export function buildStructuredMemoryBoundary(
  category: DurableMemoryCategory,
): MemoryBoundaryMetadata {
  return {
    layer: "durable",
    authority: "structured-memory",
    conflictPolicy: getConflictPolicyForCategory(category),
    originalCategory: category,
    note: "Structured memory writes are the durable source inside RecallNest.",
  };
}

export function normalizeCanonicalKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9\p{Script=Han}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120);
}

function collapseKeyText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim();
}

export function buildDefaultCanonicalKey(params: {
  category: DurableMemoryCategory;
  text?: string;
  title?: string;
}): string {
  const base = collapseKeyText(params.title || params.text || "");
  const normalizedBase = normalizeCanonicalKey(base);
  return normalizedBase
    ? `${params.category}:${normalizedBase}`
    : `${params.category}:memory`;
}

export function resolveIngestBoundary(params: {
  source: string;
  scope: string;
  category: DurableMemoryCategory;
}): IngestBoundaryResolution {
  const { source, scope, category } = params;

  if (isTranscriptIngestSource(source)) {
    if (category === "profile" || category === "preferences") {
      return {
        category: "events",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: category,
          downgradedFrom: category,
          note: "Transcript-derived stable facts stay as evidence until explicitly promoted.",
        },
      };
    }

    return {
      category,
      boundary: {
        layer: "evidence",
        authority: "transcript-ingest",
        conflictPolicy: getConflictPolicyForCategory(category),
        originalCategory: category,
        note: "Transcript-derived memories are evidence and should not override curated memory.",
      },
    };
  }

  if (isDurableMemoryScope(scope) || scope === "memory") {
    return {
      category,
      boundary: {
        layer: "durable",
        authority: "document-ingest",
        conflictPolicy: getConflictPolicyForCategory(category),
        originalCategory: category,
        note: "Curated memory documents can mirror durable memory, but they are not session authority.",
      },
    };
  }

  return {
    category,
    boundary: {
      layer: "evidence",
      authority: "document-ingest",
      conflictPolicy: getConflictPolicyForCategory(category),
      originalCategory: category,
      note: "Unstructured ingest stays evidence until explicitly promoted.",
    },
  };
}

export function parseMetadataObject(metadata?: string): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function coerceBoundaryMetadata(candidate: unknown): MemoryBoundaryMetadata | null {
  if (!candidate || typeof candidate !== "object") return null;

  const record = candidate as Record<string, unknown>;
  const layer = typeof record.layer === "string" ? record.layer : "";
  const authority = typeof record.authority === "string" ? record.authority : "";
  const conflictPolicy = typeof record.conflictPolicy === "string" ? record.conflictPolicy : "";

  if (
    !MEMORY_LAYERS.includes(layer as MemoryLayer) ||
    !MEMORY_AUTHORITIES.includes(authority as MemoryAuthority) ||
    !MEMORY_CONFLICT_POLICIES.includes(conflictPolicy as MemoryConflictPolicy)
  ) {
    return null;
  }

  return {
    layer: layer as MemoryLayer,
    authority: authority as MemoryAuthority,
    conflictPolicy: conflictPolicy as MemoryConflictPolicy,
    ...(typeof record.originalCategory === "string"
      ? { originalCategory: record.originalCategory as DurableMemoryCategory }
      : {}),
    ...(typeof record.downgradedFrom === "string"
      ? { downgradedFrom: record.downgradedFrom as DurableMemoryCategory }
      : {}),
    ...(typeof record.note === "string" ? { note: record.note } : {}),
  };
}

export function extractBoundaryMetadata(metadata?: string): MemoryBoundaryMetadata | null {
  const parsed = parseMetadataObject(metadata);
  return coerceBoundaryMetadata(parsed?.boundary);
}

export function extractPromotedFrom(metadata?: string): PromotedFromMetadata | null {
  const parsed = parseMetadataObject(metadata);
  const promotedFrom = parsed?.promotedFrom;
  if (!promotedFrom || typeof promotedFrom !== "object") return null;

  const candidate = promotedFrom as Record<string, unknown>;
  const memoryId = typeof candidate.memoryId === "string" ? candidate.memoryId.trim() : "";
  if (!memoryId) return null;

  return {
    memoryId,
    ...(typeof candidate.scope === "string" ? { scope: candidate.scope } : {}),
    ...(typeof candidate.category === "string" ? { category: candidate.category } : {}),
    ...(typeof candidate.source === "string" ? { source: candidate.source } : {}),
    boundary: coerceBoundaryMetadata(candidate.boundary),
  };
}

export function extractMemoryProvenance(params: {
  scope: string;
  metadata?: string;
}): MemoryProvenance {
  return {
    boundary: extractBoundaryMetadata(params.metadata),
    canonicalKey: extractCanonicalKey(params.metadata),
    promotedFrom: extractPromotedFrom(params.metadata),
  };
}

export function extractCanonicalKey(metadata?: string): string | null {
  const parsed = parseMetadataObject(metadata);
  const canonicalKey = parsed?.canonicalKey;
  return typeof canonicalKey === "string" && canonicalKey.trim().length > 0
    ? canonicalKey
    : null;
}

export function shouldUseStableMemoryResult(params: {
  category: "profile" | "preferences" | "entities";
  scope: string;
  metadata?: string;
}): boolean {
  if (isTranscriptScope(params.scope)) {
    return false;
  }

  const boundary = extractBoundaryMetadata(params.metadata);
  if (!boundary) {
    return true;
  }

  return boundary.layer !== "evidence";
}
