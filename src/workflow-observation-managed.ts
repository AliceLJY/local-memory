import type { ResumeContextRequest, ResumeContextResponse } from "./session-schema.js";
import type { SessionCheckpointBuildResult } from "./session-engine.js";
import type { WorkflowObservationInput } from "./workflow-observation-schema.js";

const MANAGED_SOURCE = "managed";
const MANAGED_TAGS = ["continuity", "managed"];

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function resolveObservationScope(
  request: Pick<ResumeContextRequest, "scope" | "sessionId">,
  response?: Pick<ResumeContextResponse, "resolvedScope" | "latestCheckpoint">,
): string | undefined {
  return request.scope
    || (request.sessionId ? `session:${request.sessionId}` : undefined)
    || response?.resolvedScope
    || response?.latestCheckpoint?.resolvedScope;
}

export function buildManagedResumeObservation(
  request: Pick<ResumeContextRequest, "scope" | "sessionId" | "task">,
  response: Pick<ResumeContextResponse, "stableContext" | "relevantPatterns" | "recentCases" | "latestCheckpoint" | "responseMode" | "resolvedScope">,
): WorkflowObservationInput {
  const stableCount = response.stableContext.length;
  const patternCount = response.relevantPatterns.length;
  const caseCount = response.recentCases.length;
  const checkpointText = response.latestCheckpoint ? " plus the latest checkpoint" : "";
  return {
    workflowId: "resume_context",
    outcome: "success",
    summary: response.responseMode === "recall-only"
      ? `Managed resume_context recovered ${stableCount} stable item(s) in recall-only mode${checkpointText}.`
      : `Managed resume_context recovered ${stableCount} stable item(s), ${patternCount} pattern(s), and ${caseCount} case(s)${checkpointText}.`,
    scope: resolveObservationScope(request, response),
    source: MANAGED_SOURCE,
    signal: response.responseMode === "recall-only" ? "managed-recall-resolved" : "managed-resume-resolved",
    task: request.task,
    tags: dedupeTags([
      ...MANAGED_TAGS,
      response.responseMode === "recall-only" ? "recall-only" : "startup-recovery",
    ]),
    tools: ["resume_context"],
  };
}

function formatCheckpointFieldList(fields: string[]): string {
  if (fields.length === 1) return fields[0];
  if (fields.length === 2) return `${fields[0]} and ${fields[1]}`;
  return `${fields.slice(0, -1).join(", ")}, and ${fields[fields.length - 1]}`;
}

export function buildManagedCheckpointObservation(
  result: SessionCheckpointBuildResult,
): WorkflowObservationInput {
  const corrected = result.sanitization.changed;
  const fieldText = formatCheckpointFieldList(result.sanitization.changedFields);
  return {
    workflowId: "checkpoint_session",
    outcome: corrected ? "corrected" : "success",
    summary: corrected
      ? `Managed checkpoint_session sanitized repo-state text out of ${fieldText} before saving the handoff.`
      : "Managed checkpoint_session saved a handoff without repo-state corrections.",
    scope: result.record.resolvedScope,
    source: MANAGED_SOURCE,
    signal: corrected ? "repo-state-sanitized" : "checkpoint-saved",
    task: result.record.task,
    tags: dedupeTags([
      ...MANAGED_TAGS,
      corrected ? "sanitized" : "handoff-saved",
    ]),
    tools: ["checkpoint_session"],
  };
}
