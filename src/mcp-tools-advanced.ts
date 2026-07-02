import { z } from "zod";
import { indexAsset, indexPinnedAsset } from "./asset-sync.js";
import { createAuditLogger } from "./audit-log.js";
import { persistCaseMemory, persistMemoryBatch, persistWorkflowPattern, promoteMemory } from "./capture-engine.js";
import { autoCapture } from "./capture-heuristic.js";
import { runDataCheckup, formatCheckupReport } from "./data-checkup.js";
import { runDream, formatDreamResult } from "./dream-pipeline.js";
import { forgetMemory } from "./forget-engine.js";
import { exportMemoryGraph, formatGraphExportResult } from "./graph-export.js";
import { assetSummaryLine, buildBriefAsset, buildPinAsset, listMemoryAssets, listPinAssets, saveBriefAsset, savePinAsset, writeExportArtifact } from "./memory-assets.js";
import { runMemoryLint, formatMemoryLintReport } from "./memory-lint.js";
import { distillResults, formatExplainResults, selectBriefSeedResults, summarizeResults } from "./memory-output.js";
import { DurableMemoryCategorySchema, StoreMemorySourceSchema, DebugFramingSchema } from "./memory-schema.js";
import { buildRetrievalContext, resolveScopeSelection } from "./scope-policy.js";
import { persistSkill, retrieveSkills } from "./skill-engine.js";
import { SkillImplementationTypeSchema } from "./skill-schema.js";
import type { ToolRegistryDeps } from "./mcp-tool-deps.js";
import type { RetrievalResult } from "./retriever.js";
import type { MemoryStore } from "./store.js";

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

