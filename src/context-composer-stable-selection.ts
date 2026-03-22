import { extractBoundaryMetadata, extractCanonicalKey, shouldUseStableMemoryResult } from "./memory-boundaries.js";
import { buildProjectScopeCueTerms, normalizeScopedValue } from "./context-composer-scope.js";
import { cleanText, dedupeText, stripConversationMarkers } from "./context-composer-text.js";
import type { RetrievalResult } from "./retriever.js";
import {
  GENERIC_ENTITY_TASK_TERMS,
  GENERIC_SCOPE_TERMS,
  PREFERENCE_SPECIFICITY_GROUPS,
  TASK_CUE_EXTRACTION_LIMIT,
  buildTaskHintTerms,
  containsAnyTerm,
  containsLowSignalStableTerm,
  extractTerms,
  looksLikeStableInstruction,
  normalizeText,
} from "./term-registry.js";

export type StableCategory = "profile" | "preferences" | "entities";

const STABLE_CATEGORY_LABELS: Record<StableCategory, string> = {
  profile: "Profile",
  preferences: "Preference",
  entities: "Entity",
};

function isDurableStableScope(scope: string): boolean {
  return scope.startsWith("memory:") || scope.startsWith("asset:");
}

function isStableCandidateUseful(category: StableCategory, result: RetrievalResult): boolean {
  if (!shouldUseStableMemoryResult({
    category,
    scope: result.entry.scope,
    metadata: result.entry.metadata,
  })) {
    return false;
  }

  const stripped = stripConversationMarkers(result.entry.text);
  const normalized = normalizeText(stripped);
  if (!normalized || normalized.length < 8) return false;
  if (looksLikeStableInstruction(normalized)) return false;
  if (containsLowSignalStableTerm(normalized)) return false;
  if (!isDurableStableScope(result.entry.scope) && stripped.length > 180) return false;
  if (category === "entities" && /^(用户|助手|pinned asset|memory brief)/i.test(stripped)) return false;
  return true;
}

function buildStableScopeCueTerms(scope?: string, taskSeed?: string): string[] {
  return dedupeText([
    ...extractTerms(scope, TASK_CUE_EXTRACTION_LIMIT),
    ...extractTerms(taskSeed, TASK_CUE_EXTRACTION_LIMIT),
    ...buildTaskHintTerms(taskSeed),
  ], TASK_CUE_EXTRACTION_LIMIT)
    .map((term) => normalizeText(term))
    .filter((term) =>
      term.length >= 2 &&
      !GENERIC_SCOPE_TERMS.has(term),
    );
}

function buildTaskEntityCueTerms(taskSeed?: string): string[] {
  return dedupeText([
    ...extractTerms(taskSeed, TASK_CUE_EXTRACTION_LIMIT),
    ...buildTaskHintTerms(taskSeed),
  ], TASK_CUE_EXTRACTION_LIMIT)
    .map((term) => normalizeText(term))
    .filter((term) =>
      term.length >= 2 &&
      !GENERIC_ENTITY_TASK_TERMS.has(term),
    );
}

function countTaskEntityCueMatches(result: RetrievalResult, taskSeed?: string): number {
  const cueTerms = buildTaskEntityCueTerms(taskSeed);
  if (cueTerms.length === 0) return 0;

  const haystack = normalizeText(stripConversationMarkers(result.entry.text));
  return cueTerms.filter((term) => haystack.includes(term)).length;
}

function isRelevantToScopedStableRecall(
  result: RetrievalResult,
  params: { scope?: string; taskSeed?: string },
): boolean {
  if (!params.scope) {
    return true;
  }

  const requestScope = normalizeScopedValue(params.scope);
  const resultScope = normalizeScopedValue(result.entry.scope);
  if (resultScope === requestScope) {
    return true;
  }

  const haystack = normalizeText(stripConversationMarkers(result.entry.text));
  const requestIsProject = requestScope.startsWith("project:");
  const resultIsProject = resultScope.startsWith("project:");
  if (requestIsProject && resultIsProject) {
    const projectCueTerms = buildProjectScopeCueTerms(params.scope);
    if (projectCueTerms.length === 0) {
      return false;
    }
    return projectCueTerms.some((term) => haystack.includes(term));
  }

  const cueTerms = buildStableScopeCueTerms(params.scope, params.taskSeed);
  if (cueTerms.length === 0) {
    return true;
  }

  return cueTerms.some((term) => haystack.includes(term));
}

function stableResultKey(result: RetrievalResult): string {
  return extractCanonicalKey(result.entry.metadata) || normalizeText(stripConversationMarkers(result.entry.text));
}

function scoreStableResult(
  category: StableCategory,
  result: RetrievalResult,
  params: { taskSeed?: string; styleFocused?: boolean },
): number {
  let score = result.score;
  const stripped = stripConversationMarkers(result.entry.text);
  const boundary = extractBoundaryMetadata(result.entry.metadata);

  if (isDurableStableScope(result.entry.scope)) score += 2;
  if (boundary?.layer === "durable") score += 2;
  if (extractCanonicalKey(result.entry.metadata)) score += 1;

  if (
    params.styleFocused &&
    category === "preferences" &&
    containsAnyTerm(
      stripped,
      [...extractTerms(params.taskSeed, TASK_CUE_EXTRACTION_LIMIT), ...buildTaskHintTerms(params.taskSeed)],
    )
  ) {
    score += 2;
  }

  return score;
}

function hasUnsupportedPreferenceSpecificity(result: RetrievalResult, taskSeed?: string, styleFocused?: boolean): boolean {
  if (styleFocused || !taskSeed) return false;

  const taskHaystack = normalizeText(`${taskSeed} ${buildTaskHintTerms(taskSeed).join(" ")}`);
  if (!taskHaystack) return false;

  const resultHaystack = normalizeText(stripConversationMarkers(result.entry.text));
  return PREFERENCE_SPECIFICITY_GROUPS.some((group) =>
    group.resultTerms.some((term) => resultHaystack.includes(term)) &&
    !group.taskTerms.some((term) => taskHaystack.includes(term))
  );
}

function formatStableResult(category: StableCategory, result: RetrievalResult): string {
  return cleanText(`${STABLE_CATEGORY_LABELS[category]}: ${stripConversationMarkers(result.entry.text)}`, 220);
}

export function selectStableResults(
  category: StableCategory,
  results: RetrievalResult[],
  limit: number,
  params: { taskSeed?: string; styleFocused?: boolean; scope?: string } = {},
): string[] {
  const ranked = results
    .filter((result) =>
      isStableCandidateUseful(category, result) &&
      (category !== "preferences" || !hasUnsupportedPreferenceSpecificity(result, params.taskSeed, params.styleFocused)) &&
      (category !== "entities" || isRelevantToScopedStableRecall(result, params))
    )
    .map((result) => ({
      result,
      key: stableResultKey(result),
      score: scoreStableResult(category, result, params),
      taskCueMatches: category === "entities" ? countTaskEntityCueMatches(result, params.taskSeed) : 0,
    }))
    .sort((a, b) => b.score - a.score);

  const maxTaskCueMatches = category === "entities" && !params.scope
    ? Math.max(0, ...ranked.map((item) => item.taskCueMatches))
    : 0;
  const filteredRanked = category === "entities" && !params.scope && maxTaskCueMatches > 0
    ? ranked.filter((item) => item.taskCueMatches === maxTaskCueMatches)
    : ranked;

  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of filteredRanked) {
    if (!item.key || seen.has(item.key)) continue;
    seen.add(item.key);
    output.push(formatStableResult(category, item.result));
    if (output.length >= limit) break;
  }
  return output;
}
