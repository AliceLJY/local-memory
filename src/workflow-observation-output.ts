import type {
  WorkflowEvidencePack,
  WorkflowHealthDashboardItem,
  WorkflowHealthReport,
  WorkflowObservationRecord,
} from "./workflow-observation-schema.js";

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatWorkflowObservationSaved(record: WorkflowObservationRecord): string {
  const lines = [
    `Workflow observation ${record.observationId.slice(0, 8)}`,
    `Workflow: ${record.workflowId}`,
    `Outcome: ${record.outcome}`,
    `Scope: ${record.resolvedScope}`,
    `Source: ${record.source}`,
    `Recorded: ${record.recordedAt}`,
    `Summary: ${record.summary}`,
  ];
  if (record.signal) lines.push(`Signal: ${record.signal}`);
  if (record.task) lines.push(`Task: ${record.task}`);
  if (record.tools.length > 0) lines.push(`Tools: ${record.tools.join(", ")}`);
  return lines.join("\n");
}

export function formatWorkflowHealthReport(report: WorkflowHealthReport): string {
  const lines = [
    `Workflow health: ${report.workflowId}`,
    `Scope: ${report.scope || "all"}`,
    `Status: ${report.status}`,
    `Summary: ${report.summary}`,
  ];
  if (report.latestObservationAt) lines.push(`Latest: ${report.latestObservationAt}`);
  for (const window of report.windows) {
    lines.push(
      `${window.days}d: total ${window.total}, success ${pct(window.successRate)}, issues ${window.issueCount} (${window.failures} failure / ${window.corrected} corrected / ${window.missed} missed)`,
    );
    if (window.topSignals.length > 0) {
      lines.push(`Top signals: ${window.topSignals.map((item) => `${item.signal} (${item.count})`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

export function formatWorkflowHealthDashboard(items: WorkflowHealthDashboardItem[], scope?: string): string {
  if (items.length === 0) {
    return `No workflow observations found${scope ? ` in ${scope}` : ""}.`;
  }
  return [
    `Workflow health dashboard${scope ? ` (${scope})` : ""}`,
    ...items.map((item, index) =>
      `${index + 1}. [${item.status}] ${item.workflowId}${item.scope ? ` @ ${item.scope}` : ""} — ${item.total} obs, ${pct(item.successRate)} success, ${item.issueCount} issues`,
    ),
  ].join("\n");
}

export function formatWorkflowEvidencePack(pack: WorkflowEvidencePack): string {
  const lines = [
    `Workflow evidence: ${pack.workflowId}`,
    `Scope: ${pack.scope || "all"}`,
    `Generated: ${pack.generatedAt}`,
    `Summary: ${pack.summary}`,
    `Health: ${pack.health.summary}`,
  ];
  if (pack.topSignals.length > 0) {
    lines.push(`Top signals: ${pack.topSignals.map((item) => `${item.signal} (${item.count})`).join(", ")}`);
  }
  if (pack.recentIssues.length > 0) {
    lines.push("Recent issues:");
    for (const issue of pack.recentIssues) {
      lines.push(
        `- ${issue.recordedAt.slice(0, 10)} [${issue.outcome}] ${issue.signal ? `${issue.signal}: ` : ""}${issue.summary}`,
      );
    }
  }
  if (pack.suggestions.length > 0) {
    lines.push("Suggestions:");
    for (const suggestion of pack.suggestions) {
      lines.push(`- ${suggestion}`);
    }
  }
  return lines.join("\n");
}

