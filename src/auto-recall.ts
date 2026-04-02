import { composeResumeContext, type ResumeContextDeps } from "./context-composer.js";
import { resolveTier } from "./decay-engine.js";
import type { DurableMemoryCategory } from "./memory-schema.js";
import type { RetrievalResult } from "./retriever.js";
import { buildRetrievalContext, resolveScopeSelection } from "./scope-policy.js";
import type { RetrievalProfileName, ResumeContextResponse } from "./session-schema.js";

export interface AutoRecallRequest {
  message: string;
  task?: string;
  scope?: string;
  sessionId?: string;
  allScopes?: boolean;
  limit?: number;
  limitPerSection?: number;
  includeLatestCheckpoint?: boolean;
  category?: DurableMemoryCategory;
  profile?: RetrievalProfileName;
  env?: NodeJS.ProcessEnv;
  operation?: string;
}

export interface AutoRecallResponse {
  mode: "resume-only" | "resume+search";
  resolvedScope?: string;
  resume: ResumeContextResponse;
  results: RetrievalResult[];
  searchSkippedReason?: string;
}

export async function runAutoRecall(
  deps: ResumeContextDeps,
  request: AutoRecallRequest,
): Promise<AutoRecallResponse> {
  const message = request.message.replace(/\s+/g, " ").trim();
  const task = (request.task || message).replace(/\s+/g, " ").trim();

  if (!message) {
    throw new Error("message is required");
  }

  const scopeSelection = resolveScopeSelection({
    scope: request.scope,
    sessionId: request.sessionId,
    allScopes: request.allScopes,
    operation: request.operation || "auto_recall",
    env: request.env,
    allowUnscoped: true,
  });
  const resumeScope = scopeSelection.inferredFrom === "sessionId"
    ? undefined
    : scopeSelection.resolvedScope;

  const resume = await composeResumeContext(deps, {
    task,
    scope: resumeScope,
    sessionId: request.sessionId,
    limitPerSection: request.limitPerSection,
    includeLatestCheckpoint: request.includeLatestCheckpoint,
    profile: request.profile,
  });

  const resolvedScope = request.allScopes
    ? undefined
    : (resume.resolvedScope || resume.latestCheckpoint?.resolvedScope || scopeSelection.resolvedScope);
  if (!request.allScopes && !resolvedScope) {
    return {
      mode: "resume-only",
      resolvedScope,
      resume,
      results: [],
      searchSkippedReason: "No explicit or inferred scope available for focused recall; returning resume context only.",
    };
  }

  const effectiveLimit = request.limit || 5;
  // Fetch extra candidates so tier filtering still yields enough results
  const rawResults = await deps.retriever.retrieve(buildRetrievalContext({
    query: message,
    limit: effectiveLimit * 3,
    category: request.category,
    scope: resolvedScope,
    sessionId: request.sessionId,
    allScopes: request.allScopes,
    source: "auto-recall",
  }, {
    operation: request.operation || "auto_recall",
    env: request.env,
    allowUnscoped: request.allScopes === true,
  }));

  // Tier-aware filtering: prefer core/working memories, backfill with peripheral.
  // Peripheral memories get a 15% score discount to reduce noise injection.
  const promoted: RetrievalResult[] = [];
  const demoted: RetrievalResult[] = [];
  for (const r of rawResults) {
    const tier = resolveTier(r.entry.metadata);
    if (tier === "core" || tier === "working") {
      promoted.push(r);
    } else {
      demoted.push({ ...r, score: r.score * 0.85 });
    }
  }
  const results = [...promoted, ...demoted]
    .sort((a, b) => b.score - a.score)
    .slice(0, effectiveLimit);

  return {
    mode: "resume+search",
    resolvedScope,
    resume,
    results,
  };
}
