import {
  buildProjectScopeCueTerms,
  normalizeScopedValue,
  taskMentionsScopeIdentity,
} from "./context-composer-scope.js";
import { dedupeText, stripConversationMarkers } from "./context-composer-text.js";
import {
  formatTaskResult,
  isDurableMemoryScope,
  isDurableTaskCandidate,
  isTaskCandidateUseful,
  scoreTaskCandidate,
  scoreWorkflowCandidate,
  taskResultKey,
  type TaskCategory,
} from "./context-composer-task-ranking.js";
import type { RetrievalResult } from "./retriever.js";
import {
  CASE_CUE_TERMS,
  TASK_RESULT_SPECIFICITY_GROUPS,
  TASK_CUE_EXTRACTION_LIMIT,
  WORKFLOW_CUE_TERMS,
  buildTaskHintTerms,
  containsAnyTerm,
  extractTerms,
  looksLikeContinuityTask,
  normalizeText,
  taskCueCoverage,
} from "./term-registry.js";
export type { TaskCategory } from "./context-composer-task-ranking.js";

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
  // Pull a wider term window here so leading generic cues do not crowd out
  // later task-specific nouns in long maintenance prompts.
  return dedupeText(
    extractTerms(taskSeed, TASK_CUE_EXTRACTION_LIMIT)
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

export function countTaskSpecificTextMatches(text: string, taskSeed?: string): number {
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

export function countPatternCueCoverage(items: string[]): number {
  return new Set(items.flatMap((item) => taskCueCoverage("patterns", item))).size;
}

export function looksLikeGenericWindowHandoffTask(taskSeed?: string): boolean {
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

export function selectRelevantPatterns(
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

  // Unscoped named tasks should not inherit generic durable task results unless
  // the result text itself carries the task identity; otherwise foreign project
  // cases from shared durable scopes can leak into continuity output.
  if (
    !params.scope &&
    isDurableMemoryScope(result.entry.scope) &&
    containsAnyTerm(params.taskSeed || "", ["项目", "project"]) &&
    !looksLikeGenericWindowHandoffTask(params.taskSeed) &&
    buildTaskSpecificTerms(params.taskSeed).length > 0 &&
    !taskMentionsScopeIdentity(params.taskSeed, result.entry.scope) &&
    countTaskSpecificMatches(result, params.taskSeed) === 0
  ) {
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

export function selectWorkflowFallbackCandidates(
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

export function selectTaskResults(
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
