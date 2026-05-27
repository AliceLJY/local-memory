/**
 * D-1: Skill Schema — defines the shape of agent-readable skill runbooks stored in memory.
 *
 * Skills are "what an agent can do" (vs. memories which are "what an agent learned").
 * Alita/Alita-G showed MCP itself is a natural skill representation format.
 *
 * v2.5 (2026-05-27) — schema 收缩：
 * 原 SkillImplementationTypeSchema 含 "bash" / "python" / "mcp_tool_chain" / "instruction_sequence"
 * 四种，**implementation 字段从未真执行**（无 evaluator，仅作 context 给 agent 读）——是 schema
 * 撒谎暗示可执行。源自 brgsk《agent memory: an anatomy》借鉴审计 + Codex trio 二审建议
 * "P1 选收缩/删承诺，不接 evaluator"。
 *
 * 现在 enum 只保留 "instruction_sequence" 唯一类型，明确 skill 是 **agent-readable runbook**
 * 而非可执行物。未来如真接 evaluator（产品决策另开），再展开 enum 加 "bash" / "python" 等。
 *
 * 兼容性：parseSkillFromEntry 读取老 metadata 用 type cast 不走 schema 校验，所以历史 bash/python
 * skill records 仍可 retrieve；只是新写入受新 schema 约束。production 库 2026-05-27 实测无真实
 * skill 数据，破坏面接近 zero。
 */

import { z } from "zod";

export const SkillImplementationTypeSchema = z.enum([
  "instruction_sequence",
]);

export type SkillImplementationType = z.infer<typeof SkillImplementationTypeSchema>;

export const SkillInputSchema = z.object({
  name: z.string().min(1).max(120).describe("Unique skill identifier (e.g. 'deploy_production')"),
  description: z.string().min(1).max(500).describe("Natural language description (used for retrieval)"),
  triggerPattern: z.string().min(1).max(300).describe("When to suggest this skill"),
  implementationType: SkillImplementationTypeSchema,
  implementation: z.string().min(1).max(5000).describe("Agent-readable runbook content: markdown steps, natural language workflow, or structured procedure. RecallNest does NOT execute this — it stores runbooks for agents to read and follow as context."),
  inputSchema: z.record(z.string(), z.unknown()).optional().describe("Parameter definition (JSON Schema)"),
  verification: z.string().max(500).optional().describe("How to verify execution success"),
  scope: z.string().min(1).max(160).describe("Project scope"),
  source: z.enum(["manual", "agent", "api"]).default("manual"),
  tags: z.array(z.string().max(60)).max(6).default([]),
});

export type SkillInput = z.infer<typeof SkillInputSchema>;

export const StoredSkillRecordSchema = SkillInputSchema.extend({
  id: z.string(),
  storedAt: z.string().datetime(),
  successCount: z.number().default(0),
  failureCount: z.number().default(0),
  lastRefinedAt: z.string().datetime().optional(),
});

export type StoredSkillRecord = z.infer<typeof StoredSkillRecordSchema>;
