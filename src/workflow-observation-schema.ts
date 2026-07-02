import { z } from "zod";

import { boundedStringSchema, identifierSchema, normalizedStringListSchema, optionalBoundedStringSchema } from "./schema-utils.js";

export const WORKFLOW_OBSERVATION_OUTCOMES = [
  "success",
  "failure",
  "corrected",
  "missed",
] as const;

export const WorkflowObservationOutcomeSchema = z.enum(WORKFLOW_OBSERVATION_OUTCOMES);

export const WorkflowObservationInputSchema = z.object({
  workflowId: identifierSchema("workflowId", 120),
  outcome: WorkflowObservationOutcomeSchema.default("success"),
  summary: boundedStringSchema("summary", 400),
  scope: optionalBoundedStringSchema(160),
  source: boundedStringSchema("source", 40).default("manual"),
  signal: optionalBoundedStringSchema(120),
  task: optionalBoundedStringSchema(240),
  tags: normalizedStringListSchema("tags", 8, 40),
  tools: normalizedStringListSchema("tools", 6, 60),
  recordedAt: z.string().datetime().default(() => new Date().toISOString()),
  skillId: optionalBoundedStringSchema(128),
  idempotencyKey: optionalBoundedStringSchema(160),
});

export const WorkflowObservationRecordSchema = WorkflowObservationInputSchema.extend({
  observationId: identifierSchema("observationId", 128),
  resolvedScope: identifierSchema("resolvedScope", 160),
});

export type WorkflowObservationOutcome = z.infer<typeof WorkflowObservationOutcomeSchema>;
export type WorkflowObservationInput = z.infer<typeof WorkflowObservationInputSchema>;
export type WorkflowObservationRecord = z.infer<typeof WorkflowObservationRecordSchema>;

export interface WorkflowHealthWindow {
  days: number;
  total: number;
  successes: number;
  failures: number;
  corrected: number;
  missed: number;
  issueCount: number;
  successRate: number;
  issueRate: number;
  latestAt?: string;
  topSignals: Array<{ signal: string; count: number }>;
}

export interface WorkflowHealthReport {
  workflowId: string;
  scope?: string;
  status: "healthy" | "watch" | "critical" | "no-data";
  summary: string;
  latestObservationAt?: string;
  windows: WorkflowHealthWindow[];
}

export interface WorkflowHealthDashboardItem {
  workflowId: string;
  scope?: string;
  status: "healthy" | "watch" | "critical" | "no-data";
  total: number;
  issueCount: number;
  successRate: number;
  latestObservationAt?: string;
  summary: string;
}

export interface WorkflowEvidencePack {
  workflowId: string;
  scope?: string;
  generatedAt: string;
  summary: string;
  health: WorkflowHealthReport;
  topSignals: Array<{ signal: string; count: number }>;
  recentIssues: Array<{
    observationId: string;
    outcome: WorkflowObservationOutcome;
    summary: string;
    signal?: string;
    recordedAt: string;
    task?: string;
  }>;
  suggestions: string[];
}
