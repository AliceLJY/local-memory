import { z } from "zod";

import { boundedStringSchema, identifierSchema, normalizedStringListSchema, optionalBoundedStringSchema } from "./schema-utils.js";

export const RetrievalProfileSchema = z.enum(["default", "writing", "debug", "fact-check"]);

export const SessionCheckpointInputSchema = z.object({
  sessionId: identifierSchema("sessionId"),
  scope: optionalBoundedStringSchema(160),
  summary: boundedStringSchema("summary", 600),
  task: optionalBoundedStringSchema(240),
  decisions: normalizedStringListSchema("decisions", 6, 200),
  openLoops: normalizedStringListSchema("openLoops", 6, 200),
  nextActions: normalizedStringListSchema("nextActions", 6, 200),
  entities: normalizedStringListSchema("entities", 8, 120),
  files: normalizedStringListSchema("files", 12, 220),
  updatedAt: z.string().datetime().default(() => new Date().toISOString()),
});

export const SessionCheckpointRecordSchema = SessionCheckpointInputSchema.extend({
  checkpointId: identifierSchema("checkpointId", 128),
  resolvedScope: identifierSchema("resolvedScope", 160),
});

export const ResumeContextRequestSchema = z.object({
  task: optionalBoundedStringSchema(500),
  scope: optionalBoundedStringSchema(160),
  sessionId: optionalBoundedStringSchema(160),
  limitPerSection: z.number().int().min(1).max(6).default(3),
  includeLatestCheckpoint: z.boolean().default(true),
  profile: RetrievalProfileSchema.optional(),
});

export const ResumeCheckpointSummarySchema = z.object({
  sessionId: identifierSchema("sessionId"),
  resolvedScope: optionalBoundedStringSchema(160),
  summary: boundedStringSchema("summary", 600),
  updatedAt: z.string().datetime(),
});

export const ResumeResponseModeSchema = z.enum(["default", "recall-only"]);

export const CollapsedItemSchema = z.object({
  entryId: z.string(),
  text: z.string(),
  renderLevel: z.enum(["L0", "L1", "L2"]),
  stalenessHint: z.string().optional(),
});

/** CC-8: Essential context reconstructed after compact — pinned memories, active patterns, open loops. */
export const EssentialContextSchema = z.object({
  pinnedMemories: z.array(z.string()).max(3).optional(),
  activePatterns: z.array(z.string()).max(2).optional(),
  openLoops: z.array(z.string()).max(3).optional(),
});

export const ResumeContextResponseSchema = z.object({
  summary: boundedStringSchema("summary", 800),
  resolvedScope: optionalBoundedStringSchema(160),
  stableContext: normalizedStringListSchema("stableContext", 6, 220),
  relevantPatterns: normalizedStringListSchema("relevantPatterns", 6, 220),
  recentCases: normalizedStringListSchema("recentCases", 6, 220),
  /** CC-7: Mixed-granularity collapsed view of all recalled items. */
  collapsedItems: z.array(CollapsedItemSchema).max(20).optional(),
  /** CC-8: Essential context reconstructed after compact. */
  essentialContext: EssentialContextSchema.optional(),
  latestCheckpoint: ResumeCheckpointSummarySchema.optional(),
  /** CC-1: Hint for where to inject recalled context in the prompt. */
  injectionHint: z.enum(["system_prompt", "user_attachment"]).default("user_attachment").optional(),
  /** Upstream #345: Mark recalled context as ephemeral — host should discard on compaction, not persist to transcript. */
  ephemeral: z.boolean().default(true).optional(),
  responseMode: ResumeResponseModeSchema.default("default"),
  responseGuidance: optionalBoundedStringSchema(400),
  /** Constructive retrieval: LLM-synthesized reconstruction of context. */
  reconstructedContext: z.string().max(2000).optional(),
  /** Confidence score (0-1) for the reconstructed context. */
  reconstructionConfidence: z.number().min(0).max(1).optional(),
  /** Phase 4: Contradictions detected during reconstruction. */
  reconstructionContradictions: z.array(z.object({
    memoryIds: z.tuple([z.string(), z.string()]),
    description: z.string().max(300),
  })).max(5).optional(),
  /** HP-narrative: Memories grouped by autobiographical life period. */
  narrativeGroups: z.array(z.object({
    period: z.string().max(120),
    items: z.array(z.string().max(240)).max(5),
  })).max(10).optional(),
  generatedAt: z.string().datetime(),
});

export type SessionCheckpointInput = z.infer<typeof SessionCheckpointInputSchema>;
export type SessionCheckpointRecord = z.infer<typeof SessionCheckpointRecordSchema>;
export type ResumeContextRequest = z.infer<typeof ResumeContextRequestSchema>;
export type ResumeContextResponse = z.infer<typeof ResumeContextResponseSchema>;
export type EssentialContext = z.infer<typeof EssentialContextSchema>;
export type RetrievalProfileName = z.infer<typeof RetrievalProfileSchema>;
export type ResumeResponseMode = z.infer<typeof ResumeResponseModeSchema>;
