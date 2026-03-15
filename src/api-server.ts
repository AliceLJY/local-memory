#!/usr/bin/env bun
/**
 * RecallNest HTTP API Server
 *
 * Universal REST API for any agent framework to access RecallNest memory.
 * Port 4318 by default (configurable via RECALLNEST_API_PORT).
 */

import { createComponentResolver, loadConfig, loadDotEnv } from "./runtime-config.js";

const config = (loadDotEnv(), loadConfig());
const getComponents = createComponentResolver(config);

// ============================================================================
// Helpers
// ============================================================================

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function readJson(request: Request): Promise<Record<string, any>> {
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, any>;
  } catch {
    return {};
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function parseMetadata(raw?: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ============================================================================
// Route handlers
// ============================================================================

/** POST /v1/recall — search memories (simple mode) */
async function handleRecall(request: Request): Promise<Response> {
  const body = await readJson(request);
  const query = body.query;
  if (!query || typeof query !== "string") {
    return errorResponse(400, "query is required");
  }

  const limit = clampInt(body.limit, 5, 1, 20);
  const minScore = clampFloat(body.minScore, 0, 0, 1);
  const category = typeof body.category === "string" ? body.category : undefined;
  const profileName = typeof body.profile === "string" ? body.profile : undefined;

  const { retriever, profile, store } = getComponents(profileName);
  const results = await retriever.retrieve({ query, limit, category });

  const filtered = minScore > 0 ? results.filter((r) => r.score >= minScore) : results;

  const stats = await store.stats();

  return jsonResponse({
    results: filtered.map((r) => {
      const meta = parseMetadata(r.entry.metadata);
      return {
        id: r.entry.id,
        text: r.entry.text,
        category: r.entry.category,
        tier: String(meta.tier || "peripheral"),
        source: String(meta.source || r.entry.scope || "?"),
        scope: r.entry.scope,
        score: Math.round(r.score * 1000) / 1000,
        date: new Date(r.entry.timestamp).toISOString().split("T")[0],
      };
    }),
    query,
    profile: profile.name,
    totalMemories: stats.totalCount,
  });
}

/** POST /v1/store — store a new memory */
async function handleStore(request: Request): Promise<Response> {
  const body = await readJson(request);
  const text = body.text;
  if (!text || typeof text !== "string") {
    return errorResponse(400, "text is required");
  }

  const VALID_CATEGORIES = ["profile", "preferences", "entities", "events", "cases", "patterns"];
  const rawCategory = typeof body.category === "string" ? body.category : "events";
  const category = VALID_CATEGORIES.includes(rawCategory) ? rawCategory : "events";
  const source = typeof body.source === "string" ? body.source : "api";
  const importance = clampFloat(body.importance, 0.7, 0, 1);

  const { store, embedder } = getComponents();
  const vector = await embedder.embed(text);

  const entry = await store.store({
    text,
    vector,
    category: category as any,
    scope: `api:${source}`,
    importance,
  });

  return jsonResponse({ id: entry.id, stored: true }, 201);
}

/** POST /v1/search — advanced search with full detail */
async function handleSearch(request: Request): Promise<Response> {
  const body = await readJson(request);
  const query = body.query;
  if (!query || typeof query !== "string") {
    return errorResponse(400, "query is required");
  }

  const limit = clampInt(body.limit, 5, 1, 20);
  const minScore = clampFloat(body.minScore, 0, 0, 1);
  const category = typeof body.category === "string" ? body.category : undefined;
  const profileName = typeof body.profile === "string" ? body.profile : undefined;
  const scope = typeof body.scope === "string" ? body.scope : undefined;

  const { retriever, profile } = getComponents(profileName);
  const results = await retriever.retrieve({
    query,
    limit,
    scopeFilter: scope ? [scope] : undefined,
    category,
  });

  const filtered = minScore > 0 ? results.filter((r) => r.score >= minScore) : results;

  return jsonResponse({
    results: filtered.map((r) => {
      const metadata = parseMetadata(r.entry.metadata);
      return {
        id: r.entry.id,
        text: r.entry.text,
        category: r.entry.category,
        scope: r.entry.scope,
        score: Math.round(r.score * 1000) / 1000,
        importance: r.entry.importance,
        timestamp: r.entry.timestamp,
        date: new Date(r.entry.timestamp).toISOString().split("T")[0],
        metadata,
        sources: r.sources,
      };
    }),
    query,
    profile: profile.name,
    count: filtered.length,
  });
}

/** GET /v1/stats — memory statistics */
async function handleStats(): Promise<Response> {
  const { store } = getComponents();
  const stats = await store.stats();

  return jsonResponse({
    totalMemories: stats.totalCount,
    byScope: stats.scopeCounts,
    byCategory: stats.categoryCounts,
  });
}

/** GET /v1/health — health check */
async function handleHealth(): Promise<Response> {
  try {
    const { store } = getComponents();
    const stats = await store.stats();
    return jsonResponse({
      status: "ok",
      version: "1.0.0",
      totalMemories: stats.totalCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse(
      {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }
}

// ============================================================================
// Server
// ============================================================================

const port = clampInt(process.env.RECALLNEST_API_PORT, 4318, 1, 65535);

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      // POST endpoints
      if (method === "POST") {
        if (pathname === "/v1/recall") return await handleRecall(request);
        if (pathname === "/v1/store") return await handleStore(request);
        if (pathname === "/v1/search") return await handleSearch(request);
      }

      // GET endpoints
      if (method === "GET") {
        if (pathname === "/v1/stats") return await handleStats();
        if (pathname === "/v1/health") return await handleHealth();
      }

      return errorResponse(404, "Not Found");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[API] ${method} ${pathname} error:`, message);
      return errorResponse(500, `Internal error: ${message}`);
    }
  },
});

console.log(`RecallNest API running at http://localhost:${server.port}`);
