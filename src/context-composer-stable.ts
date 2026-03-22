import type { PinAsset } from "./memory-assets.js";
import type { RetrievalResult } from "./retriever.js";
import type { SessionCheckpointRecord } from "./session-schema.js";
import { selectPinnedContext } from "./context-composer-pins.js";
import { cleanText, dedupeText } from "./context-composer-text.js";
import { selectStableResults } from "./context-composer-stable-selection.js";
import {
  TASK_CUE_EXTRACTION_LIMIT,
  buildTaskHintTerms,
  containsLowSignalStableTerm,
  extractTerms,
  looksLikeContinuityTask,
  looksLikeStableInstruction,
  normalizeText,
} from "./term-registry.js";

export type { StableCategory } from "./context-composer-stable-selection.js";

const TASK_FOCUS_LOW_SIGNAL_TERMS = new Set([
  "context",
  "composer",
  "helper",
  "boundary",
  "刚才",
  "那个",
  "audit",
  "ranking",
  "scoring",
  "selection",
  "orchestration",
  "stable",
  "fallback",
  "cleanup",
  "regression",
  "hardening",
  "issue",
  "error",
  "problem",
  "calling",
  "窗口",
  "window",
  "系统",
  "system",
]);

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

  const candidates = dedupeText([
    ...buildTaskHintTerms(taskSeed),
    ...extractTerms(taskSeed, TASK_CUE_EXTRACTION_LIMIT),
  ], TASK_CUE_EXTRACTION_LIMIT)
    .filter((term) => {
      const normalized = normalizeText(term);
      if (!normalized || normalized.length < 2) return false;
      if (looksLikeStableInstruction(normalized)) return false;
      if (containsLowSignalStableTerm(normalized)) return false;

      if (/^[a-z0-9._/-]+$/i.test(term)) {
        return term.length >= 3;
      }

      return (
        term.includes("记忆") ||
        term.includes("项目") ||
        term.includes("连续") ||
        term.includes("文章") ||
        term.includes("写作") ||
        term.includes("配图") ||
        term.includes("封面") ||
        term.includes("终端") ||
        term.includes("窗口") ||
        normalized.includes("memory") ||
        normalized.includes("layer") ||
        normalized.includes("nest")
      );
    });
  const preferredCandidates = candidates.filter((term) => !TASK_FOCUS_LOW_SIGNAL_TERMS.has(normalizeText(term)));
  const selectedCandidates = (preferredCandidates.length > 0 ? preferredCandidates : candidates)
    .slice(0, limit);

  return dedupeText(selectedCandidates.map((term) => `Task focus: ${term}`), limit);
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
  const taskHints = buildTaskHintTerms(taskSeed);
  const suppressPinnedContextForGenericContinuity = Boolean(
    !styleFocusedTask &&
    taskHints.length === 0 &&
    looksLikeContinuityTask(taskSeed) &&
    (entityContext.length > 0 || checkpointContext.length > 0)
  );
  const pinnedContext = suppressPinnedContextForGenericContinuity
    ? []
    : selectPinnedContext(pinAssets, {
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
