import type { PinAsset } from "./memory-assets.js";
import { extractBoundaryMetadata, extractCanonicalKey, shouldUseStableMemoryResult } from "./memory-boundaries.js";
import type { RetrievalResult } from "./retriever.js";
import type { SessionCheckpointRecord } from "./session-schema.js";
import {
  GENERIC_ENTITY_TASK_TERMS,
  GENERIC_SCOPE_TERMS,
  buildTaskHintTerms,
  containsAnyTerm,
  containsLowSignalStableTerm,
  extractTerms,
  looksLikeLowSignalTaskResult,
  looksLikePlanishTaskResult,
  looksLikeStableInstruction,
  normalizeText,
} from "./term-registry.js";

export type StableCategory = "profile" | "preferences" | "entities";

const STABLE_CATEGORY_LABELS: Record<StableCategory, string> = {
  profile: "Profile",
  preferences: "Preference",
  entities: "Entity",
};

export function cleanText(text: string, maxLen: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

export function stripConversationMarkers(text: string): string {
  return text
    .replace(/<image[^>]*>\s*/gi, "")
    .replace(/\[(用户|助手|Pinned Asset|Memory Brief)\]\s*/g, "")
    .replace(/\bSummary:\s*/gi, "")
    .replace(/\bSnippet:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

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

export function dedupeText(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const key = normalizeText(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length >= limit) break;
  }
  return output;
}

function scorePin(asset: PinAsset, taskTerms: string[], scope?: string): number {
  let score = 0;
  const haystack = `${asset.title} ${asset.summary} ${asset.tags.join(" ")}`.toLowerCase();
  for (const term of taskTerms) {
    if (haystack.includes(term)) score += 2;
  }
  if (scope && asset.source.scope === scope) score += 3;
  return score;
}

function formatPinnedContext(asset: PinAsset, taskTerms: string[]): string {
  const title = asset.title.trim();
  const summary = asset.summary.trim();
  const hasStandaloneTitle = title.length > 0 && !title.startsWith("[");
  const base = hasStandaloneTitle && summary && !normalizeText(summary).includes(normalizeText(title))
    ? `Pinned: ${title}: ${summary}`
    : `Pinned: ${summary || title}`;

  const combined = `${title} ${summary} ${asset.tags.join(" ")}`.toLowerCase();
  const snippet = cleanText(stripConversationMarkers(asset.snippet), 120);
  const shouldAppendSnippet = Boolean(
    snippet &&
    taskTerms.some((term) => {
      const normalized = normalizeText(term);
      return normalized.length >= 2 && snippet.toLowerCase().includes(normalized) && !combined.includes(normalized);
    }),
  );

  return cleanText(
    shouldAppendSnippet
      ? `${base} Snippet: ${snippet}`
      : base,
    220,
  );
}

function isDurablePinAsset(asset: PinAsset): boolean {
  if (asset.type === "pinned-memory") return true;

  const metadata = JSON.stringify(asset.source.metadata || {});
  const boundary = extractBoundaryMetadata(metadata);
  if (boundary?.layer === "durable") return true;
  if (extractCanonicalKey(metadata)) return true;
  return asset.source.scope.startsWith("memory:") || asset.source.scope.startsWith("asset:");
}

function looksLikeConversationalPinnedText(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (looksLikeStableInstruction(normalized)) return true;
  if (looksLikePlanishTaskResult(normalized)) return true;
  if (looksLikeLowSignalTaskResult(normalized)) return true;

  return [
    "现在看",
    "现在查",
    "现在更新",
    "现在修改",
    "现在修",
    "现在补",
    "现在排查",
    "现在确认",
    "现在检查",
    "现在同步",
    "现在处理",
    "刚才",
    "刚刚",
    "i'll",
    "i will",
    "let me",
    "going to",
  ].some((prefix) => normalized.startsWith(prefix));
}

function isConversationalPinnedAsset(asset: PinAsset): boolean {
  const rawLead = `${asset.title} ${asset.summary}`.trim();
  if (!/^\[(用户|助手|Pinned Asset|Memory Brief)\]/i.test(rawLead)) return false;
  if (looksLikeConversationalPinnedText(stripConversationMarkers(rawLead))) return true;
  return !isDurablePinAsset(asset) || !asset.source.scope.startsWith("memory:");
}

function isUsefulPinnedAsset(asset: PinAsset): boolean {
  if (isConversationalPinnedAsset(asset)) return false;

  const stripped = stripConversationMarkers(`${asset.title} ${asset.summary}`);
  const normalized = normalizeText(stripped);
  if (!normalized || normalized.length < 8) return false;
  if (looksLikeStableInstruction(normalized)) return false;
  if (containsLowSignalStableTerm(normalized)) return false;
  return true;
}

export function normalizeScopedValue(scope: string): string {
  const normalized = normalizeText(scope);
  if (normalized.startsWith("memory:")) return normalized.slice("memory:".length);
  if (normalized.startsWith("asset:")) return normalized.slice("asset:".length);
  return normalized;
}

function buildScopeIdentityTerms(scope?: string): string[] {
  if (!scope) return [];

  const normalizedScope = normalizeScopedValue(scope);
  const identity = normalizedScope.includes(":")
    ? normalizedScope.slice(normalizedScope.indexOf(":") + 1)
    : normalizedScope;
  if (!identity) return [];

  const spaced = identity.replace(/[-_/.:]+/g, " ");
  return dedupeText([
    identity,
    spaced,
    ...extractTerms(identity),
    ...extractTerms(spaced),
  ], 12)
    .map((term) => normalizeText(term))
    .filter((term) =>
      term.length >= 2 &&
      !GENERIC_SCOPE_TERMS.has(term),
    );
}

export function buildProjectScopeCueTerms(scope?: string): string[] {
  if (!scope) return [];
  return dedupeText(extractTerms(scope), 8)
    .map((term) => normalizeText(term))
    .filter((term) =>
      term.length >= 2 &&
      !GENERIC_SCOPE_TERMS.has(term),
    );
}

function isRelevantToScopedPinnedContext(asset: PinAsset, scope?: string): boolean {
  if (!scope) return true;

  const requestScope = normalizeScopedValue(scope);
  const assetScope = normalizeScopedValue(asset.source.scope);
  if (assetScope === requestScope) return true;

  const requestIsProject = requestScope.startsWith("project:");
  const assetIsProject = assetScope.startsWith("project:");
  if (!requestIsProject || !assetIsProject) return true;

  const cueTerms = buildProjectScopeCueTerms(scope);
  if (cueTerms.length === 0) return false;

  const haystack = normalizeText(stripConversationMarkers(`${asset.title} ${asset.summary} ${asset.tags.join(" ")}`));
  return cueTerms.some((term) => haystack.includes(term));
}

function selectPinnedContext(
  assets: Array<PinAsset & { path: string }>,
  params: {
    taskSeed?: string;
    scope?: string;
    limit: number;
    styleFocused?: boolean;
    skipForStyleTask?: boolean;
  },
): string[] {
  const { taskSeed, scope, limit, styleFocused, skipForStyleTask } = params;
  if (styleFocused && skipForStyleTask) {
    return [];
  }

  const taskTerms = Array.from(new Set([
    ...extractTerms(taskSeed),
    ...buildTaskHintTerms(taskSeed),
    ...(styleFocused ? ["写作", "文章", "风格", "语气", "口语化", "不端着", "自嘲", "style", "tone", "voice"] : []),
  ]));
  const requirePositiveMatch = taskTerms.length > 0 || Boolean(scope);
  const ranked = assets
    .filter((asset) => isUsefulPinnedAsset(asset) && isRelevantToScopedPinnedContext(asset, scope))
    .map((asset, index) => ({
      asset,
      score: scorePin(asset, taskTerms, scope)
        + ((styleFocused && isDurablePinAsset(asset)) ? 2 : 0)
        - index * 0.01,
    }))
    .filter((item) =>
      (!requirePositiveMatch || item.score > 0) &&
      (!styleFocused || isDurablePinAsset(item.asset)),
    )
    .sort((a, b) => b.score - a.score);

  return dedupeText(
    ranked
      .slice(0, Math.max(limit * 2, 4))
      .map(({ asset }) => formatPinnedContext(asset, taskTerms)),
    limit,
  );
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

export function taskMentionsScopeIdentity(taskSeed: string | undefined, scope?: string): boolean {
  if (!taskSeed) return false;
  const identityTerms = buildScopeIdentityTerms(scope);
  if (identityTerms.length === 0) return false;

  const haystack = normalizeText(`${taskSeed} ${buildTaskHintTerms(taskSeed).join(" ")}`);
  return identityTerms.some((term) => haystack.includes(term));
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
    checkpoint.task ? `Checkpoint focus: ${checkpoint.task}` : "",
    checkpoint.summary ? `Checkpoint summary: ${checkpoint.summary}` : "",
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
