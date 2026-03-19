import { extractBoundaryMetadata, extractCanonicalKey } from "./memory-boundaries.js";
import {
  buildProjectScopeCueTerms,
  normalizeScopedValue,
  taskMentionsScopeIdentity,
} from "./context-composer-scope.js";
import { cleanText, dedupeText, stripConversationMarkers } from "./context-composer-text.js";
import {
  buildCaseFallbackQuery,
  buildContinuityFallbackPatterns,
  buildWorkflowFallbackQuery,
} from "./context-composer-task-fallbacks.js";
import type { RetrievalResult } from "./retriever.js";
import {
  CASE_CUE_TERMS,
  TASK_RESULT_SPECIFICITY_GROUPS,
  WORKFLOW_CUE_TERMS,
  buildTaskHintTerms,
  containsAnyTerm,
  extractTerms,
  countTermHits,
  looksLikeCaseFallbackTask,
  looksLikeContinuityTask,
  looksLikeLowSignalTaskResult,
  looksLikePlanishTaskResult,
  normalizeText,
  taskCueCoverage,
} from "./term-registry.js";

export type TaskCategory = "patterns" | "cases";

function parseResultMetadata(metadata?: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(metadata || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function formatWorkflowPatternResult(result: RetrievalResult): string {
  const metadata = parseResultMetadata(result.entry.metadata);
  const workflowPattern = metadata?.workflowPattern;
  if (!workflowPattern || typeof workflowPattern !== "object" || Array.isArray(workflowPattern)) {
    return cleanText(stripConversationMarkers(result.entry.text), 220);
  }

  const pattern = workflowPattern as Record<string, unknown>;
  const title = typeof pattern.title === "string" ? pattern.title.trim() : "";
  const trigger = typeof pattern.trigger === "string" ? pattern.trigger.trim() : "";
  const tools = Array.isArray(pattern.tools)
    ? pattern.tools.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const steps = Array.isArray(pattern.steps)
    ? pattern.steps.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  const parts = [
    title ? `Workflow pattern: ${title}` : "",
    tools.length > 0 ? `Tools: ${tools.join(", ")}` : "",
    trigger ? `Use when: ${trigger}` : "",
    steps.length > 0
      ? `Steps: ${steps.slice(0, 1).map((step, index) => `${index + 1}. ${step}`).join(" ")}`
      : "",
  ].filter(Boolean);

  return cleanText(parts.join(" "), 220);
}

function formatTaskResult(result: RetrievalResult): string {
  if (result.entry.category === "patterns") {
    return formatWorkflowPatternResult(result);
  }
  return cleanText(stripConversationMarkers(result.entry.text), 220);
}

function countTaskHintMatches(result: RetrievalResult, taskSeed?: string): number {
  const hintTerms = buildTaskHintTerms(taskSeed);
  if (hintTerms.length === 0) return 0;

  const haystack = normalizeText(stripConversationMarkers(result.entry.text));
  return hintTerms.filter((term) => haystack.includes(term)).length;
}

const GENERIC_TASK_MATCH_TERMS = new Set([
  ...WORKFLOW_CUE_TERMS.map((term) => normalizeText(term)),
  ...CASE_CUE_TERMS.map((term) => normalizeText(term)),
  "continue",
  "继续",
  "接着",
  "项目",
  "project",
  "terminal",
  "window",
  "fresh",
  "new",
  "same",
  "回到",
  "之前",
  "刚才",
]);

function buildTaskSpecificTerms(taskSeed?: string): string[] {
  if (!taskSeed) return [];
  return dedupeText(
    extractTerms(taskSeed)
      .map((term) => normalizeText(term))
      .filter((term) =>
        term.length >= 2 &&
        !GENERIC_TASK_MATCH_TERMS.has(term)
      ),
    24,
  );
}

function countTaskSpecificMatches(result: RetrievalResult, taskSeed?: string): number {
  const specificTerms = buildTaskSpecificTerms(taskSeed);
  if (specificTerms.length === 0) return 0;

  const haystack = normalizeText(stripConversationMarkers(result.entry.text));
  return specificTerms.filter((term) => haystack.includes(term)).length;
}

function countTaskSpecificTextMatches(text: string, taskSeed?: string): number {
  const specificTerms = buildTaskSpecificTerms(taskSeed);
  if (specificTerms.length === 0) return 0;

  const haystack = normalizeText(stripConversationMarkers(text));
  return specificTerms.filter((term) => haystack.includes(term)).length;
}

function hasUnsupportedTaskResultSpecificity(result: RetrievalResult, taskSeed?: string): boolean {
  if (!taskSeed) return false;

  const taskHaystack = normalizeText(`${taskSeed} ${buildTaskHintTerms(taskSeed).join(" ")}`);
  if (!taskHaystack) return false;

  const resultHaystack = normalizeText(stripConversationMarkers(result.entry.text));
  return TASK_RESULT_SPECIFICITY_GROUPS.some((group) =>
    group.resultTerms.some((term) => resultHaystack.includes(term)) &&
    !group.taskTerms.some((term) => taskHaystack.includes(term))
  );
}

function isDurableMemoryScope(scope: string): boolean {
  return scope.startsWith("memory:") || scope.startsWith("asset:");
}

function scoreWorkflowCandidate(result: RetrievalResult, scope?: string): number {
  const text = normalizeText(result.entry.text);
  const cueHits = WORKFLOW_CUE_TERMS.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0);
  if (cueHits === 0) return -1;

  let score = cueHits * 4 + result.score;
  if (result.entry.category === "patterns") score += 3;
  if (result.entry.category === "cases") score += 1;
  if (scope && result.entry.scope === scope) score += 2;
  if (isDurableMemoryScope(result.entry.scope)) score += 2;
  return score;
}

function selectWorkflowFallbackCandidates(
  results: RetrievalResult[],
  params: {
    scope?: string;
    taskSeed?: string;
    limit: number;
    cueTerms?: string[];
  },
): string[] {
  const cueTerms = params.cueTerms || WORKFLOW_CUE_TERMS;
  const ranked = results
    .map((result) => ({
      result,
      score: scoreWorkflowCandidate(result, params.scope),
    }))
    .filter((item) =>
      item.score > 0 &&
      isDurableMemoryScope(item.result.entry.scope) &&
      !hasUnsupportedTaskResultSpecificity(item.result, params.taskSeed) &&
      isRelevantToScopedTaskResult(item.result, {
        scope: params.scope,
        taskSeed: params.taskSeed,
      }) &&
      containsAnyTerm(item.result.entry.text, cueTerms),
    )
    .sort((a, b) => b.score - a.score)
    .map((item) => formatTaskResult(item.result));

  return dedupeText(ranked, params.limit);
}

function looksLikeStructuredPatternResult(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    normalized.startsWith("workflow pattern:") ||
    normalized.startsWith("pattern:") ||
    (normalized.includes("use when:") && normalized.includes("steps:")) ||
    (normalized.includes("流程") && normalized.includes("步骤"))
  );
}

