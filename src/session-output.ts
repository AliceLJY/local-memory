import type { ResumeContextResponse, SessionCheckpointRecord } from "./session-schema.js";
import { cleanText } from "./context-composer-text.js";

function listBlock(label: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [
    `${label}:`,
    ...items.map((item, index) => `${index + 1}. ${item}`),
  ];
}

export function formatCheckpointRecallSummary(record: SessionCheckpointRecord): string {
  const parts: string[] = [];
  const baseSummary = record.summary.trim();
  if (baseSummary) {
    parts.push(baseSummary);
  }

  const baseLower = baseSummary.toLowerCase();
  const missingEntities = record.entities
    .filter((entity) => entity.trim().length > 0 && !baseLower.includes(entity.toLowerCase()))
    .slice(0, 2);
  if (missingEntities.length > 0) {
    parts.push(`Entities: ${missingEntities.join(", ")}`);
  }

  return cleanText(parts.join(" "), 600);
}

export function formatCheckpointSaved(record: SessionCheckpointRecord): string {
  const lines = [
    `Checkpoint ${record.checkpointId.slice(0, 8)}`,
    `Session: ${record.sessionId}`,
    `Scope: ${record.resolvedScope}`,
    `Updated: ${record.updatedAt}`,
    `Summary: ${record.summary}`,
    ...listBlock("Decisions", record.decisions),
    ...listBlock("Open loops", record.openLoops),
    ...listBlock("Next actions", record.nextActions),
  ];
  return lines.join("\n");
}

export function formatCheckpointSummary(record: SessionCheckpointRecord | null): string {
  if (!record) return "No checkpoint found.";

  const lines = [
    `Latest checkpoint`,
    `Session: ${record.sessionId}`,
    `Scope: ${record.resolvedScope}`,
    `Updated: ${record.updatedAt}`,
    `Summary: ${record.summary}`,
  ];
  if (record.nextActions.length > 0) {
    lines.push(`Next: ${record.nextActions.slice(0, 3).join(" | ")}`);
  }
  return lines.join("\n");
}

export function formatResumeContext(response: ResumeContextResponse): string {
  const lines = [
    "Resume context",
    `Generated: ${response.generatedAt}`,
    `Summary: ${response.summary}`,
  ];

  if (response.resolvedScope) {
    lines.push(`Scope: ${response.resolvedScope}`);
  }

  if (response.responseMode !== "default") {
    lines.push(`Response mode: ${response.responseMode}`);
  }

  if (response.responseGuidance) {
    lines.push(`Guidance: ${response.responseGuidance}`);
  }

  lines.push(
    ...listBlock("Stable context", response.stableContext),
    ...listBlock("Relevant patterns", response.relevantPatterns),
    ...listBlock("Recent cases", response.recentCases),
  );

  // CC-7: Collapsed items with renderLevel + staleness hints
  if (response.collapsedItems && response.collapsedItems.length > 0) {
    lines.push("Collapsed context (mixed granularity):");
    for (const item of response.collapsedItems) {
      const hint = item.stalenessHint ? ` ${item.stalenessHint}` : "";
      lines.push(`[${item.renderLevel}] ${item.text}${hint}`);
    }
  }

  if (response.latestCheckpoint) {
    lines.push("Latest checkpoint:");
    lines.push(`Session: ${response.latestCheckpoint.sessionId}`);
    if (response.latestCheckpoint.resolvedScope) {
      lines.push(`Scope: ${response.latestCheckpoint.resolvedScope}`);
    }
    lines.push(`Updated: ${response.latestCheckpoint.updatedAt}`);
    lines.push(`Summary: ${response.latestCheckpoint.summary}`);
  }

  return lines.join("\n");
}
