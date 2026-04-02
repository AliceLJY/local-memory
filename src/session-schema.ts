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

export const ResumeContextResponseSchema = z.object({
  summary: boundedStringSchema("summary", 800),
  resolvedScope: optionalBoundedStringSchema(160),
  stableContext: normalizedStringListSchema("stableContext", 6, 220),
  relevantPatterns: normalizedStringListSchema("relevantPatterns", 6, 220),
  recentCases: normalizedStringListSchema("recentCases", 6, 220),
  /** CC-7: Mixed-granularity collapsed view of all recalled items. */
  collapsedItems: z.array(CollapsedItemSchema).max(20).optional(),
  latestCheckpoint: ResumeCheckpointSummarySchema.optional(),
  responseMode: ResumeResponseModeSchema.default("default"),
  responseGuidance: optionalBoundedStringSchema(400),
  generatedAt: z.string().datetime(),
});

export type SessionCheckpointInput = z.infer<typeof SessionCheckpointInputSchema>;
export type SessionCheckpointRecord = z.infer<typeof SessionCheckpointRecordSchema>;
export type ResumeContextRequest = z.infer<typeof ResumeContextRequestSchema>;
export type ResumeContextResponse = z.infer<typeof ResumeContextResponseSchema>;
export type RetrievalProfileName = z.infer<typeof RetrievalProfileSchema>;
export type ResumeResponseMode = z.infer<typeof ResumeResponseModeSchema>;
