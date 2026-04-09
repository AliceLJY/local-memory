#!/usr/bin/env bun
/**
 * RecallNest MCP Server
 *
 * Exposes conversation memory search as MCP tools,
 * so any MCP-compatible AI client (Claude Code, etc.)
 * can search your indexed conversations.
 *
 * Tool tiers:
 * - core: Always exposed (5 tools)
 * - advanced: Exposed by default, includes core (15 tools)
 * - full: All tools including governance (24 tools)
 *
 * Control: RECALLNEST_MCP_TIER=core|advanced|full
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ============================================================================
// Tier Configuration
// ============================================================================

type ToolTier = "core" | "advanced" | "governance";

const MCP_TIER = (process.env.RECALLNEST_MCP_TIER || "advanced") as "core" | "advanced" | "full";

const TOOL_TIERS: Record<string, ToolTier> = {
  // Core (always)
  resume_context: "core",
  search_memory: "core",
  store_memory: "core",
  checkpoint_session: "core",
  latest_checkpoint: "core",
  list_tools: "core",

  set_reminder: "core",

  // Advanced
  batch_store: "advanced",
  auto_capture: "advanced",
  store_case: "advanced",
  store_workflow_pattern: "advanced",
  promote_memory: "advanced",
  explain_memory: "advanced",
  distill_memory: "advanced",
  brief_memory: "advanced",
  pin_memory: "advanced",
  list_assets: "advanced",
  list_pins: "advanced",
  memory_stats: "advanced",
  data_checkup: "advanced",
  memory_lint: "advanced",
  export_graph: "advanced",
  dream: "advanced",
  memory_drill_down: "advanced",
  export_memory: "advanced",
  store_skill: "advanced",
  retrieve_skill: "advanced",
  import_conversations: "advanced",
  distill_session: "advanced",
  scan_skill_promotions: "governance",

  // Governance (CLI-only, not in MCP by default)
  workflow_observe: "governance",
  workflow_health: "governance",
  workflow_evidence: "governance",
  list_conflicts: "governance",
  resolve_conflict: "governance",
  audit_conflicts: "governance",
  escalate_conflicts: "governance",
  list_dirty_briefs: "governance",
  clean_dirty_briefs: "governance",
  consolidate_memories: "governance",
};

function shouldRegisterTool(toolName: string): boolean {
  const tier = TOOL_TIERS[toolName];
  if (!tier) return true; // unknown tools always register (backward compat)
  if (MCP_TIER === "full") return true;
  if (MCP_TIER === "advanced") return tier !== "governance";
  if (MCP_TIER === "core") return tier === "core";
  return true;
}
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { autoRegisterBabelMemory } from "./language-hook.js";
import { z } from "zod";
import type { RetrievalResult } from "./retriever.js";
import type { MemoryStore } from "./store.js";
import { distillResults, formatExplainResults, formatSearchResults, formatBriefResults, formatFullResults, selectBriefSeedResults, summarizeResults } from "./memory-output.js";
import { archiveDirtyBriefAsset, assetSummaryLine, buildBriefAsset, buildPinAsset, listDirtyBriefAssets, listMemoryAssets, listPinAssets, saveBriefAsset, savePinAsset, writeExportArtifact } from "./memory-assets.js";
import { indexAsset, indexPinnedAsset } from "./asset-sync.js";
import { createComponentResolver, loadConfig, loadDotEnv, resolveRecallMode } from "./runtime-config.js";
import { DurableMemoryCategorySchema, StoreMemorySourceSchema } from "./memory-schema.js";
import { persistCaseMemory, persistMemory, persistMemoryBatch, persistWorkflowPattern, promoteMemory } from "./capture-engine.js";
import { persistSkill, retrieveSkills } from "./skill-engine.js";
import { SkillImplementationTypeSchema } from "./skill-schema.js";
import { scanForPromotions, formatPromotionResult } from "./skill-promotion.js";
import { autoCapture } from "./capture-heuristic.js";
import { ConsolidationEngine, formatConsolidationResult } from "./consolidation-engine.js";
import { renderMemories, type RenderMode } from "./context-renderer.js";
import { buildSessionCheckpointResult } from "./session-engine.js";
import { SessionCheckpointStore } from "./session-store.js";
import { composeLightResumeContext, composeResumeContext } from "./context-composer.js";
import { formatCheckpointSaved, formatCheckpointSummary, formatResumeContext } from "./session-output.js";
import { ConflictStatusSchema } from "./conflict-schema.js";
import { KGStore } from "./kg-store.js";
import { createKGExtractor, isKGModeEnabled, type KGExtractor } from "./kg-extractor.js";
import { resolveConflictCandidate } from "./conflict-engine.js";
import { escalateConflicts } from "./conflict-escalation.js";
import { ConflictCandidateStore } from "./conflict-store.js";
import { runDataCheckup, formatCheckupReport } from "./data-checkup.js";
import { runMemoryLint, formatMemoryLintReport } from "./memory-lint.js";
import { exportMemoryGraph, formatGraphExportResult } from "./graph-export.js";
import { runDream, formatDreamResult } from "./dream-pipeline.js";
import { formatConflictAudit, formatConflictClusters, formatConflictEscalation, formatConflictList, formatConflictRecord, formatConflictResolution } from "./conflict-output.js";
import { CONFLICT_ATTENTION_LEVELS, summarizeConflictLifecycle } from "./conflict-lifecycle.js";
import { buildConflictAuditSummary, clusterConflicts } from "./conflict-advisor.js";
import { WorkflowObservationOutcomeSchema } from "./workflow-observation-schema.js";
import { buildWorkflowEvidence, buildWorkflowObservationRecord, inspectWorkflowDashboard, inspectWorkflowHealth } from "./workflow-observation-engine.js";
import { formatWorkflowEvidencePack, formatWorkflowHealthDashboard, formatWorkflowHealthReport, formatWorkflowObservationSaved } from "./workflow-observation-output.js";
import { WorkflowObservationStore } from "./workflow-observation-store.js";
import { buildManagedCheckpointObservation, buildManagedResumeObservation } from "./workflow-observation-managed.js";
import { buildRetrievalContext, resolveScopeSelection } from "./scope-policy.js";
import { matchesTemporalConstraint, type TemporalConstraint } from "./temporal-parser.js";
import { setReminder, checkTriggers, fireReminder, formatReminders } from "./prospective-memory.js";
// distill_session uses dynamic import("./session-distiller.js") at call time

function entryToRetrievalResult(entry: Awaited<ReturnType<MemoryStore["get"]>>): RetrievalResult {
  if (!entry) {
    throw new Error("Memory entry not found.");
  }
  return {
    entry,
    score: entry.importance || 0.7,
    sources: {
      fused: { score: entry.importance || 0.7 },
    },
  };
}

async function saveManagedObservation(observation: Parameters<typeof buildWorkflowObservationRecord>[0]): Promise<void> {
  try {
    const record = buildWorkflowObservationRecord(observation);
    await workflowObservationStore.save(record);
  } catch (error) {
    console.error("[RecallNest MCP] Failed to persist managed workflow observation:", error);
  }
}

// ============================================================================
// MCP Server
// ============================================================================

loadDotEnv();
const config = loadConfig();
const getComponents = createComponentResolver(config);
const { store, llm } = getComponents();
const checkpointStore = new SessionCheckpointStore();
const conflictStore = new ConflictCandidateStore();
const workflowObservationStore = new WorkflowObservationStore();

// Tier 4.1: Knowledge Graph triple extraction (gated by RECALLNEST_KG_MODE=true)
let kgExtractor: KGExtractor | null = null;
let kgStoreInstance: KGStore | null = null;
if (isKGModeEnabled() && llm) {
  try {
    kgStoreInstance = new KGStore({ dbPath: store.dbPath });
    kgExtractor = createKGExtractor({ llmClient: llm, kgStore: kgStoreInstance });
    // Attach KG store to default retriever for PPR graph traversal
    const { retriever } = getComponents();
    retriever.setKGStore(kgStoreInstance);
    console.error("[RecallNest] KG triple extraction + graph traversal enabled");
  } catch (err) {
    console.error("[RecallNest] KG init failed:", err);
  }
}

const server = new McpServer({
  name: "recallnest",
  version: "1.4.0",
});

// ============================================================================
// Tool Registration Helper (tier-aware)
// ============================================================================

type ToolSchema = Parameters<typeof server.tool>[2];
type ToolHandler = Parameters<typeof server.tool>[3];

/** Map of all registered tool names to their descriptions (populated during registration). */
const TOOL_DESCRIPTIONS = new Map<string, string>();

function registerTool(name: string, description: string, schema: ToolSchema, handler: ToolHandler): void {
  if (!shouldRegisterTool(name)) {
    // stdout is reserved for MCP JSON-RPC on stdio transports.
    console.error(`[MCP] Skipping ${name} (tier: ${TOOL_TIERS[name]})`);
    return;
  }
  TOOL_DESCRIPTIONS.set(name, description);
  server.tool(name, description, schema, handler);
}

