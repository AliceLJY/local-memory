import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import { MemoryStore, validateStoragePath } from "./store.js";
import { createEmbedder, type EmbeddingConfig } from "./embedder.js";
import { createRetriever, type RetrievalConfig, DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";
import { applyRetrievalProfile } from "./retrieval-profiles.js";

export interface LocalMemoryConfig {
  dbPath: string;
  embedding: {
    provider: string;
    apiKey: string;
    model: string;
    baseURL?: string;
    dimensions?: number;
    taskQuery?: string;
    taskPassage?: string;
  };
  sources: Record<string, { path: string; glob: string; description: string }>;
  retrieval?: Partial<RetrievalConfig>;
}

export function loadDotEnv(): void {
  const envPath = resolve(import.meta.dir, "../.env");
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
  if (process.env.LOCAL_MEMORY_CONFIG) return resolve(process.env.LOCAL_MEMORY_CONFIG);

  const localConfig = resolve(import.meta.dir, "../config.json");
  if (existsSync(localConfig)) return localConfig;

  const branded = join(homedir(), ".config", "recallnest", "config.json");
  if (existsSync(branded)) return branded;

  const legacy = join(homedir(), ".config", "local-memory", "config.json");
  if (existsSync(legacy)) return legacy;

  throw new Error(
    "Config not found. Set LOCAL_MEMORY_CONFIG env var, or place config.json in the project / ~/.config/recallnest / ~/.config/local-memory."
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

export function createComponents(config: LocalMemoryConfig, profileName?: string) {
  const dbPath = resolve(import.meta.dir, "..", expandHome(config.dbPath));
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

  return { store, embedder, retriever, profile };
}

export function createComponentResolver(config: LocalMemoryConfig) {
  const cache = new Map<string, ReturnType<typeof createComponents>>();

  return function getComponents(profileName?: string) {
    const key = profileName || "default";
    const cached = cache.get(key);
    if (cached) return cached;
    const created = createComponents(config, profileName);
    cache.set(key, created);
    return created;
  };
}
