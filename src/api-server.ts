#!/usr/bin/env bun
/**
 * RecallNest HTTP API Server
 *
 * Universal REST API for any agent framework to access RecallNest memory.
 * Port 4318 by default (configurable via RECALLNEST_API_PORT).
 */

import { createComponentResolver, loadConfig, loadDotEnv } from "./runtime-config.js";
import { DurableMemoryCategorySchema } from "./memory-schema.js";
import { persistCaseMemory, persistMemory, persistMemoryBatch, persistWorkflowPattern, promoteMemory } from "./capture-engine.js";
import { buildSessionCheckpointResult } from "./session-engine.js";
import { SessionCheckpointStore } from "./session-store.js";
import { composeResumeContext } from "./context-composer.js";
import { extractMemoryProvenance } from "./memory-boundaries.js";
import { ConflictStatusSchema } from "./conflict-schema.js";
import { resolveConflictCandidate } from "./conflict-engine.js";
import { escalateConflicts } from "./conflict-escalation.js";
import { ConflictCandidateStore } from "./conflict-store.js";
import { parseConflictAttention, summarizeConflictLifecycle } from "./conflict-lifecycle.js";
import { buildConflictAuditSummary, clusterConflicts, summarizeConflictAdvice } from "./conflict-advisor.js";
import { buildWorkflowEvidence, buildWorkflowObservationRecord, inspectWorkflowDashboard, inspectWorkflowHealth } from "./workflow-observation-engine.js";
import { recordSkillOutcome } from "./skill-engine.js";
import { WorkflowObservationStore } from "./workflow-observation-store.js";
import { buildManagedCheckpointObservation, buildManagedResumeObservation } from "./workflow-observation-managed.js";
import { runAutoRecall } from "./auto-recall.js";
import { buildRetrievalContext, resolveScopeSelection } from "./scope-policy.js";
import { runMemoryLint } from "./memory-lint.js";

const config = (loadDotEnv(), loadConfig());
const getComponents = createComponentResolver(config);
const checkpointStore = new SessionCheckpointStore();
const conflictStore = new ConflictCandidateStore();
const workflowObservationStore = new WorkflowObservationStore();

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

