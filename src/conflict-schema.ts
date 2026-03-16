import { z } from "zod";

import { MemoryCategorySchema, MemoryImportanceSchema, MemoryScopeSchema, MemoryTextSchema, StoreMemorySourceSchema, DurableMemoryCategorySchema, CanonicalKeySchema } from "./memory-schema.js";
import { MEMORY_AUTHORITIES, MEMORY_CONFLICT_POLICIES, MEMORY_LAYERS } from "./memory-boundaries.js";
import { identifierSchema, optionalBoundedStringSchema } from "./schema-utils.js";

const BoundaryMetadataSchema = z.object({
  layer: z.enum(MEMORY_LAYERS),
  authority: z.enum(MEMORY_AUTHORITIES),
  conflictPolicy: z.enum(MEMORY_CONFLICT_POLICIES),
  originalCategory: DurableMemoryCategorySchema.optional(),
  downgradedFrom: DurableMemoryCategorySchema.optional(),
  note: optionalBoundedStringSchema(240),
});

export const ConflictReasonSchema = z.enum([
  "promotion_conflicts_with_existing_durable",
  "canonical_key_conflicts_with_existing_durable",
]);

export const ConflictStatusSchema = z.enum([
  "open",
  "accepted-incoming",
  "kept-existing",
  "merged",
]);

export const ConflictExistingMemorySchema = z.object({
  memoryId: identifierSchema("memoryId", 128),
  text: MemoryTextSchema,
  category: MemoryCategorySchema,
  scope: identifierSchema("scope", 160),
  importance: MemoryImportanceSchema,
  metadata: z.string().min(1).max(8000),
  boundary: BoundaryMetadataSchema.nullable().optional(),
  canonicalKey: CanonicalKeySchema,
});

export const ConflictIncomingMemorySchema = z.object({
  text: MemoryTextSchema,
  category: DurableMemoryCategorySchema,
  scope: identifierSchema("scope", 160),
  importance: MemoryImportanceSchema,
  metadata: z.string().min(1).max(8000),
  source: StoreMemorySourceSchema,
  sourceMemoryId: identifierSchema("sourceMemoryId", 128).optional(),
  sourceCategory: MemoryCategorySchema.optional(),
  sourceBoundary: BoundaryMetadataSchema.nullable().optional(),
});

export const ConflictCandidateInputSchema = z.object({
  canonicalKey: z.string().min(1).max(120),
  category: DurableMemoryCategorySchema,
  fingerprint: z.string().min(1).max(240),
  reason: ConflictReasonSchema,
  existing: ConflictExistingMemorySchema,
  incoming: ConflictIncomingMemorySchema,
  createdAt: z.string().datetime().default(() => new Date().toISOString()),
  updatedAt: z.string().datetime().default(() => new Date().toISOString()),
});

export const ConflictCandidateRecordSchema = ConflictCandidateInputSchema.extend({
  conflictId: identifierSchema("conflictId", 128),
  status: ConflictStatusSchema.default("open"),
  reopenCount: z.number().int().min(0).default(0),
  escalationCount: z.number().int().min(0).default(0),
  lastReopenedAt: z.string().datetime().optional(),
  lastEscalatedAt: z.string().datetime().optional(),
  lastEscalationAttention: z.enum(["stale", "escalated"]).optional(),
  resolvedAt: z.string().datetime().optional(),
  resolutionNotes: optionalBoundedStringSchema(320),
});

export const ResolveConflictInputSchema = z.object({
  conflictId: identifierSchema("conflictId", 128),
  resolution: z.enum(["accept_incoming", "keep_existing", "merge"]),
  mergedText: MemoryTextSchema.optional(),
  notes: optionalBoundedStringSchema(320),
});

export const ConflictResolutionResultSchema = z.object({
  conflictId: identifierSchema("conflictId", 128),
  status: ConflictStatusSchema,
  updatedAt: z.string().datetime(),
  resolvedAt: z.string().datetime(),
  updatedMemoryId: identifierSchema("updatedMemoryId", 128).optional(),
});

export const EscalateConflictsInputSchema = z.object({
  attention: z.enum(["stale", "escalated"]).optional(),
  canonicalKey: CanonicalKeySchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
  top: z.number().int().min(1).max(20).default(10),
  apply: z.boolean().default(false),
  notes: optionalBoundedStringSchema(320),
});

export const ConflictEscalationResultItemSchema = z.object({
  conflictId: identifierSchema("conflictId", 128),
  canonicalKey: CanonicalKeySchema,
  attention: z.enum(["stale", "escalated"]),
  openAgeDays: z.number().int().min(0),
  reopenCount: z.number().int().min(0),
  escalationCount: z.number().int().min(0),
  suggestedResolution: z.enum(["keep_existing", "accept_incoming", "manual_review"]),
  confidence: z.enum(["low", "medium", "high"]),
  action: z.enum(["pending", "escalated", "already-escalated"]),
  clusterKey: z.string().min(1).max(240),
});

export const EscalateConflictsResultSchema = z.object({
  apply: z.boolean(),
  scanned: z.number().int().min(0),
  eligible: z.number().int().min(0),
  escalated: z.number().int().min(0),
  skipped: z.number().int().min(0),
  items: z.array(ConflictEscalationResultItemSchema),
});

export type ConflictReason = z.infer<typeof ConflictReasonSchema>;
export type ConflictStatus = z.infer<typeof ConflictStatusSchema>;
export type ConflictExistingMemory = z.infer<typeof ConflictExistingMemorySchema>;
export type ConflictIncomingMemory = z.infer<typeof ConflictIncomingMemorySchema>;
export type ConflictCandidateInput = z.infer<typeof ConflictCandidateInputSchema>;
export type ConflictCandidateRecord = z.infer<typeof ConflictCandidateRecordSchema>;
export type ResolveConflictInput = z.infer<typeof ResolveConflictInputSchema>;
export type ConflictResolutionResult = z.infer<typeof ConflictResolutionResultSchema>;
export type EscalateConflictsInput = z.infer<typeof EscalateConflictsInputSchema>;
export type ConflictEscalationResultItem = z.infer<typeof ConflictEscalationResultItemSchema>;
export type EscalateConflictsResult = z.infer<typeof EscalateConflictsResultSchema>;