registerTool(
  "workflow_observe",
  "Store an append-only workflow observation for self-evolution. Use this to record whether a continuity primitive or reusable workflow succeeded, failed, was corrected by the user, or was missed entirely.",
  {
    workflowId: z.string().min(1).max(120).describe("Workflow primitive id, such as resume_context or checkpoint_session"),
    outcome: WorkflowObservationOutcomeSchema.default("success").describe("success | failure | corrected | missed"),
    summary: z.string().min(1).max(400).describe("Short description of what happened"),
    scope: z.string().min(1).max(160).optional().describe("Optional scope such as project:recallnest"),
    source: z.string().min(1).max(40).default("agent").describe("Source label such as agent, smoke, eval, or manual"),
    signal: z.string().min(1).max(120).optional().describe("Optional failure/correction signal tag"),
    task: z.string().min(1).max(240).optional().describe("Optional related task"),
    tags: z.array(z.string().min(1).max(40)).max(8).default([]).describe("Optional tags"),
    tools: z.array(z.string().min(1).max(60)).max(6).default([]).describe("Optional tools involved"),
  },
  async ({ workflowId, outcome, summary, scope, source, signal, task, tags, tools }) => {
    const record = buildWorkflowObservationRecord({
      workflowId,
      outcome,
      summary,
      scope,
      source,
      signal,
      task,
      tags,
      tools,
    });
    const stored = await workflowObservationStore.save(record);
    return {
      content: [{
        type: "text" as const,
        text: formatWorkflowObservationSaved(stored),
      }],
    };
  },
);

registerTool(
  "workflow_health",
  "Inspect workflow observation health: 7d/30d report for one workflow or dashboard of degraded workflows. Read-only. Use when checking if continuity primitives are succeeding or degrading.",
  {
    workflowId: z.string().min(1).max(120).optional().describe("Optional workflow primitive id"),
    scope: z.string().min(1).max(160).optional().describe("Optional scope filter"),
    limit: z.number().int().min(1).max(30).default(10).describe("Dashboard result limit when workflowId is omitted"),
  },
  async ({ workflowId, scope, limit }) => {
    const text = workflowId
      ? formatWorkflowHealthReport(await inspectWorkflowHealth(workflowObservationStore, { workflowId, scope }))
      : formatWorkflowHealthDashboard(await inspectWorkflowDashboard(workflowObservationStore, { scope, limit }), scope);
    return {
      content: [{
        type: "text" as const,
        text,
      }],
    };
  },
);

registerTool(
  "workflow_evidence",
  "Generate an evidence pack for a workflow primitive with recent issues, top signals, and suggested actions. Read-only. Use when investigating why a workflow is degraded and you need concrete failure examples.",
  {
    workflowId: z.string().min(1).max(120).describe("Workflow primitive id, e.g. 'resume_context'"),
    scope: z.string().min(1).max(160).optional().describe("Scope filter, e.g. 'project:recallnest'"),
    limit: z.number().int().min(1).max(20).default(5).describe("Max recent issue observations to include"),
  },
  async ({ workflowId, scope, limit }) => {
    const pack = await buildWorkflowEvidence(workflowObservationStore, {
      workflowId,
      scope,
      limit,
    });
    return {
      content: [{
        type: "text" as const,
        text: formatWorkflowEvidencePack(pack),
      }],
    };
  },
);

registerTool(
  "store_memory",
  "Store a durable memory when the user shares a stable preference, identity fact, project entity, reusable pattern, or solved case that should survive future windows. Do not use this for transient task state; use it only for memory worth keeping.",
  {
    text: z.string().min(1).max(4000).describe("Memory text to store"),
    category: DurableMemoryCategorySchema.default("events").describe("Durable memory category"),
    importance: z.number().min(0).max(1).default(0.7).describe("Importance score from 0 to 1"),
    scope: z.string().min(1).max(160).describe("Required scope such as project:recallnest or session:abc123"),
    source: StoreMemorySourceSchema.default("manual").describe("How this memory was captured"),
    tags: z.array(z.string().min(1).max(40)).max(8).default([]).describe("Optional tags"),
    canonicalKey: z.string().min(1).max(120).optional().describe("Optional stable key for merge/update semantics"),
    topicTag: z.string().min(1).max(60).optional().describe("Optional topic tag for intra-scope partitioning (e.g. 'auth', 'deploy', 'testing'). Auto-detected if omitted."),
  },
  async ({ text, category, importance, scope, source, tags, canonicalKey, topicTag }) => {
    const { store, embedder } = getComponents();
    const stored = await persistMemory({
      store,
      embedder,
      conflictStore,
      kgExtractor,
    }, {
      text,
      category,
      importance,
      scope,
      source,
      tags,
      canonicalKey,
      topicTag,
    });

    return {
      content: [{
        type: "text" as const,
        text: [
          `Stored memory ${stored.id.slice(0, 8)}`,
          `Disposition: ${stored.disposition}`,
          `Category: ${stored.category}`,
          `Scope: ${stored.resolvedScope}`,
          `Canonical key: ${stored.canonicalKey}`,
          ...(stored.conflictId ? [`Conflict: ${stored.conflictId.slice(0, 8)}`] : []),
          `Stored at: ${stored.storedAt}`,
        ].join("\n"),
      }],
    };
  }
);

registerTool(
  "store_workflow_pattern",
  "Store a reusable workflow pattern as durable memory. Use this when you identify a repeatable process worth reusing across fresh windows, such as startup continuity, debugging routines, review flows, or handoff steps.",
  {
    title: z.string().min(1).max(120).describe("Short pattern title"),
    trigger: z.string().min(1).max(240).describe("When this workflow should be used"),
    steps: z.array(z.string().min(1).max(220)).min(1).max(8).describe("Ordered workflow steps"),
    outcome: z.string().min(1).max(240).optional().describe("Optional expected outcome"),
    tools: z.array(z.string().min(1).max(60)).max(6).default([]).describe("Optional tools, commands, or interfaces involved"),
    importance: z.number().min(0).max(1).default(0.82).describe("Importance score from 0 to 1"),
    scope: z.string().min(1).max(160).describe("Required scope such as project:recallnest or session:abc123"),
    source: StoreMemorySourceSchema.default("agent").describe("How this pattern was captured"),
    tags: z.array(z.string().min(1).max(40)).max(8).default([]).describe("Optional tags"),
    canonicalKey: z.string().min(1).max(120).optional().describe("Optional stable key for merge/update semantics"),
  },
  async ({ title, trigger, steps, outcome, tools, importance, scope, source, tags, canonicalKey }) => {
    const { store, embedder } = getComponents();
    const stored = await persistWorkflowPattern({
      store,
      embedder,
      conflictStore,
      kgExtractor,
    }, {
      title,
      trigger,
      steps,
      outcome,
      tools,
      importance,
      scope,
      source,
      tags,
      canonicalKey,
    });

    return {
      content: [{
        type: "text" as const,
        text: [
          `Stored workflow pattern ${stored.id.slice(0, 8)}`,
          `Disposition: ${stored.disposition}`,
          `Title: ${stored.title}`,
          `Scope: ${stored.resolvedScope}`,
          `Canonical key: ${stored.canonicalKey}`,
          `Tags: ${stored.tags.join(", ") || "-"}`,
          ...(stored.conflictId ? [`Conflict: ${stored.conflictId.slice(0, 8)}`] : []),
          `Stored at: ${stored.storedAt}`,
        ].join("\n"),
      }],
    };
  }
);

registerTool(
  "set_reminder",
  "Set a prospective memory reminder that auto-triggers during future search_memory calls when the trigger keywords match. Side effect: stores a reminder entry. Use when you need a future nudge tied to a specific context.",
  {
    trigger: z.string().min(1).max(200).describe("Trigger condition — keywords that should activate this reminder"),
    action: z.string().min(1).max(500).describe("What to remind about when the trigger fires"),
    scope: z.string().min(1).max(160).describe("Required scope"),
    expiresInDays: z.number().min(1).max(365).optional().describe("Optional: auto-expire after N days"),
  },
  async ({ trigger, action, scope, expiresInDays }) => {
    const { store, embedder } = getComponents();
    const entry = await setReminder(store, embedder, { trigger, action, scope, expiresInDays });

    return {
      content: [{
        type: "text" as const,
        text: [
          `Reminder set: ${entry.id.slice(0, 8)}`,
          `Trigger: "${trigger}"`,
          `Action: ${action}`,
          `Scope: ${scope}`,
          ...(expiresInDays ? [`Expires in: ${expiresInDays} days`] : []),
        ].join("\n"),
      }],
    };
  }
);

