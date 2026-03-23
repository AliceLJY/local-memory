import type { RetrievalContext } from "./retriever.js";

function normalizeScopeValue(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return trimmed || undefined;
}

function envScopeCandidate(env: NodeJS.ProcessEnv): { scope?: string; inferredFrom?: string } {
  const explicitEnvKeys = [
    "RECALLNEST_DEFAULT_SCOPE",
    "RECALLNEST_SCOPE",
    "RECALLNEST_PROJECT_SCOPE",
  ] as const;

  for (const key of explicitEnvKeys) {
    const value = normalizeScopeValue(env[key]);
    if (value) {
      return {
        scope: value,
        inferredFrom: key,
      };
    }
  }

  const sessionId = normalizeScopeValue(env.RECALLNEST_SESSION_ID);
  if (sessionId) {
    return {
      scope: `session:${sessionId}`,
      inferredFrom: "RECALLNEST_SESSION_ID",
    };
  }

  return {};
}

export function resolveSessionScope(sessionId?: string): string | undefined {
  const normalized = normalizeScopeValue(sessionId);
  return normalized ? `session:${normalized}` : undefined;
}

export function matchesScopeFilter(rowScope: string, scopeFilter?: string[]): boolean {
  if (!scopeFilter || scopeFilter.length === 0) return true;
  return scopeFilter.some((scope) => scope.includes(":") ? rowScope === scope : rowScope.startsWith(scope));
}

export interface ScopeSelectionOptions {
  scope?: string;
  sessionId?: string;
  allScopes?: boolean;
  operation: string;
  env?: NodeJS.ProcessEnv;
  allowUnscoped?: boolean;
}

export interface ScopeSelection {
  allScopes: boolean;
  resolvedScope?: string;
  scopeFilter?: string[];
  inferredFrom?: string;
}

export function resolveScopeSelection(options: ScopeSelectionOptions): ScopeSelection {
  if (options.allScopes) {
    return {
      allScopes: true,
      scopeFilter: undefined,
      inferredFrom: "allScopes",
    };
  }

  const explicitScope = normalizeScopeValue(options.scope);
  if (explicitScope) {
    return {
      allScopes: false,
      resolvedScope: explicitScope,
      scopeFilter: [explicitScope],
      inferredFrom: "scope",
    };
  }

  const sessionScope = resolveSessionScope(options.sessionId);
  if (sessionScope) {
    return {
      allScopes: false,
      resolvedScope: sessionScope,
      scopeFilter: [sessionScope],
      inferredFrom: "sessionId",
    };
  }

  const envSelection = envScopeCandidate(options.env || process.env);
  if (envSelection.scope) {
    return {
      allScopes: false,
      resolvedScope: envSelection.scope,
      scopeFilter: [envSelection.scope],
      inferredFrom: envSelection.inferredFrom,
    };
  }

  if (options.allowUnscoped) {
    return {
      allScopes: false,
      scopeFilter: undefined,
    };
  }

  throw new Error(
    `${options.operation} requires a scope. Pass scope explicitly, provide sessionId, or set ` +
    `RECALLNEST_DEFAULT_SCOPE / RECALLNEST_SCOPE / RECALLNEST_SESSION_ID. ` +
    `Use allScopes=true only for explicit cross-scope reads.`,
  );
}

export function buildRetrievalContext(
  base: Omit<RetrievalContext, "scopeFilter"> & {
    scope?: string;
    sessionId?: string;
    allScopes?: boolean;
  },
  options: Pick<ScopeSelectionOptions, "operation" | "env" | "allowUnscoped">,
): RetrievalContext {
  const selection = resolveScopeSelection({
    scope: base.scope,
    sessionId: base.sessionId,
    allScopes: base.allScopes,
    operation: options.operation,
    env: options.env,
    allowUnscoped: options.allowUnscoped,
  });

  return {
    query: base.query,
    limit: base.limit,
    category: base.category,
    source: base.source,
    includeArchived: base.includeArchived,
    trace: base.trace,
    scopeFilter: selection.scopeFilter,
  };
}
