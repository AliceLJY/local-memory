import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import { metaDir } from "./compat.js";
import { MemoryStore, validateStoragePath } from "./store.js";
import { createEmbedder, getVectorDimensions, type EmbeddingConfig } from "./embedder.js";
import { createRetriever, type RetrievalConfig, DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";
import { applyRetrievalProfile } from "./retrieval-profiles.js";
import { AccessTracker } from "./access-tracker.js";
import { FrequencyTracker } from "./frequency-tracker.js";
import { createLLMClient, type LLMClient, type LLMConfig } from "./llm-client.js";
import { logInfo } from "./stderr-log.js";
import * as envConfig from "./env-config.js";

export type RecallMode = "full" | "light" | "summary" | "off";

export interface LocalMemoryConfig {
  dbPath: string;
  recallMode?: RecallMode;
  embedding: {
    provider: string;
    apiKey: string;
    model: string;
    baseURL?: string;
    dimensions?: number;
    taskQuery?: string;
    taskPassage?: string;
  };
  llm?: {
    apiKey: string;
    model: string;
    baseURL: string;
  };
  sources: Record<string, { path: string; glob: string; description: string }>;
  retrieval?: Partial<RetrievalConfig>;
  /**
   * Opt-in cross-scope sidecar map for search_memory.
   * Main scoped search remains isolated; callers must pass includeRelatedScopes
   * before configured related scopes are queried and shown separately.
   */
  scopeRelations?: Record<string, string[]>;
  /**
   * Default depth for auto-recall injection.
   * - "full": inject complete text (default, backward compatible)
   * - "l1": inject L1 overview from metadata (~500 tokens)
   * - "l0": inject L0 abstract from metadata (~100 tokens)
   * Agent can use memory_drill_down tool to get deeper content on demand.
   */
  recallDepthDefault?: "l0" | "l1" | "full";
}

export function loadDotEnv(): void {
  const envPath = resolve(metaDir(import.meta), "../.env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

export function findConfigPath(): string {
  if (process.env.LOCAL_MEMORY_CONFIG) {
    const explicit = resolve(process.env.LOCAL_MEMORY_CONFIG);
    // Check here rather than letting readFileSync throw a bare ENOENT: scripts
    // resolve the database at module load, so a stale env var would otherwise
    // surface as an unexplained crash before any of their own output appears.
    if (!existsSync(explicit)) {
      throw new Error(
        `LOCAL_MEMORY_CONFIG points to a file that does not exist:\n` +
        `  ${explicit}\n` +
        `  Fix: correct the env var, or unset it to use the repo's config.json.`
      );
    }
    return explicit;
  }

  const localConfig = resolve(metaDir(import.meta), "../config.json");
  if (existsSync(localConfig)) return localConfig;

  const branded = join(homedir(), ".config", "recallnest", "config.json");
  if (existsSync(branded)) return branded;

  const exampleExists = existsSync(resolve(metaDir(import.meta), "../config.json.example"));
  throw new Error(
    "Config not found.\n" +
    (exampleExists
      ? "  Quick fix: cp config.json.example config.json\n"
      : "") +
    "  Or set LOCAL_MEMORY_CONFIG env var, or place config.json in ~/.config/recallnest/"
  );
}

export function loadConfig(): LocalMemoryConfig {
  const raw = readFileSync(findConfigPath(), "utf-8");
  return JSON.parse(raw) as LocalMemoryConfig;
}

export function resolveEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const envVal = process.env[name];
    if (!envVal) throw new Error(`Environment variable ${name} not set`);
    return envVal;
  });
}

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Single source of truth for "which LanceDB directory do we operate on".
 *
 * Every entry point — MCP server, CLI, and maintenance scripts — must resolve
 * the database through this function. Scripts that hardcode "./data/lancedb"
 * or read a non-existent config key silently operate on a *different* database
 * than the server does, so a health check, cleanup, or backfill can report on
 * an empty directory while the real store sits elsewhere.
 *
 * Relative dbPath values resolve against the repo root (not process.cwd()), so
 * a script's behaviour does not depend on where it was invoked from.
 */
