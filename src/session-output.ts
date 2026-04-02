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

  // CC-8: Essential context (pinned memories, active patterns, open loops)
  if (response.essentialContext) {
    const ec = response.essentialContext;
    const hasContent = (ec.pinnedMemories && ec.pinnedMemories.length > 0)
      || (ec.activePatterns && ec.activePatterns.length > 0)
      || (ec.openLoops && ec.openLoops.length > 0);
    if (hasContent) {
      lines.push("Essential context:");
      if (ec.pinnedMemories && ec.pinnedMemories.length > 0) {
        for (const pin of ec.pinnedMemories) {
          lines.push(`- Pinned: ${pin}`);
        }
      }
      if (ec.activePatterns && ec.activePatterns.length > 0) {
        for (const pattern of ec.activePatterns) {
          lines.push(`- Pattern: ${pattern}`);
        }
      }
      if (ec.openLoops && ec.openLoops.length > 0) {
        for (const loop of ec.openLoops) {
          lines.push(`- Open loop: ${loop}`);
        }
      }
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

  // CC-1: Injection hint for prompt placement
  if (response.injectionHint) {
    lines.push(`Injection hint: ${response.injectionHint} (place recalled context as user message attachment for better prompt cache hit rate)`);
  }

  return lines.join("\n");
}
