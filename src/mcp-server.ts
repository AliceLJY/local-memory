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

  set_reminder: "core",

  // Advanced
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
  memory_drill_down: "advanced",
  export_memory: "advanced",

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
import { z } from "zod";
import type { RetrievalResult } from "./retriever.js";
import type { MemoryStore } from "./store.js";
import { distillResults, formatExplainResults, formatSearchResults, selectBriefSeedResults, summarizeResults } from "./memory-output.js";
import { archiveDirtyBriefAsset, assetSummaryLine, buildBriefAsset, buildPinAsset, listDirtyBriefAssets, listMemoryAssets, listPinAssets, saveBriefAsset, savePinAsset, writeExportArtifact } from "./memory-assets.js";
import { indexAsset, indexPinnedAsset } from "./asset-sync.js";
import { createComponentResolver, loadConfig, loadDotEnv, resolveRecallMode } from "./runtime-config.js";
import { DurableMemoryCategorySchema, StoreMemorySourceSchema } from "./memory-schema.js";
import { persistCaseMemory, persistMemory, persistMemoryBatch, persistWorkflowPattern, promoteMemory } from "./capture-engine.js";
import { autoCapture } from "./capture-heuristic.js";
import { ConsolidationEngine, formatConsolidationResult } from "./consolidation-engine.js";
import { renderMemories, type RenderMode } from "./context-renderer.js";
import { buildSessionCheckpointResult } from "./session-engine.js";
import { SessionCheckpointStore } from "./session-store.js";
import { composeResumeContext } from "./context-composer.js";
import { formatCheckpointSaved, formatCheckpointSummary, formatResumeContext } from "./session-output.js";
import { ConflictStatusSchema } from "./conflict-schema.js";
import { KGStore } from "./kg-store.js";
import { createKGExtractor, isKGModeEnabled, type KGExtractor } from "./kg-extractor.js";
import { resolveConflictCandidate } from "./conflict-engine.js";
import { escalateConflicts } from "./conflict-escalation.js";
import { ConflictCandidateStore } from "./conflict-store.js";
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

