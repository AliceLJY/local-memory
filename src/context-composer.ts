import { listPinAssets, type PinAsset } from "./memory-assets.js";
import { extractBoundaryMetadata, extractCanonicalKey, shouldUseStableMemoryResult } from "./memory-boundaries.js";
import type { RetrievalContext, RetrievalResult } from "./retriever.js";
import type { ResumeContextResponse, SessionCheckpointRecord } from "./session-schema.js";
import { ResumeContextRequestSchema, ResumeContextResponseSchema } from "./session-schema.js";
import {
  CASE_CUE_TERMS,
  GENERIC_ENTITY_TASK_TERMS,
  GENERIC_SCOPE_TERMS,
  STRONG_WORKFLOW_CUE_TERMS,
  TASK_RESULT_SPECIFICITY_GROUPS,
  WORKFLOW_CUE_TERMS,
  buildTaskHintTerms,
  containsAnyTerm,
  containsLowSignalStableTerm,
  countTermHits,
  extractTerms,
  looksLikeCaseFallbackTask,
  looksLikeContinuityTask,
  looksLikeLowSignalTaskResult,
  looksLikePlanishTaskResult,
  looksLikeRecallOnlyTask,
  looksLikeStableInstruction,
  looksLikeStyleTask,
  normalizeText,
  taskCueCoverage,
} from "./term-registry.js";

type StableCategory = "profile" | "preferences" | "entities";
type TaskCategory = "patterns" | "cases";
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

const STABLE_CATEGORY_LABELS: Record<StableCategory, string> = {
  profile: "Profile",
  preferences: "Preference",
  entities: "Entity",
};

function cleanText(text: string, maxLen: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

function stripConversationMarkers(text: string): string {
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

function dedupeText(items: string[], limit: number): string[] {
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

function normalizeScopedValue(scope: string): string {
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

function buildProjectScopeCueTerms(scope?: string): string[] {
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

function taskMentionsScopeIdentity(taskSeed: string | undefined, scope?: string): boolean {
  if (!taskSeed) return false;
  const identityTerms = buildScopeIdentityTerms(scope);
  if (identityTerms.length === 0) return false;

  const haystack = normalizeText(`${taskSeed} ${buildTaskHintTerms(taskSeed).join(" ")}`);
  return identityTerms.some((term) => haystack.includes(term));
}

function countTaskHintMatches(result: RetrievalResult, taskSeed?: string): number {
  const hintTerms = buildTaskHintTerms(taskSeed);
  if (hintTerms.length === 0) return 0;

  const haystack = normalizeText(stripConversationMarkers(result.entry.text));
  return hintTerms.filter((term) => haystack.includes(term)).length;
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

function buildWorkflowFallbackQuery(taskSeed?: string): string {
  if (taskSeed) {
    return `${taskSeed} search_memory resume_context checkpoint_session checkpoint autoRecall sessionStrategy workflow pattern steps`;
  }
  return "search_memory resume_context checkpoint_session checkpoint autoRecall sessionStrategy workflow pattern steps";
}

function buildCaseFallbackQuery(taskSeed?: string): string {
  if (taskSeed) {
    return `${taskSeed} case solution fix root cause workaround cleanup continuity 问题 解决 方案 排查`;
  }
  return "case solution fix root cause workaround cleanup continuity 问题 解决 方案 排查";
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

function buildContinuityFallbackPatterns(limit: number): string[] {
  const patterns = [
    "Start fresh windows with resume_context before coding so stable context is restored early.",
    "Before leaving a window, save checkpoint_session so the next session can recover decisions and next actions.",
  ];
  return patterns.slice(0, limit);
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

  if (params.scope && resultScope === requestScope) return true;

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
      formatted: formatTaskResult(result),
    }))
    .sort((a, b) => b.score - a.score);

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
        const value = item.score + uncoveredCueCount * 3;
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
  const profileContext = selectStableResults("profile", profileResults, Math.max(2, stableLimit), {
    taskSeed,
    styleFocused: styleFocusedTask,
    scope: resolvedScope,
  });
  const preferenceContext = selectStableResults("preferences", preferenceResults, Math.max(2, stableLimit), {
    taskSeed,
    styleFocused: styleFocusedTask,
    scope: resolvedScope,
  });
  const entityContext = selectStableResults("entities", entityResults, Math.max(2, stableLimit), {
    taskSeed,
    styleFocused: styleFocusedTask,
    scope: resolvedScope,
  });
  const checkpointContext = buildCheckpointStableContext(latestCheckpoint, Math.min(3, stableLimit));
  const pinnedContext = selectPinnedContext(pinAssets, {
    taskSeed,
    scope: resolvedScope,
    limit: Math.min(2, stableLimit),
    styleFocused: styleFocusedTask,
    skipForStyleTask: styleFocusedTask && preferenceContext.length > 0,
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

  const retrievedPatterns = selectTaskResults("patterns", patternResults, taskLimit, {
    scope: resolvedScope,
    taskSeed,
  });
  const workflowFallbackResults = !continuityTask || countPatternCueCoverage(retrievedPatterns) >= 3
    ? []
    : await retrieveCandidates(deps.retriever, {
        query: buildWorkflowFallbackQuery(taskSeed),
        limit: Math.max(4, taskLimit * 2),
        scope: resolvedScope,
      });
  const fallbackPatterns = selectWorkflowFallbackCandidates(workflowFallbackResults, {
    scope: resolvedScope,
    taskSeed,
    limit: taskLimit,
    cueTerms: STRONG_WORKFLOW_CUE_TERMS,
  });
  const continuityFallbackPatterns = continuityTask && retrievedPatterns.length === 0 && fallbackPatterns.length === 0
    ? buildContinuityFallbackPatterns(taskLimit)
    : [];
  const relevantPatterns = selectRelevantPatterns([
    ...retrievedPatterns.map((text) => ({ text, sourcePriority: 3 })),
    ...fallbackPatterns.map((text) => ({ text, sourcePriority: 2 })),
    ...continuityFallbackPatterns.map((text) => ({ text, sourcePriority: 1 })),
  ], taskLimit);
  const retrievedCases = selectTaskResults("cases", caseResults, taskLimit, {
    scope: resolvedScope,
    taskSeed,
  });
  const caseFallbackResults = retrievedCases.length > 0 || (!latestCheckpoint && !looksLikeCaseFallbackTask(taskSeed))
    ? []
    : await retrieveCandidates(deps.retriever, {
        category: "cases",
        query: buildCaseFallbackQuery(taskSeed),
        limit: Math.max(4, taskLimit * 2),
        scope: resolvedScope,
      });
  const fallbackCases = selectTaskResults("cases", caseFallbackResults, taskLimit, {
    scope: resolvedScope,
    taskSeed,
  });
  const recentCases = dedupeText([
    ...retrievedCases,
    ...fallbackCases,
  ], taskLimit);

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
