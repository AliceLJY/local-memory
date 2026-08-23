import { z } from "zod";

import { boundedStringSchema, identifierSchema, normalizedStringListSchema, optionalBoundedStringSchema } from "./schema-utils.js";
import { RECALLED_IDS_CAP } from "./recall-ledger.js";

export const WORKFLOW_OBSERVATION_OUTCOMES = [
  "success",
  "failure",
  "corrected",
  "missed",
] as const;

export const WorkflowObservationOutcomeSchema = z.enum(WORKFLOW_OBSERVATION_OUTCOMES);

/**
 * P0 join key：这次任务用到过哪些记忆。
 *
 * 超上限**截断而不报错**——观测层的第一守则是别把上报挡回去，一条记多了的
 * observation 也远好过一条写不进去的。
 * // simplified: capped, best-effort join signal — 不是账目，别拿它做审计口径。
 * 需要完整读取轨迹时查 audit.jsonl 的 retrieve 记录。
 */
const recalledIdsSchema = z.array(z.string().trim().min(1).max(128))
  .transform((items) => {
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item)) continue;
      seen.add(item);
      deduped.push(item);
    }
    return deduped.slice(0, RECALLED_IDS_CAP);
  })
  .optional();

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
  /** P0 join key（会话级）：上报这条 observation 的读者身份，对应 memory metadata 的 readerIds。 */
  readerId: optionalBoundedStringSchema(64),
  /** P0 join key（任务级，更精确）：本次任务窗口内被检索返回过的 memory id。 */
  recalledIds: recalledIdsSchema,
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
