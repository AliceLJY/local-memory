#!/usr/bin/env bun
/**
 * RecallNest MCP Server
 *
 * Exposes conversation memory search as MCP tools,
 * so any MCP-compatible AI client (Claude Code, etc.)
 * can search your indexed conversations.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { RetrievalResult } from "./retriever.js";
import type { MemoryStore } from "./store.js";
import { distillResults, formatExplainResults, formatSearchResults, selectBriefSeedResults, summarizeResults } from "./memory-output.js";
import { archiveDirtyBriefAsset, assetSummaryLine, buildBriefAsset, buildPinAsset, listDirtyBriefAssets, listMemoryAssets, listPinAssets, saveBriefAsset, savePinAsset, writeExportArtifact } from "./memory-assets.js";
import { indexAsset, indexPinnedAsset } from "./asset-sync.js";
import { createComponentResolver, loadConfig, loadDotEnv } from "./runtime-config.js";
import { DurableMemoryCategorySchema, StoreMemorySourceSchema } from "./memory-schema.js";
import { persistCaseMemory, persistMemory, persistWorkflowPattern, promoteMemory } from "./capture-engine.js";
import { buildSessionCheckpointRecord } from "./session-engine.js";
import { SessionCheckpointStore } from "./session-store.js";
import { composeResumeContext } from "./context-composer.js";
import { formatCheckpointSaved, formatCheckpointSummary, formatResumeContext } from "./session-output.js";
import { ConflictStatusSchema } from "./conflict-schema.js";
import { resolveConflictCandidate } from "./conflict-engine.js";
import { escalateConflicts } from "./conflict-escalation.js";
import { ConflictCandidateStore } from "./conflict-store.js";
import { formatConflictAudit, formatConflictClusters, formatConflictEscalation, formatConflictList, formatConflictRecord, formatConflictResolution } from "./conflict-output.js";
import { CONFLICT_ATTENTION_LEVELS, summarizeConflictLifecycle } from "./conflict-lifecycle.js";
import { buildConflictAuditSummary, clusterConflicts } from "./conflict-advisor.js";

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

// ============================================================================
// MCP Server
// ============================================================================

loadDotEnv();
const config = loadConfig();
const getComponents = createComponentResolver(config);
const { store } = getComponents();
const checkpointStore = new SessionCheckpointStore();
const conflictStore = new ConflictCandidateStore();

const server = new McpServer({
  name: "recallnest",
  version: "1.3.0",
});

server.tool(
  "store_memory",
  "Store a durable memory when the user shares a stable preference, identity fact, project entity, reusable pattern, or solved case that should survive future windows. Do not use this for transient task state; use it only for memory worth keeping.",
  {
    text: z.string().min(1).max(4000).describe("Memory text to store"),
    category: DurableMemoryCategorySchema.default("events").describe("Durable memory category"),
    importance: z.number().min(0).max(1).default(0.7).describe("Importance score from 0 to 1"),
    scope: z.string().min(1).max(160).optional().describe("Optional scope override; defaults to memory:<source>"),
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

server.tool(
  "store_workflow_pattern",
  "Store a reusable workflow pattern as durable memory. Use this when you identify a repeatable process worth reusing across fresh windows, such as startup continuity, debugging routines, review flows, or handoff steps.",
  {
    title: z.string().min(1).max(120).describe("Short pattern title"),
    trigger: z.string().min(1).max(240).describe("When this workflow should be used"),
    steps: z.array(z.string().min(1).max(220)).min(1).max(8).describe("Ordered workflow steps"),
    outcome: z.string().min(1).max(240).optional().describe("Optional expected outcome"),
    tools: z.array(z.string().min(1).max(60)).max(6).default([]).describe("Optional tools, commands, or interfaces involved"),
    importance: z.number().min(0).max(1).default(0.82).describe("Importance score from 0 to 1"),
    scope: z.string().min(1).max(160).optional().describe("Optional scope override; defaults to memory:<source>"),
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

server.tool(
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
    scope: z.string().min(1).max(160).optional().describe("Optional scope override; defaults to memory:<source>"),
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

server.tool(
  "promote_memory",
  "Promote an evidence memory into durable memory. Use this when a transcript snippet or imported artifact contains a fact worth keeping across windows, and you want an explicit authority upgrade instead of leaving it as raw evidence.",
  {
    memoryId: z.string().min(1).max(128).describe("Existing evidence memory ID or unique prefix"),
    text: z.string().min(1).max(4000).optional().describe("Optional cleaned durable text; defaults to the source entry text"),
    category: DurableMemoryCategorySchema.optional().describe("Optional target durable category; defaults to the source evidence category or its originalCategory"),
    importance: z.number().min(0).max(1).default(0.78).describe("Importance score from 0 to 1"),
    scope: z.string().min(1).max(160).optional().describe("Optional scope override; defaults to memory:<source>"),
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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
    const record = buildSessionCheckpointRecord({
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
    const storedRecord = await checkpointStore.save(record);
    return {
      content: [{
        type: "text" as const,
        text: formatCheckpointSaved(storedRecord),
      }],
    };
  }
);

server.tool(
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

server.tool(
  "resume_context",
  "Compose startup context for a fresh window by combining stable durable memory, relevant patterns and cases, plus the latest checkpoint for the current scope or session.",
  {
    task: z.string().min(1).max(500).optional().describe("Optional current task or question to bias recall"),
    scope: z.string().min(1).max(160).optional().describe("Optional shared scope for project or terminal continuity"),
    sessionId: z.string().min(1).max(160).optional().describe("Optional session identifier to recover the latest checkpoint"),
    limitPerSection: z.number().int().min(1).max(6).default(3).describe("Max items per section"),
    includeLatestCheckpoint: z.boolean().default(true).describe("Whether to include the latest checkpoint summary"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
  },
  async ({ task, scope, sessionId, limitPerSection, includeLatestCheckpoint, profile: profileName }) => {
    const { retriever, profile } = getComponents(profileName);
    const context = await composeResumeContext({
      retriever,
      checkpointStore,
    }, {
      task,
      scope,
      sessionId,
      limitPerSection,
      includeLatestCheckpoint,
      profile: profile.name,
    });

    return {
      content: [{
        type: "text" as const,
        text: formatResumeContext(context),
      }],
    };
  }
);

// --- search_memory tool ---
server.tool(
  "search_memory",
  "IMPORTANT: Use this tool proactively at the start of tasks to recall relevant past conversations, decisions, and patterns. Search when: starting a new task, debugging, writing, making decisions, or when the user references past work. Do NOT wait for the user to ask you to search. Query with key nouns/verbs from the user's message.",
  {
    query: z.string().describe("Search query — natural language or keywords"),
    limit: z.number().min(1).max(20).default(5).describe("Max results to return"),
    scope: z.string().optional().describe("Filter by source: cc, codex, gemini, memory"),
    category: DurableMemoryCategorySchema.optional().describe("Filter by memory category: profile (identity/background), preferences (habits/style), entities (projects/tools/people), events (past happenings), cases (problem-solution pairs), patterns (reusable workflows)"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
  },
  async ({ query, limit, scope, category, profile: profileName }) => {
    const { retriever, profile } = getComponents(profileName);
    const scopeFilter = scope ? [scope] : undefined;
    const results = await retriever.retrieve({ query, limit, scopeFilter, category });

    return {
      content: [{
        type: "text" as const,
        text: formatSearchResults(results, { query, profile: profile.name }),
      }],
    };
  }
);

server.tool(
  "explain_memory",
  "Explain why the indexed memories matched: retrieval path, freshness, file/session, and matched terms.",
  {
    query: z.string().describe("Search query — natural language or keywords"),
    limit: z.number().min(1).max(20).default(5).describe("Max results to analyze"),
    scope: z.string().optional().describe("Filter by source: cc, codex, gemini, memory"),
    category: DurableMemoryCategorySchema.optional().describe("Filter by memory category"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
  },
  async ({ query, limit, scope, category, profile: profileName }) => {
    const { retriever, profile } = getComponents(profileName);
    const scopeFilter = scope ? [scope] : undefined;
    const results = await retriever.retrieve({ query, limit, scopeFilter, category });
    return {
      content: [{
        type: "text" as const,
        text: formatExplainResults(results, { query, profile: profile.name }),
      }],
    };
  }
);

server.tool(
  "distill_memory",
  "Distill retrieved memories into a compact briefing with source map, takeaways, and reusable evidence.",
  {
    query: z.string().describe("Topic or task to distill"),
    limit: z.number().min(1).max(20).default(8).describe("Max results to distill"),
    scope: z.string().optional().describe("Filter by source: cc, codex, gemini, memory"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
  },
  async ({ query, limit, scope, profile: profileName }) => {
    const { retriever, profile } = getComponents(profileName || "writing");
    const scopeFilter = scope ? [scope] : undefined;
    const results = await retriever.retrieve({ query, limit, scopeFilter });
    return {
      content: [{
        type: "text" as const,
        text: distillResults(results, { query, profile: profile.name }),
      }],
    };
  }
);

server.tool(
  "brief_memory",
  "Create a structured memory brief from retrieved results and feed it back into recall.",
  {
    query: z.string().describe("Topic or task to turn into a memory brief"),
    limit: z.number().min(1).max(20).default(8).describe("Max results to distill into the brief"),
    scope: z.string().optional().describe("Filter by source: cc, codex, gemini, memory"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
    title: z.string().optional().describe("Optional brief title"),
  },
  async ({ query, limit, scope, profile: profileName, title }) => {
    const { retriever, profile, store, embedder } = getComponents(profileName || "writing");
    const scopeFilter = scope ? [scope] : undefined;
    const results = await retriever.retrieve({ query, limit, scopeFilter });
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

server.tool(
  "pin_memory",
  "Promote one retrieved memory into a pinned asset for later reuse.",
  {
    memory_id: z.string().describe("Memory ID or unique prefix from search/explain output"),
    title: z.string().optional().describe("Optional pinned title"),
    summary: z.string().optional().describe("Optional pinned summary"),
    query: z.string().optional().describe("Optional query that led to this pin"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
  },
  async ({ memory_id, title, summary, query, profile: profileName }) => {
    const { store, embedder } = getComponents(profileName);
    const entry = await store.get(memory_id);
    if (!entry) {
      return { content: [{ type: "text" as const, text: `Memory not found: ${memory_id}` }] };
    }

    await store.update(entry.id, { importance: Math.max(entry.importance || 0.7, 0.95) });
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

server.tool(
  "export_memory",
  "Export a distilled memory briefing to a markdown or json artifact on disk.",
  {
    query: z.string().describe("Topic or task to export"),
    limit: z.number().min(1).max(20).default(8).describe("Max results to export"),
    scope: z.string().optional().describe("Filter by source: cc, codex, gemini, memory"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
    format: z.enum(["md", "json"]).default("md").describe("Export format"),
  },
  async ({ query, limit, scope, profile: profileName, format }) => {
    const { retriever, profile } = getComponents(profileName || "writing");
    const scopeFilter = scope ? [scope] : undefined;
    const results = await retriever.retrieve({ query, limit, scopeFilter });
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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
server.tool(
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
// Start
// ============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