export function resolveDbPath(config?: LocalMemoryConfig): string {
  const cfg = config ?? loadConfig();
  return resolve(metaDir(import.meta), "..", expandHome(cfg.dbPath));
}

/** Sidecar directory (frequency-stats.json etc.) that lives beside the database. */
export function resolveDataDir(config?: LocalMemoryConfig): string {
  return resolve(resolveDbPath(config), "..");
}

export function createComponents(config: LocalMemoryConfig, profileName?: string) {
  const dbPath = resolveDbPath(config);
  validateStoragePath(dbPath);

  const embeddingConfig: EmbeddingConfig = {
    provider: "openai-compatible",
    apiKey: resolveEnv(config.embedding.apiKey),
    model: config.embedding.model,
    baseURL: config.embedding.baseURL,
    dimensions: config.embedding.dimensions,
    taskQuery: config.embedding.taskQuery,
    taskPassage: config.embedding.taskPassage,
  };

  const embedder = createEmbedder(embeddingConfig);
  const store = new MemoryStore({ dbPath, vectorDim: embedder.dimensions });
  const baseRetrievalConfig = {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...(config.retrieval || {}),
  };
  const { profile, config: retrieverConfig } = applyRetrievalProfile(baseRetrievalConfig, profileName);
  const retriever = createRetriever(store, embedder, retrieverConfig);

  // Attach access tracker for reinforcement-based decay
  const accessTracker = new AccessTracker(store);
  retriever.setAccessTracker(accessTracker);

  // P0.2: Attach frequency tracker for hit-count based boosting
  const dataDir = resolveDataDir(config);
  const frequencyTracker = new FrequencyTracker({
    filePath: join(dataDir, "frequency-stats.json"),
  });
  retriever.setFrequencyTracker(frequencyTracker);

  // Create LLM client if configured (optional, graceful)
  let llm: LLMClient | null = null;
  if (config.llm) {
    llm = createLLMClient(config.llm);
    if (llm) {
      logInfo(`[INFO] LLM client initialized: ${config.llm.model} @ ${config.llm.baseURL}`);
    }
  }

  return { store, embedder, retriever, profile, accessTracker, frequencyTracker, llm };
}

export function createStoreOnly(config: LocalMemoryConfig): MemoryStore {
  const dbPath = resolveDbPath(config);
  validateStoragePath(dbPath);
  return new MemoryStore({
    dbPath,
    vectorDim: getVectorDimensions(config.embedding.model, config.embedding.dimensions),
  });
}

export function createComponentResolver(config: LocalMemoryConfig) {
  const cache = new Map<string, ReturnType<typeof createComponents>>();
  const MAX_COMPONENT_CACHE_SIZE = 32;

  return function getComponents(profileName?: string) {
    const key = profileName || "default";
    const cached = cache.get(key);
    if (cached) return cached;
    // Evict oldest entry if cache is full
    if (cache.size >= MAX_COMPONENT_CACHE_SIZE) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    const created = createComponents(config, profileName);
    cache.set(key, created);
    return created;
  };
}

const VALID_RECALL_MODES: RecallMode[] = ["full", "light", "summary", "off"];

/**
 * Resolve effective recall mode: per-call override > env var > config > default ("summary").
 */
export function resolveRecallMode(config: LocalMemoryConfig, perCallOverride?: string): RecallMode {
  if (perCallOverride && VALID_RECALL_MODES.includes(perCallOverride as RecallMode)) {
    return perCallOverride as RecallMode;
  }
  const envMode = envConfig.recallModeRaw();
  if (envMode && VALID_RECALL_MODES.includes(envMode as RecallMode)) {
    return envMode as RecallMode;
  }
  return config.recallMode ?? "summary";
}