registerTool(
  "auto_capture",
  "Extract memory-worthy items from a conversation turn using lightweight heuristics (zero LLM calls). Detects preferences, identity facts, decisions, corrections, explicit memory instructions, and workflow patterns. Items that pass salience filtering are stored as durable memories. Use this when you want to analyze a block of conversation text and automatically capture any signals worth remembering.",
  {
    text: z.string().min(1).max(8000).describe("Conversation text to analyze for memory-worthy signals"),
    scope: z.string().min(1).max(160).describe("Required scope such as project:recallnest or session:abc123"),
    source: StoreMemorySourceSchema.default("agent").describe("How this memory was captured"),
  },
  async ({ text, scope, source }) => {
    const result = autoCapture(text);

    if (result.skippedSalience) {
      return {
        content: [{
          type: "text" as const,
          text: "Skipped: text did not pass salience filter (too short, noise, or greeting)",
        }],
      };
    }

    if (result.items.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No memory-worthy signals detected in this text",
        }],
      };
    }

    const { store, embedder } = getComponents();
    const stored = await persistMemoryBatch({
      store,
      embedder,
      conflictStore,
      kgExtractor,
    }, {
      scope,
      source,
      defaultImportance: 0.7,
      memories: result.items.map((item) => ({
        text: item.text,
        category: item.category,
        importance: item.importance,
        tags: [`auto-capture:${item.sourceContext.replace(/\s+/g, "-")}`],
      })),
    });

    const lines = stored.map((r, i) => {
      const item = result.items[i];
      return `${i + 1}. [${item.sourceContext}] ${r.disposition} → ${r.category} (${r.id.slice(0, 8)})`;
    });

    return {
      content: [{
        type: "text" as const,
        text: [
          `Auto-captured ${stored.length} item(s) from ${result.items.length} signal(s):`,
          ...lines,
          `Scope: ${scope}`,
        ].join("\n"),
      }],
    };
  }
);

registerTool(
  "store_case",
  "Store a reusable case as durable memory. Use this when you identify a concrete problem-and-solution pair worth reusing across future windows, such as a debugging fix, continuity cleanup, migration lesson, or implementation recovery.",
  {
    title: z.string().min(1).max(120).describe("Short case title"),
    problem: z.string().min(1).max(320).describe("What problem happened"),
    context: z.string().min(1).max(240).optional().describe("Optional context or preconditions"),
    solutionSteps: z.array(z.string().min(1).max(220)).min(1).max(8).describe("Ordered solution steps"),
    outcome: z.string().min(1).max(240).optional().describe("Optional result or resolution"),
    tools: z.array(z.string().min(1).max(60)).max(6).default([]).describe("Optional tools, commands, or interfaces involved"),
    importance: z.number().min(0).max(1).default(0.84).describe("Importance score from 0 to 1"),
    scope: z.string().min(1).max(160).describe("Required scope such as project:recallnest or session:abc123"),
    source: StoreMemorySourceSchema.default("agent").describe("How this case was captured"),
    tags: z.array(z.string().min(1).max(40)).max(8).default([]).describe("Optional tags"),
    canonicalKey: z.string().min(1).max(120).optional().describe("Optional stable key for merge/update semantics"),
  },
  async ({ title, problem, context, solutionSteps, outcome, tools, importance, scope, source, tags, canonicalKey }) => {
    const { store, embedder } = getComponents();
    const stored = await persistCaseMemory({
      store,
      embedder,
      conflictStore,
      kgExtractor,
    }, {
      title,
      problem,
      context,
      solutionSteps,
      outcome,
      tools,
      importance,
      scope,
      source,
      tags,
      canonicalKey,
    });

    return {
      content: [{
        type: "text" as const,
        text: [
          `Stored case ${stored.id.slice(0, 8)}`,
          `Disposition: ${stored.disposition}`,
          `Title: ${stored.title}`,
          `Scope: ${stored.resolvedScope}`,
          `Canonical key: ${stored.canonicalKey}`,
          `Tags: ${stored.tags.join(", ") || "-"}`,
          ...(stored.conflictId ? [`Conflict: ${stored.conflictId.slice(0, 8)}`] : []),
          `Stored at: ${stored.storedAt}`,
        ].join("\n"),
      }],
    };
  }
);

registerTool(
  "promote_memory",
  "Promote an evidence memory into durable memory with an authority upgrade. Side effect: creates a new durable entry linked to the source evidence. Use when a transcript snippet or imported artifact contains a fact worth keeping across windows.",
  {
    memoryId: z.string().min(1).max(128).describe("Existing evidence memory ID or unique prefix"),
    text: z.string().min(1).max(4000).optional().describe("Optional cleaned durable text; defaults to the source entry text"),
    category: DurableMemoryCategorySchema.optional().describe("Optional target durable category; defaults to the source evidence category or its originalCategory"),
    importance: z.number().min(0).max(1).default(0.78).describe("Importance score from 0 to 1"),
    scope: z.string().min(1).max(160).describe("Required target scope such as project:recallnest or session:abc123"),
    source: StoreMemorySourceSchema.default("agent").describe("How this promotion was captured"),
    tags: z.array(z.string().min(1).max(40)).max(8).default([]).describe("Optional tags"),
    canonicalKey: z.string().min(1).max(120).optional().describe("Optional stable key for merge/update semantics"),
  },
  async ({ memoryId, text, category, importance, scope, source, tags, canonicalKey }) => {
    const { store, embedder } = getComponents();
    const stored = await promoteMemory({
      store,
      embedder,
      conflictStore,
      kgExtractor,
    }, {
      memoryId,
      text,
      category,
      importance,
      scope,
      source,
      tags,
      canonicalKey,
    });

    return {
      content: [{
        type: "text" as const,
        text: stored.disposition === "conflict" && stored.conflictId
          ? `Promotion conflict ${stored.conflictId.slice(0, 8)}\nIncoming: ${stored.sourceMemoryId.slice(0, 8)} (${stored.sourceCategory})\nExisting durable: ${stored.id.slice(0, 8)}\nCategory: ${stored.category}\nCanonical key: ${stored.canonicalKey}\nStatus: manual review required`
          : `Promoted memory ${stored.id.slice(0, 8)}\nFrom: ${stored.sourceMemoryId.slice(0, 8)} (${stored.sourceCategory})\nDisposition: ${stored.disposition}\nCategory: ${stored.category}\nScope: ${stored.resolvedScope}\nCanonical key: ${stored.canonicalKey}\nStored at: ${stored.storedAt}`,
      }],
    };
  }
);

registerTool(
  "list_conflicts",
  "List or inspect conflict candidates where promoted evidence disagrees with existing durable memory. Read-only. Use when reviewing pending conflicts before resolution.",
  {
    conflictId: z.string().min(1).max(128).optional().describe("Conflict ID to inspect a single record, e.g. 'c1d2e3f4'"),
    status: ConflictStatusSchema.optional().describe("Optional status filter"),
    attention: z.enum(CONFLICT_ATTENTION_LEVELS).optional().describe("Optional lifecycle filter: fresh / aging / stale / escalated / resolved"),
    canonicalKey: z.string().min(1).max(120).optional().describe("Optional canonical key filter"),
    groupBy: z.enum(["record", "cluster"]).default("record").describe("Whether to list individual conflicts or grouped clusters"),
    limit: z.number().int().min(1).max(50).default(20).describe("Max conflicts to list"),
  },
  async ({ conflictId, status, attention, canonicalKey, groupBy, limit }) => {
    if (conflictId) {
      const record = await conflictStore.getById(conflictId);
      return {
        content: [{
          type: "text" as const,
          text: record ? formatConflictRecord(record) : `Conflict not found: ${conflictId}`,
        }],
      };
    }

    const records = (await conflictStore.listRecent({ status, canonicalKey, limit: Math.max(limit * 2, limit) }))
      .filter((record) => !attention || summarizeConflictLifecycle(record).attention === attention)
      .slice(0, limit);
    return {
      content: [{
        type: "text" as const,
        text: groupBy === "cluster"
          ? formatConflictClusters(clusterConflicts(records))
          : formatConflictList(records),
      }],
    };
  }
);

registerTool(
  "resolve_conflict",
  "Resolve a conflict candidate by keeping existing, accepting incoming, or merging texts. Side effect: updates conflict status and may modify durable memory. Use when list_conflicts shows open conflicts that need a decision.",
  {
    conflictId: z.string().min(1).max(128).describe("Conflict ID to resolve"),
    resolution: z.enum(["accept_incoming", "keep_existing", "merge"]).describe("How to resolve the conflict"),
    mergedText: z.string().min(1).max(2000).optional().describe("Optional merged text override when resolution is merge"),
    notes: z.string().min(1).max(320).optional().describe("Optional operator notes"),
  },
  async ({ conflictId, resolution, mergedText, notes }) => {
    const { store, embedder } = getComponents();
    const result = await resolveConflictCandidate({
      store,
      embedder,
      conflictStore,
    }, {
      conflictId,
      resolution,
      ...(mergedText ? { mergedText } : {}),
      notes,
    });

    return {
      content: [{
        type: "text" as const,
        text: formatConflictResolution(result),
      }],
    };
  }
);

