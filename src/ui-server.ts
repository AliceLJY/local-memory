#!/usr/bin/env bun

import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { metaDir } from "./compat.js";
import type { RetrievalResult } from "./retriever.js";
import type { MemoryStore } from "./store.js";
import { distillResults, formatExplainResults, formatSearchResults, selectBriefSeedResults, summarizeResults } from "./memory-output.js";
import { extractMemoryProvenance } from "./memory-boundaries.js";
import { archiveDirtyBriefAsset, assetSummaryLine, buildBriefAsset, buildPinAsset, listDirtyBriefAssets, listExportArtifacts, listMemoryAssets, saveBriefAsset, savePinAsset, writeExportArtifact } from "./memory-assets.js";
import { indexAsset, indexPinnedAsset } from "./asset-sync.js";
import { createComponentResolver, loadConfig, loadDotEnv } from "./runtime-config.js";
import { buildRetrievalContext, resolveScopeSelection } from "./scope-policy.js";
import * as envConfig from "./env-config.js";
const config = (loadDotEnv(), loadConfig());
const getComponents = createComponentResolver(config);

class UiHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UiHttpError(400, "JSON body must be an object");
    }
    return parsed as Record<string, any>;
  } catch (error) {
    if (error instanceof UiHttpError) throw error;
    throw new UiHttpError(400, "Invalid JSON body");
  }
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  const trimmed = readString(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireString(value: unknown, field: string): string {
  const resolved = readOptionalString(value);
  if (!resolved) {
    throw new UiHttpError(400, `${field} is required`);
  }
  return resolved;
}

function readLimit(value: unknown, fallback: number, min = 1, max = 50): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function textResponse(output: string, init?: ResponseInit) {
  return Response.json({ output }, init);
}

function errorResponse(error: unknown): Response {
  if (error instanceof UiHttpError) {
    return textResponse(error.message, { status: error.status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return textResponse(`Internal error: ${message}`, { status: 500 });
}

function isAllowedArtifactPath(targetPath: string): boolean {
  try {
    const resolved = realpathSync(targetPath);
    const exportsDir = resolve(metaDir(import.meta), "../data/exports");
    const pinsDir = resolve(metaDir(import.meta), "../data/pins");
    return (
      resolved === exportsDir ||
      resolved.startsWith(`${exportsDir}${sep}`) ||
      resolved === pinsDir ||
      resolved.startsWith(`${pinsDir}${sep}`)
    );
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
    const provenance = extractMemoryProvenance({
      scope: result.entry.scope,
      metadata: result.entry.metadata,
    });
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
      boundary: provenance.boundary,
      canonicalKey: provenance.canonicalKey,
      promotedFrom: provenance.promotedFrom,
      provenanceHistory: provenance.provenanceHistory,
      provenanceHistoryCount: provenance.provenanceHistoryCount,
    };
  });
}

function serveStatic(pathname: string): Response | null {
  const uiDir = resolve(metaDir(import.meta), "../assets/ui");
  const relativePath = pathname === "/"
    ? join(uiDir, "index.html")
    : join(uiDir, pathname.replace(/^\/ui\//, ""));
  const filePath = resolve(relativePath);
  if (filePath !== uiDir && !filePath.startsWith(`${uiDir}${sep}`)) {
    return new Response("Forbidden", { status: 403 });
  }
  const file = Bun.file(filePath);
  if (!existsSync(filePath)) return null;
  return new Response(file);
}

async function handleSearch(mode: "search" | "explain" | "distill", body: Record<string, any>) {
  const query = requireString(body.query, "query");
  const { retriever, profile } = getComponents(readOptionalString(body.profile));
  const explicitScope = readOptionalString(body.scope);
  const results = await retriever.retrieve(buildRetrievalContext({
    query,
    limit: readLimit(body.limit, 5, 1, 20),
    scope: explicitScope,
    sessionId: readOptionalString(body.sessionId),
    allScopes: explicitScope ? false : true,
    topicTag: readOptionalString(body.topicTag),
  }, {
    operation: `ui:${mode}`,
    allowUnscoped: true,
  }));
  const context = { query, profile: profile.name };
  const output = mode === "explain"
    ? formatExplainResults(results, context)
    : mode === "distill"
      ? distillResults(results, context)
      : formatSearchResults(results, context);
  return Response.json({
    output,
    mode,
    profile: profile.name,
    query,
    items: serializeResults(results),
  });
}

const server = Bun.serve({
  port: readLimit(envConfig.uiPortRaw(), 4317, 1, 65535),
  async fetch(request) {
    try {
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
        const rows = listMemoryAssets(readLimit(url.searchParams.get("limit"), 10, 1, 50));
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
        const rows = listExportArtifacts(readLimit(url.searchParams.get("limit"), 20, 1, 50));
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

      if (request.method === "GET" && url.pathname === "/api/skills") {
        const { store, embedder } = getComponents();
        const { retrieveSkills } = await import("./skill-engine.js");
        const scope = url.searchParams.get("scope") || undefined;
        const skills = await retrieveSkills(store, embedder, "all skills", scope, 20);
        return Response.json({
          items: skills.map(({ skill, score }) => ({
            shortId: skill.id.slice(0, 8),
            name: skill.name,
            description: skill.description,
            trigger: skill.triggerPattern,
            type: skill.implementationType,
            implementation: skill.implementation,
            verification: skill.verification,
            scope: skill.scope,
            tags: skill.tags,
            score: Math.round(score * 100),
            storedAt: skill.storedAt,
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

      if (request.method === "GET" && url.pathname === "/api/dirty-briefs") {
        const rows = listDirtyBriefAssets();
        const output = rows.length === 0
          ? "No dirty briefs found."
          : rows.map((row) => `${row.id.slice(0, 8)}  ${row.title}  [${row.scope}]  ${row.reasons.join("; ")}`).join("\n");
        return Response.json({
          output,
          count: rows.length,
          items: rows.map((row) => ({
            id: row.id,
            shortId: row.id.slice(0, 8),
            title: row.title,
            scope: row.scope,
            reasons: row.reasons,
            path: row.path,
          })),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/pin") {
        const body = await readJson(request);
        const memoryId = requireString(body.memoryId, "memoryId");
        const { store, embedder } = getComponents(readOptionalString(body.profile));
        const scopeSelection = resolveScopeSelection({
          scope: readOptionalString(body.scope),
          sessionId: readOptionalString(body.sessionId),
          allScopes: readOptionalString(body.scope) ? false : true,
          operation: "ui:pin",
        });
        const entry = await store.get(memoryId, scopeSelection.scopeFilter);
        if (!entry) return textResponse(`Memory not found: ${memoryId}`, { status: 404 });
        await store.update(entry.id, { importance: Math.max(entry.importance || 0.7, 0.95) }, scopeSelection.scopeFilter);
        const asset = buildPinAsset(entryToRetrievalResult(entry), {
          title: readOptionalString(body.title),
          summary: readOptionalString(body.summary),
          query: readOptionalString(body.query),
          profile: readOptionalString(body.profile) as any || "default",
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
        const query = requireString(body.query, "query");
        const { retriever, profile, store, embedder } = getComponents(readOptionalString(body.profile) || "writing");
        const results = await retriever.retrieve(buildRetrievalContext({
          query,
          limit: readLimit(body.limit, 8, 1, 20),
          scope: readOptionalString(body.scope),
          sessionId: readOptionalString(body.sessionId),
          allScopes: readOptionalString(body.scope) ? false : true,
        }, {
          operation: "ui:brief",
        }));
        if (results.length === 0) {
          return textResponse(`No results found for: ${query}`, { status: 404 });
        }
        const briefSeedResults = selectBriefSeedResults(results);
        const summary = summarizeResults(briefSeedResults, { query, profile: profile.name });
        const asset = buildBriefAsset(summary, { title: readOptionalString(body.title) });
        const path = saveBriefAsset(asset);
        await indexAsset(store, embedder, asset);
        return Response.json({
          output: `Created brief ${asset.id.slice(0, 8)}\nTitle: ${asset.title}\nHits: ${asset.hits}\nPath: ${path}`,
          assetId: asset.id,
          path,
        });
      }

      if (request.method === "POST" && url.pathname === "/api/clean-dirty-briefs") {
        const rows = listDirtyBriefAssets();
        if (rows.length === 0) {
          return Response.json({ output: "No dirty briefs found.", count: 0, archived: 0, deleted: 0 });
        }

        let archived = 0;
        let deleted = 0;
        for (const row of rows) {
          archiveDirtyBriefAsset(row);
          archived += 1;
          deleted += await getComponents().store.bulkDelete([row.scope]);
        }

        return Response.json({
          output: `Dirty briefs: ${rows.length}\nArchived: ${archived}\nIndex rows deleted: ${deleted}`,
          count: rows.length,
          archived,
          deleted,
        });
      }

      if (request.method === "POST" && url.pathname === "/api/export") {
        const body = await readJson(request);
        const query = requireString(body.query, "query");
        const { retriever, profile } = getComponents(readOptionalString(body.profile) || "writing");
        const results = await retriever.retrieve(buildRetrievalContext({
          query,
          limit: readLimit(body.limit, 8, 1, 20),
          scope: readOptionalString(body.scope),
          sessionId: readOptionalString(body.sessionId),
          allScopes: readOptionalString(body.scope) ? false : true,
        }, {
          operation: "ui:export",
        }));
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
        const targetPath = requireString(body.path, "path");
        if (!existsSync(targetPath) || !isAllowedArtifactPath(targetPath)) {
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

      // ----- Dashboard API -----
      if (request.method === "GET" && url.pathname === "/api/dashboard-stats") {
        const { store } = getComponents();
        const stats = await store.stats();
        const allEntries = await store.list(undefined, undefined, 10000, 0);

        const now = Date.now();
        const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
        const thisWeek = allEntries.filter(e => e.timestamp > weekAgo).length;
        const thisMonth = allEntries.filter(e => e.timestamp > monthAgo).length;

        return Response.json({
          totalCount: stats.totalCount,
          categoryCounts: stats.categoryCounts,
          scopeCounts: stats.scopeCounts,
          growth: { thisWeek, thisMonth },
        });
      }

      if (request.method === "GET" && url.pathname === "/api/stale-memories") {
        const { store } = getComponents();
        const { runMemoryLint } = await import("./memory-lint.js");
        const report = await runMemoryLint({ store });
        const staleFindings = report.findings.filter(f => f.check === "stale");
        return Response.json({
          count: staleFindings.length,
          items: staleFindings.slice(0, 20).map(f => ({
            detail: f.detail,
            memoryIds: f.memoryIds,
          })),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/lint-summary") {
        const { store } = getComponents();
        const { runMemoryLint } = await import("./memory-lint.js");
        const report = await runMemoryLint({ store });
        return Response.json({
          healthScore: report.healthScore,
          totalScanned: report.totalScanned,
          summary: report.summary,
          timestamp: report.timestamp,
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  },
});

console.log(`RecallNest UI running at http://localhost:${server.port}`);
