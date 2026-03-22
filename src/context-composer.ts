import { listPinAssets, type PinAsset } from "./memory-assets.js";
import { buildStableContextSections } from "./context-composer-stable.js";
import {
  buildAssociativeNestEntityFallbackQuery,
  buildScopedEntityFallbackQuery,
  buildStableQuery,
  buildStylePreferenceFallbackQuery,
  buildTaskQuery,
  formatLatestCheckpointHeadline,
} from "./context-composer-queries.js";
import { cleanText, dedupeText } from "./context-composer-text.js";
import {
  buildTaskResultSections,
} from "./context-composer-task-results.js";
import type { RetrievalContext, RetrievalResult } from "./retriever.js";
import type { ResumeContextResponse, SessionCheckpointRecord } from "./session-schema.js";
import { ResumeContextRequestSchema, ResumeContextResponseSchema } from "./session-schema.js";
import { formatCheckpointRecallSummary } from "./session-output.js";
import {
  STRONG_WORKFLOW_CUE_TERMS,
  looksLikeContinuityTask,
  looksLikeRecallOnlyTask,
  looksLikeStyleTask,
} from "./term-registry.js";
type ResumeCategory = "profile" | "preferences" | "entities" | "patterns" | "cases";

interface ResumeRetriever {
  retrieve(context: RetrievalContext): Promise<RetrievalResult[]>;
}

interface CheckpointLookup {
  getLatest(query?: { sessionId?: string; scope?: string }): Promise<SessionCheckpointRecord | null>;
}

export interface ResumeContextDeps {
  retriever: ResumeRetriever;
  checkpointStore: CheckpointLookup;
  listPins?: (limit?: number) => Array<PinAsset & { path: string }>;
}

async function retrieveCandidates(
  retriever: ResumeRetriever,
  params: {
    category?: ResumeCategory;
    query: string;
    limit: number;
    scope?: string;
  },
): Promise<RetrievalResult[]> {
  const { category, query, limit, scope } = params;

  if (!scope) {
    return retriever.retrieve({
      query,
      limit,
      ...(category ? { category } : {}),
      source: "auto-recall",
    });
  }

  const [scoped, global] = await Promise.all([
    retriever.retrieve({
      query,
      limit,
      ...(category ? { category } : {}),
      scopeFilter: [scope],
      source: "auto-recall",
    }),
    retriever.retrieve({
      query,
      limit: Math.min(10, limit * 2),
      ...(category ? { category } : {}),
      source: "auto-recall",
    }),
  ]);

  const seen = new Set<string>();
  const merged: RetrievalResult[] = [];
  for (const result of [...scoped, ...global]) {
    if (seen.has(result.entry.id)) continue;
    seen.add(result.entry.id);
    merged.push(result);
    if (merged.length >= Math.min(10, limit * 2)) break;
  }
  return merged;
}