registerTool(
  "audit_conflicts",
  "Generate a conflict audit summary showing priority clusters by staleness and escalation level. Read-only. Use when triaging which conflict clusters to resolve first.",
  {
    status: ConflictStatusSchema.optional().describe("Optional status filter"),
    canonicalKey: z.string().min(1).max(120).optional().describe("Optional canonical key filter"),
    limit: z.number().int().min(1).max(500).default(100).describe("How many conflict records to scan"),
    top: z.number().int().min(1).max(20).default(5).describe("How many priority clusters to show"),
  },
  async ({ status, canonicalKey, limit, top }) => {
    const records = await conflictStore.listRecent({
      status,
      canonicalKey,
      limit,
    });
    const summary = buildConflictAuditSummary(records, top);
    return {
      content: [{
        type: "text" as const,
        text: formatConflictAudit(summary),
      }],
    };
  }
);

registerTool(
  "escalate_conflicts",
  "Preview or apply conflict aging policy to mark stale conflicts for operator review. Side effect: when apply=true, persists escalation metadata. Use when conflicts have aged past their attention threshold.",
  {
    attention: z.enum(["stale", "escalated"]).default("stale").describe("Only consider stale or escalated conflicts"),
    canonicalKey: z.string().min(1).max(120).optional().describe("Optional canonical key filter"),
    limit: z.number().int().min(1).max(500).default(100).describe("How many open conflicts to scan"),
    top: z.number().int().min(1).max(20).default(10).describe("How many eligible conflicts to include"),
    apply: z.boolean().default(false).describe("When false, preview only. When true, persist escalation metadata."),
    notes: z.string().min(1).max(320).optional().describe("Optional operator note when applying escalation"),
  },
  async ({ attention, canonicalKey, limit, top, apply, notes }) => {
    const result = await escalateConflicts({
      conflictStore,
    }, {
      attention,
      canonicalKey,
      limit,
      top,
      apply,
      notes,
    });
    return {
      content: [{
        type: "text" as const,
        text: formatConflictEscalation(result),
      }],
    };
  }
);

registerTool(
  "checkpoint_session",
  "Store a compact checkpoint of the current work state. Use this when a task spans windows or terminals and you need the next session to recover decisions, open loops, and next actions without polluting durable memory.",
  {
    sessionId: z.string().min(1).max(160).describe("Current session identifier"),
    scope: z.string().min(1).max(160).optional().describe("Optional shared scope; defaults to session:<sessionId>"),
    summary: z.string().min(1).max(600).describe("Compact summary of the current work state"),
    task: z.string().min(1).max(240).optional().describe("Optional task label"),
    decisions: z.array(z.string().min(1).max(200)).max(6).default([]).describe("Key decisions already made"),
    openLoops: z.array(z.string().min(1).max(200)).max(6).default([]).describe("Unresolved questions or pending items"),
    nextActions: z.array(z.string().min(1).max(200)).max(6).default([]).describe("Next actions to take"),
    entities: z.array(z.string().min(1).max(120)).max(8).default([]).describe("Relevant projects, tools, or people"),
    files: z.array(z.string().min(1).max(220)).max(12).default([]).describe("Relevant files or paths"),
    updatedAt: z.string().datetime().optional().describe("Optional override; defaults to now"),
  },
  async ({ sessionId, scope, summary, task, decisions, openLoops, nextActions, entities, files, updatedAt }) => {
    const result = buildSessionCheckpointResult({
      sessionId,
      scope,
      summary,
      task,
      decisions,
      openLoops,
      nextActions,
      entities,
      files,
      ...(updatedAt ? { updatedAt } : {}),
    });
    const storedRecord = await checkpointStore.save(result.record);
    await saveManagedObservation(buildManagedCheckpointObservation({
      ...result,
      record: storedRecord,
    }));
    return {
      content: [{
        type: "text" as const,
        text: formatCheckpointSaved(storedRecord),
      }],
    };
  }
);

registerTool(
  "latest_checkpoint",
  "Fetch the most recent saved checkpoint for a session or shared scope. Read-only. Use when you need to inspect current work state without running a full resume_context.",
  {
    sessionId: z.string().min(1).max(160).optional().describe("Session identifier filter, e.g. 'abc123'"),
    scope: z.string().min(1).max(160).optional().describe("Shared scope filter, e.g. 'project:recallnest'"),
  },
  async ({ sessionId, scope }) => {
    const latest = await checkpointStore.getLatest({ sessionId, scope });
    return {
      content: [{
        type: "text" as const,
        text: formatCheckpointSummary(latest),
      }],
    };
  }
);

