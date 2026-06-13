/**
 * Shared dependency contract for MCP tool registration modules.
 *
 * P3-B split: the 43 `registerTool(...)` calls that used to live inline in
 * mcp-server.ts now live in tier modules (mcp-tools-core / -advanced /
 * -governance). mcp-server.ts owns the heavy module-level state (config,
 * component resolver, stores, lazy KG handles, the tier-aware registerTool
 * wrapper) and hands it to each tier module through this contract.
 *
 * Mutable module-level handles (kgExtractor / kgStoreInstance) are exposed as
 * getters so tier handlers read the live value after ensureComponents() runs,
 * not the null they would capture at registration time.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createComponentResolver, loadConfig } from "./runtime-config.js";
import type { SessionCheckpointStore } from "./session-store.js";
import type { ConflictCandidateStore } from "./conflict-store.js";
import type { WorkflowObservationStore } from "./workflow-observation-store.js";
import type { KGExtractor } from "./kg-extractor.js";
import type { KGStore } from "./kg-store.js";

export type ToolTier = "core" | "advanced" | "governance";
export type ToolSchema = Parameters<McpServer["tool"]>[2];
export type ToolHandler = Parameters<McpServer["tool"]>[3];
export type ComponentResolver = ReturnType<typeof createComponentResolver>;

export interface ToolRegistryDeps {
  /** Tier-aware registration wrapper from mcp-server.ts (shouldRegisterTool gate + lazy component init). */
  registerTool: (name: string, description: string, schema: ToolSchema, handler: ToolHandler) => void;
  /** Memoized component resolver: getComponents(profileName?) => { store, embedder, retriever, llm, profile }. */
  getComponents: ComponentResolver;
  /** Loaded runtime config (used by resume_context for recall-mode resolution). */
  config: ReturnType<typeof loadConfig>;
  checkpointStore: SessionCheckpointStore;
  conflictStore: ConflictCandidateStore;
  workflowObservationStore: WorkflowObservationStore;
  /** Live map of registered tool name -> description, populated by the registerTool wrapper (read by list_tools). */
  toolDescriptions: Map<string, string>;
  /** Static tool-name -> tier map (read by list_tools to group/filter tools). */
  toolTiers: Record<string, ToolTier>;
  /** Live getter for the lazily-initialized KG extractor (null unless RECALLNEST_KG_MODE=true). */
  getKGExtractor: () => KGExtractor | null;
  /** Live getter for the lazily-initialized KG store (null unless RECALLNEST_KG_MODE=true). */
  getKGStore: () => KGStore | null;
}
