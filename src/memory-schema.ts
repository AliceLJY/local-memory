import { z } from "zod";

import { boundedStringSchema, identifierSchema, normalizedStringListSchema, optionalBoundedStringSchema } from "./schema-utils.js";

export const DURABLE_MEMORY_CATEGORIES = [
  "profile",
  "preferences",
  "entities",
  "events",
  "cases",
  "patterns",
] as const;

export const LEGACY_MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "other",
] as const;

export const ALL_MEMORY_CATEGORIES = [
  ...DURABLE_MEMORY_CATEGORIES,
  ...LEGACY_MEMORY_CATEGORIES,
] as const;

export const STORE_MEMORY_SOURCES = ["manual", "agent", "api", "session_distill", "conversation_import"] as const;

export const DurableMemoryCategorySchema = z.enum(DURABLE_MEMORY_CATEGORIES);
export const MemoryCategorySchema = z.enum(ALL_MEMORY_CATEGORIES);
export const StoreMemorySourceSchema = z.enum(STORE_MEMORY_SOURCES);
export const WriteDispositionSchema = z.enum(["stored", "updated", "deduped", "promoted", "conflict", "rejected"]);

export type DurableMemoryCategory = z.infer<typeof DurableMemoryCategorySchema>;
export type MemoryCategoryValue = z.infer<typeof MemoryCategorySchema>;
export type StoreMemorySource = z.infer<typeof StoreMemorySourceSchema>;
export type WriteDisposition = z.infer<typeof WriteDispositionSchema>;

// --- Emotional Valence (Philosophy of Memory: Affective Memory) ---
export interface EmotionMetadata {
  /** Negative (-1) to Positive (+1) */
  valence: number;
  /** Calm (0) to Excited (1) */
  arousal: number;
  /** Human-readable label */
  label?: string;
  /** Composite mnemonic significance: (|valence| + arousal) / 2, range 0-1 */
  salience?: number;
  /** Detection method */
  source?: "keyword" | "llm" | "user";
}

export const EmotionMetadataSchema = z.object({
  valence: z.number().min(-1).max(1),
  arousal: z.number().min(0).max(1),
  label: z.string().max(30).optional(),
  salience: z.number().min(0).max(1).optional(),
  source: z.enum(["keyword", "llm", "user"]).optional(),
});

/** Parse emotion from metadata JSON string, returns null if absent */
export function parseEmotion(metadata: string | undefined): EmotionMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.emotion && typeof parsed.emotion.valence === "number") {
      return EmotionMetadataSchema.parse(parsed.emotion);
    }
  } catch { /* malformed metadata - safe to ignore */ }
  return null;
}

/** Default neutral emotion for memories without emotion data */
export const NEUTRAL_EMOTION: EmotionMetadata = { valence: 0, arousal: 0, label: "neutral" };

// --- Privacy Tier (Philosophy of Memory: Ethics Layer) ---
/**
 * Privacy tiers control how aggressively a memory is persisted, extracted, and shared.
 *
 * - ephemeral: auto-expire, no KG extraction, no sharing — session scratch
 * - private:   persist but no KG extraction, no sharing — personal notes
 * - durable:   full lifecycle, KG extraction, standard decay — default
 * - shared:    marked safe for cross-scope retrieval — collaborative knowledge
 */
export const PRIVACY_TIERS = ["ephemeral", "private", "durable", "shared"] as const;
export type PrivacyTier = (typeof PRIVACY_TIERS)[number];
export const PrivacyTierSchema = z.enum(PRIVACY_TIERS);

/** Parse privacyTier from metadata JSON string, returns "durable" (default) if absent */
export function parsePrivacyTier(metadata: string | undefined): PrivacyTier {
  if (!metadata) return "durable";
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.privacyTier && PRIVACY_TIERS.includes(parsed.privacyTier)) {
      return parsed.privacyTier;
    }
  } catch { /* malformed metadata - safe default */ }
  return "durable";
}

export const MemoryTextSchema = boundedStringSchema("text", 4000);
export const MemoryScopeSchema = optionalBoundedStringSchema(160);
export const RequiredMemoryScopeSchema = boundedStringSchema("scope", 160);
export const MemoryImportanceSchema = z.number().min(0).max(1);
export const CanonicalKeySchema = optionalBoundedStringSchema(120);
export const MemoryTagsSchema = normalizedStringListSchema("tags", 8, 40);
export const WorkflowPatternTitleSchema = boundedStringSchema("title", 120);
export const WorkflowPatternTriggerSchema = boundedStringSchema("trigger", 240);
export const WorkflowPatternStepsSchema = normalizedStringListSchema("steps", 8, 220)
  .pipe(z.array(z.string()).min(1, "steps must contain at least 1 item"));
export const WorkflowPatternOutcomeSchema = optionalBoundedStringSchema(240);
export const WorkflowPatternToolsSchema = normalizedStringListSchema("tools", 6, 60);
export const CaseMemoryTitleSchema = boundedStringSchema("title", 120);
export const CaseMemoryProblemSchema = boundedStringSchema("problem", 320);
export const CaseMemoryContextSchema = optionalBoundedStringSchema(240);
export const CaseMemorySolutionStepsSchema = normalizedStringListSchema("solutionSteps", 8, 220)
  .pipe(z.array(z.string()).min(1, "solutionSteps must contain at least 1 item"));
export const CaseMemoryOutcomeSchema = optionalBoundedStringSchema(240);
export const CaseMemoryToolsSchema = normalizedStringListSchema("tools", 6, 60);