registerTool(
  "resume_context",
  "Compose startup context for a fresh window by combining durable memory, patterns, cases, and the latest checkpoint. Read-only. Use when entering a new session and you need to recover prior decisions, open loops, and next actions.",
  {
    task: z.string().min(1).max(500).optional().describe("Optional current task or question to bias recall"),
    scope: z.string().min(1).max(160).optional().describe("Optional shared scope for project or terminal continuity"),
    sessionId: z.string().min(1).max(160).optional().describe("Optional session identifier to recover the latest checkpoint"),
    limitPerSection: z.number().int().min(1).max(6).default(3).describe("Max items per section"),
    includeLatestCheckpoint: z.boolean().default(true).describe("Whether to include the latest checkpoint summary"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
    mode: z.enum(["full", "light", "summary", "off"]).optional().describe("Override recall mode: 'full' (default), 'light' (<300 tokens), 'summary' (checkpoint only), 'off'"),
  },
  async ({ task, scope, sessionId, limitPerSection, includeLatestCheckpoint, profile: profileName, mode: modeOverride }) => {
    const effectiveMode = resolveRecallMode(config, modeOverride);

    // --- off mode: no recall, guide agent to use search_memory ---
    if (effectiveMode === "off") {
      return {
        content: [{
          type: "text" as const,
          text: "Recall mode is off. Use search_memory to retrieve specific memories on demand.",
        }],
      };
    }

    // --- summary mode: checkpoint only, lightweight ---
    if (effectiveMode === "summary") {
      const scopeSelection = resolveScopeSelection({
        scope,
        sessionId,
        operation: "resume_context",
        allowUnscoped: true,
      });
      const latest = await checkpointStore.getLatest({
        sessionId,
        scope: scopeSelection.resolvedScope,
      });
      const summaryText = formatCheckpointSummary(latest) +
        "\n\nFor detailed recall, use search_memory with specific queries.";
      await saveManagedObservation({
        workflowId: "resume_context",
        outcome: "success",
        summary: `Managed resume_context returned summary-mode checkpoint${latest ? "" : " (none found)"}.`,
        scope: scopeSelection.resolvedScope || scope || "global",
        source: "managed:recallnest",
        signal: "managed-resume-summary",
        task,
        tags: ["managed", "recallnest", "summary-mode"],
      });
      return {
        content: [{
          type: "text" as const,
          text: summaryText,
        }],
      };
    }

    // --- light mode: <300 token ultra-light wake-up ---
    if (effectiveMode === "light") {
      const { retriever: lightRetriever } = getComponents(profileName);
      const lightScope = resolveScopeSelection({
        scope,
        sessionId,
        operation: "resume_context",
        allowUnscoped: true,
      });
      const lightResult = await composeLightResumeContext({
        retriever: lightRetriever,
        checkpointStore,
      }, {
        task,
        scope: lightScope.resolvedScope,
        sessionId,
        limitPerSection: limitPerSection,
        includeLatestCheckpoint,
        profile: profileName,
      });
      await saveManagedObservation({
        workflowId: "resume_context",
        outcome: "success",
        summary: `Managed resume_context returned light-mode context (~${lightResult.text.length} chars).`,
        scope: lightScope.resolvedScope || scope || "global",
        source: "managed:recallnest",
        signal: "managed-resume-light",
        task,
        tags: ["managed", "recallnest", "light-mode"],
      });
      return {
        content: [{
          type: "text" as const,
          text: lightResult.text,
        }],
      };
    }

    // --- full mode: existing compose behavior ---
    const { retriever, profile } = getComponents(profileName);
    const scopeSelection = resolveScopeSelection({
      scope,
      sessionId,
      operation: "resume_context",
      allowUnscoped: true,
    });
    const context = await composeResumeContext({
      retriever,
      checkpointStore,
    }, {
      task,
      scope: scopeSelection.resolvedScope,
      sessionId,
      limitPerSection,
      includeLatestCheckpoint,
      profile: profile.name,
    });
    await saveManagedObservation(buildManagedResumeObservation({
      task,
      scope,
      sessionId,
    }, context));

    return {
      content: [{
        type: "text" as const,
        text: formatResumeContext(context),
      }],
    };
  }
);

// --- search_memory tool ---
registerTool(
  "search_memory",
  "Search indexed memories by semantic similarity and return ranked results with optional temporal filtering. Read-only, but may fire stored reminders as a side effect. Use proactively at the start of tasks, when debugging, writing, or when the user references past work.",
  {
    query: z.string().describe("Search query — natural language or keywords"),
    limit: z.number().min(1).max(20).default(5).describe("Max results to return"),
    scope: z.string().optional().describe("Optional explicit scope"),
    sessionId: z.string().min(1).max(160).optional().describe("Optional session identifier to infer session:<id> scope"),
    allScopes: z.boolean().default(false).describe("When true, explicitly allow cross-scope search"),
    category: DurableMemoryCategorySchema.optional().describe("Filter by memory category: profile (identity/background), preferences (habits/style), entities (projects/tools/people), events (past happenings), cases (problem-solution pairs), patterns (reusable workflows)"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
    render: z.enum(["verbatim", "highlight"]).default("verbatim").optional().describe("Result rendering mode: verbatim (default, original order) or highlight (reorder by contextual relevance to query)"),
    after: z.string().optional().describe("Filter memories stored after this date (ISO format YYYY-MM-DD, or relative like '最近30天', 'last 7 days')"),
    before: z.string().optional().describe("Filter memories stored before this date (ISO format YYYY-MM-DD, or relative)"),
    graph: z.boolean().default(false).optional().describe("Enable KG graph traversal (PPR) for relationship-aware search. Use when query involves entity relationships (e.g. 'what tools does Alice use', 'Bob的朋友')."),
    includeArchived: z.boolean().default(false).optional().describe("When true, also return archived/superseded/consolidated memories (default: only active)"),
    detail_level: z.enum(["brief", "normal", "full"]).default("normal").optional()
      .describe("Result detail level: brief (ID+score+one-liner), normal (default, current behavior), full (include metadata)"),
    topicTag: z.string().min(1).max(60).optional()
      .describe("Filter by topic tag (e.g. 'auth', 'deploy', 'testing'). Only returns memories tagged with this topic."),
  },
  async ({ query, limit, scope, sessionId, allScopes, category, profile: profileName, render, after, before, graph, includeArchived, detail_level, topicTag }) => {
    const { retriever, profile } = getComponents(profileName);
    // Ensure KG store is attached to non-default profile retrievers for PPR
    if (graph && kgStoreInstance) retriever.setKGStore(kgStoreInstance);
    let results = await retriever.retrieve(buildRetrievalContext({
      query,
      limit: (after || before || topicTag) ? limit * 3 : limit,
      category,
      scope,
      sessionId,
      allScopes,
      graph,
      includeArchived,
      topicTag,
    }, {
      operation: "search_memory",
    }));

    // Explicit temporal filtering from after/before params
    if (after || before) {
      const constraint: TemporalConstraint = {
        type: (after && before) ? "range" : (after ? "after" : "before"),
        startMs: after ? new Date(after).getTime() || undefined : undefined,
        endMs: before ? new Date(before).getTime() || undefined : undefined,
        anchor: `${after || ""}..${before || ""}`,
      };
      if (constraint.startMs || constraint.endMs) {
        results = results
          .filter(r => matchesTemporalConstraint(r.entry.timestamp, constraint))
          .slice(0, limit);
      }
    }

    // Apply context-aware rendering when requested
    if (render === "highlight" && results.length > 0) {
      const rendered = renderMemories(
        results.map(r => ({ id: r.entry.id, text: r.entry.text, score: r.score, category: r.entry.category })),
        query,
        "highlight",
      );
      // Reorder results to match rendered order
      const idOrder = new Map(rendered.memories.map((m, i) => [m.id, i]));
      results.sort((a, b) => (idOrder.get(a.entry.id) ?? 999) - (idOrder.get(b.entry.id) ?? 999));
    }

    // Tier 3.4: Check for triggered reminders alongside search results
    const { store, embedder } = getComponents();
    const scopeFilter = scope ? [scope] : undefined;
    const triggered = await checkTriggers(store, embedder, query, scopeFilter);
    let reminderText = "";
    if (triggered.length > 0) {
      const firedActions: string[] = [];
      for (const reminder of triggered) {
        const action = await fireReminder(store, reminder.entryId, scopeFilter);
        if (action) firedActions.push(action);
      }
      if (firedActions.length > 0) {
        reminderText = "\n\n--- Triggered Reminders ---\n" +
          firedActions.map(a => `- ${a}`).join("\n");
      }
    }

    const level = detail_level ?? "normal";
    let body: string;
    if (level === "brief") {
      body = formatBriefResults(results, { query });
    } else if (level === "full") {
      body = formatFullResults(results, { query, profile: profile.name });
    } else {
      body = formatSearchResults(results, { query, profile: profile.name });
    }

    return {
      content: [{
        type: "text" as const,
        text: body + reminderText,
      }],
    };
  }
);

registerTool(
  "explain_memory",
  "Explain why memories matched a query: retrieval path, freshness, scope, and matched terms. Read-only. Use when search results seem unexpected and you need to debug ranking or scope filtering.",
  {
    query: z.string().describe("Search query to explain — natural language or keywords, e.g. 'auth migration'"),
    limit: z.number().min(1).max(20).default(5).describe("Maximum number of matched results to analyze and explain (default: 5)"),
    scope: z.string().optional().describe("Restrict to a specific scope, e.g. 'project:myapp'. Omit to use default scope"),
    sessionId: z.string().min(1).max(160).optional().describe("Session identifier to infer session-scoped search, e.g. 'abc123'"),
    allScopes: z.boolean().default(false).describe("Set to true to search across all scopes instead of the default scope"),
    category: DurableMemoryCategorySchema.optional().describe("Filter results by memory category, e.g. 'preference', 'decision', 'fact'"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile that tunes ranking: 'debug' for technical, 'fact-check' for precision"),
  },
  async ({ query, limit, scope, sessionId, allScopes, category, profile: profileName }) => {
    const { retriever, profile } = getComponents(profileName);
    const results = await retriever.retrieve(buildRetrievalContext({
      query,
      limit,
      category,
      scope,
      sessionId,
      allScopes,
    }, {
      operation: "explain_memory",
    }));
    return {
      content: [{
        type: "text" as const,
        text: formatExplainResults(results, { query, profile: profile.name }),
      }],
    };
  }
);

registerTool(
  "distill_memory",
  "Distill retrieved memories into a compact briefing with source map, key takeaways, and reusable evidence. Use this when you need a synthesized summary of stored knowledge on a topic rather than raw search results. Returns a structured briefing with citations. Read-only — does not modify stored memories.",
  {
    query: z.string().describe("Natural language topic or task to distill, e.g. 'authentication migration decisions'"),
    limit: z.number().min(1).max(20).default(8).describe("Maximum number of retrieved memories to include in the distillation (default: 8)"),
    scope: z.string().optional().describe("Restrict search to a specific scope, e.g. 'project:myapp'. Omit to use the default scope"),
    sessionId: z.string().min(1).max(160).optional().describe("Session identifier to infer session-scoped search, e.g. 'abc123'"),
    allScopes: z.boolean().default(false).describe("Set to true to search across all scopes instead of the default scope"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile that tunes ranking weights: 'writing' for narrative, 'debug' for technical, 'fact-check' for high-precision"),
  },
  async ({ query, limit, scope, sessionId, allScopes, profile: profileName }) => {
    const { retriever, profile } = getComponents(profileName || "writing");
    const results = await retriever.retrieve(buildRetrievalContext({
      query,
      limit,
      scope,
      sessionId,
      allScopes,
    }, {
      operation: "distill_memory",
    }));
    return {
      content: [{
        type: "text" as const,
        text: distillResults(results, { query, profile: profile.name }),
      }],
    };
  }
);

registerTool(
  "brief_memory",
  "Create a structured memory brief by retrieving and summarizing relevant memories, then persist it as a reusable asset indexed for future recall. Use this when you want to consolidate scattered knowledge on a topic into a single retrievable document. Side effect: writes a new brief asset to disk and indexes it in the vector store for future search.",
  {
    query: z.string().describe("Natural language topic or task to brief, e.g. 'deployment pipeline architecture decisions'"),
    limit: z.number().min(1).max(20).default(8).describe("Maximum number of source memories to include in the brief (default: 8)"),
    scope: z.string().optional().describe("Restrict search to a specific scope, e.g. 'project:myapp'. Omit to use the default scope"),
    sessionId: z.string().min(1).max(160).optional().describe("Session identifier to infer session-scoped search, e.g. 'abc123'"),
    allScopes: z.boolean().default(false).describe("Set to true to search across all scopes instead of the default scope"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile that tunes ranking weights: 'writing' for narrative, 'debug' for technical, 'fact-check' for high-precision"),
    title: z.string().optional().describe("Human-readable title for the brief asset, e.g. 'Q1 Auth Migration Summary'. Auto-generated if omitted"),
  },
  async ({ query, limit, scope, sessionId, allScopes, profile: profileName, title }) => {
    const { retriever, profile, store, embedder } = getComponents(profileName || "writing");
    const results = await retriever.retrieve(buildRetrievalContext({
      query,
      limit,
      scope,
      sessionId,
      allScopes,
    }, {
      operation: "brief_memory",
    }));
    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: `No results found for: ${query}` }] };
    }
    const briefSeedResults = selectBriefSeedResults(results);
    const summary = summarizeResults(briefSeedResults, { query, profile: profile.name });
    const asset = buildBriefAsset(summary, { title });
    const path = saveBriefAsset(asset);
    await indexAsset(store, embedder, asset);

    return {
      content: [{
        type: "text" as const,
        text: `Created brief ${asset.id.slice(0, 8)}\nTitle: ${asset.title}\nHits: ${asset.hits}\nPath: ${path}`,
      }],
    };
  }
);

registerTool(
  "pin_memory",
  "Pin a retrieved memory as a high-importance reusable asset on disk. Side effect: boosts importance to 0.95, writes pin asset file, and indexes it. Use when a search result is critical and should be surfaced in future recalls.",
  {
    memory_id: z.string().describe("Memory ID or unique prefix from search/explain output, e.g. 'a1b2c3d4'"),
    scope: z.string().optional().describe("Explicit scope filter, e.g. 'project:recallnest'"),
    sessionId: z.string().min(1).max(160).optional().describe("Session identifier to infer session:<id> scope, e.g. 'abc123'"),
    allScopes: z.boolean().default(false).describe("When true, allow cross-scope reads to find the memory"),
    title: z.string().optional().describe("Human-readable title for the pin, e.g. 'Auth migration decision'"),
    summary: z.string().optional().describe("Short summary override for the pinned asset"),
    query: z.string().optional().describe("Original query that led to this pin, e.g. 'auth decisions'"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile for ranking, e.g. 'debug'"),
  },
  async ({ memory_id, scope, sessionId, allScopes, title, summary, query, profile: profileName }) => {
    const { store, embedder } = getComponents(profileName);
    const scopeSelection = resolveScopeSelection({
      scope,
      sessionId,
      allScopes,
      operation: "pin_memory",
    });
    const entry = await store.get(memory_id, scopeSelection.scopeFilter);
    if (!entry) {
      return { content: [{ type: "text" as const, text: `Memory not found: ${memory_id}` }] };
    }

    await store.update(entry.id, { importance: Math.max(entry.importance || 0.7, 0.95) }, scopeSelection.scopeFilter);
    const asset = buildPinAsset(entryToRetrievalResult(entry), {
      title,
      summary,
      query,
      profile: profileName || "default",
    });
    const path = savePinAsset(asset);
    await indexPinnedAsset(store, embedder, asset);

    return {
      content: [{
        type: "text" as const,
        text: `Pinned ${asset.id.slice(0, 8)} from memory ${entry.id.slice(0, 8)}\nTitle: ${asset.title}\nPath: ${path}`,
      }],
    };
  }
);

registerTool(
  "export_memory",
  "Export a distilled memory briefing to a markdown or JSON file on disk. Side effect: writes an export artifact file. Use when you need an offline-readable snapshot of knowledge on a topic.",
  {
    query: z.string().describe("Topic or task to export, e.g. 'auth migration decisions'"),
    limit: z.number().min(1).max(20).default(8).describe("Maximum number of source memories to include in the export (default: 8)"),
    scope: z.string().optional().describe("Restrict to a specific scope, e.g. 'project:recallnest'. Omit to use default scope"),
    sessionId: z.string().min(1).max(160).optional().describe("Session identifier to infer session-scoped search, e.g. 'abc123'"),
    allScopes: z.boolean().default(false).describe("Set to true to search across all scopes instead of the default scope"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile for ranking, e.g. 'writing'"),
    format: z.enum(["md", "json"]).default("md").describe("Export format: 'md' for markdown, 'json' for structured JSON"),
  },
  async ({ query, limit, scope, sessionId, allScopes, profile: profileName, format }) => {
    const { retriever, profile } = getComponents(profileName || "writing");
    const results = await retriever.retrieve(buildRetrievalContext({
      query,
      limit,
      scope,
      sessionId,
      allScopes,
    }, {
      operation: "export_memory",
    }));
    const summary = distillResults(results, { query, profile: profile.name });
    const artifact = writeExportArtifact({
      query,
      profile: profile.name,
      results,
      summary,
      format,
    });

    return {
      content: [{
        type: "text" as const,
        text: `Exported ${artifact.id.slice(0, 8)}\nFormat: ${artifact.format}\nPath: ${artifact.outputPath}`,
      }],
    };
  }
);

registerTool(
  "list_assets",
  "List recent structured memory assets (pinned memories and distilled briefs) sorted by creation date. Read-only. Use when you need an inventory of persisted knowledge artifacts — for example, before creating a new brief to avoid duplicates. Returns asset type, title, scope, creation date, and file path for each entry.",
  {
    limit: z.number().min(1).max(50).default(12).describe("Maximum number of assets to return, sorted most-recent-first (default: 12, max: 50)"),
  },
  async ({ limit }) => {
    const rows = listMemoryAssets(limit);
    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No assets yet." }] };
    }
    const lines = [
      "Asset ID  Kind   Title  Scope / Sources  Date",
      "--------  -----  -----  ---------------  ----------",
      ...rows.map(row => assetSummaryLine(row)),
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

registerTool(
  "list_dirty_briefs",
  "List memory briefs generated before current cleanup rules that may need re-indexing. Read-only. Use when auditing brief quality or before running clean_dirty_briefs.",
  {},
  async () => {
    const rows = listDirtyBriefAssets();
    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No dirty briefs found." }] };
    }
    const lines = [
      "Brief ID  Title  Scope  Reasons",
      "--------  -----  -----  ----------------------------------------",
      ...rows.map(row => `${row.id.slice(0, 8)}  ${row.title}  [${row.scope}]  ${row.reasons.join("; ")}`),
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

registerTool(
  "clean_dirty_briefs",
  "Archive dirty briefs and remove their indexed asset entries. Side effect: when apply=true, moves briefs to archive and deletes index rows. Use when list_dirty_briefs shows stale briefs that need cleanup.",
  {
    apply: z.boolean().default(false).describe("When false, preview only (no writes). When true, archive briefs and delete indexed rows."),
  },
  async ({ apply }) => {
    const rows = listDirtyBriefAssets();
    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No dirty briefs found." }] };
    }

    if (!apply) {
      const preview = rows.map(row => `${row.id.slice(0, 8)}  ${row.title}  [${row.scope}]  ${row.reasons.join("; ")}`).join("\n");
      return {
        content: [{
          type: "text" as const,
          text: `Dirty briefs detected: ${rows.length}\n\n${preview}\n\nCall clean_dirty_briefs with apply=true to archive them.`,
        }],
      };
    }

    let archived = 0;
    let deleted = 0;
    for (const row of rows) {
      archiveDirtyBriefAsset(row);
      archived += 1;
      deleted += await store.bulkDelete([row.scope]);
    }

    return {
      content: [{
        type: "text" as const,
        text: `Dirty briefs: ${rows.length}\nArchived: ${archived}\nIndex rows deleted: ${deleted}`,
      }],
    };
  }
);

registerTool(
  "consolidate_memories",
  "Run semantic consolidation: cluster similar memories, merge near-duplicates, and detect contradictions. Side effect: when apply=true, archives merged entries. Use when a scope has grown large and needs deduplication.",
  {
    scope: z.string().min(1).max(160).describe("Scope to consolidate (e.g. project:recallnest)"),
    clusterThreshold: z.number().min(0.5).max(1.0).default(0.82).describe("Min similarity to form a cluster (default 0.82)"),
    mergeThreshold: z.number().min(0.5).max(1.0).default(0.92).describe("Min similarity to merge/archive (default 0.92)"),
    maxEntries: z.number().min(10).max(2000).default(500).describe("Max entries to scan (default 500)"),
    apply: z.boolean().default(false).describe("When false, preview only (scan + report without archiving). When true, actually merge/archive."),
  },
  async ({ scope, clusterThreshold, mergeThreshold, maxEntries, apply }) => {
    const { store } = getComponents();

    if (!apply) {
      // Dry-run: use a read-only wrapper that blocks writes
      const readOnlyStore = {
        list: store.list.bind(store),
        getById: store.getById.bind(store),
        vectorSearch: store.vectorSearch.bind(store),
        update: async () => null, // no-op in dry-run
      };
      const engine = new ConsolidationEngine(readOnlyStore, { clusterThreshold, mergeThreshold, maxEntriesPerRun: maxEntries });
      const result = await engine.run(scope);
      return {
        content: [{
          type: "text" as const,
          text: `[DRY-RUN] ${formatConsolidationResult(result)}\n\nRe-run with apply=true to execute merges.`,
        }],
      };
    }

    const engine = new ConsolidationEngine(store, { clusterThreshold, mergeThreshold, maxEntriesPerRun: maxEntries });
    const result = await engine.run(scope);
    return {
      content: [{
        type: "text" as const,
        text: formatConsolidationResult(result),
      }],
    };
  }
);

registerTool(
  "list_pins",
  "List pinned memory assets sorted by creation date, showing title, scope, importance score, and file path. Read-only. Use when you need to review high-value memories that were explicitly pinned via pin_memory, or to check if a topic already has a pinned reference before creating a new one.",
  {
    limit: z.number().min(1).max(50).default(10).describe("Maximum number of pinned assets to return, sorted most-recent-first (default: 10, max: 50)"),
  },
  async ({ limit }) => {
    const rows = listPinAssets(limit);
    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No pinned assets yet." }] };
    }
    const lines = [
      "Pin ID    Title  Scope  Date",
      "--------  -----  -----  ----------",
      ...rows.map(row => `${row.id.slice(0, 8)}  ${row.title}  [${row.source.scope}]  ${row.createdAt.slice(0, 10)}`),
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// --- memory_stats tool ---
registerTool(
  "memory_stats",
  "Show aggregate statistics of the memory database: total entries, counts by source and category. Read-only. Use when you need an overview of memory store health or size.",
  {},
  async () => {
    const stats = await store.stats();

    // Aggregate by source prefix
    const sourceCounts: Record<string, number> = {};
    for (const [scope, count] of Object.entries(stats.scopeCounts)) {
      const prefix = scope.split(":")[0];
      sourceCounts[prefix] = (sourceCounts[prefix] || 0) + count;
    }

    const lines = [
      `Total entries: ${stats.totalCount}`,
      "",
      "By source:",
      ...Object.entries(sourceCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([src, count]) => `  ${src}: ${count}`),
      "",
      "By category:",
      ...Object.entries(stats.categoryCounts || {})
        .sort((a, b) => b[1] - a[1])
        .map(([cat, count]) => `  ${cat}: ${count}`),
    ];

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// ============================================================================
// LC-P4: Data Checkup Tool
// ============================================================================

registerTool(
  "data_checkup",
  "Run health checks on the memory database: vector dimensions, orphans, tier distribution, and conflict backlog. Read-only. Use when diagnosing data quality issues or before a consolidation run.",
  {},
  async () => {
    const openConflicts = (await conflictStore.listRecent({ status: "open", limit: 200 })).length;
    const report = await runDataCheckup({ store, openConflictCount: openConflicts });
    return {
      content: [{ type: "text" as const, text: formatCheckupReport(report) }],
    };
  }
);

// ============================================================================
// Memory Lint Tool
// ============================================================================

registerTool(
  "memory_lint",
  "Run memory quality lint checks: contradictions, duplicates, stale entries, and orphans. Read-only. Returns a health score (0-100) and actionable findings. Use for periodic memory hygiene or before consolidation.",
  {
    scope: z.string().min(1).max(160).optional().describe("Optional scope filter, e.g. 'project:recallnest'. Omit to lint all scopes"),
    verbose: z.boolean().default(false).describe("Include all individual findings in output (default: summarized)"),
  },
  async ({ scope, verbose }) => {
    const report = await runMemoryLint({ store, scope, verbose });
    return {
      content: [{ type: "text" as const, text: formatMemoryLintReport(report) }],
    };
  }
);

// ============================================================================
// Knowledge Graph Export Tool
// ============================================================================

registerTool(
  "export_graph",
  "Export memories as an interactive HTML knowledge graph. Creates a self-contained HTML file with a force-directed visualization. Open in any browser. Use when the user wants to visualize their memory network.",
  {
    scope: z.string().min(1).max(160).optional().describe("Optional scope filter"),
    maxNodes: z.number().int().min(10).max(500).default(200).describe("Maximum nodes to include (default 200)"),
  },
  async ({ scope, maxNodes }) => {
    const { path, graph } = await exportMemoryGraph(store, { scope, maxNodes });
    return {
      content: [{ type: "text" as const, text: formatGraphExportResult(path, graph) }],
    };
  }
);

// ============================================================================
// AD-1: Dream Pipeline Tool
// ============================================================================

registerTool(
  "dream",
  "Run a full memory consolidation cycle (Orient, Gather, Consolidate, Prune). Side effect: may archive low-value entries and generate insight memories. Use when memory count is high and you need periodic maintenance.",
  {
    scope: z.string().min(1).max(160).optional().describe("Scope to consolidate, e.g. 'project:myapp'. Omit to consolidate across all scopes"),
    force: z.boolean().default(false).describe("Set to true to force consolidation even if recent write count is below the automatic threshold"),
  },
  async ({ scope, force }) => {
    const resolvedScope = scope || "project:default";
    const components = getComponents();
    const result = await runDream({
      store: components.store,
      llm: components.llm,
      embedder: components.embedder,
      scope: resolvedScope,
      force,
    });
    return {
      content: [{ type: "text" as const, text: formatDreamResult(result) }],
    };
  }
);

// ============================================================================
// Memory Drill-Down Tool
// ============================================================================

registerTool(
  "memory_drill_down",
  "Retrieve the full or overview-level content of a single memory entry. Read-only. Use when search returned compact summaries and you need the complete text or L1 overview.",
  {
    id: z.string().describe("Memory ID or unique prefix (at least 8 hex chars), e.g. 'a1b2c3d4'"),
    level: z.enum(["overview", "full"]).optional().default("full")
      .describe("Content depth: 'overview' (L1) or 'full' (L2, default)"),
  },
  async ({ id, level }) => {
    try {
      const entry = await store.getById(id);
      if (!entry) {
        return {
          content: [{ type: "text" as const, text: `No memory found with ID: ${id}` }],
        };
      }

      // Parse metadata for L0/L1/L2 content
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(entry.metadata || "{}");
      } catch { /* malformed metadata, use raw text */ }

      // Support both legacy short names (l0/l1) and current long names (l0_abstract/l1_overview/l2_content)
      const l0 = typeof meta.l0_abstract === "string" ? meta.l0_abstract : typeof meta.l0 === "string" ? meta.l0 : null;
      const l1 = typeof meta.l1_overview === "string" ? meta.l1_overview : typeof meta.l1 === "string" ? meta.l1 : null;
      const l2 = typeof meta.l2_content === "string" ? meta.l2_content : entry.text;

      let content: string;
      if (level === "overview" && l1) {
        content = `## ${entry.category} (L1 Overview)\n\n${l1}`;
      } else {
        content = `## ${entry.category} (Full Content)\n\n${l2}`;
      }

      const header = [
        `**ID**: ${entry.id}`,
        `**Category**: ${entry.category}`,
        `**Scope**: ${entry.scope}`,
        `**Importance**: ${entry.importance}`,
        `**Created**: ${new Date(entry.timestamp).toISOString()}`,
        l0 ? `**Abstract**: ${l0}` : null,
      ].filter(Boolean).join("\n");

      return {
        content: [{ type: "text" as const, text: `${header}\n\n${content}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error drilling down: ${String(err)}` }],
      };
    }
  },
);

// ============================================================================
// Skill Memory Tools (D-1)
// ============================================================================

registerTool(
  "store_skill",
  "Store an executable skill with trigger conditions, implementation, and verification steps. Side effect: persists a new skill entry and indexes it. Use when you identify a reusable procedure worth automating across sessions.",
  {
    name: z.string().min(1).max(120).describe("Unique skill identifier, e.g. 'deploy_production' or 'run_migrations'"),
    description: z.string().min(1).max(500).describe("Natural language description of what the skill does (used for semantic retrieval matching)"),
    triggerPattern: z.string().min(1).max(300).describe("Natural language pattern describing when to suggest this skill, e.g. 'user asks to deploy to production'"),
    implementationType: SkillImplementationTypeSchema.describe("Execution type: 'bash' for shell scripts, 'python' for Python code, 'mcp_tool_chain' for MCP sequences, 'instruction_sequence' for step-by-step instructions"),
    implementation: z.string().min(1).max(5000).describe("Executable content: the actual script, code, or instruction steps to run"),
    inputSchema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema defining the skill's input parameters, e.g. {\"env\": {\"type\": \"string\"}}"),
    verification: z.string().max(500).optional().describe("Steps to verify the skill executed correctly, e.g. 'check deployment URL returns 200'"),
    scope: z.string().min(1).max(160).describe("Scope to store the skill under, e.g. 'project:recallnest'"),
    source: z.enum(["manual", "agent", "api"]).default("agent").describe("How this skill was captured: 'manual' by user, 'agent' by AI, or 'api' programmatically"),
    tags: z.array(z.string().max(60)).max(6).default([]).describe("Optional categorization tags, e.g. ['deployment', 'production']"),
  },
  async ({ name, description, triggerPattern, implementationType, implementation, inputSchema, verification, scope, source, tags }) => {
    const { store, embedder } = getComponents();
    const stored = await persistSkill(store, embedder, {
      name,
      description,
      triggerPattern,
      implementationType,
      implementation,
      inputSchema,
      verification,
      scope,
      source,
      tags,
    });

    return {
      content: [{
        type: "text" as const,
        text: [
          `Stored skill ${stored.id.slice(0, 8)}`,
          `Name: ${stored.name}`,
          `Type: ${stored.implementationType}`,
          `Scope: ${stored.scope}`,
          `Tags: ${stored.tags.join(", ") || "-"}`,
          `Stored at: ${stored.storedAt}`,
        ].join("\n"),
      }],
    };
  },
);

registerTool(
  "retrieve_skill",
  "Retrieve executable skills matching a task description by semantic similarity. Read-only. Use when you need a stored procedure to act on, not just recall knowledge.",
  {
    query: z.string().min(1).max(300).describe("Natural language task description to match, e.g. 'deploy the app to production'"),
    scope: z.string().min(1).max(160).optional().describe("Restrict to skills in a specific scope, e.g. 'project:myapp'. Omit to search all scopes"),
    limit: z.number().min(1).max(10).default(3).describe("Maximum number of matching skills to return, sorted by relevance (default: 3)"),
  },
  async ({ query, scope, limit }) => {
    const { store, embedder } = getComponents();
    const results = await retrieveSkills(store, embedder, query, scope, limit);

    if (results.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No matching skills found.",
        }],
      };
    }

    const formatted = results.map(({ skill, score }, index) => [
      `## ${index + 1}. ${skill.name} (score: ${score.toFixed(3)})`,
      `**Description**: ${skill.description}`,
      `**Trigger**: ${skill.triggerPattern}`,
      `**Type**: ${skill.implementationType}`,
      skill.verification ? `**Verification**: ${skill.verification}` : null,
      `**Tags**: ${skill.tags.join(", ") || "-"}`,
      "",
      "```",
      skill.implementation,
      "```",
    ].filter((line): line is string => line !== null).join("\n")).join("\n\n---\n\n");

    return {
      content: [{
        type: "text" as const,
        text: `Found ${results.length} skill(s):\n\n${formatted}`,
      }],
    };
  },
);

// --- D-2: scan_skill_promotions tool ---
registerTool(
  "scan_skill_promotions",
  "Scan cases and patterns in a scope for potential promotion to reusable skills. Read-only. Use when you want to discover recurring procedures that deserve formalization as skills.",
  {
    scope: z.string().min(1).max(160).describe("Project scope to scan for promotion candidates"),
    minOccurrences: z.number().min(2).max(20).default(3).describe("Minimum similar cases to trigger a promotion suggestion"),
  },
  async ({ scope, minOccurrences }) => {
    const { store } = getComponents();
    const result = await scanForPromotions(store, scope, {
      minCaseOccurrences: minOccurrences,
    });

    return {
      content: [{
        type: "text" as const,
        text: formatPromotionResult(result),
      }],
    };
  },
);

// --- MCP-1: list_tools tool ---
registerTool(
  "list_tools",
  "List available RecallNest tools with one-line descriptions, filtered by tier. Read-only. Use when you need to discover advanced or governance tools beyond the core set.",
  {
    tier: z.enum(["core", "advanced", "full"]).default("advanced").optional()
      .describe("Which tier of tools to list. Returns tools at this tier and below."),
  },
  async ({ tier }) => {
    const requestedTier = tier ?? "advanced";
    const tierOrder: Record<string, number> = { core: 0, advanced: 1, governance: 2 };
    const maxOrder = requestedTier === "full" ? 2 : tierOrder[requestedTier] ?? 1;

    const lines: string[] = [`Available tools (tier: ${requestedTier}):`];
    for (const [toolName, toolTier] of Object.entries(TOOL_TIERS)) {
      if ((tierOrder[toolTier] ?? 999) > maxOrder) continue;
      const desc = TOOL_DESCRIPTIONS.get(toolName);
      const oneLiner = desc
        ? desc.split(/[.!]\s/)[0]?.slice(0, 100) ?? desc.slice(0, 100)
        : "(no description)";
      lines.push(`- ${toolName}: ${oneLiner}`);
    }

    return {
      content: [{
        type: "text" as const,
        text: lines.join("\n"),
      }],
    };
  },
);

// --- MCP-3: batch_store tool ---
registerTool(
  "batch_store",
  "Store multiple memories in a single call with deduplication. Side effect: persists up to 20 entries. Use when you have several facts to store at once, more efficient than repeated store_memory calls.",
  {
    memories: z.array(z.object({
      text: z.string().min(1),
      category: DurableMemoryCategorySchema.default("events"),
      importance: z.number().min(0).max(1).default(0.7),
      tags: z.array(z.string()).max(6).default([]),
    })).min(1).max(20),
    scope: z.string().min(1).max(160),
    source: z.enum(["manual", "agent", "api"]).default("agent"),
  },
  async ({ memories, scope, source }) => {
    const { store, embedder } = getComponents();
    const stored = await persistMemoryBatch({
      store,
      embedder,
      conflictStore,
      kgExtractor,
    }, {
      scope,
      source,
      defaultImportance: 0.7,
      memories: memories.map((m) => ({
        text: m.text,
        category: m.category,
        importance: m.importance,
        tags: m.tags,
      })),
    });

    const counts = { new: 0, deduped: 0, updated: 0 };
    for (const r of stored) {
      if (r.disposition === "deduped") counts.deduped++;
      else if (r.disposition === "updated") counts.updated++;
      else counts.new++;
    }

    return {
      content: [{
        type: "text" as const,
        text: `Stored ${stored.length} memories (${counts.new} new, ${counts.deduped} deduped, ${counts.updated} updated)`,
      }],
    };
  },
);

// --- MP-2: import_conversations tool ---

registerTool(
  "import_conversations",
  "Import a conversation file (Claude Code JSONL, Claude.ai JSON, ChatGPT JSON, Slack JSON, or plaintext) into memory. Auto-detects format or use explicit format parameter. Messages are normalized and stored via the standard persistMemory pipeline.",
  {
    content: z.string().min(1).max(500_000).describe("Raw file content to import"),
    scope: z.string().min(1).max(160).describe("Target scope for imported memories, e.g. 'project:myapp'"),
    format: z.enum(["auto", "claude-code", "claude-ai", "chatgpt", "slack", "plaintext"]).default("auto").describe("Conversation format. Use 'auto' to detect automatically."),
  },
  async ({ content, scope, format }) => {
    const { detectFormat, normalizeConversation, ingestNormalizedMessages } = await import("./conversation-importer.js");
    const { embedder } = getComponents();

    const resolvedFormat = format === "auto" ? detectFormat(content) : format;
    const messages = normalizeConversation(content, resolvedFormat);

    if (messages.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: `No messages found (detected format: ${resolvedFormat})`,
        }],
      };
    }

    const result = await ingestNormalizedMessages(
      { store, embedder, llm, conflictStore, kgExtractor },
      messages,
      scope,
    );

    return {
      content: [{
        type: "text" as const,
        text: [
          `Import complete (format: ${resolvedFormat})`,
          `Total: ${result.total}`,
          `Stored: ${result.stored}`,
          `Rejected: ${result.rejected}`,
          result.errors.length > 0 ? `Errors: ${result.errors.join("; ")}` : null,
        ].filter(Boolean).join("\n"),
      }],
    };
  },
);

// --- S15: distill_session tool ---
registerTool(
  "distill_session",
  "Distill a conversation session into structured knowledge and persist to long-term memory. Three layers: (1) microcompact clears old tool results at zero cost, (2) LLM summarizes into 9 dimensions, (3) extracts durable knowledge into RecallNest. Use when a session is ending or context is getting large. Side effect: persists extracted memories.",
  {
    messages: z.array(z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.union([
        z.string(),
        z.array(z.object({
          type: z.enum(["text", "tool_use", "tool_result"]),
          name: z.string().optional(),
          id: z.string().optional(),
          input: z.record(z.unknown()).optional(),
          content: z.string().optional(),
          text: z.string().optional(),
          tool_use_id: z.string().optional(),
        })),
      ]),
    })).min(1).max(500).describe("Conversation messages to distill"),
    scope: z.string().min(1).max(160).describe("Memory scope for persisted knowledge, e.g. 'project:recallnest'"),
    preserveRecent: z.number().min(0).max(20).default(6).describe("Keep the N most recent messages verbatim (default: 6)"),
    keepRecentTools: z.number().min(0).max(20).default(5).describe("Keep the N most recent tool results during microcompact (default: 5)"),
    persist: z.boolean().default(true).describe("Whether to persist extracted knowledge to RecallNest (default: true)"),
  },
  async ({ messages, scope, preserveRecent, keepRecentTools, persist }) => {
    const { store, embedder } = getComponents();
    const { distillSession } = await import("./session-distiller.js");

    const result = await distillSession(
      { messages, scope, preserveRecent, keepRecentTools, persist },
      {
        llm: llmClient,
        persistMemory: async (input) => {
          const stored = await persistMemory({
            store, embedder, conflictStore, kgExtractor,
          }, input);
          return { disposition: stored.disposition, id: stored.id };
        },
      },
    );

    const lines = [
      `Microcompact: ${result.microcompact.toolsCleared} tool results cleared, ~${result.microcompact.tokensFreed} tokens freed`,
    ];
    if (result.summary) {
      lines.push(`Summary: 9-dimension structured summary generated`);
    }
    if (result.persisted) {
      const p = result.persisted;
      lines.push(`Persisted: ${p.memoriesStored} stored, ${p.memoriesDeduped} deduped, ${p.memoriesConflicted} conflicted, ${p.memoriesRejected} rejected`);
    }

    return {
      content: [{
        type: "text" as const,
        text: lines.join("\n"),
      }],
    };
  },
);

// ============================================================================
// Start
// ============================================================================

// Auto-register babel-memory language processor if installed (non-blocking)
autoRegisterBabelMemory().then((ok) => {
  if (ok) console.error("[recallnest] babel-memory registered");
});

const transport = new StdioServerTransport();
await server.connect(transport);
