import { dedupeText } from "./context-composer-text.js";
import { taskMentionsScopeIdentity } from "./context-composer-scope.js";
import {
  buildCaseFallbackQuery,
  buildContinuityFallbackPatterns,
  buildWorkflowFallbackQuery,
} from "./context-composer-task-fallbacks.js";
import type { RetrievalResult } from "./retriever.js";
import {
  looksLikeCaseFallbackTask,
} from "./term-registry.js";
import {
  countPatternCueCoverage,
  countTaskSpecificTextMatches,
  looksLikeGenericWindowHandoffTask,
  selectRelevantPatterns,
  selectTaskResults,
  selectWorkflowFallbackCandidates,
  type TaskCategory,
} from "./context-composer-task-selection.js";

export async function buildTaskResultSections(params: {
  retrieveCandidates: (args: {
    category?: TaskCategory;
    query: string;
    limit: number;
    scope?: string;
  }) => Promise<RetrievalResult[]>;
  patternResults: RetrievalResult[];
  caseResults: RetrievalResult[];
  continuityTask: boolean;
  hasLatestCheckpoint: boolean;
  taskLimit: number;
  taskSeed?: string;
  scope?: string;
  strongWorkflowCueTerms?: string[];
}): Promise<{ relevantPatterns: string[]; recentCases: string[] }> {
  const {
    retrieveCandidates,
    patternResults,
    caseResults,
    continuityTask,
    hasLatestCheckpoint,
    taskLimit,
    taskSeed,
    scope,
    strongWorkflowCueTerms,
  } = params;

  const retrievedPatterns = selectTaskResults("patterns", patternResults, taskLimit, {
    scope,
    taskSeed,
  });
  const allowSparseCheckpointSupplement = Boolean(
    hasLatestCheckpoint &&
    scope?.startsWith("project:") &&
    taskMentionsScopeIdentity(taskSeed, scope) &&
    retrievedPatterns.length <= 1,
  );
  const shouldProvideContinuityGuidance = continuityTask || allowSparseCheckpointSupplement;
  const workflowFallbackResults = !shouldProvideContinuityGuidance || countPatternCueCoverage(retrievedPatterns) >= 3
    ? []
    : await retrieveCandidates({
        query: buildWorkflowFallbackQuery(taskSeed),
        limit: Math.max(4, taskLimit * 2),
        scope,
      });
  const fallbackPatterns = selectWorkflowFallbackCandidates(workflowFallbackResults, {
    scope,
    taskSeed,
    limit: taskLimit,
    cueTerms: strongWorkflowCueTerms,
  });
  const combinedPatterns = [
    ...retrievedPatterns,
    ...fallbackPatterns,
  ];
  const combinedPatternCueCoverage = countPatternCueCoverage(combinedPatterns);
  const allowSingleContinuityGapSupplement = Boolean(
    continuityTask &&
    retrievedPatterns.length === 1 &&
    combinedPatterns.length === 1 &&
    (
      combinedPatternCueCoverage >= 2 ||
      looksLikeGenericWindowHandoffTask(taskSeed)
    ),
  );
  const continuityFallbackPatterns = !shouldProvideContinuityGuidance
    ? []
    : combinedPatterns.length === 0
      ? buildContinuityFallbackPatterns(taskLimit)
      : combinedPatternCueCoverage < 3 && (
          combinedPatterns.length >= 2 ||
          allowSparseCheckpointSupplement ||
          allowSingleContinuityGapSupplement
        )
        ? buildContinuityFallbackPatterns(taskLimit, combinedPatterns)
        : [];
  const relevantPatterns = selectRelevantPatterns([
    ...retrievedPatterns.map((text) => ({ text, sourcePriority: 3 })),
    ...fallbackPatterns.map((text) => ({ text, sourcePriority: 2 })),
    ...continuityFallbackPatterns.map((text) => ({ text, sourcePriority: 1 })),
  ], taskLimit);

  const retrievedCases = selectTaskResults("cases", caseResults, taskLimit, {
    scope,
    taskSeed,
  });
  const allowSparseCaseFallback = Boolean(
    retrievedCases.length <= 1 &&
    looksLikeCaseFallbackTask(taskSeed) &&
    Math.max(0, ...retrievedCases.map((item) => countTaskSpecificTextMatches(item, taskSeed))) === 0,
  );
  const caseFallbackResults = (retrievedCases.length > 0 && !allowSparseCaseFallback) ||
      (!hasLatestCheckpoint && !looksLikeCaseFallbackTask(taskSeed))
    ? []
    : await retrieveCandidates({
        category: "cases",
        query: buildCaseFallbackQuery(taskSeed),
        // Case fallback is now competing with more durable meta-maintenance
        // cases. Pull a wider pool so generic RecallNest continues can still
        // reach the canonical cleanup cases after specificity filtering.
        limit: Math.max(10, taskLimit * 3),
        scope,
      });
  const fallbackCases = selectTaskResults("cases", caseFallbackResults, taskLimit, {
    scope,
    taskSeed,
  });
  const recentCases = dedupeText([
    ...retrievedCases,
    ...fallbackCases,
  ], taskLimit);

  return { relevantPatterns, recentCases };
}
