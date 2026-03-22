import { containsAnyTerm, taskCueCoverage } from "./term-registry.js";

export function buildWorkflowFallbackQuery(taskSeed?: string): string {
  if (taskSeed) {
    return `${taskSeed} search_memory resume_context checkpoint_session checkpoint autoRecall sessionStrategy workflow pattern steps`;
  }
  return "search_memory resume_context checkpoint_session checkpoint autoRecall sessionStrategy workflow pattern steps";
}

export function buildCaseFallbackQuery(taskSeed?: string): string {
  if (taskSeed) {
    if (containsAnyTerm(taskSeed, ["RecallNest", "recallnest"])) {
      return `${taskSeed} scope fallback project scope handoff stable context cleanup continuity durable case 项目范围 交接 稳定上下文 问题 解决 方案 排查`;
    }
    return `${taskSeed} case solution fix root cause workaround cleanup continuity 问题 解决 方案 排查`;
  }
  return "case solution fix root cause workaround cleanup continuity 问题 解决 方案 排查";
}

export function buildContinuityFallbackPatterns(limit: number, existingItems: string[] = []): string[] {
  const patterns = [
    "Start fresh windows with resume_context before coding so stable context is restored early.",
    "If resume_context still leaves gaps, run search_memory with the project name and task nouns before repo exploration drifts.",
    "Before leaving a window, save checkpoint_session so the next session can recover decisions and next actions.",
  ];
  if (existingItems.length === 0) {
    return patterns.slice(0, limit);
  }

  const coveredCues = new Set(existingItems.flatMap((item) => taskCueCoverage("patterns", item)));
  return patterns
    .filter((pattern) =>
      taskCueCoverage("patterns", pattern).some((term) => !coveredCues.has(term))
    )
    .slice(0, limit);
}