function mergeRetrievalResults(resultSets: RetrievalResult[][], limit: number): RetrievalResult[] {
  const seen = new Set<string>();
  const merged: RetrievalResult[] = [];
  for (const set of resultSets) {
    for (const result of set) {
      if (seen.has(result.entry.id)) continue;
      seen.add(result.entry.id);
      merged.push(result);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}

async function resolveLatestCheckpoint(
  checkpointStore: CheckpointLookup,
  params: {
    includeLatestCheckpoint: boolean;
    sessionId?: string;
    scope?: string;
  },
): Promise<SessionCheckpointRecord | null> {
  if (!params.includeLatestCheckpoint) return null;

  if (params.sessionId) {
    const bySession = await checkpointStore.getLatest({ sessionId: params.sessionId });
    if (bySession) return bySession;
  }

  if (params.scope) {
    return checkpointStore.getLatest({ scope: params.scope });
  }

  return null;
}

function buildSummary(params: {
  stableContext: string[];
  relevantPatterns: string[];
  recentCases: string[];
  latestCheckpoint: SessionCheckpointRecord | null;
}): string {
  const parts: string[] = [];

  if (params.latestCheckpoint) {
    parts.push(
      formatLatestCheckpointHeadline(
        params.latestCheckpoint.sessionId,
        params.latestCheckpoint.updatedAt,
        formatCheckpointRecallSummary(params.latestCheckpoint),
      ),
    );
  }

  if (params.stableContext.length > 0) {
    parts.push(`Stable context: ${params.stableContext.slice(0, 2).map((item) => cleanText(item, 120)).join(" | ")}`);
  }

  parts.push(
    `Loaded ${params.stableContext.length} stable context item(s), ${params.relevantPatterns.length} pattern(s), and ${params.recentCases.length} case(s).`,
  );

  return cleanText(parts.join(" "), 800);
}

export async function composeResumeContext(
  deps: ResumeContextDeps,
  rawInput: unknown,
): Promise<ResumeContextResponse> {
  const input = ResumeContextRequestSchema.parse(rawInput);
  const latestCheckpoint = await resolveLatestCheckpoint(deps.checkpointStore, {
    includeLatestCheckpoint: input.includeLatestCheckpoint,
    sessionId: input.sessionId,
    scope: input.scope,
  });

  const resolvedScope = input.scope || latestCheckpoint?.resolvedScope;
  const taskSeed = input.task || latestCheckpoint?.task || latestCheckpoint?.summary;
  const stableLimit = input.limitPerSection;
  const taskLimit = input.limitPerSection;
  const styleFocusedTask = looksLikeStyleTask(taskSeed) || input.profile === "writing";
  const recallOnlyTask = looksLikeRecallOnlyTask(taskSeed) && styleFocusedTask;

  const preferenceQueries = dedupeText([
    buildStableQuery("preferences", taskSeed),
    ...(styleFocusedTask ? [buildStylePreferenceFallbackQuery(taskSeed)] : []),
  ], 2);
  const entityQueries = dedupeText([
    buildStableQuery("entities", taskSeed),
    ...(resolvedScope ? [buildScopedEntityFallbackQuery(resolvedScope, taskSeed)] : []),
    ...(!resolvedScope ? [buildAssociativeNestEntityFallbackQuery(taskSeed)] : []),
  ], 3);

  const [profileResults, preferenceResultSets, entityResultSets, patternResults, caseResults] = await Promise.all([
    retrieveCandidates(deps.retriever, {
      category: "profile",
      query: buildStableQuery("profile", taskSeed),
      limit: Math.max(2, stableLimit),
      scope: resolvedScope,
    }),
    Promise.all(preferenceQueries.map((query) =>
      retrieveCandidates(deps.retriever, {
        category: "preferences",
        query,
        limit: Math.max(2, stableLimit),
          scope: resolvedScope,
        })
    )),
    Promise.all(entityQueries.map((query) =>
      retrieveCandidates(deps.retriever, {
        category: "entities",
        query,
        limit: Math.max(2, stableLimit),
        scope: resolvedScope,
      })
    )),
    retrieveCandidates(deps.retriever, {
      category: "patterns",
      query: buildTaskQuery("patterns", taskSeed),
      limit: taskLimit,
      scope: resolvedScope,
    }),
    retrieveCandidates(deps.retriever, {
      category: "cases",
      query: buildTaskQuery("cases", taskSeed),
      limit: taskLimit,
      scope: resolvedScope,
    }),
  ]);
  const preferenceResults = mergeRetrievalResults(preferenceResultSets, Math.max(4, stableLimit * 3));
  const entityResults = mergeRetrievalResults(entityResultSets, Math.max(4, stableLimit * 3));

  const continuityTask = looksLikeContinuityTask(taskSeed) && !styleFocusedTask;
  const pinAssets = (deps.listPins || listPinAssets)(Math.max(4, stableLimit * 2));
  const {
    preferenceContext,
    stableContext,
  } = buildStableContextSections({
    profileResults,
    preferenceResults,
    entityResults,
    pinAssets,
    latestCheckpoint,
    taskSeed,
    scope: resolvedScope,
    stableLimit,
    styleFocusedTask,
  });

  const { relevantPatterns, recentCases } = await buildTaskResultSections({
    retrieveCandidates: ({ category, query, limit, scope }) =>
      retrieveCandidates(deps.retriever, {
        ...(category ? { category } : {}),
        query,
        limit,
        scope,
      }),
    patternResults,
    caseResults,
    continuityTask,
    hasLatestCheckpoint: Boolean(latestCheckpoint),
    taskLimit,
    taskSeed,
    scope: resolvedScope,
    strongWorkflowCueTerms: STRONG_WORKFLOW_CUE_TERMS,
  });

  const response = {
    summary: buildSummary({
      stableContext,
      relevantPatterns,
      recentCases,
      latestCheckpoint,
    }),
    resolvedScope,
    stableContext,
    relevantPatterns,
    recentCases,
    latestCheckpoint: latestCheckpoint
      ? {
        sessionId: latestCheckpoint.sessionId,
        resolvedScope: latestCheckpoint.resolvedScope,
        summary: formatCheckpointRecallSummary(latestCheckpoint),
        updatedAt: latestCheckpoint.updatedAt,
      }
      : undefined,
    responseMode: recallOnlyTask ? "recall-only" as const : "default" as const,
    responseGuidance: recallOnlyTask
      ? (
          stableContext.length <= 1
            ? "Recall-only mode: answer from the recalled stable context item only. Restate it briefly and do not expand into extra rules, examples, or local writing docs unless the user explicitly asks."
            : "Recall-only mode: answer only from the recalled stable context items. Keep the reply brief and do not expand into extra rules, examples, or local writing docs unless the user explicitly asks."
        )
      : undefined,
    generatedAt: new Date().toISOString(),
  };

  return ResumeContextResponseSchema.parse(response);
}