export const StoreMemoryInputSchema = z.object({
  text: MemoryTextSchema,
  category: DurableMemoryCategorySchema.default("events"),
  importance: MemoryImportanceSchema.default(0.7),
  scope: RequiredMemoryScopeSchema,
  source: StoreMemorySourceSchema.default("manual"),
  tags: MemoryTagsSchema,
  canonicalKey: CanonicalKeySchema,
  topicTag: z.string().min(1).max(60).optional(),
  privacyTier: PrivacyTierSchema.default("durable"),
});

export const StoredMemoryRecordSchema = StoreMemoryInputSchema.extend({
  id: identifierSchema("id", 128),
  resolvedScope: identifierSchema("resolvedScope", 160),
  storedAt: z.string().datetime(),
  disposition: WriteDispositionSchema.default("stored"),
  conflictId: identifierSchema("conflictId", 128).optional(),
});

export const CaptureMemoryItemSchema = z.object({
  text: MemoryTextSchema,
  category: DurableMemoryCategorySchema.default("events"),
  importance: MemoryImportanceSchema.optional(),
  scope: MemoryScopeSchema,
  source: StoreMemorySourceSchema.optional(),
  tags: MemoryTagsSchema.optional(),
  canonicalKey: CanonicalKeySchema,
});

export const CaptureMemoryInputSchema = z.object({
  scope: MemoryScopeSchema,
  source: StoreMemorySourceSchema.default("agent"),
  defaultImportance: MemoryImportanceSchema.default(0.7),
  memories: z.array(CaptureMemoryItemSchema)
    .min(1, "memories must contain at least 1 item")
    .max(20, "memories must contain at most 20 items"),
}).superRefine((input, ctx) => {
  if (input.scope) return;
  input.memories.forEach((memory, index) => {
    if (!memory.scope) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memories", index, "scope"],
        message: "scope is required for each memory when capture scope is not provided",
      });
    }
  });
});

export const WorkflowPatternInputSchema = z.object({
  title: WorkflowPatternTitleSchema,
  trigger: WorkflowPatternTriggerSchema,
  steps: WorkflowPatternStepsSchema,
  outcome: WorkflowPatternOutcomeSchema,
  tools: WorkflowPatternToolsSchema,
  importance: MemoryImportanceSchema.default(0.82),
  scope: RequiredMemoryScopeSchema,
  source: StoreMemorySourceSchema.default("agent"),
  tags: MemoryTagsSchema,
  canonicalKey: CanonicalKeySchema,
});

export const CaseMemoryInputSchema = z.object({
  title: CaseMemoryTitleSchema,
  problem: CaseMemoryProblemSchema,
  context: CaseMemoryContextSchema,
  solutionSteps: CaseMemorySolutionStepsSchema,
  outcome: CaseMemoryOutcomeSchema,
  tools: CaseMemoryToolsSchema,
  importance: MemoryImportanceSchema.default(0.84),
  scope: RequiredMemoryScopeSchema,
  source: StoreMemorySourceSchema.default("agent"),
  tags: MemoryTagsSchema,
  canonicalKey: CanonicalKeySchema,
});

export const PromoteMemoryInputSchema = z.object({
  memoryId: identifierSchema("memoryId", 128),
  text: MemoryTextSchema.optional(),
  category: DurableMemoryCategorySchema.optional(),
  importance: MemoryImportanceSchema.default(0.78),
  scope: RequiredMemoryScopeSchema,
  source: StoreMemorySourceSchema.default("agent"),
  tags: MemoryTagsSchema,
  canonicalKey: CanonicalKeySchema,
});

export const StoredWorkflowPatternRecordSchema = WorkflowPatternInputSchema.extend({
  category: z.literal("patterns"),
  text: MemoryTextSchema,
  id: identifierSchema("id", 128),
  resolvedScope: identifierSchema("resolvedScope", 160),
  storedAt: z.string().datetime(),
  disposition: WriteDispositionSchema.default("stored"),
  conflictId: identifierSchema("conflictId", 128).optional(),
});

export const StoredCaseMemoryRecordSchema = CaseMemoryInputSchema.extend({
  category: z.literal("cases"),
  text: MemoryTextSchema,
  id: identifierSchema("id", 128),
  resolvedScope: identifierSchema("resolvedScope", 160),
  storedAt: z.string().datetime(),
  disposition: WriteDispositionSchema.default("stored"),
  conflictId: identifierSchema("conflictId", 128).optional(),
});

export const StoredPromotedMemoryRecordSchema = StoreMemoryInputSchema.extend({
  id: identifierSchema("id", 128),
  resolvedScope: identifierSchema("resolvedScope", 160),
  storedAt: z.string().datetime(),
  disposition: WriteDispositionSchema.default("promoted"),
  sourceMemoryId: identifierSchema("sourceMemoryId", 128),
  sourceCategory: MemoryCategorySchema,
  conflictId: identifierSchema("conflictId", 128).optional(),
});

export type StoreMemoryInput = z.infer<typeof StoreMemoryInputSchema>;
export type StoredMemoryRecord = z.infer<typeof StoredMemoryRecordSchema>;
export type CaptureMemoryItem = z.infer<typeof CaptureMemoryItemSchema>;
export type CaptureMemoryInput = z.infer<typeof CaptureMemoryInputSchema>;
export type WorkflowPatternInput = z.infer<typeof WorkflowPatternInputSchema>;
export type StoredWorkflowPatternRecord = z.infer<typeof StoredWorkflowPatternRecordSchema>;
export type CaseMemoryInput = z.infer<typeof CaseMemoryInputSchema>;
export type StoredCaseMemoryRecord = z.infer<typeof StoredCaseMemoryRecordSchema>;
export type PromoteMemoryInput = z.infer<typeof PromoteMemoryInputSchema>;
export type StoredPromotedMemoryRecord = z.infer<typeof StoredPromotedMemoryRecordSchema>;

export function isEmotionScoringEnabled(): boolean {
  return process.env.RECALLNEST_EMOTION_SCORING === "true";
}
