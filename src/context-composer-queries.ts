import type { StableCategory } from "./context-composer-stable.js";
import { cleanText, dedupeText } from "./context-composer-text.js";
import type { TaskCategory } from "./context-composer-task-results.js";
import {
  containsAnyTerm,
  extractTerms,
  looksLikeStyleTask,
} from "./term-registry.js";

export function buildStableQuery(category: StableCategory, taskSeed?: string): string {
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

export function buildStylePreferenceFallbackQuery(taskSeed?: string): string {
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

export function buildTaskQuery(category: TaskCategory, taskSeed?: string): string {
  if (taskSeed) {
    return category === "patterns"
      ? `${taskSeed} reusable workflow pattern steps`
      : `${taskSeed} similar solved case previous fix`;
  }
  return category === "patterns"
    ? "reusable workflow pattern steps"
    : "similar solved case previous fix";
}

export function buildScopedEntityFallbackQuery(scope?: string, taskSeed?: string): string {
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

export function buildAssociativeNestEntityFallbackQuery(taskSeed?: string): string {
  if (!taskSeed || !containsAnyTerm(taskSeed, ["RecallNest", "recallnest", "Nest", "nest"])) {
    return "";
  }

  const taskTerms = extractTerms(taskSeed).slice(0, 4);
  const query = dedupeText([
    ...taskTerms,
    "RecallNest",
    "checkpoint_session",
    "resume_context",
    "store_memory",
    "memory system",
    "记忆系统",
    "continuity",
    "project entity",
  ], 10).join(" ");

  return query || "RecallNest checkpoint_session resume_context store_memory memory system continuity project entity";
}

export function formatLatestCheckpointHeadline(
  sessionId: string,
  updatedAt: string,
  summary: string,
): string {
  return `Latest checkpoint from ${sessionId} on ${updatedAt.slice(0, 10)}: ${cleanText(summary, 220)}`;
}
