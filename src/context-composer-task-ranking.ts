import { extractBoundaryMetadata, extractCanonicalKey } from "./memory-boundaries.js";
import { cleanText, stripConversationMarkers } from "./context-composer-text.js";
import type { RetrievalResult } from "./retriever.js";
import {
  CASE_CUE_TERMS,
  WORKFLOW_CUE_TERMS,
  containsAnyTerm,
  countTermHits,
  looksLikeLowSignalTaskResult,
  looksLikePlanishTaskResult,
  normalizeText,
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
  const normalizedTools = Array.isArray(pattern.tools)
    ? pattern.tools.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const steps = Array.isArray(pattern.steps)
    ? pattern.steps.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  const parts = [
    title ? `Workflow pattern: ${title}` : "",
    normalizedTools.length > 0 ? `Tools: ${normalizedTools.join(", ")}` : "",
    trigger ? `Use when: ${trigger}` : "",
    steps.length > 0
      ? `Steps: ${steps.slice(0, 1).map((step, index) => `${index + 1}. ${step}`).join(" ")}`
      : "",
  ].filter(Boolean);

  return cleanText(parts.join(" "), 220);
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
    (normalized.includes("problem:") && (
      normalized.includes("solution:") ||
      normalized.includes("fix:") ||
      normalized.includes("resolved:") ||
      normalized.includes("workaround:")
    )) ||
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

export function formatTaskResult(result: RetrievalResult): string {
  if (result.entry.category === "patterns") {
    return formatWorkflowPatternResult(result);
  }
  return cleanText(stripConversationMarkers(result.entry.text), 220);
}

export function isDurableMemoryScope(scope: string): boolean {
  return scope.startsWith("memory:") || scope.startsWith("asset:");
}

export function scoreWorkflowCandidate(result: RetrievalResult, scope?: string): number {
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

export function isDurableTaskCandidate(result: RetrievalResult): boolean {
  if (isDurableMemoryScope(result.entry.scope)) return true;
  return extractBoundaryMetadata(result.entry.metadata)?.layer === "durable";
}

export function taskResultKey(result: RetrievalResult): string {
  return extractCanonicalKey(result.entry.metadata) || normalizeText(stripConversationMarkers(result.entry.text));
}

export function scoreTaskCandidate(category: TaskCategory, result: RetrievalResult): number {
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

export function isTaskCandidateUseful(category: TaskCategory, result: RetrievalResult): boolean {
  const stripped = stripConversationMarkers(result.entry.text);
  const normalized = normalizeText(stripped);
  if (!normalized || normalized.length < 12) return false;
  if (looksLikeLowSignalTaskResult(normalized)) return false;
  const cueTerms = category === "patterns" ? WORKFLOW_CUE_TERMS : CASE_CUE_TERMS;
  const cueHits = countTermHits(normalized, cueTerms);
  const structured = looksLikeStructuredTaskResult(category, stripped);
  const durable = isDurableTaskCandidate(result);
  const canonicalKey = extractCanonicalKey(result.entry.metadata);
  const durableMemoryScope = isDurableMemoryScope(result.entry.scope);

  if (durable) {
    if (looksLikePlanishTaskResult(normalized) && !structured) return false;
    if (category === "cases" && !structured && !durableMemoryScope && !canonicalKey) return false;
    return structured || cueHits > 0 || result.entry.category === category;
  }

  // Non-durable pattern and case hits are often transcript fragments or
  // maintenance notes that happen to mention workflow/case cues. Keep them
  // out unless they are explicitly structured.
  if (category === "patterns" && !structured) return false;
  if (category === "cases" && !structured) return false;

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
