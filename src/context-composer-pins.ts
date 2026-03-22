import type { PinAsset } from "./memory-assets.js";
import { extractBoundaryMetadata, extractCanonicalKey } from "./memory-boundaries.js";
import { buildProjectScopeCueTerms, normalizeScopedValue } from "./context-composer-scope.js";
import { cleanText, dedupeText, stripConversationMarkers } from "./context-composer-text.js";
import {
  TASK_CUE_EXTRACTION_LIMIT,
  buildTaskHintTerms,
  containsLowSignalStableTerm,
  extractTerms,
  looksLikeLowSignalTaskResult,
  looksLikePlanishTaskResult,
  looksLikeStableInstruction,
  normalizeText,
} from "./term-registry.js";

function isUsefulPinnedTaskTerm(term: string): boolean {
  const normalized = normalizeText(term);
  if (!normalized) return false;
  if (looksLikeStableInstruction(normalized)) return false;
  if (containsLowSignalStableTerm(normalized)) return false;
  if (normalized.includes("刚才")) return false;
  if (normalized.endsWith("那个") || normalized === "那个") return false;
  if (["窗口", "window", "系统", "system", "项目", "project"].includes(normalized)) return false;

  if (/[\p{Script=Han}]/u.test(term)) {
    return normalized.length >= 3;
  }

  return normalized.length >= 4;
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

export function selectPinnedContext(
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

  const taskTerms = dedupeText([
    ...buildTaskHintTerms(taskSeed),
    ...extractTerms(taskSeed, TASK_CUE_EXTRACTION_LIMIT).filter((term) => isUsefulPinnedTaskTerm(term)),
    ...(styleFocused ? ["写作", "文章", "风格", "语气", "口语化", "不端着", "自嘲", "style", "tone", "voice"] : []),
  ], 24);
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