export function registerAdvancedTools(deps: ToolRegistryDeps): void {
  const { registerTool, getComponents, conflictStore, getKGExtractor, getKGStore } = deps;

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
    const kgExtractor = getKGExtractor();
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
    const kgExtractor = getKGExtractor();
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
    debugFraming: DebugFramingSchema.optional().describe("Optional break-loop 五维归因 (rootCause/whyPriorFixFailed/defense/systematicExtension/knowledgeFix)"),
  },
  async ({ title, problem, context, solutionSteps, outcome, tools, importance, scope, source, tags, canonicalKey, debugFraming }) => {
    const { store, embedder } = getComponents();
    const kgExtractor = getKGExtractor();
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
      debugFraming,
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
    const kgExtractor = getKGExtractor();
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
  "forget_memory",
  "Permanently forget a memory with full cascade: delete primary entry, remove KG triples, demote related memories, and log an audit trail. Requires confirm=true for durable-tier memories. Use when the user explicitly requests a memory be forgotten, or to clean up sensitive/incorrect data.",
  {
    memoryId: z.string().min(1).max(128).describe("Memory ID to forget (full UUID or 8+ hex prefix)"),
    confirm: z.boolean().default(false).describe("Required confirmation — must be true for durable-tier memories"),
    reason: z.string().min(1).max(200).optional().describe("Reason for forgetting (recorded in audit trail)"),
    scope: z.string().min(1).max(160).optional().describe("Optional scope filter for permission check"),
  },
  async ({ memoryId, confirm, reason, scope }) => {
    const { store } = getComponents();
    const kgStoreInstance = getKGStore();
    const auditLogger = createAuditLogger();
    const scopeFilter = scope ? [scope] : undefined;

    const result = await forgetMemory(
      { store, kgStore: kgStoreInstance, auditLogger },
      { memoryId, confirm, reason, scopeFilter },
    );

    if (!result.success) {
      // P1-7 C 类收尾：写操作逻辑失败改抛出，进 runToolSafely 统一层带 isError + reason_code，
      // 不再当「看起来成功」的普通文本返回（原样抛 result.error 保留失败原因）。
      throw new Error(result.error || "forget_memory failed");
    }

    const lines = [
      `✅ Memory ${result.memoryId.slice(0, 8)} forgotten.`,
      `Privacy tier: ${result.evidence?.privacyTier || "unknown"}`,
      `KG triples removed: ${result.kgTriplesRemoved ? "yes" : "no/N/A"}`,
      `Cascade demoted: ${result.cascadeResult.demotedCount} related memories`,
    ];
    if (result.evidence?.reason) {
      lines.push(`Reason: ${result.evidence.reason}`);
    }

    return {
      content: [{
        type: "text" as const,
        text: lines.join("\n"),
      }],
    };
  },
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

registerTool(
  "memory_stats",
  "Show aggregate statistics of the memory database: total entries, counts by source and category. Read-only. Use when you need an overview of memory store health or size.",
  {},
  async () => {
    const { store } = getComponents();
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

registerTool(
  "data_checkup",
  "Run health checks on the memory database: vector dimensions, orphans, tier distribution, and conflict backlog. Read-only. Use when diagnosing data quality issues or before a consolidation run.",
  {},
  async () => {
    const { store } = getComponents();
    const openConflicts = (await conflictStore.listRecent({ status: "open", limit: 200 })).length;
    const report = await runDataCheckup({ store, openConflictCount: openConflicts });
    return {
      content: [{ type: "text" as const, text: formatCheckupReport(report) }],
    };
  }
);

registerTool(
  "memory_lint",
  "Run memory quality lint checks: contradictions, duplicates, stale entries, and orphans. Read-only. Returns a health score (0-100) and actionable findings. Use for periodic memory hygiene or before consolidation.",
  {
    scope: z.string().min(1).max(160).optional().describe("Optional scope filter, e.g. 'project:recallnest'. Omit to lint all scopes"),
    verbose: z.boolean().default(false).describe("Include all individual findings in output (default: summarized)"),
  },
  async ({ scope, verbose }) => {
    const { store } = getComponents();
    const report = await runMemoryLint({ store, scope, verbose });
    return {
      content: [{ type: "text" as const, text: formatMemoryLintReport(report) }],
    };
  }
);

registerTool(
  "export_graph",
  "Export memories as an interactive HTML knowledge graph. Creates a self-contained HTML file with a force-directed visualization. Open in any browser. Use when the user wants to visualize their memory network.",
  {
    scope: z.string().min(1).max(160).optional().describe("Optional scope filter"),
    maxNodes: z.number().int().min(10).max(500).default(200).describe("Maximum nodes to include (default 200)"),
  },
  async ({ scope, maxNodes }) => {
    const { store } = getComponents();
    const { path, graph } = await exportMemoryGraph(store, { scope, maxNodes });
    return {
      content: [{ type: "text" as const, text: formatGraphExportResult(path, graph) }],
    };
  }
);

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

registerTool(
  "memory_drill_down",
  "Retrieve the full or overview-level content of a single memory entry. Read-only. Use when search returned compact summaries and you need the complete text or L1 overview.",
  {
    id: z.string().describe("Memory ID or unique prefix (at least 8 hex chars), e.g. 'a1b2c3d4'"),
    level: z.enum(["overview", "full"]).optional().default("full")
      .describe("Content depth: 'overview' (L1) or 'full' (L2, default)"),
  },
  async ({ id, level }) => {
    const { store } = getComponents();
    // P1-7 第二阶段：不设外层 catch —— store.getById 的真错误（LanceDB 故障等）直接抛给
    // runToolSafely 归类为 store_error/isError，让 agent 能判断重试/上报。旧的外层 catch 把
    // 主操作错误吞成「看起来成功」的普通文本（无 isError），比不 catch 更糟。内层 :663
    // metadata 解析兜底保留（best-effort，非主操作）。
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
  },
);

registerTool(
  "store_skill",
  "Store an agent-readable skill runbook with trigger conditions, instruction content, and verification steps. Side effect: persists a new skill entry and indexes it. Use when you identify a reusable procedure worth surfacing across sessions. NOTE: RecallNest does NOT execute skills — `implementation` is a runbook agents read as context, not a script we run. (v2.5 收缩，2026-05-27)",
  {
    name: z.string().min(1).max(120).describe("Unique skill identifier, e.g. 'deploy_production' or 'run_migrations'"),
    description: z.string().min(1).max(500).describe("Natural language description of what the skill does (used for semantic retrieval matching)"),
    triggerPattern: z.string().min(1).max(300).describe("Natural language pattern describing when to suggest this skill, e.g. 'user asks to deploy to production'"),
    implementationType: SkillImplementationTypeSchema.describe("Skill runbook type. Currently only 'instruction_sequence' is supported — RecallNest stores runbooks for agents to read, does not execute them. (v2.5 schema 收缩，2026-05-27)"),
    implementation: z.string().min(1).max(5000).describe("Agent-readable runbook content: markdown steps, natural language workflow, or structured procedure. RecallNest does NOT execute this — agents read it as context to follow."),
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
          `Skill ID: ${stored.id}`,
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
      `**ID**: ${skill.id}`,
      `**Description**: ${skill.description}`,
      `**Trigger**: ${skill.triggerPattern}`,
      `**Type**: ${skill.implementationType}`,
      skill.verification ? `**Verification**: ${skill.verification}` : null,
      `**Tags**: ${skill.tags.join(", ") || "-"}`,
      `**Outcome counts**: success=${skill.successCount} failure=${skill.failureCount}` + (skill.lastRefinedAt ? ` (last: ${skill.lastRefinedAt})` : ""),
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
    const kgExtractor = getKGExtractor();
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

registerTool(
  "import_conversations",
  "Import a conversation file (Claude Code JSONL, Claude.ai JSON, ChatGPT JSON, Slack JSON, plaintext, or connector-v1 JSON) into memory. Auto-detects format or use explicit format parameter. Messages are normalized and stored via the standard persistMemory pipeline. For connector-v1 format, use the standard ConnectorOutputV1 schema (see docs/connector-spec.md).",
  {
    content: z.string().min(1).max(500_000).describe("Raw file content to import"),
    scope: z.string().min(1).max(160).describe("Target scope for imported memories, e.g. 'project:myapp'"),
    format: z.enum(["auto", "claude-code", "claude-ai", "chatgpt", "slack", "plaintext", "connector-v1"]).default("auto").describe("Conversation format. Use 'auto' to detect automatically. 'connector-v1' for standard connector output."),
  },
  async ({ content, scope, format }) => {
    const { detectFormat, normalizeConversation, ingestNormalizedMessages } = await import("./conversation-importer.js");
    const { embedder } = getComponents();
    const { store, llm } = getComponents();
    const kgExtractor = getKGExtractor();

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
    const { llm } = getComponents();
    const kgExtractor = getKGExtractor();
    const { distillSession } = await import("./session-distiller.js");

    const result = await distillSession(
      messages,
      { llm, store, embedder, conflictStore, kgExtractor },
      { scope, preserveRecent, keepRecentTools, persist },
    );

    const lines = [
      `Microcompact: ${result.microcompact.tools_cleared} tool results cleared, ~${result.microcompact.tokens_freed} tokens freed`,
    ];
    if (result.summary) {
      lines.push(`Summary: 9-dimension structured summary generated`);
    }
    if (result.persisted) {
      const p = result.persisted;
      lines.push(`Persisted: ${p.memories_stored} stored, ${p.memories_deduped} deduped, ${p.memories_conflicted} conflicted`);
    }

    return {
      content: [{
        type: "text" as const,
        text: lines.join("\n"),
      }],
    };
  },
);
}