function looksLikeStructuredCaseResult(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    normalized.startsWith("case:") ||
    normalized.startsWith("案例:") ||
    normalized.includes("problem:") ||
    normalized.includes("solution:") ||
    normalized.includes("root cause") ||
    normalized.includes("workaround") ||
    (normalized.includes("问题:") && (
      normalized.includes("解决:") ||
      normalized.includes("修复:") ||
      normalized.includes("方案:") ||
      normalized.includes("原因:")
    ))
  );
}

function looksLikeStructuredTaskResult(category: TaskCategory, text: string): boolean {
  return category === "patterns"
    ? looksLikeStructuredPatternResult(text)
    : looksLikeStructuredCaseResult(text);
}

function isDurableTaskCandidate(result: RetrievalResult): boolean {
  if (isDurableMemoryScope(result.entry.scope)) return true;
  return extractBoundaryMetadata(result.entry.metadata)?.layer === "durable";
}

function taskResultKey(result: RetrievalResult): string {
  return extractCanonicalKey(result.entry.metadata) || normalizeText(stripConversationMarkers(result.entry.text));
}

function scoreTaskCandidate(category: TaskCategory, result: RetrievalResult): number {
  const stripped = stripConversationMarkers(result.entry.text);
  const normalized = normalizeText(stripped);
  const boundary = extractBoundaryMetadata(result.entry.metadata);
  const cueTerms = category === "patterns" ? WORKFLOW_CUE_TERMS : CASE_CUE_TERMS;
  const cueHits = countTermHits(normalized, cueTerms);
  const structured = looksLikeStructuredTaskResult(category, stripped);

  let score = result.score;
  if (isDurableMemoryScope(result.entry.scope)) score += 5;
  if (boundary?.layer === "durable") score += 4;
  if (boundary?.layer === "working") score += 1;
  if (boundary?.layer === "evidence") score -= 4;
  if (extractCanonicalKey(result.entry.metadata)) score += 2;
  if (result.entry.category === category) score += 2;
  if (structured) score += 3;
  score += Math.min(cueHits, 3) * 1.5;
  if (looksLikePlanishTaskResult(normalized)) score -= 5;
  return score;
}

