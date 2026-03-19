import { dedupeText } from "./context-composer-text.js";
import {
  GENERIC_SCOPE_TERMS,
  buildTaskHintTerms,
  extractTerms,
  normalizeText,
} from "./term-registry.js";

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

export function taskMentionsScopeIdentity(taskSeed: string | undefined, scope?: string): boolean {
  if (!taskSeed) return false;
  const identityTerms = buildScopeIdentityTerms(scope);
  if (identityTerms.length === 0) return false;

  const haystack = normalizeText(`${taskSeed} ${buildTaskHintTerms(taskSeed).join(" ")}`);
  return identityTerms.some((term) => haystack.includes(term));
}
