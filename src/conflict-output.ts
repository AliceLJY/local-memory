import type { ConflictCandidateRecord, ConflictResolutionResult } from "./conflict-schema.js";
import type { ConflictAuditSummary, ConflictClusterSummary } from "./conflict-advisor.js";
import { summarizeConflictAdvice } from "./conflict-advisor.js";
import { summarizeConflictLifecycle } from "./conflict-lifecycle.js";
import type { EscalateConflictsResult } from "./conflict-schema.js";

export interface ConflictAuditRenderOptions {
  generatedAt: string;
  limit: number;
  top: number;
  status?: string;
  canonicalKey?: string;
}

function shortAdviceLabel(record: ConflictCandidateRecord): string {
  const advice = summarizeConflictAdvice(record);
  const action = advice.suggestedResolution === "keep_existing"
    ? "keep"
    : advice.suggestedResolution === "accept_incoming"
      ? "accept"
      : "review";
  const confidence = advice.confidence === "high"
    ? "h"
    : advice.confidence === "medium"
      ? "m"
      : "l";
  return `${action}[${confidence}]`;
}

export function formatConflictList(records: ConflictCandidateRecord[]): string {
  if (records.length === 0) return "No conflicts found.";

  const lines = [
    "ID       Status             Attention   Advice     Category     Canonical key                   Updated      Existing -> Incoming",
    "-------- ------------------ ----------  ---------  ------------ ------------------------------ ----------  ------------------------------",
  ];

  for (const record of records) {
    const lifecycle = summarizeConflictLifecycle(record);
    lines.push(
      `${record.conflictId.slice(0, 8).padEnd(8)} ${record.status.padEnd(18)} ${lifecycle.attention.padEnd(10)} ${shortAdviceLabel(record).padEnd(9)} ${record.category.padEnd(12)} ${record.canonicalKey.slice(0, 30).padEnd(30)} ${record.updatedAt.slice(0, 10)}  ${record.existing.memoryId.slice(0, 8)} -> ${record.incoming.sourceMemoryId?.slice(0, 8) || "manual"}`,
    );
  }

  return lines.join("\n");
}

export function formatConflictClusters(clusters: ConflictClusterSummary[]): string {
  if (clusters.length === 0) return "No conflict clusters found.";

  const lines = [
    "Cluster                          Attention   Open/All  Advice     Category     Canonical key                   Latest      Latest ID",
    "------------------------------  ----------  --------  ---------  ------------ ------------------------------ ----------  --------",
  ];

  for (const cluster of clusters) {
    const action = cluster.suggestedResolution === "keep_existing"
      ? "keep"
      : cluster.suggestedResolution === "accept_incoming"
        ? "accept"
        : "review";
    const confidence = cluster.confidence === "high"
      ? "h"
      : cluster.confidence === "medium"
        ? "m"
        : "l";
    lines.push(
      `${cluster.clusterKey.slice(0, 30).padEnd(30)}  ${cluster.attention.padEnd(10)}  ${`${cluster.openCount}/${cluster.totalCount}`.padEnd(8)}  ${`${action}[${confidence}]`.padEnd(9)} ${cluster.category.padEnd(12)} ${cluster.canonicalKey.slice(0, 30).padEnd(30)} ${cluster.latestUpdatedAt.slice(0, 10)}  ${cluster.latestConflictId.slice(0, 8)}`,
    );
  }

  return lines.join("\n");
}

export function formatConflictAudit(summary: ConflictAuditSummary): string {
  const lines = [
    "Conflict audit",
    `Open conflicts : ${summary.openConflicts}/${summary.totalConflicts}`,
    `Open clusters  : ${summary.openClusters}/${summary.totalClusters}`,
    `Attention      : fresh=${summary.attentionCounts.fresh}, aging=${summary.attentionCounts.aging}, stale=${summary.attentionCounts.stale}, escalated=${summary.attentionCounts.escalated}, resolved=${summary.attentionCounts.resolved}`,
    "",
    "Suggested actions:",
    ...summary.suggestedActions.map((action) => `- ${action}`),
  ];

  lines.push("");
  lines.push("Priority clusters:");
  if (summary.priorityClusters.length === 0) {
    lines.push("- None");
  } else {
    lines.push(formatConflictClusters(summary.priorityClusters));
  }

  return lines.join("\n");
}

