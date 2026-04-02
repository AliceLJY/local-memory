/**
 * D-1: Skill Schema — defines the shape of executable skills stored in memory.
 *
 * Skills are "what an agent can do" (vs. memories which are "what an agent learned").
 * Alita/Alita-G showed MCP itself is a natural skill representation format.
 */

import { z } from "zod";

export const SkillImplementationTypeSchema = z.enum([
  "bash", "python", "mcp_tool_chain", "instruction_sequence",
]);

export type SkillImplementationType = z.infer<typeof SkillImplementationTypeSchema>;

export const SkillInputSchema = z.object({
  name: z.string().min(1).max(120).describe("Unique skill identifier (e.g. 'deploy_production')"),
  description: z.string().min(1).max(500).describe("Natural language description (used for retrieval)"),
  triggerPattern: z.string().min(1).max(300).describe("When to suggest this skill"),
  implementationType: SkillImplementationTypeSchema,
  implementation: z.string().min(1).max(5000).describe("Executable content"),
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
