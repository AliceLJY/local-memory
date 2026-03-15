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

const server = new McpServer({
  name: "recallnest",
  version: "1.3.0",
});

// --- search_memory tool ---
server.tool(
  "search_memory",
  "IMPORTANT: Use this tool proactively at the start of tasks to recall relevant past conversations, decisions, and patterns. Search when: starting a new task, debugging, writing, making decisions, or when the user references past work. Do NOT wait for the user to ask you to search. Query with key nouns/verbs from the user's message.",
  {
    query: z.string().describe("Search query — natural language or keywords"),
    limit: z.number().min(1).max(20).default(5).describe("Max results to return"),
    scope: z.string().optional().describe("Filter by source: cc, codex, gemini, memory"),
    category: z.enum(["profile", "preferences", "entities", "events", "cases", "patterns"]).optional().describe("Filter by memory category: profile (identity/background), preferences (habits/style), entities (projects/tools/people), events (past happenings), cases (problem-solution pairs), patterns (reusable workflows)"),
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
    category: z.enum(["profile", "preferences", "entities", "events", "cases", "patterns"]).optional().describe("Filter by memory category"),
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