export function formatConflictAuditMarkdown(
  summary: ConflictAuditSummary,
  options: ConflictAuditRenderOptions,
): string {
  const lines = [
    "# Conflict Audit",
    "",
    `- Generated: ${options.generatedAt}`,
    `- Filters: status=${options.status || "all"}, canonicalKey=${options.canonicalKey || "all"}, limit=${options.limit}, top=${options.top}`,
    `- Open conflicts: ${summary.openConflicts}/${summary.totalConflicts}`,
    `- Open clusters: ${summary.openClusters}/${summary.totalClusters}`,
    `- Attention: fresh=${summary.attentionCounts.fresh}, aging=${summary.attentionCounts.aging}, stale=${summary.attentionCounts.stale}, escalated=${summary.attentionCounts.escalated}, resolved=${summary.attentionCounts.resolved}`,
    "",
    "## Suggested Actions",
    "",
    ...summary.suggestedActions.map((action) => `- ${action}`),
    "",
    "## Priority Clusters",
    "",
  ];

  if (summary.priorityClusters.length === 0) {
    lines.push("- None");
    return lines.join("\n");
  }

  summary.priorityClusters.forEach((cluster, index) => {
    lines.push(`### ${index + 1}. ${cluster.clusterLabel}`);
    lines.push("");
    lines.push(`- Cluster key: ${cluster.clusterKey}`);
    lines.push(`- Attention: ${cluster.attention}`);
    lines.push(`- Open/All: ${cluster.openCount}/${cluster.totalCount}`);
    lines.push(`- Advice: ${cluster.suggestedResolution} (${cluster.confidence})`);
    lines.push(`- Canonical key: ${cluster.canonicalKey}`);
    lines.push(`- Category: ${cluster.category}`);
    lines.push(`- Latest conflict: ${cluster.latestConflictId}`);
    lines.push(`- Updated: ${cluster.latestUpdatedAt}`);
    lines.push("");
  });

  return lines.join("\n");
}

export function formatConflictRecord(record: ConflictCandidateRecord): string {
  const lifecycle = summarizeConflictLifecycle(record);
  const advice = summarizeConflictAdvice(record);
  const lines = [
    `Conflict ${record.conflictId.slice(0, 8)}`,
    `Status: ${record.status}`,
    `Attention: ${lifecycle.attention}`,
    `Open age days: ${lifecycle.openAgeDays}`,
    `Reopen count: ${lifecycle.reopenCount}`,
    `Escalation count: ${record.escalationCount || 0}`,
    `Suggested resolution: ${advice.suggestedResolution} (${advice.confidence})`,
    `Similarity: ${advice.similarity}`,
    `Cluster key: ${advice.clusterKey}`,
    `Reason: ${record.reason}`,
    `Canonical key: ${record.canonicalKey}`,
    `Incoming category: ${record.category}`,
    `Existing category: ${record.existing.category}`,
    `Created: ${record.createdAt}`,
    `Updated: ${record.updatedAt}`,
    ...(record.lastReopenedAt ? [`Last reopened: ${record.lastReopenedAt}`] : []),
    ...(record.lastEscalatedAt ? [`Last escalated: ${record.lastEscalatedAt} (${record.lastEscalationAttention})`] : []),
    "",
    `Existing durable (${record.existing.memoryId.slice(0, 8)}): ${record.existing.text}`,
    `Incoming candidate (${record.incoming.sourceMemoryId?.slice(0, 8) || record.incoming.source}): ${record.incoming.text}`,
  ];

  if (record.resolutionNotes) {
    lines.push(`Notes: ${record.resolutionNotes}`);
  }
  if (advice.mergeSuggestion) {
    lines.push(`Merge suggestion: ${advice.mergeSuggestion}`);
  }
  if (advice.reasons.length > 0) {
    lines.push("");
    lines.push("Advice reasons:");
    for (const reason of advice.reasons) {
      lines.push(`- ${reason}`);
    }
  }

  return lines.join("\n");
}

export function formatConflictEscalation(result: EscalateConflictsResult): string {
  const lines = [
    result.apply ? "Conflict escalation applied" : "Conflict escalation preview",
    `Scanned   : ${result.scanned}`,
    `Eligible  : ${result.eligible}`,
    `Escalated : ${result.escalated}`,
    `Skipped   : ${result.skipped}`,
  ];

  if (result.items.length === 0) {
    lines.push("");
    lines.push("No stale or escalated conflicts matched.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Items:");
  for (const item of result.items) {
    lines.push(
      `${item.conflictId.slice(0, 8)}  ${item.attention.padEnd(10)} ${item.action.padEnd(17)} ${item.suggestedResolution.padEnd(15)} ${item.canonicalKey}`,
    );
  }
  return lines.join("\n");
}

export function formatConflictResolution(result: ConflictResolutionResult): string {
  const lines = [
    `Conflict ${result.conflictId.slice(0, 8)} resolved`,
    `Status: ${result.status}`,
    `Updated: ${result.updatedAt}`,
  ];
  if (result.updatedMemoryId) {
    lines.push(`Updated memory: ${result.updatedMemoryId.slice(0, 8)}`);
  }
  return lines.join("\n");
}