function countPatternCueCoverage(items: string[]): number {
  return new Set(items.flatMap((item) => taskCueCoverage("patterns", item))).size;
}

function looksLikeGenericWindowHandoffTask(taskSeed?: string): boolean {
  if (!taskSeed) return false;
  const normalized = normalizeText(taskSeed);
  const hasWindowCue = [
    "新窗口",
    "fresh window",
    "new window",
    "cross window",
    "窗口",
    "window",
    "terminal",
    "终端",
  ].some((term) => normalized.includes(term));
  const hasContinuationCue = [
    "继续",
    "continue",
    "同一个",
    "same",
    "项目",
    "project",
    "接力",
    "handoff",
  ].some((term) => normalized.includes(term));
  return hasWindowCue && hasContinuationCue;
}

function selectRelevantPatterns(
  candidates: Array<{ text: string; sourcePriority: number }>,
  limit: number,
): string[] {
  const seen = new Set<string>();
  const remaining = candidates
    .map((item, index) => ({ ...item, index }))
    .filter((item) => {
      const key = normalizeText(item.text);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const selected: string[] = [];
  const coveredCues = new Set<string>();

  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const item = remaining[index];
      const uncoveredCueCount = taskCueCoverage("patterns", item.text)
        .filter((term) => !coveredCues.has(term))
        .length;
      const value = item.sourcePriority + uncoveredCueCount * 3 - item.index * 0.01;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }

    const [item] = remaining.splice(bestIndex, 1);
    if (!item) continue;
    selected.push(item.text);
    for (const term of taskCueCoverage("patterns", item.text)) {
      coveredCues.add(term);
    }
  }

  return selected;
}

function isTaskCandidateUseful(category: TaskCategory, result: RetrievalResult): boolean {
  const stripped = stripConversationMarkers(result.entry.text);
  const normalized = normalizeText(stripped);
  if (!normalized || normalized.length < 12) return false;
  if (looksLikeLowSignalTaskResult(normalized)) return false;
  const cueTerms = category === "patterns" ? WORKFLOW_CUE_TERMS : CASE_CUE_TERMS;
  const cueHits = countTermHits(normalized, cueTerms);
  const structured = looksLikeStructuredTaskResult(category, stripped);
  const durable = isDurableTaskCandidate(result);

  if (durable) {
    if (looksLikePlanishTaskResult(normalized) && !structured) return false;
    return structured || cueHits > 0 || result.entry.category === category;
  }

  if (looksLikePlanishTaskResult(normalized)) return false;
  if (structured) return true;

  if (category === "patterns") {
    return cueHits >= 2;
  }

  return cueHits >= 2 && containsAnyTerm(normalized, [
    "解决",
    "修复",
    "方案",
    "恢复",
    "workaround",
    "root cause",
    "resolved",
    "solution",
    "fixed",
  ]);
}