function parseDurableMemoryCategory(value: unknown) {
  if (typeof value !== "string") return undefined;
  const parsed = DurableMemoryCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseConflictStatus(value: unknown) {
  if (typeof value !== "string") return undefined;
  const parsed = ConflictStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function buildProvenance(scope: string, metadata?: string) {
  const provenance = extractMemoryProvenance({ scope, metadata });
  return {
    boundary: provenance.boundary,
    canonicalKey: provenance.canonicalKey,
    promotedFrom: provenance.promotedFrom,
    provenanceHistory: provenance.provenanceHistory,
    provenanceHistoryCount: provenance.provenanceHistoryCount,
  };
}

function serializeRetrievalResult(result: Awaited<ReturnType<ReturnType<typeof getComponents>["retriever"]["retrieve"]>>[number]) {
  const metadata = parseMetadata(result.entry.metadata);
  const provenance = buildProvenance(result.entry.scope, result.entry.metadata);
  return {
    id: result.entry.id,
    text: result.entry.text,
    category: result.entry.category,
    tier: String(metadata.tier || "peripheral"),
    source: String(metadata.source || result.entry.scope || "?"),
    scope: result.entry.scope,
    score: Math.round(result.score * 1000) / 1000,
    importance: result.entry.importance,
    timestamp: result.entry.timestamp,
    date: new Date(result.entry.timestamp).toISOString().split("T")[0],
    metadata,
    boundary: provenance.boundary,
    canonicalKey: provenance.canonicalKey,
    promotedFrom: provenance.promotedFrom,
    provenanceHistory: provenance.provenanceHistory,
    provenanceHistoryCount: provenance.provenanceHistoryCount,
    sources: result.sources,
  };
}

async function saveManagedObservation(observation: Parameters<typeof buildWorkflowObservationRecord>[0]): Promise<void> {
  try {
    const record = buildWorkflowObservationRecord(observation);
    await workflowObservationStore.save(record);
  } catch (error) {
    console.error("[API] Failed to persist managed workflow observation:", error);
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
  const category = parseDurableMemoryCategory(body.category);
  const profileName = typeof body.profile === "string" ? body.profile : undefined;

  const { retriever, profile, store } = getComponents(profileName);
  const results = await retriever.retrieve(buildRetrievalContext({
    query,
    limit,
    category,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    allScopes: body.allScopes === true,
  }, {
    operation: "api:/v1/recall",
  }));

  const filtered = minScore > 0 ? results.filter((r) => r.score >= minScore) : results;

  const stats = await store.stats();

  return jsonResponse({
    results: filtered.map((r) => serializeRetrievalResult(r)),
    query,
    profile: profile.name,
    totalMemories: stats.totalCount,
  });
}

/** POST /v1/auto-recall — compose resume context and scoped focused recall in one call */
async function handleAutoRecall(request: Request): Promise<Response> {
  const body = await readJson(request);
  const message = typeof body.message === "string"
    ? body.message
    : typeof body.query === "string"
      ? body.query
      : undefined;
  if (!message) {
    return errorResponse(400, "message is required");
  }

  try {
    const profileName = typeof body.profile === "string" ? body.profile : undefined;
    const category = parseDurableMemoryCategory(body.category);
    const { retriever, profile } = getComponents(profileName);
    const autoRecall = await runAutoRecall({
      retriever,
      checkpointStore,
    }, {
      message,
      task: typeof body.task === "string" ? body.task : undefined,
      scope: typeof body.scope === "string" ? body.scope : undefined,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
      allScopes: body.allScopes === true,
      limit: clampInt(body.limit, 5, 1, 20),
      limitPerSection: clampInt(body.limitPerSection, 3, 1, 6),
      includeLatestCheckpoint: typeof body.includeLatestCheckpoint === "boolean"
        ? body.includeLatestCheckpoint
        : true,
      category,
      profile: profile.name,
      operation: "api:/v1/auto-recall",
    });

    await saveManagedObservation(buildManagedResumeObservation({
      task: typeof body.task === "string" ? body.task : message,
      scope: typeof body.scope === "string" ? body.scope : undefined,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    }, autoRecall.resume));

    return jsonResponse({
      mode: autoRecall.mode,
      query: message,
      profile: profile.name,
      resolvedScope: autoRecall.resolvedScope,
      searchSkippedReason: autoRecall.searchSkippedReason,
      resume: autoRecall.resume,
      results: autoRecall.results.map((result) => serializeRetrievalResult(result)),
      count: autoRecall.results.length,
    });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    return errorResponse(400, messageText);
  }
}

/** POST /v1/store — store a new memory */
async function handleStore(request: Request): Promise<Response> {
  const body = await readJson(request);
  try {
    const { store, embedder } = getComponents();
    const stored = await persistMemory({ store, embedder, conflictStore }, body);

    return jsonResponse({
      id: stored.id,
      stored: stored.disposition !== "conflict",
      disposition: stored.disposition,
      storedAt: stored.storedAt,
      category: stored.category,
      scope: stored.resolvedScope,
      canonicalKey: stored.canonicalKey,
      conflictId: stored.conflictId,
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(400, message);
  }
}

/** POST /v1/capture — store multiple structured memories in one request */
async function handleCapture(request: Request): Promise<Response> {
  const body = await readJson(request);
  try {
    const { store, embedder } = getComponents();
    const stored = await persistMemoryBatch({ store, embedder, conflictStore }, body);
    return jsonResponse({
      stored: stored.length,
      memories: stored.map((memory) => ({
        id: memory.id,
        text: memory.text,
        category: memory.category,
        scope: memory.resolvedScope,
        source: memory.source,
        storedAt: memory.storedAt,
        disposition: memory.disposition,
        canonicalKey: memory.canonicalKey,
        conflictId: memory.conflictId,
      })),
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(400, message);
  }
}

/** POST /v1/pattern — store a structured workflow pattern as durable memory */
async function handlePattern(request: Request): Promise<Response> {
  const body = await readJson(request);
  try {
    const { store, embedder } = getComponents();
    const stored = await persistWorkflowPattern({ store, embedder, conflictStore }, body);
    return jsonResponse({
      id: stored.id,
      stored: stored.disposition !== "conflict",
      disposition: stored.disposition,
      category: stored.category,
      title: stored.title,
      scope: stored.resolvedScope,
      tags: stored.tags,
      storedAt: stored.storedAt,
      canonicalKey: stored.canonicalKey,
      conflictId: stored.conflictId,
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(400, message);
  }
}

/** POST /v1/case — store a structured case as durable memory */
async function handleCase(request: Request): Promise<Response> {
  const body = await readJson(request);
  try {
    const { store, embedder } = getComponents();
    const stored = await persistCaseMemory({ store, embedder, conflictStore }, body);
    return jsonResponse({
      id: stored.id,
      stored: stored.disposition !== "conflict",
      disposition: stored.disposition,
      category: stored.category,
      title: stored.title,
      scope: stored.resolvedScope,
      tags: stored.tags,
      storedAt: stored.storedAt,
      canonicalKey: stored.canonicalKey,
      conflictId: stored.conflictId,
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(400, message);
  }
}

/** POST /v1/promote — promote an evidence memory into durable memory */
async function handlePromote(request: Request): Promise<Response> {
  const body = await readJson(request);
  try {
    const { store, embedder } = getComponents();
    const stored = await promoteMemory({ store, embedder, conflictStore }, body);
    return jsonResponse({
      id: stored.id,
      stored: stored.disposition !== "conflict",
      disposition: stored.disposition,
      category: stored.category,
      scope: stored.resolvedScope,
      sourceMemoryId: stored.sourceMemoryId,
      sourceCategory: stored.sourceCategory,
      storedAt: stored.storedAt,
      canonicalKey: stored.canonicalKey,
      conflictId: stored.conflictId,
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(400, message);
  }
}

/** GET /v1/conflicts — list recent conflicts or inspect a single conflict */
async function handleConflicts(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const conflictId = url.searchParams.get("conflictId") || undefined;
  const groupBy = url.searchParams.get("groupBy") === "cluster" ? "cluster" : "record";
  if (conflictId) {
    const conflict = await conflictStore.getById(conflictId);
    return jsonResponse({
      conflict: conflict
        ? {
          ...conflict,
          lifecycle: summarizeConflictLifecycle(conflict),
          advice: summarizeConflictAdvice(conflict),
        }
        : null,
    });
  }

  const status = parseConflictStatus(url.searchParams.get("status"));
  const attention = parseConflictAttention(url.searchParams.get("attention"));
  const canonicalKey = url.searchParams.get("canonicalKey") || undefined;
  const limit = clampInt(url.searchParams.get("limit"), 20, 1, 50);
  const conflicts = (await conflictStore.listRecent({ status, canonicalKey, limit: Math.max(limit * 2, limit) }))
    .map((conflict) => ({
      ...conflict,
      lifecycle: summarizeConflictLifecycle(conflict),
      advice: summarizeConflictAdvice(conflict),
    }))
    .filter((conflict) => !attention || conflict.lifecycle.attention === attention)
    .slice(0, limit);
  if (groupBy === "cluster") {
    const clusters = clusterConflicts(conflicts).slice(0, limit);
    return jsonResponse({
      groupBy,
      clusters,
      count: clusters.length,
    });
  }
  return jsonResponse({
    groupBy,
    conflicts,
    count: conflicts.length,
  });
}

/** GET /v1/conflicts/audit — summarize conflict attention and priority clusters */
async function handleConflictAudit(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const status = parseConflictStatus(url.searchParams.get("status"));
  const canonicalKey = url.searchParams.get("canonicalKey") || undefined;
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 500);
  const top = clampInt(url.searchParams.get("top"), 5, 1, 20);
  const records = await conflictStore.listRecent({ status, canonicalKey, limit });
  return jsonResponse(buildConflictAuditSummary(records, top));
}

/** POST /v1/conflicts/escalate — preview or apply conflict aging / escalation policy */
async function handleEscalateConflicts(request: Request): Promise<Response> {
  const body = await readJson(request);
  try {
    const result = await escalateConflicts({
      conflictStore,
    }, body);
    return jsonResponse(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(400, message);
  }
}

/** POST /v1/conflicts/resolve — resolve an open conflict candidate */
async function handleResolveConflict(request: Request): Promise<Response> {
  const body = await readJson(request);
  try {
    const { store, embedder } = getComponents();
    const result = await resolveConflictCandidate({
      store,
      embedder,
      conflictStore,
    }, body);
    return jsonResponse(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(400, message);
  }
}

/** POST /v1/checkpoint — persist current session state in the checkpoint store */
async function handleCheckpoint(request: Request): Promise<Response> {
  const body = await readJson(request);
  try {
    const result = buildSessionCheckpointResult(body);
    const stored = await checkpointStore.save(result.record);
    await saveManagedObservation(buildManagedCheckpointObservation({
      ...result,
      record: stored,
    }));
    return jsonResponse(stored, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(400, message);
  }
}

/** POST /v1/workflow-observe — persist a workflow observation outside durable memory; bumps skill counters when `skillId` is present */
async function handleWorkflowObserve(request: Request): Promise<Response> {
  const body = await readJson(request);
  try {
    const record = buildWorkflowObservationRecord(body);
    const stored = await workflowObservationStore.save(record);

    let skillOutcome: unknown = undefined;
    if (record.skillId) {
      try {
        const { store } = getComponents();
        const result = await recordSkillOutcome(store, record.skillId, record.outcome);
        skillOutcome = result;
        if (!result.updated) {
          console.warn(`[api /v1/workflow-observe] skillId=${record.skillId} update skipped: ${result.reason}`);
        }
      } catch (err) {
        console.warn(`[api /v1/workflow-observe] recordSkillOutcome threw for skillId=${record.skillId}:`, err);
        skillOutcome = { updated: false, reason: "exception" };
      }
    }

    return jsonResponse({ observation: stored, ...(skillOutcome !== undefined ? { skillOutcome } : {}) }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(400, message);
  }
}

/** GET /v1/workflow-health — inspect one workflow or return a dashboard */
async function handleWorkflowHealth(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const workflowId = url.searchParams.get("workflowId") || undefined;
  const scope = url.searchParams.get("scope") || undefined;
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 30);

  if (workflowId) {
    return jsonResponse(await inspectWorkflowHealth(workflowObservationStore, { workflowId, scope }));
  }

  return jsonResponse({
    dashboard: await inspectWorkflowDashboard(workflowObservationStore, { scope, limit }),
  });
}

/** GET /v1/workflow-evidence — build an evidence pack for a workflow primitive */
async function handleWorkflowEvidence(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const workflowId = url.searchParams.get("workflowId") || undefined;
  if (!workflowId) {
    return errorResponse(400, "workflowId is required");
  }
  const scope = url.searchParams.get("scope") || undefined;
  const limit = clampInt(url.searchParams.get("limit"), 5, 1, 20);
  return jsonResponse(await buildWorkflowEvidence(workflowObservationStore, { workflowId, scope, limit }));
}

/** GET /v1/checkpoint/latest — fetch the latest checkpoint for a scope or session */
async function handleLatestCheckpoint(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId") || undefined;
  const scope = url.searchParams.get("scope") || undefined;
  const latest = await checkpointStore.getLatest({ sessionId, scope });
  return jsonResponse({
    checkpoint: latest,
  });
}

/** POST /v1/resume — compose startup context for a fresh window */
async function handleResume(request: Request): Promise<Response> {
  const body = await readJson(request);
  try {
    const profileName = typeof body.profile === "string" ? body.profile : undefined;
    const { retriever, profile } = getComponents(profileName);
    const scopeSelection = resolveScopeSelection({
      scope: typeof body.scope === "string" ? body.scope : undefined,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
      operation: "api:/v1/resume",
      allowUnscoped: true,
    });
    const context = await composeResumeContext({
      retriever,
      checkpointStore,
    }, {
      ...body,
      scope: scopeSelection.resolvedScope,
      profile: profile.name,
    });
    await saveManagedObservation(buildManagedResumeObservation({
      task: typeof body.task === "string" ? body.task : undefined,
      scope: typeof body.scope === "string" ? body.scope : undefined,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    }, context));

    return jsonResponse({
      ...context,
      profile: profile.name,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(400, message);
  }
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
  const category = parseDurableMemoryCategory(body.category);
  const profileName = typeof body.profile === "string" ? body.profile : undefined;

  const { retriever, profile } = getComponents(profileName);
  const results = await retriever.retrieve(buildRetrievalContext({
    query,
    limit,
    category,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    allScopes: body.allScopes === true,
  }, {
    operation: "api:/v1/search",
  }));

  const filtered = minScore > 0 ? results.filter((r) => r.score >= minScore) : results;

  return jsonResponse({
    results: filtered.map((r) => serializeRetrievalResult(r)),
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

/** GET /v1/lint — memory quality lint */
async function handleLint(searchParams: URLSearchParams): Promise<Response> {
  const { store } = getComponents();
  const scope = searchParams.get("scope") || undefined;
  const report = await runMemoryLint({ store, scope });
  return jsonResponse(report);
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
        if (pathname === "/v1/auto-recall") return await handleAutoRecall(request);
        if (pathname === "/v1/store") return await handleStore(request);
        if (pathname === "/v1/capture") return await handleCapture(request);
        if (pathname === "/v1/pattern") return await handlePattern(request);
        if (pathname === "/v1/case") return await handleCase(request);
        if (pathname === "/v1/promote") return await handlePromote(request);
        if (pathname === "/v1/conflicts/resolve") return await handleResolveConflict(request);
        if (pathname === "/v1/conflicts/escalate") return await handleEscalateConflicts(request);
        if (pathname === "/v1/checkpoint") return await handleCheckpoint(request);
        if (pathname === "/v1/workflow-observe") return await handleWorkflowObserve(request);
        if (pathname === "/v1/resume") return await handleResume(request);
        if (pathname === "/v1/search") return await handleSearch(request);
      }

      // GET endpoints
      if (method === "GET") {
        if (pathname === "/v1/conflicts/audit") return await handleConflictAudit(request);
        if (pathname === "/v1/conflicts") return await handleConflicts(request);
        if (pathname === "/v1/checkpoint/latest") return await handleLatestCheckpoint(request);
        if (pathname === "/v1/workflow-health") return await handleWorkflowHealth(request);
        if (pathname === "/v1/workflow-evidence") return await handleWorkflowEvidence(request);
        if (pathname === "/v1/stats") return await handleStats();
        if (pathname === "/v1/lint") return await handleLint(url.searchParams);
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
