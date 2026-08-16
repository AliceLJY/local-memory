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

/**
 * scope 过滤的匹配模式（2026-08-16 加，互审 C1/K3 双方独立命中）。
 *
 * - `family`（默认，历史行为）：**由 scope 字符串里有没有冒号隐式决定** —— 含冒号走精确，
 *   不含冒号走前缀。`search_memory` 等靠它做 `project` → `project:*` 的家族匹配。
 * - `exact`：调用方明说"我给的就是一个具体 scope 名"，一律精确匹配。
 *
 * 为什么要显式模式：隐式规则在调用方**拿真实 scope 名当参数**时会失效——真实 scope 名
 * 里恰好没有冒号（`memory` / `cc` / `global`），于是被当成 family selector。
 * 实测后果：weekly `dream --scope memory` 借前缀把 `memory:pivot`（手写提炼层）
 * 一起卷进同一轮聚类，14 条 insight 的来源横跨两个 scope（2026-08-16 查库坐实）。
 * 修法不是改默认语义（会伤 search_memory），是让 dream 这类"喂具体 scope 名"的
 * 入口显式声明 exact。
 */
export type ScopeMatchMode = "exact" | "family";

export function matchesScopeFilter(
  rowScope: string,
  scopeFilter?: string[],
  mode: ScopeMatchMode = "family",
): boolean {
  if (!scopeFilter || scopeFilter.length === 0) return true;
  if (mode === "exact") return scopeFilter.some((scope) => rowScope === scope);
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
    graph: base.graph,
    topicTag: base.topicTag,
    reconstruct: base.reconstruct,
    validAt: base.validAt,
    includeExpired: base.includeExpired,
    scopeFilter: selection.scopeFilter,
  };
}