function registerTool(name: string, description: string, schema: ToolSchema, handler: ToolHandler): void {
  if (!shouldRegisterTool(name)) {
    // stdout is reserved for MCP JSON-RPC on stdio transports.
    console.error(`[MCP] Skipping ${name} (tier: ${TOOL_TIERS[name]})`);
    return;
  }
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
  "Inspect workflow observation health. With workflowId, return a 7d/30d health report; without workflowId, return a dashboard of the most degraded workflows.",
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
  "Generate an evidence pack for a workflow primitive, including recent issue observations, top signals, and suggested next actions.",
  {
    workflowId: z.string().min(1).max(120).describe("Workflow primitive id"),
    scope: z.string().min(1).max(160).optional().describe("Optional scope filter"),
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
  },
  async ({ text, category, importance, scope, source, tags, canonicalKey }) => {
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
  "Set a prospective memory reminder: 'next time X comes up, remind me about Y'. The reminder is stored and automatically triggered during future retrievals when the trigger condition is matched.",
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
  "Promote an evidence memory into durable memory. Use this when a transcript snippet or imported artifact contains a fact worth keeping across windows, and you want an explicit authority upgrade instead of leaving it as raw evidence.",
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
  "List or inspect open conflict candidates when incoming evidence promotions disagree with an existing durable memory for the same canonical key.",
  {
    conflictId: z.string().min(1).max(128).optional().describe("Optional conflict ID to inspect a single record"),
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
  "Resolve a stored conflict candidate by keeping the existing durable memory, accepting the incoming promoted evidence, or merging the two texts.",
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
  "Generate a terminal-friendly conflict audit summary so you can see which stale or escalated conflict clusters should be reviewed first.",
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
  "Preview or apply the conflict aging policy so stale or escalated open conflicts are explicitly marked for operator review.",
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
  "Fetch the latest saved checkpoint for a session or shared scope. Useful for inspecting current work state before resume_context exists.",
  {
    sessionId: z.string().min(1).max(160).optional().describe("Optional session identifier filter"),
    scope: z.string().min(1).max(160).optional().describe("Optional shared scope filter"),
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
  "Compose startup context for a fresh window by combining stable durable memory, relevant patterns and cases, plus the latest checkpoint for the current scope or session.",
  {
    task: z.string().min(1).max(500).optional().describe("Optional current task or question to bias recall"),
    scope: z.string().min(1).max(160).optional().describe("Optional shared scope for project or terminal continuity"),
    sessionId: z.string().min(1).max(160).optional().describe("Optional session identifier to recover the latest checkpoint"),
    limitPerSection: z.number().int().min(1).max(6).default(3).describe("Max items per section"),
    includeLatestCheckpoint: z.boolean().default(true).describe("Whether to include the latest checkpoint summary"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
    mode: z.enum(["full", "summary", "off"]).optional().describe("Override recall mode (default: from config.recallMode)"),
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
  "IMPORTANT: Use this tool proactively at the start of tasks to recall relevant past conversations, decisions, and patterns. Search when: starting a new task, debugging, writing, making decisions, or when the user references past work. Do NOT wait for the user to ask you to search. Query with key nouns/verbs from the user's message.",
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
  },
  async ({ query, limit, scope, sessionId, allScopes, category, profile: profileName, render, after, before, graph }) => {
    const { retriever, profile } = getComponents(profileName);
    // Ensure KG store is attached to non-default profile retrievers for PPR
    if (graph && kgStoreInstance) retriever.setKGStore(kgStoreInstance);
    let results = await retriever.retrieve(buildRetrievalContext({
      query,
      limit: (after || before) ? limit * 3 : limit, // Over-fetch when temporal filtering will reduce results
      category,
      scope,
      sessionId,
      allScopes,
      graph,
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

    return {
      content: [{
        type: "text" as const,
        text: formatSearchResults(results, { query, profile: profile.name }) + reminderText,
      }],
    };
  }
);

registerTool(
  "explain_memory",
  "Explain why the indexed memories matched: retrieval path, freshness, file/session, and matched terms.",
  {
    query: z.string().describe("Search query — natural language or keywords"),
    limit: z.number().min(1).max(20).default(5).describe("Max results to analyze"),
    scope: z.string().optional().describe("Optional explicit scope"),
    sessionId: z.string().min(1).max(160).optional().describe("Optional session identifier to infer session:<id> scope"),
    allScopes: z.boolean().default(false).describe("When true, explicitly allow cross-scope search"),
    category: DurableMemoryCategorySchema.optional().describe("Filter by memory category"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
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
  "Distill retrieved memories into a compact briefing with source map, takeaways, and reusable evidence.",
  {
    query: z.string().describe("Topic or task to distill"),
    limit: z.number().min(1).max(20).default(8).describe("Max results to distill"),
    scope: z.string().optional().describe("Optional explicit scope"),
    sessionId: z.string().min(1).max(160).optional().describe("Optional session identifier to infer session:<id> scope"),
    allScopes: z.boolean().default(false).describe("When true, explicitly allow cross-scope search"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
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
  "Create a structured memory brief from retrieved results and feed it back into recall.",
  {
    query: z.string().describe("Topic or task to turn into a memory brief"),
    limit: z.number().min(1).max(20).default(8).describe("Max results to distill into the brief"),
    scope: z.string().optional().describe("Optional explicit scope"),
    sessionId: z.string().min(1).max(160).optional().describe("Optional session identifier to infer session:<id> scope"),
    allScopes: z.boolean().default(false).describe("When true, explicitly allow cross-scope search"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
    title: z.string().optional().describe("Optional brief title"),
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
  "Promote one retrieved memory into a pinned asset for later reuse.",
  {
    memory_id: z.string().describe("Memory ID or unique prefix from search/explain output"),
    scope: z.string().optional().describe("Optional explicit scope"),
    sessionId: z.string().min(1).max(160).optional().describe("Optional session identifier to infer session:<id> scope"),
    allScopes: z.boolean().default(false).describe("When true, explicitly allow cross-scope reads"),
    title: z.string().optional().describe("Optional pinned title"),
    summary: z.string().optional().describe("Optional pinned summary"),
    query: z.string().optional().describe("Optional query that led to this pin"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
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
  "Export a distilled memory briefing to a markdown or json artifact on disk.",
  {
    query: z.string().describe("Topic or task to export"),
    limit: z.number().min(1).max(20).default(8).describe("Max results to export"),
    scope: z.string().optional().describe("Optional explicit scope"),
    sessionId: z.string().min(1).max(160).optional().describe("Optional session identifier to infer session:<id> scope"),
    allScopes: z.boolean().default(false).describe("When true, explicitly allow cross-scope search"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
    format: z.enum(["md", "json"]).default("md").describe("Export format"),
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
  "List recent structured memory assets, including pinned memories and distilled briefs.",
  {
    limit: z.number().min(1).max(50).default(12).describe("Max assets to list"),
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
  "Preview dirty memory briefs that were generated before the current brief-cleanup rules.",
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
  "Archive dirty briefs and remove their indexed asset scopes. Use preview mode first if unsure.",
  {
    apply: z.boolean().default(false).describe("When false, preview only. When true, archive and delete indexed rows."),
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
  "Run semantic consolidation on a scope: cluster similar memories, merge near-duplicates, link related entries, and detect contradictions. Dry-run by default — set apply=true to actually archive merged entries.",
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
  "List recently pinned memory assets.",
  {
    limit: z.number().min(1).max(50).default(10).describe("Max pinned assets to list"),
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
  "Show statistics of the indexed memory database",
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
// Memory Drill-Down Tool
// ============================================================================

registerTool(
  "memory_drill_down",
  "Get deeper content for a memory entry. Use after seeing compact summaries to get the full text or structured overview.",
  {
    id: z.string().describe("Memory ID or prefix (at least 8 hex chars)"),
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
// Start
// ============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
