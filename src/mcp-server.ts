#!/usr/bin/env bun
/**
 * RecallNest MCP Server
 *
 * Exposes conversation memory search as MCP tools,
 * so any MCP-compatible AI client (Claude Code, etc.)
 * can search your indexed conversations.
 *
 * Tool tiers:
 * - core: Always exposed (7 tools)
 * - advanced: Exposed by default, includes core (30 tools)
 * - full: All tools including governance (43 tools)
 *
 * Control: RECALLNEST_MCP_TIER=core|advanced|full
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as envConfig from "./env-config.js";
import { autoRegisterBabelMemory } from "./language-hook.js";
import { createComponentResolver, loadConfig, loadDotEnv } from "./runtime-config.js";
import { SessionCheckpointStore } from "./session-store.js";
import { ConflictCandidateStore } from "./conflict-store.js";
import { WorkflowObservationStore } from "./workflow-observation-store.js";
import { KGStore } from "./kg-store.js";
import { createKGExtractor, isKGModeEnabled, type KGExtractor } from "./kg-extractor.js";
import type { MemoryStore } from "./store.js";
import type { LLMClient } from "./llm-client.js";

import { registerCoreTools } from "./mcp-tools-core.js";
import { registerAdvancedTools } from "./mcp-tools-advanced.js";
import { registerGovernanceTools } from "./mcp-tools-governance.js";
import type { ToolRegistryDeps } from "./mcp-tool-deps.js";

// ============================================================================
// Tier Configuration
// ============================================================================

type ToolTier = "core" | "advanced" | "governance";

const MCP_TIER = envConfig.mcpTier();

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
  promote_scan: "governance",
  manage_alias: "governance",
  forget_memory: "advanced",

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


// ============================================================================
// MCP Server
// ============================================================================

loadDotEnv();
const config = loadConfig();
const getComponents = createComponentResolver(config);
// Lazy: components (embedder/store/retriever/LLM client) are heavy (~8s incl.
// LanceDB + LLM client). Constructing at module top-level blocked the stdio
// `initialize` handshake (server.connect is at EOF), making headless `claude -p`
// cron runs fail with "✗ Failed to connect". getComponents() is a memoized
// factory (runtime-config.ts), so deferring to first tool call is free.
let store!: MemoryStore;
let llm: LLMClient | null = null;
const checkpointStore = new SessionCheckpointStore();
const conflictStore = new ConflictCandidateStore();
const workflowObservationStore = new WorkflowObservationStore();

// Tier 4.1: Knowledge Graph triple extraction (gated by RECALLNEST_KG_MODE=true)
let kgExtractor: KGExtractor | null = null;
let kgStoreInstance: KGStore | null = null;

// Idempotent + concurrency-safe lazy component init. Runs on first tool call
// (via registerTool wrapper), NOT during the MCP handshake — so server.connect()
// answers `initialize` immediately and headless cron no longer times out.
let componentsReady: Promise<void> | null = null;
function ensureComponents(): Promise<void> {
  if (componentsReady) return componentsReady;
  componentsReady = (async () => {
    ({ store, llm } = getComponents());
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
  })();
  return componentsReady;
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
  // Lazy-init guard: defer heavy component construction to first tool call so the
  // MCP handshake (initialize / tools/list) isn't blocked. tools/call enters here.
  const lazyHandler = (async (...args: unknown[]) => {
    await ensureComponents();
    return (handler as (...a: unknown[]) => unknown)(...args);
  }) as ToolHandler;
  server.tool(name, description, schema, lazyHandler);
}

// ============================================================================
// Tool Registration — tier modules (P3-B split; see mcp-tools-{core,advanced,governance}.ts)
// ============================================================================

const toolDeps: ToolRegistryDeps = {
  registerTool,
  getComponents,
  config,
  checkpointStore,
  conflictStore,
  workflowObservationStore,
  toolDescriptions: TOOL_DESCRIPTIONS,
  toolTiers: TOOL_TIERS,
  getKGExtractor: () => kgExtractor,
  getKGStore: () => kgStoreInstance,
};

registerCoreTools(toolDeps);
registerAdvancedTools(toolDeps);
registerGovernanceTools(toolDeps);

// ============================================================================
// Global error handlers — prevent silent crashes from unhandled async errors
// ============================================================================

process.on("unhandledRejection", (reason) => {
  console.error("[recallnest] Unhandled promise rejection:", reason instanceof Error ? reason.stack || reason.message : String(reason));
});

process.on("uncaughtException", (err) => {
  console.error("[recallnest] Uncaught exception:", err.stack || err.message);
  // Give stderr a chance to flush before exiting
  setTimeout(() => process.exit(1), 100);
});

// ============================================================================
// Start
// ============================================================================

// Auto-register babel-memory language processor if installed (non-blocking)
autoRegisterBabelMemory().then((ok) => {
  if (ok) console.error("[recallnest] babel-memory registered");
}).catch((err) => {
  console.error("[recallnest] babel-memory registration failed:", err instanceof Error ? err.message : String(err));
});

const transport = new StdioServerTransport();
const CONNECT_TIMEOUT_MS = 30_000;
try {
  await Promise.race([
    server.connect(transport),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("MCP server.connect() timed out after 30s")), CONNECT_TIMEOUT_MS)
    ),
  ]);
} catch (err) {
  console.error("[recallnest] Fatal: MCP connection failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
