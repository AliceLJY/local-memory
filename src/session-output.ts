import type { ResumeContextResponse, SessionCheckpointRecord } from "./session-schema.js";

function listBlock(label: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [
    `${label}:`,
    ...items.map((item, index) => `${index + 1}. ${item}`),
  ];
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

  if (response.latestCheckpoint) {
    lines.push("Latest checkpoint:");
    lines.push(`Session: ${response.latestCheckpoint.sessionId}`);
    lines.push(`Updated: ${response.latestCheckpoint.updatedAt}`);
    lines.push(`Summary: ${response.latestCheckpoint.summary}`);
  }

  return lines.join("\n");
}