function isRelevantToScopedTaskResult(
  result: RetrievalResult,
  params: { scope?: string; taskSeed?: string },
): boolean {
  const requestScope = params.scope ? normalizeScopedValue(params.scope) : "";
  const resultScope = normalizeScopedValue(result.entry.scope);
  const haystack = normalizeText(stripConversationMarkers(result.entry.text));
  const resultIsProject = resultScope.startsWith("project:");
  const requestIsProject = requestScope.startsWith("project:");
  const resultHasNamedIdentity = !["memory:", "asset:", "cc:", "codex:", "gemini:", "session:", "agent:", "eval:"]
    .some((prefix) => normalizeText(result.entry.scope).startsWith(prefix));

  if (params.scope && resultScope === requestScope) return true;

  if (!params.scope && resultHasNamedIdentity && !taskMentionsScopeIdentity(params.taskSeed, result.entry.scope)) {
    return false;
  }

  if (resultIsProject && !taskMentionsScopeIdentity(params.taskSeed, result.entry.scope)) {
    return false;
  }

  if (!params.scope) return true;

  if (requestIsProject && resultIsProject) {
    const projectCueTerms = buildProjectScopeCueTerms(params.scope);
    if (projectCueTerms.length === 0) return false;
    return projectCueTerms.some((term) => haystack.includes(term));
  }

  return true;
}

function selectTaskResults(
  category: TaskCategory,
  results: RetrievalResult[],
  limit: number,
  params: { scope?: string; taskSeed?: string } = {},
): string[] {
  const taskHintTerms = buildTaskHintTerms(params.taskSeed);
  const ranked = results
    .filter((result) =>
      isTaskCandidateUseful(category, result) &&
      !hasUnsupportedTaskResultSpecificity(result, params.taskSeed) &&
      isRelevantToScopedTaskResult(result, params)
    )
    .map((result) => ({
      result,
      key: taskResultKey(result),
      durable: isDurableTaskCandidate(result),
      score: scoreTaskCandidate(category, result),
      taskHintMatches: countTaskHintMatches(result, params.taskSeed),
      taskSpecificMatches: countTaskSpecificMatches(result, params.taskSeed),
      formatted: formatTaskResult(result),
    }))
    .sort((a, b) => {
      if (b.taskSpecificMatches !== a.taskSpecificMatches) {
        return b.taskSpecificMatches - a.taskSpecificMatches;
      }
      return b.score - a.score;
    });

  const maxTaskHintMatches = taskHintTerms.length > 0
    ? Math.max(0, ...ranked.map((item) => item.taskHintMatches))
    : 0;
  if (
    taskHintTerms.length > 0 &&
    !looksLikeContinuityTask(params.taskSeed) &&
    maxTaskHintMatches === 0
  ) {
    return [];
  }

  const hintFiltered = taskHintTerms.length > 0 && maxTaskHintMatches > 0
    ? ranked.filter((item) => item.taskHintMatches === maxTaskHintMatches)
    : ranked;
  const preferred = hintFiltered.some((item) => item.durable)
    ? hintFiltered.filter((item) => item.durable)
    : hintFiltered;
  const seen = new Set<string>();
  const selected: string[] = [];
  if (category === "patterns") {
    const remaining = preferred.filter((item) => item.key && !seen.has(item.key));
    const coveredCues = new Set<string>();

    while (remaining.length > 0 && selected.length < limit) {
      let bestIndex = 0;
      let bestValue = Number.NEGATIVE_INFINITY;

      for (let index = 0; index < remaining.length; index += 1) {
        const item = remaining[index];
        const uncoveredCueCount = taskCueCoverage(category, item.formatted)
          .filter((term) => !coveredCues.has(term))
          .length;
        const value = item.score + item.taskSpecificMatches * 4 + uncoveredCueCount * 3;
        if (value > bestValue) {
          bestValue = value;
          bestIndex = index;
        }
      }

      const [item] = remaining.splice(bestIndex, 1);
      if (!item || !item.key || seen.has(item.key)) continue;
      seen.add(item.key);
      selected.push(item.formatted);
      for (const term of taskCueCoverage(category, item.formatted)) {
        coveredCues.add(term);
      }
    }
    return selected;
  }

  for (const item of preferred) {
    if (!item.key || seen.has(item.key)) continue;
    seen.add(item.key);
    selected.push(item.formatted);
    if (selected.length >= limit) break;
  }

  return selected;
}

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
        limit: Math.max(4, taskLimit * 2),
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
