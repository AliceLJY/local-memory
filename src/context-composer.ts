import { listPinAssets, type PinAsset } from "./memory-assets.js";
import {
  buildStableContextSections,
  cleanText,
  dedupeText,
  type StableCategory,
} from "./context-composer-stable.js";
import {
  buildTaskResultSections,
  type TaskCategory,
} from "./context-composer-task-results.js";
import type { RetrievalContext, RetrievalResult } from "./retriever.js";
import type { ResumeContextResponse, SessionCheckpointRecord } from "./session-schema.js";
import { ResumeContextRequestSchema, ResumeContextResponseSchema } from "./session-schema.js";
import {
  STRONG_WORKFLOW_CUE_TERMS,
  containsAnyTerm,
  extractTerms,
  looksLikeContinuityTask,
  looksLikeRecallOnlyTask,
  looksLikeStyleTask,
} from "./term-registry.js";
type ResumeCategory = StableCategory | TaskCategory;

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

function buildStableQuery(category: StableCategory, taskSeed?: string): string {
  if (taskSeed) {
    switch (category) {
      case "profile":
        return `${taskSeed} user background identity role`;
      case "preferences":
        if (looksLikeStyleTask(taskSeed)) {
          return `${taskSeed} user preferences writing tone voice style habits 口语化 不端着 自嘲 鸡血 浮夸`;
        }
        return `${taskSeed} user preferences workflow style`;
      case "entities":
        return `${taskSeed} project tools repository entities`;
    }
  }

  switch (category) {
    case "profile":
      return "user background identity role";
    case "preferences":
      return "user preferences workflow style habits";
    case "entities":
      return "active project tools repository entities";
  }
}

function buildStylePreferenceFallbackQuery(taskSeed?: string): string {
  const extracted = extractTerms(taskSeed).filter((term) =>
    containsAnyTerm(term, ["写作", "风格", "语气", "偏好", "表达", "style", "tone", "voice", "preference"])
  );
  const lead = dedupeText([
    "写作风格",
    "语气",
    "偏好",
    "避免表达",
    "口语化",
    "不端着",
    ...extracted,
  ], 6).join(" ");

  return lead || "写作风格 语气 偏好 避免表达 口语化 不端着";
}

function buildTaskQuery(category: TaskCategory, taskSeed?: string): string {
  if (taskSeed) {
    return category === "patterns"
      ? `${taskSeed} reusable workflow pattern steps`
      : `${taskSeed} similar solved case previous fix`;
  }
  return category === "patterns"
    ? "reusable workflow pattern steps"
    : "similar solved case previous fix";
}

function buildScopedEntityFallbackQuery(scope?: string, taskSeed?: string): string {
  const scopeTerms = extractTerms(scope).slice(0, 4);
  const taskTerms = extractTerms(taskSeed).slice(0, 4);
  const query = dedupeText([
    ...scopeTerms,
    ...taskTerms,
    "active project",
    "shared memory layer",
    "continuity",
    "checkpoint_session",
    "resume_context",
    "project entity",
    "tools",
    "repository",
  ], 10).join(" ");

  return query || "active project continuity checkpoint_session resume_context project entity tools repository";
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
      `Latest checkpoint from ${params.latestCheckpoint.sessionId} on ${params.latestCheckpoint.updatedAt.slice(0, 10)}: ${cleanText(params.latestCheckpoint.summary, 220)}`,
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
  ], 2);

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

  const continuityTask = looksLikeContinuityTask(taskSeed);
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
        summary: latestCheckpoint.summary,
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
