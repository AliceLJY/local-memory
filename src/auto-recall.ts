import { composeResumeContext, type ResumeContextDeps } from "./context-composer.js";
import { resolveTier } from "./decay-engine.js";
import type { DurableMemoryCategory } from "./memory-schema.js";
import {
  classifyRecallGate,
  logRecallGateShadow,
  resolveRecallGateMode,
  type RecallGateResult,
} from "./recall-gate.js";
import { governResults, truncateQuery, type GovernorConfig, type GovernorSession } from "./recall-governor.js";
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
  /** Governor config overrides (charBudget, maxItems, maxQueryChars) */
  governor?: Partial<GovernorConfig>;
  /** Governor session for cross-call dedup within a single conversation turn */
  governorSession?: GovernorSession;
}

export interface AutoRecallResponse {
  mode: "resume-only" | "resume+search";
  resolvedScope?: string;
  resume: ResumeContextResponse;
  results: RetrievalResult[];
  searchSkippedReason?: string;
}

/** Minimal valid ResumeContextResponse for enforce-mode skip-all short-circuits. */
function emptyResumeContext(): ResumeContextResponse {
  return {
    summary: "",
    stableContext: [],
    relevantPatterns: [],
    recentCases: [],
    injectionHint: "user_attachment",
    ephemeral: true,
    responseMode: "default",
    generatedAt: new Date().toISOString(),
  };
}

export async function runAutoRecall(
  deps: ResumeContextDeps,
  request: AutoRecallRequest,
): Promise<AutoRecallResponse> {
  const govCfg = request.governor;
  const maxQ = govCfg?.maxQueryChars ?? 1000;
  const message = truncateQuery(request.message.replace(/\s+/g, " ").trim(), maxQ);
  const task = truncateQuery((request.task || message).replace(/\s+/g, " ").trim(), maxQ);

  if (!message) {
    throw new Error("message is required");
  }

  // Recall gate (mlp adaptive-retrieval borrow, three-way per Codex review).
  // Sits BEFORE composeResumeContext — compose itself hits the retriever, so a
  // gate placed after it would save nothing. Default mode is observe: verdicts
  // are computed and shadow-logged but behavior is unchanged until real-sample
  // false-positive rates have been reviewed (shared-behaviors §5).
  const gateMode = resolveRecallGateMode(request.env);
  let gateVerdict: RecallGateResult | undefined;
  if (gateMode !== "off") {
    gateVerdict = classifyRecallGate(message);
    logRecallGateShadow({
      ts: new Date().toISOString(),
      decision: gateVerdict.decision,
      ruleId: gateVerdict.ruleId,
      msgLen: message.length,
      mode: gateMode,
      source: request.operation,
    });
    if (gateMode === "enforce" && gateVerdict.decision === "skip-all") {
      return {
        mode: "resume-only",
        resolvedScope: undefined,
        resume: emptyResumeContext(),
        results: [],
        searchSkippedReason: `recall-gate: skip-all (${gateVerdict.ruleId})`,
      };
    }
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

  // Continuity nudges ("继续", "下一步") want the resume context they just got,
  // not an embedding search over their own two characters.
  if (gateMode === "enforce" && gateVerdict?.decision === "resume-only") {
    return {
      mode: "resume-only",
      resolvedScope: resume.resolvedScope || resume.latestCheckpoint?.resolvedScope || scopeSelection.resolvedScope,
      resume,
      results: [],
      searchSkippedReason: `recall-gate: resume-only (${gateVerdict.ruleId})`,
    };
  }

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
    const tier = resolveTier(r.entry.metadata, r.entry.importance);
    if (tier === "core" || tier === "working") {
      promoted.push(r);
    } else {
      demoted.push({ ...r, score: r.score * 0.85 });
    }
  }
  const tierFiltered = [...promoted, ...demoted]
    .sort((a, b) => b.score - a.score)
    .slice(0, effectiveLimit);

  // LME-7: Recall Governor — evolution filter, budget control, session dedup
  const results = governResults(tierFiltered, request.governorSession, govCfg);

  return {
    mode: "resume+search",
    resolvedScope,
    resume,
    results,
  };
}
