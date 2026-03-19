import type { PinAsset } from "./memory-assets.js";
import { extractBoundaryMetadata, extractCanonicalKey, shouldUseStableMemoryResult } from "./memory-boundaries.js";
import type { RetrievalResult } from "./retriever.js";
import type { SessionCheckpointRecord } from "./session-schema.js";
import { buildProjectScopeCueTerms, normalizeScopedValue } from "./context-composer-scope.js";
import { selectPinnedContext } from "./context-composer-pins.js";
import { cleanText, dedupeText, stripConversationMarkers } from "./context-composer-text.js";
import {
  GENERIC_ENTITY_TASK_TERMS,
  GENERIC_SCOPE_TERMS,
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

function interleaveUnique(buckets: string[][], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  let cursor = 0;

  while (output.length < limit) {
    let progressed = false;
    for (const bucket of buckets) {
      const value = bucket[cursor];
      if (!value) continue;
      const key = normalizeText(value);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(value);
      progressed = true;
      if (output.length >= limit) break;
    }
    if (!progressed) break;
    cursor += 1;
  }

  return output;
}

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
    ...extractTerms(scope),
    ...extractTerms(taskSeed),
    ...buildTaskHintTerms(taskSeed),
  ], 12)
    .map((term) => normalizeText(term))
    .filter((term) =>
      term.length >= 2 &&
      !GENERIC_SCOPE_TERMS.has(term),
    );
}

function buildTaskEntityCueTerms(taskSeed?: string): string[] {
  return dedupeText([
    ...extractTerms(taskSeed),
    ...buildTaskHintTerms(taskSeed),
  ], 12)
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
    containsAnyTerm(stripped, [...extractTerms(params.taskSeed), ...buildTaskHintTerms(params.taskSeed)])
  ) {
    score += 2;
  }

  return score;
}

function formatStableResult(category: StableCategory, result: RetrievalResult): string {
  return cleanText(`${STABLE_CATEGORY_LABELS[category]}: ${stripConversationMarkers(result.entry.text)}`, 220);
}

function selectStableResults(
  category: StableCategory,
  results: RetrievalResult[],
  limit: number,
  params: { taskSeed?: string; styleFocused?: boolean; scope?: string } = {},
): string[] {
  const ranked = results
    .filter((result) =>
      isStableCandidateUseful(category, result) &&
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

function buildCheckpointStableContext(
  checkpoint: SessionCheckpointRecord | null,
  limit: number,
): string[] {
  if (!checkpoint) return [];

  const items = [
    checkpoint.summary ? `Checkpoint summary: ${checkpoint.summary}` : "",
    checkpoint.task ? `Checkpoint focus: ${checkpoint.task}` : "",
    checkpoint.decisions[0] ? `Checkpoint decision: ${checkpoint.decisions[0]}` : "",
    checkpoint.nextActions[0] ? `Checkpoint next: ${checkpoint.nextActions[0]}` : "",
    checkpoint.entities[0] ? `Checkpoint entity: ${checkpoint.entities[0]}` : "",
  ].filter(Boolean);

  return dedupeText(items.map((item) => cleanText(item, 220)), limit);
}

function buildTaskSeedStableContext(taskSeed?: string, limit = 1): string[] {
  if (!taskSeed) return [];

  const candidates = extractTerms(taskSeed)
    .filter((term) => {
      const normalized = normalizeText(term);
      if (!normalized || normalized.length < 2) return false;
      if (looksLikeStableInstruction(normalized)) return false;
      if (containsLowSignalStableTerm(normalized)) return false;

      if (/^[a-z0-9._/-]+$/i.test(term)) {
        return term.length >= 3;
      }

      return (
        term.includes("项目") ||
        term.includes("连续") ||
        term.includes("文章") ||
        term.includes("写作") ||
        term.includes("配图") ||
        term.includes("封面") ||
        term.includes("终端") ||
        term.includes("窗口")
      );
    })
    .slice(0, limit);

  return dedupeText(candidates.map((term) => `Task focus: ${term}`), limit);
}

export function buildStableContextSections(params: {
  profileResults: RetrievalResult[];
  preferenceResults: RetrievalResult[];
  entityResults: RetrievalResult[];
  pinAssets: Array<PinAsset & { path: string }>;
  latestCheckpoint: SessionCheckpointRecord | null;
  taskSeed?: string;
  scope?: string;
  stableLimit: number;
  styleFocusedTask?: boolean;
}): {
  profileContext: string[];
  preferenceContext: string[];
  entityContext: string[];
  checkpointContext: string[];
  pinnedContext: string[];
  taskFocusContext: string[];
  stableContext: string[];
} {
  const {
    profileResults,
    preferenceResults,
    entityResults,
    pinAssets,
    latestCheckpoint,
    taskSeed,
    scope,
    stableLimit,
    styleFocusedTask,
  } = params;

  const profileContext = selectStableResults("profile", profileResults, Math.max(2, stableLimit), {
    taskSeed,
    styleFocused: styleFocusedTask,
    scope,
  });
  const preferenceContext = selectStableResults("preferences", preferenceResults, Math.max(2, stableLimit), {
    taskSeed,
    styleFocused: styleFocusedTask,
    scope,
  });
  const entityContext = selectStableResults("entities", entityResults, Math.max(2, stableLimit), {
    taskSeed,
    styleFocused: styleFocusedTask,
    scope,
  });
  const checkpointContext = buildCheckpointStableContext(latestCheckpoint, Math.min(3, stableLimit));
  const pinnedContext = selectPinnedContext(pinAssets, {
    taskSeed,
    scope,
    limit: Math.min(2, stableLimit),
    styleFocused: styleFocusedTask,
    skipForStyleTask: Boolean(styleFocusedTask && preferenceContext.length > 0),
  });
  const taskFocusContext = (
    checkpointContext.length === 0 &&
    profileContext.length === 0 &&
    preferenceContext.length === 0 &&
    entityContext.length === 0 &&
    pinnedContext.length === 0
  )
    ? buildTaskSeedStableContext(taskSeed, 1)
    : [];

  const stableContext = interleaveUnique([
    profileContext,
    preferenceContext,
    entityContext,
    checkpointContext,
    taskFocusContext,
    pinnedContext,
  ], stableLimit);

  return {
    profileContext,
    preferenceContext,
    entityContext,
    checkpointContext,
    pinnedContext,
    taskFocusContext,
    stableContext,
  };
}
