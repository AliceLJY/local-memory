#!/usr/bin/env bun

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import { MemoryStore, validateStoragePath } from "./store.js";
import { createEmbedder, type EmbeddingConfig } from "./embedder.js";
import { createRetriever, type RetrievalConfig, DEFAULT_RETRIEVAL_CONFIG, type RetrievalResult } from "./retriever.js";
import { applyRetrievalProfile } from "./retrieval-profiles.js";
import { distillResults, formatExplainResults, formatSearchResults, selectBriefSeedResults, summarizeResults } from "./memory-output.js";
import { assetSummaryLine, buildBriefAsset, buildPinAsset, listExportArtifacts, listMemoryAssets, saveBriefAsset, savePinAsset, writeExportArtifact } from "./memory-assets.js";
import { indexAsset, indexPinnedAsset } from "./asset-sync.js";

interface LocalMemoryConfig {
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

function findConfigPath(): string {
  if (process.env.LOCAL_MEMORY_CONFIG) return resolve(process.env.LOCAL_MEMORY_CONFIG);
  const localConfig = resolve(import.meta.dir, "../config.json");
  if (existsSync(localConfig)) return localConfig;
  const branded = join(homedir(), ".config", "recallnest", "config.json");
  if (existsSync(branded)) return branded;
  const legacy = join(homedir(), ".config", "local-memory", "config.json");
  if (existsSync(legacy)) return legacy;
  throw new Error("Config not found.");
}

function loadDotEnv(): void {
  const envPath = resolve(import.meta.dir, "../.env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

function loadConfig(): LocalMemoryConfig {
  return JSON.parse(readFileSync(findConfigPath(), "utf-8")) as LocalMemoryConfig;
}

function resolveEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const envVal = process.env[name];
    if (!envVal) throw new Error(`Environment variable ${name} not set`);
    return envVal;
  });
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function createComponents(config: LocalMemoryConfig, profileName?: string) {
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

const config = (loadDotEnv(), loadConfig());
const componentCache = new Map<string, ReturnType<typeof createComponents>>();

function getComponents(profileName?: string) {
  const key = profileName || "default";
  const cached = componentCache.get(key);
  if (cached) return cached;
  const created = createComponents(config, profileName);
  componentCache.set(key, created);
  return created;
}

function entryToRetrievalResult(entry: Awaited<ReturnType<MemoryStore["get"]>>): RetrievalResult {
  if (!entry) throw new Error("Memory entry not found.");
  return {
    entry,
    score: entry.importance || 0.7,
    sources: { fused: { score: entry.importance || 0.7 } },
  };
}

async function readJson(request: Request) {
  return await request.json() as Record<string, any>;
}

function textResponse(output: string, init?: ResponseInit) {
  return Response.json({ output }, init);
}

function isAllowedArtifactPath(targetPath: string): boolean {
  try {
    const resolved = realpathSync(targetPath);
    const exportsDir = resolve(import.meta.dir, "../data/exports");
    const pinsDir = resolve(import.meta.dir, "../data/pins");
    return resolved.startsWith(exportsDir) || resolved.startsWith(pinsDir);
  } catch {
    return false;
  }
}

function parseMetadata(raw?: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getRetrievalPath(result: RetrievalResult): string {
  const parts: string[] = [];
  if (result.sources.vector) parts.push("vector");
  if (result.sources.bm25) parts.push("bm25");
  if (result.sources.reranked) parts.push("reranked");
  return parts.join("+") || "direct";
}

function serializeResults(results: RetrievalResult[]) {
  return results.map((result) => {
    const metadata = parseMetadata(result.entry.metadata);
    return {
      id: result.entry.id,
      shortId: result.entry.id.slice(0, 8),
      score: Math.round(result.score * 100),
      scope: result.entry.scope,
      source: String(metadata.source || result.entry.scope || "?"),
      file: String(metadata.file || metadata.heading || "-"),
      timestamp: result.entry.timestamp,
      date: new Date(result.entry.timestamp).toISOString().split("T")[0],
      retrievalPath: getRetrievalPath(result),
      text: result.entry.text,
      metadata,
    };
  });
}

function serveStatic(pathname: string): Response | null {
  const uiDir = resolve(import.meta.dir, "../assets/ui");
  const filePath = pathname === "/"
    ? join(uiDir, "index.html")
    : join(uiDir, pathname.replace(/^\/ui\//, ""));
  if (!filePath.startsWith(uiDir)) return new Response("Forbidden", { status: 403 });
  const file = Bun.file(filePath);
  if (!existsSync(filePath)) return null;
  return new Response(file);
}

async function handleSearch(mode: "search" | "explain" | "distill", body: Record<string, any>) {
  const { retriever, profile } = getComponents(body.profile);
  const results = await retriever.retrieve({
    query: String(body.query || ""),
    limit: Number(body.limit || 5),
    scopeFilter: body.scope ? [String(body.scope)] : undefined,
  });
  const context = { query: String(body.query || ""), profile: profile.name };
  const output = mode === "explain"
    ? formatExplainResults(results, context)
    : mode === "distill"
      ? distillResults(results, context)
      : formatSearchResults(results, context);
  return Response.json({
    output,
    mode,
    profile: profile.name,
    query: String(body.query || ""),
    items: serializeResults(results),
  });
}

const server = Bun.serve({
  port: Number(process.env.RECALLNEST_UI_PORT || 4317),
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/ui/"))) {
      const response = serveStatic(url.pathname);
      if (response) return response;
    }

    if (request.method === "POST" && url.pathname === "/api/search") {
      return handleSearch("search", await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/api/explain") {
      return handleSearch("explain", await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/api/distill") {
      return handleSearch("distill", await readJson(request));
    }

    if (request.method === "GET" && url.pathname === "/api/pins") {
      const rows = listMemoryAssets(Number(url.searchParams.get("limit") || 10));
      const output = rows.length === 0
        ? "No assets yet."
        : [
            "Asset ID  Kind   Title  Scope / Sources  Date",
            "--------  -----  -----  ---------------  ----------",
            ...rows.map(row => assetSummaryLine(row)),
          ].join("\n");
      return Response.json({
        output,
        items: rows.map((row) => ({
          id: row.id,
          shortId: row.id.slice(0, 8),
          type: row.type,
          title: row.title,
          summary: row.summary,
          scope: row.type === "pinned-memory" ? row.source.scope : row.sources.map((item) => item.source).join(", "),
          createdAt: row.createdAt,
          date: row.createdAt.slice(0, 10),
          tags: row.tags,
          path: row.path,
          sourceMemoryId: row.type === "pinned-memory" ? row.source.memoryId : undefined,
          sourceScope: row.type === "pinned-memory" ? row.source.scope : undefined,
          snippet: row.type === "pinned-memory" ? row.snippet : undefined,
          retrieval: row.type === "pinned-memory" ? row.retrieval : undefined,
          hits: row.type === "memory-brief" ? row.hits : undefined,
          query: row.type === "memory-brief" ? row.query : undefined,
          profile: row.type === "memory-brief" ? row.profile : undefined,
          takeaways: row.type === "memory-brief" ? row.takeaways : undefined,
          evidence: row.type === "memory-brief" ? row.evidence : undefined,
          reusableCandidates: row.type === "memory-brief" ? row.reusableCandidates : undefined,
          sources: row.type === "memory-brief" ? row.sources : undefined,
        })),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/exports") {
      const rows = listExportArtifacts(Number(url.searchParams.get("limit") || 20));
      const output = rows.length === 0
        ? "No exports yet."
        : rows.map((row) => `${row.id.slice(0, 8)}  ${row.query}  [${row.profile}]  ${row.createdAt.slice(0, 10)}`).join("\n");
      return Response.json({
        output,
        items: rows.map((row) => ({
          id: row.id,
          shortId: row.id.length > 8 ? row.id.slice(-8) : row.id,
          query: row.query,
          profile: row.profile,
          createdAt: row.createdAt,
          date: row.createdAt.slice(0, 10),
          format: row.format,
          path: row.path,
          summary: row.summary || "",
        })),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/stats") {
      const { store } = getComponents();
      const stats = await store.stats();
      const sourceCounts = Object.entries(stats.scopeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([scope, count]) => `${scope}: ${count}`)
        .join("\n");
      return textResponse(`Total: ${stats.totalCount}\n\nBy scope:\n${sourceCounts}`);
    }

    if (request.method === "POST" && url.pathname === "/api/pin") {
      const body = await readJson(request);
      const { store, embedder } = getComponents(body.profile);
      const entry = await store.get(String(body.memoryId || ""));
      if (!entry) return textResponse(`Memory not found: ${String(body.memoryId || "")}`, { status: 404 });
      await store.update(entry.id, { importance: Math.max(entry.importance || 0.7, 0.95) });
      const asset = buildPinAsset(entryToRetrievalResult(entry), {
        title: body.title ? String(body.title) : undefined,
        summary: body.summary ? String(body.summary) : undefined,
        query: body.query ? String(body.query) : undefined,
        profile: body.profile ? String(body.profile) as any : "default",
      });
      const path = savePinAsset(asset);
      await indexPinnedAsset(store, embedder, asset);
      return Response.json({
        output: `Pinned ${asset.id.slice(0, 8)}\nMemory: ${entry.id.slice(0, 8)} (${entry.scope})\nPath: ${path}`,
        assetId: asset.id,
        memoryId: entry.id,
        path,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/brief") {
      const body = await readJson(request);
      const { retriever, profile, store, embedder } = getComponents(body.profile || "writing");
      const query = String(body.query || "");
      const results = await retriever.retrieve({
        query,
        limit: Number(body.limit || 8),
        scopeFilter: body.scope ? [String(body.scope)] : undefined,
      });
      if (results.length === 0) {
        return textResponse(`No results found for: ${query}`, { status: 404 });
      }
      const briefSeedResults = selectBriefSeedResults(results);
      const summary = summarizeResults(briefSeedResults, { query, profile: profile.name });
      const asset = buildBriefAsset(summary, { title: body.title ? String(body.title) : undefined });
      const path = saveBriefAsset(asset);
      await indexAsset(store, embedder, asset);
      return Response.json({
        output: `Created brief ${asset.id.slice(0, 8)}\nTitle: ${asset.title}\nHits: ${asset.hits}\nPath: ${path}`,
        assetId: asset.id,
        path,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/export") {
      const body = await readJson(request);
      const { retriever, profile } = getComponents(body.profile || "writing");
      const query = String(body.query || "");
      const results = await retriever.retrieve({
        query,
        limit: Number(body.limit || 8),
        scopeFilter: body.scope ? [String(body.scope)] : undefined,
      });
      const summary = distillResults(results, { query, profile: profile.name });
      const artifact = writeExportArtifact({
        query,
        profile: profile.name,
        results,
        summary,
        format: body.format === "json" ? "json" : "md",
      });
      return Response.json({
        output: `Exported ${artifact.id.slice(0, 8)}\nFormat: ${artifact.format}\nPath: ${artifact.outputPath}`,
        artifactId: artifact.id,
        format: artifact.format,
        path: artifact.outputPath,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/open-path") {
      const body = await readJson(request);
      const targetPath = String(body.path || "");
      if (!targetPath || !existsSync(targetPath) || !isAllowedArtifactPath(targetPath)) {
        return textResponse("Path is not allowed.", { status: 400 });
      }

      const proc = Bun.spawn(["open", targetPath], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const errText = await new Response(proc.stderr).text();
        return textResponse(`Failed to open path: ${errText}`, { status: 500 });
      }

      return Response.json({
        output: `Opened ${targetPath}`,
        path: targetPath,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`RecallNest UI running at http://localhost:${server.port}`);
