#!/usr/bin/env bun
/**
 * RecallNest CLI — MCP-native memory search and distillation
 *
 * Usage:
 *   lm search "query keywords"
 *   lm ingest --source cc --limit 5
 *   lm ingest --source all
 *   lm stats
 */

import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

import { metaDir } from "./compat.js";
import type { RetrievalResult } from "./retriever.js";
import { applyRetrievalProfile, listRetrievalProfiles } from "./retrieval-profiles.js";
import { distillResults, formatExplainResults, formatSearchResults, selectBriefSeedResults, summarizeResults } from "./memory-output.js";
import { archiveDirtyBriefAsset, assetSummaryLine, buildBriefAsset, buildPinAsset, getExportsDir, listDirtyBriefAssets, listMemoryAssets, listPinAssets, pinSummaryLine, saveBriefAsset, savePinAsset, writeExportArtifact } from "./memory-assets.js";
import { indexAsset, indexPinnedAsset } from "./asset-sync.js";
import { createComponents, createStoreOnly, expandHome, loadConfig, loadDotEnv, type LocalMemoryConfig } from "./runtime-config.js";
import {
  formatDedupReasonSummary,
  getDedupSkipRate,
  type IngestResult,
  ingestCCTranscripts,
  ingestCodexSessions,
  ingestGeminiSessions,
  ingestMarkdownFiles,
  ingestObsidianVault,
  ingestConnectorFile,
} from "./ingest.js";
import { runDoctor, formatDoctorResults } from "./doctor.js";
import { persistCaseMemory, persistMemory, persistWorkflowPattern } from "./capture-engine.js";
import {
  CaseMemoryInputSchema,
  type CaseMemoryInput,
  StoreMemoryInputSchema,
  type StoreMemoryInput,
  WorkflowPatternInputSchema,
  type WorkflowPatternInput,
} from "./memory-schema.js";
import { classifyLegacyScope, type MemoryEntry } from "./store.js";
import { ConflictStatusSchema } from "./conflict-schema.js";
import { resolveConflictCandidate } from "./conflict-engine.js";
import { escalateConflicts } from "./conflict-escalation.js";
import { ConflictCandidateStore } from "./conflict-store.js";
import { formatConflictAudit, formatConflictAuditMarkdown, formatConflictClusters, formatConflictEscalation, formatConflictList, formatConflictRecord, formatConflictResolution } from "./conflict-output.js";
import { CONFLICT_ATTENTION_LEVELS, parseConflictAttention, summarizeConflictLifecycle } from "./conflict-lifecycle.js";
import { buildConflictAuditSummary, clusterConflicts, summarizeConflictAdvice } from "./conflict-advisor.js";
import { WorkflowObservationOutcomeSchema } from "./workflow-observation-schema.js";
import { buildWorkflowEvidence, buildWorkflowObservationRecord, inspectWorkflowDashboard, inspectWorkflowHealth } from "./workflow-observation-engine.js";
import { formatWorkflowEvidencePack, formatWorkflowHealthDashboard, formatWorkflowHealthReport, formatWorkflowObservationSaved } from "./workflow-observation-output.js";
import { WorkflowObservationStore } from "./workflow-observation-store.js";
import {
  applyWorkflowObservationScopeSuggestions,
  formatWorkflowObservationScopeReview,
  keepWorkflowObservationScopesGlobal,
  parseWorkflowObservationScopeCue,
  reviewWorkflowObservationScopes,
} from "./workflow-observation-scope-review.js";
import { collectScopeInventory, formatScopeInventoryReport } from "./scope-inventory.js";
import { buildRetrievalContext, resolveScopeSelection } from "./scope-policy.js";

/**
 * Auto-detect Claude Code transcript directories.
 * Scans ~/.claude/projects/ for ALL subdirectories containing .jsonl files.
 *
 * CC 按 cwd 编码 project 子目录，凡是不在 ~ 下跑的会话（Codex spawn 的子进程 / cd 到 repo 跑 /
 * bridge 临时工作目录）会落到 ~/.claude/projects/-XXX/ 别的子目录。旧版只挑 jsonl 最多的根
 * 目录返回，导致 28+ 个子目录全失声。修复：返回所有有 jsonl 的子目录，调用方循环 ingest。
 */
function detectCCPath(): string[] {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];
  try {
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(projectsDir, d.name))
      .filter(dir => {
        try { return readdirSync(dir).some(f => f.endsWith(".jsonl")); }
        catch { return false; }
      });
  } catch {
    return [];
  }
}

/**
 * Pick the CC project subdirectory with the most jsonl files (heuristic: user's primary cwd).
 * Used by memory source which still expects a single directory.
 */
function pickPrimaryCCPath(detected: string[]): string {
  let best = detected[0];
  let bestCount = 0;
  for (const dir of detected) {
    try {
      const c = readdirSync(dir).filter(f => f.endsWith(".jsonl")).length;
      if (c > bestCount) { bestCount = c; best = dir; }
    } catch { /* skip */ }
  }
  return best;
}

/**
 * Resolve "auto" paths in config to actual directories.
 *
 * Note: cc 分支只返回第一个 detect 到的目录（fallback），ingest 入口已改为直接调
 * detectCCPath() 拿全量子目录循环处理。这里保留是为兼容潜在的其它调用方。
 */
function resolveSourcePath(source: string, key: string): string {
  if (source !== "auto") return expandHome(source);

  if (key === "cc") {
    const detected = detectCCPath();
    if (detected.length === 0) throw new Error("Could not auto-detect Claude Code transcript path. Set sources.cc.path in config.json.");
    return pickPrimaryCCPath(detected);
  }
  if (key === "memory") {
    const detected = detectCCPath();
    if (detected.length === 0) throw new Error("Could not auto-detect memory path. Set sources.memory.path in config.json.");
    return join(pickPrimaryCCPath(detected), "memory");
  }
  throw new Error(`Cannot auto-detect path for source "${key}". Set it manually in config.json.`);
}

function formatIngestSummary(result: IngestResult): string {
  return `${result.filesProcessed} files, ${result.chunksIngested} ingested, ${result.chunksDeduped} deduped (${formatDedupReasonSummary(result)}), ${result.errors.length} errors`;
}

function maybeWarnHighCCDedupRate(result: IngestResult): void {
  if (result.source !== "cc") return;
  const dedupRate = getDedupSkipRate(result);
  if (dedupRate <= 0.85) return;
  console.log(`  ⚠️  dedup 率异常: ${(dedupRate * 100).toFixed(1)}%`);
}

// ============================================================================
// CLI
// ============================================================================

const program = new Command();

program
  .name("recallnest")
  .description("本地优先 AI 对话记忆搜索与蒸馏层")
  .version("1.4.0");

async function runRetrievalView(
  view: "search" | "explain" | "distill",
  query: string,
  options: {
    limit?: string;
    scope?: string;
    sessionId?: string;
    allScopes?: boolean;
    json?: boolean;
    profile?: string;
    explain?: boolean;
    trace?: boolean;
  },
) {
  const config = loadConfig();
  const { retriever, profile } = createComponents(config, options.profile);

  const limit = parseLimitOption(options.limit, 5, 1, 20);

  // Build trace collector when --trace is set
  let trace: import("./retrieval-trace.js").TraceCollector | undefined;
  if (options.trace) {
    const { TraceCollector } = await import("./retrieval-trace.js");
    trace = new TraceCollector();
  }

  const results = await retriever.retrieve(buildRetrievalContext({
    query,
    limit,
    scope: options.scope,
    sessionId: options.sessionId,
    allScopes: Boolean(options.allScopes),
    source: "cli",
    trace,
  }, {
    operation: `cli:${view}`,
  }));

  if (view === "search" && options.json) {
    console.log(
      JSON.stringify(
        {
          query,
          profile: profile.name,
          results: results.map((r) => ({
            score: r.score,
            scope: r.entry.scope,
            text: r.entry.text,
            metadata: r.entry.metadata,
            retrievalPath: Object.keys(r.sources).filter((key) => Boolean((r.sources as any)[key])),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  // Print trace summary before results when --trace is set
  if (trace) {
    const mode = retriever.getConfig().mode === "vector" ? "vector" as const : "hybrid" as const;
    console.log(trace.summarize(query, mode));
    console.log(""); // blank separator
  }

  const context = { query, profile: profile.name };
  const rendered = view === "explain"
    ? formatExplainResults(results, context)
    : view === "distill"
      ? distillResults(results, context)
      : formatSearchResults(results, context);

  console.log(rendered);
}

function parseLimitOption(value: string | undefined, fallback: number, min = 1, max = 50): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseRequiredLimitOption(value: string | undefined, field: string, min = 1, max = 50): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an integer`);
  }
  return Math.min(max, Math.max(min, parsed));
}

function toScopeFilter(scope?: string): string[] | undefined {
  const trimmed = typeof scope === "string" ? scope.trim() : "";
  return trimmed ? [trimmed] : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseExportFormat(value: string | undefined, fallback: "md" | "json" = "md"): "md" | "json" {
  if (!value) return fallback;
  if (value === "md" || value === "json") return value;
  throw new Error(`Invalid export format: ${value}`);
}

function splitCsvOption(value?: string): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultConflictAuditExportPath(format: "md" | "json", canonicalKey?: string): string {
  const timestamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+/, "");
  const stem = canonicalKey
    ? canonicalKey
      .toLowerCase()
      .replace(/[^a-z0-9\p{Script=Han}]+/giu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "conflict-audit"
    : "conflict-audit";
  return join(getExportsDir(), `${timestamp}-${stem}.${format}`);
}

function parseConflictStatusOption(value?: string): "open" | "accepted-incoming" | "kept-existing" | undefined {
  if (!value) return undefined;
  const parsed = ConflictStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid conflict status: ${value}`);
  }
  return parsed.data;
}

function filterConflictsByAttention<T extends { status: string; createdAt: string; updatedAt: string; reopenCount?: number; lastReopenedAt?: string }>(
  records: T[],
  attention?: string,
  staleOnly?: boolean,
): T[] {
  if (!attention && !staleOnly) return records;
  return records.filter((record) => {
    const lifecycle = summarizeConflictLifecycle(record as any);
    if (staleOnly) {
      return lifecycle.attention === "stale" || lifecycle.attention === "escalated";
    }
    return lifecycle.attention === attention;
  });
}

function workflowPatternSeedsPath(file?: string): string {
  return file
    ? resolve(file)
    : resolve(metaDir(import.meta), "../eval/continuity/pattern-seeds.json");
}

function caseMemorySeedsPath(file?: string): string {
  return file
    ? resolve(file)
    : resolve(metaDir(import.meta), "../eval/continuity/case-seeds.json");
}

function memorySeedsPath(file?: string): string {
  return file
    ? resolve(file)
    : resolve(metaDir(import.meta), "../eval/continuity/memory-seeds.json");
}

function parseMetadata(raw?: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractWorkflowPatternTitle(entry: MemoryEntry): string {
  const metadata = parseMetadata(entry.metadata);
  const workflowPattern = metadata.workflowPattern;
  if (workflowPattern && typeof workflowPattern === "object" && typeof (workflowPattern as any).title === "string") {
    return String((workflowPattern as any).title).trim();
  }

  const match = entry.text.match(/^Workflow pattern:\s*(.+)$/im);
  return match?.[1]?.trim() || "";
}

function extractCaseMemoryTitle(entry: MemoryEntry): string {
  const metadata = parseMetadata(entry.metadata);
  const caseMemory = metadata.caseMemory;
  if (caseMemory && typeof caseMemory === "object" && typeof (caseMemory as any).title === "string") {
    return String((caseMemory as any).title).trim();
  }

  const match = entry.text.match(/^Case:\s*(.+)$/im);
  return match?.[1]?.trim() || "";
}

function workflowPatternIdentity(title: string, scope: string): string {
  return `${scope.toLowerCase()}::${title.trim().toLowerCase()}`;
}

function caseMemoryIdentity(title: string, scope: string): string {
  return `${scope.toLowerCase()}::${title.trim().toLowerCase()}`;
}

function normalizeSeedIdentityValue(value?: string): string {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function extractStoreMemoryCanonicalKey(entry: MemoryEntry): string {
  const metadata = parseMetadata(entry.metadata);
  return typeof metadata.canonicalKey === "string" ? metadata.canonicalKey.trim() : "";
}

function storeMemoryIdentity(params: {
  category: string;
  scope: string;
  text: string;
  canonicalKey?: string;
}): string {
  const identity = normalizeSeedIdentityValue(params.canonicalKey) || normalizeSeedIdentityValue(params.text);
  return `${params.scope.toLowerCase()}::${params.category.toLowerCase()}::${identity}`;
}

function normalizeWorkflowPatternSeed(raw: unknown, defaults: {
  scope?: string;
  source?: string;
}): WorkflowPatternInput {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return WorkflowPatternInputSchema.parse({
    ...record,
    scope: typeof record.scope === "string" ? record.scope : defaults.scope,
    source: typeof record.source === "string" ? record.source : defaults.source,
  });
}

function normalizeCaseMemorySeed(raw: unknown, defaults: {
  scope?: string;
  source?: string;
}): CaseMemoryInput {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return CaseMemoryInputSchema.parse({
    ...record,
    scope: typeof record.scope === "string" ? record.scope : defaults.scope,
    source: typeof record.source === "string" ? record.source : defaults.source,
  });
}

function normalizeStoreMemorySeed(raw: unknown, defaults: {
  scope?: string;
  source?: string;
}): StoreMemoryInput {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return StoreMemoryInputSchema.parse({
    ...record,
    scope: typeof record.scope === "string" ? record.scope : defaults.scope,
    source: typeof record.source === "string" ? record.source : defaults.source,
  });
}

function seedTextPreview(text: string, maxLen = 72): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLen ? compact : `${compact.slice(0, maxLen - 3).trimEnd()}...`;
}

function formatLegacyScope(value: string | null): string {
  const kind = classifyLegacyScope(value);
  if (kind === "missing") return "<missing>";
  if (kind === "empty") return "<empty>";
  return value ?? "<missing>";
}

function collectRepeatedOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

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

// ─── search ──────────────────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("搜索记忆（支持 profile / explain）")
  .option("-n, --limit <n>", "返回结果数", "5")
  .option("-s, --scope <scope>", "显式限定 scope")
  .option("--session-id <sessionId>", "当前 sessionId；未传 scope 时会推断为 session:<id>")
  .option("--all-scopes", "显式允许跨 scope 搜索")
  .option("-p, --profile <profile>", "检索画像：default / writing / debug / fact-check", "default")
  .option("--explain", "显示命中原因与检索路径")
  .option("--trace", "显示检索管道各阶段 trace（调试用）")
  .option("--json", "JSON 格式输出")
  .action(async (query: string, options) => {
    await runRetrievalView(options.explain ? "explain" : "search", query, options);
  });

program
  .command("explain <query>")
  .description("解释为什么召回这些记忆")
  .option("-n, --limit <n>", "返回结果数", "5")
  .option("-s, --scope <scope>", "显式限定 scope")
  .option("--session-id <sessionId>", "当前 sessionId；未传 scope 时会推断为 session:<id>")
  .option("--all-scopes", "显式允许跨 scope 搜索")
  .option("-p, --profile <profile>", "检索画像：default / writing / debug / fact-check", "default")
  .action(async (query: string, options) => {
    await runRetrievalView("explain", query, options);
  });

program
  .command("distill <query>")
  .description("把命中结果蒸馏成可复用 briefing")
  .option("-n, --limit <n>", "返回结果数", "8")
  .option("-s, --scope <scope>", "显式限定 scope")
  .option("--session-id <sessionId>", "当前 sessionId；未传 scope 时会推断为 session:<id>")
  .option("--all-scopes", "显式允许跨 scope 搜索")
  .option("-p, --profile <profile>", "检索画像：default / writing / debug / fact-check", "writing")
  .action(async (query: string, options) => {
    await runRetrievalView("distill", query, options);
  });

program
  .command("profiles")
  .description("显示可用检索画像")
  .action(() => {
    const rows = [
      "Profile     Label           What It Optimizes",
      "----------- --------------  -----------------------------------------------",
    ];
    for (const profile of listRetrievalProfiles()) {
      rows.push(
        `${profile.name.padEnd(11)} ${profile.label.padEnd(14)} ${profile.description}`,
      );
    }
    console.log(rows.join("\n"));
  });

program
  .command("pin <memoryId>")
  .description("把一条命中记忆提升为 pinned asset")
  .option("-s, --scope <scope>", "显式限定 scope")
  .option("--session-id <sessionId>", "当前 sessionId；未传 scope 时会推断为 session:<id>")
  .option("--all-scopes", "显式允许跨 scope 读取")
  .option("-p, --profile <profile>", "检索画像：default / writing / debug / fact-check", "default")
  .option("-q, --query <query>", "记录这条记忆来自哪个查询")
  .option("-t, --title <title>", "自定义 asset 标题")
  .option("--summary <summary>", "自定义 asset 摘要")
  .action(async (memoryId: string, options) => {
    const config = loadConfig();
    const { store, embedder } = createComponents(config, options.profile);
    const scopeSelection = resolveScopeSelection({
      scope: options.scope,
      sessionId: options.sessionId,
      allScopes: Boolean(options.allScopes),
      operation: "cli:pin",
    });
    const entry = await store.get(memoryId, scopeSelection.scopeFilter);
    if (!entry) {
      console.log(`Memory not found: ${memoryId}`);
      return;
    }

    const pinnedImportance = Math.max(entry.importance || 0.7, 0.95);
    await store.update(entry.id, { importance: pinnedImportance }, scopeSelection.scopeFilter);

    const asset = buildPinAsset(entryToRetrievalResult(entry), {
      title: options.title,
      summary: options.summary,
      query: options.query,
      profile: options.profile,
    });
    const path = savePinAsset(asset);
    await indexPinnedAsset(store, embedder, asset);

    console.log([
      `Pinned   : ${asset.id.slice(0, 8)}`,
      `Memory   : ${entry.id.slice(0, 8)} (${entry.scope})`,
      `Title    : ${asset.title}`,
      `Path     : ${path}`,
    ].join("\n"));
  });

program
  .command("brief <query>")
  .description("把一组召回结果沉淀成 structured memory brief")
  .option("-n, --limit <n>", "返回结果数", "8")
  .option("-s, --scope <scope>", "显式限定 scope")
  .option("--session-id <sessionId>", "当前 sessionId；未传 scope 时会推断为 session:<id>")
  .option("--all-scopes", "显式允许跨 scope 搜索")
  .option("-p, --profile <profile>", "检索画像：default / writing / debug / fact-check", "writing")
  .option("-t, --title <title>", "自定义 brief 标题")
  .action(async (query: string, options) => {
    const config = loadConfig();
    const { retriever, profile, store, embedder } = createComponents(config, options.profile);
    const limit = parseLimitOption(options.limit, 8, 1, 20);
    const results = await retriever.retrieve(buildRetrievalContext({
      query,
      limit,
      scope: options.scope,
      sessionId: options.sessionId,
      allScopes: Boolean(options.allScopes),
      source: "cli",
    }, {
      operation: "cli:brief",
    }));
    if (results.length === 0) {
      console.log("No results found.");
      return;
    }

    const briefSeedResults = selectBriefSeedResults(results);
    const summary = summarizeResults(briefSeedResults, { query, profile: profile.name });
    const asset = buildBriefAsset(summary, { title: options.title });
    const path = saveBriefAsset(asset);
    await indexAsset(store, embedder, asset);

    console.log([
      `Brief    : ${asset.id.slice(0, 8)}`,
      `Title    : ${asset.title}`,
      `Hits     : ${asset.hits}`,
      `Path     : ${path}`,
    ].join("\n"));
  });

program
  .command("pins")
  .description("列出最近的 pinned assets")
  .option("-n, --limit <n>", "返回结果数", "10")
  .action((options) => {
    const limit = parseLimitOption(options.limit, 10, 1, 50);
    const rows = listPinAssets(limit);
    if (rows.length === 0) {
      console.log("No pinned assets yet.");
      return;
    }
    console.log("Pin ID    Title  Scope  Date");
    console.log("--------  -----  -----  ----------");
    for (const row of rows) {
      console.log(pinSummaryLine(row));
    }
  });

program
  .command("assets")
  .description("列出最近的 structured memory assets")
  .option("-n, --limit <n>", "返回结果数", "12")
  .action((options) => {
    const limit = parseLimitOption(options.limit, 12, 1, 50);
    const rows = listMemoryAssets(limit);
    if (rows.length === 0) {
      console.log("No assets yet.");
      return;
    }
    console.log("Asset ID  Kind   Title  Scope / Sources  Date");
    console.log("--------  -----  -----  ---------------  ----------");
    for (const row of rows) {
      console.log(assetSummaryLine(row));
    }
  });

program
  .command("clean-briefs")
  .description("归档旧规则生成的脏 brief，并从索引删除对应 asset scope")
  .option("--apply", "执行清理；默认只预览")
  .action(async (options) => {
    const dirty = listDirtyBriefAssets();
    if (dirty.length === 0) {
      console.log("No dirty briefs found.");
      return;
    }

    if (!options.apply) {
      console.log("Dirty briefs detected:");
      for (const item of dirty) {
        console.log(`${item.id.slice(0, 8)}  ${item.title}  [${item.scope}]  ${item.reasons.join("; ")}`);
      }
      console.log("\nRun with --apply to archive files and delete their indexed asset scopes.");
      return;
    }

    const config = loadConfig();
    const { store } = createComponents(config);
    let archived = 0;
    let deleted = 0;

    for (const item of dirty) {
      archiveDirtyBriefAsset(item);
      archived += 1;
      deleted += await store.bulkDelete([item.scope]);
    }

    console.log([
      `Dirty briefs: ${dirty.length}`,
      `Archived    : ${archived}`,
      `Index rows  : ${deleted}`,
    ].join("\n"));
  });

program
  .command("export <query>")
  .description("导出检索与蒸馏结果到 markdown/json")
  .option("-n, --limit <n>", "返回结果数", "8")
  .option("-s, --scope <scope>", "显式限定 scope")
  .option("--session-id <sessionId>", "当前 sessionId；未传 scope 时会推断为 session:<id>")
  .option("--all-scopes", "显式允许跨 scope 搜索")
  .option("-p, --profile <profile>", "检索画像：default / writing / debug / fact-check", "writing")
  .option("-f, --format <format>", "导出格式：md / json", "md")
  .action(async (query: string, options) => {
    const format = options.format === "json" ? "json" : "md";
    const config = loadConfig();
    const { retriever, profile } = createComponents(config, options.profile);
    const limit = parseLimitOption(options.limit, 8, 1, 20);
    const results = await retriever.retrieve(buildRetrievalContext({
      query,
      limit,
      scope: options.scope,
      sessionId: options.sessionId,
      allScopes: Boolean(options.allScopes),
      source: "cli",
    }, {
      operation: "cli:export",
    }));
    const summary = distillResults(results, { query, profile: profile.name });
    const artifact = writeExportArtifact({
      query,
      profile: profile.name,
      results,
      summary,
      format,
    });

    console.log([
      `Exported : ${artifact.id.slice(0, 8)}`,
      `Format   : ${artifact.format}`,
      `Profile  : ${artifact.profile}`,
      `Path     : ${artifact.outputPath}`,
    ].join("\n"));
  });

const conflictsCommand = program
  .command("conflicts")
  .description("查看和裁决 memory promotion conflicts");

conflictsCommand
  .command("list")
  .description("列出近期 conflict candidates")
  .option("-n, --limit <n>", "返回结果数", "20")
  .option("--status <status>", "状态过滤：open / accepted-incoming / kept-existing")
  .option("--attention <attention>", `生命周期过滤：${CONFLICT_ATTENTION_LEVELS.join(" / ")}`)
  .option("--stale", "只看 stale / escalated 的 open conflicts")
  .option("-k, --canonical-key <canonicalKey>", "按 canonicalKey 过滤")
  .option("--group-by <mode>", "输出模式：record / cluster", "record")
  .option("--json", "JSON 格式输出")
  .action(async (options) => {
    const limit = parseLimitOption(options.limit, 20, 1, 50);
    const status = parseConflictStatusOption(options.status) || (
      options.attention || options.stale ? undefined : "open"
    );
    const attention = parseConflictAttention(options.attention);
    if (options.attention && !attention) {
      throw new Error(`Invalid attention level: ${options.attention}`);
    }
    const conflictStore = new ConflictCandidateStore();
    const records = filterConflictsByAttention(await conflictStore.listRecent({
      status,
      canonicalKey: options.canonicalKey,
      limit: Math.max(limit * 2, limit),
    }), attention, Boolean(options.stale)).slice(0, limit);
    const groupBy = options.groupBy === "cluster" ? "cluster" : "record";

    if (options.json) {
      if (groupBy === "cluster") {
        const clusters = clusterConflicts(records);
        console.log(JSON.stringify({
          groupBy,
          clusters,
          count: clusters.length,
        }, null, 2));
      } else {
        console.log(JSON.stringify({
          groupBy,
          conflicts: records.map((record) => ({
            ...record,
            lifecycle: summarizeConflictLifecycle(record),
            advice: summarizeConflictAdvice(record),
          })),
          count: records.length,
        }, null, 2));
      }
      return;
    }

    console.log(groupBy === "cluster" ? formatConflictClusters(clusterConflicts(records)) : formatConflictList(records));
  });

conflictsCommand
  .command("show <conflictId>")
  .description("查看单条 conflict 的完整详情")
  .option("--json", "JSON 格式输出")
  .action(async (conflictId: string, options) => {
    const conflictStore = new ConflictCandidateStore();
    const record = await conflictStore.getById(conflictId);
    if (!record) {
      console.log(`Conflict not found: ${conflictId}`);
      process.exitCode = 1;
      return;
    }

    if (options.json) {
      console.log(JSON.stringify({
        ...record,
        lifecycle: summarizeConflictLifecycle(record),
        advice: summarizeConflictAdvice(record),
      }, null, 2));
      return;
    }

    console.log(formatConflictRecord(record));
  });

conflictsCommand
  .command("audit")
  .description("生成一份面向终端的 conflict audit 摘要，优先指出 stale / escalated clusters")
  .option("-n, --limit <n>", "扫描的 conflict 记录数", "100")
  .option("--top <n>", "展示的 priority cluster 数", "5")
  .option("--status <status>", "状态过滤：open / accepted-incoming / kept-existing / merged")
  .option("-k, --canonical-key <canonicalKey>", "按 canonicalKey 过滤")
  .option("--export", "把 audit 报告导出到文件")
  .option("--format <format>", "导出格式：md / json", "md")
  .option("--output <path>", "导出文件路径；默认写到 data/exports")
  .option("--json", "JSON 格式输出")
  .action(async (options) => {
    const limit = parseLimitOption(options.limit, 100, 1, 500);
    const top = parseLimitOption(options.top, 5, 1, 20);
    const status = parseConflictStatusOption(options.status);
    const conflictStore = new ConflictCandidateStore();
    const records = await conflictStore.listRecent({
      status,
      canonicalKey: options.canonicalKey,
      limit,
    });
    const summary = buildConflictAuditSummary(records, top);
    const exportRequested = Boolean(options.export || options.output);

    if (options.json) {
      const payload = {
        generatedAt: new Date().toISOString(),
        filters: {
          status: status || "all",
          canonicalKey: options.canonicalKey || "all",
          limit,
          top,
        },
        summary,
      };
      if (exportRequested) {
        const format = parseExportFormat(options.format);
        const outputPath = options.output
          ? resolve(options.output)
          : defaultConflictAuditExportPath(format, options.canonicalKey);
        const rendered = format === "json"
          ? JSON.stringify(payload, null, 2) + "\n"
          : formatConflictAuditMarkdown(summary, {
            generatedAt: payload.generatedAt,
            limit,
            top,
            ...(status ? { status } : {}),
            ...(options.canonicalKey ? { canonicalKey: options.canonicalKey } : {}),
          });
        writeFileSync(outputPath, rendered);
        console.log(JSON.stringify({ ...payload, export: { format, outputPath } }, null, 2));
        return;
      }
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    const rendered = formatConflictAudit(summary);
    if (!exportRequested) {
      console.log(rendered);
      return;
    }

    const format = parseExportFormat(options.format);
    const generatedAt = new Date().toISOString();
    const outputPath = options.output
      ? resolve(options.output)
      : defaultConflictAuditExportPath(format, options.canonicalKey);
    const exported = format === "json"
      ? JSON.stringify({
        generatedAt,
        filters: {
          status: status || "all",
          canonicalKey: options.canonicalKey || "all",
          limit,
          top,
        },
        summary,
      }, null, 2) + "\n"
      : formatConflictAuditMarkdown(summary, {
        generatedAt,
        limit,
        top,
        ...(status ? { status } : {}),
        ...(options.canonicalKey ? { canonicalKey: options.canonicalKey } : {}),
      });
    writeFileSync(outputPath, exported);
    console.log(`${rendered}\n\nExported: ${outputPath}`);
  });

conflictsCommand
  .command("escalate")
  .description("预览或应用 conflict aging / escalation policy")
  .option("--attention <attention>", "仅处理 stale / escalated", "stale")
  .option("-k, --canonical-key <canonicalKey>", "按 canonicalKey 过滤")
  .option("-n, --limit <n>", "扫描的 open conflict 数", "100")
  .option("--top <n>", "最多处理多少条 eligible conflict", "10")
  .option("--apply", "真正写回 escalation metadata；默认只预览")
  .option("--notes <notes>", "写回时附带备注")
  .option("--json", "JSON 格式输出")
  .action(async (options) => {
    const attention = options.attention === "escalated"
      ? "escalated"
      : options.attention === "stale"
        ? "stale"
        : null;
    if (!attention) {
      throw new Error("Invalid escalation attention. Use stale or escalated.");
    }

    const conflictStore = new ConflictCandidateStore();
    const result = await escalateConflicts({
      conflictStore,
    }, {
      attention,
      canonicalKey: options.canonicalKey,
      limit: parseLimitOption(options.limit, 100, 1, 500),
      top: parseLimitOption(options.top, 10, 1, 20),
      apply: Boolean(options.apply),
      notes: options.notes,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(formatConflictEscalation(result));
  });

conflictsCommand
  .command("resolve [conflictId]")
  .description("解决一条或一批 conflict candidates")
  .option("--keep-existing", "保留现有 durable memory")
  .option("--accept-incoming", "接受 incoming promoted text")
  .option("--merge", "合并 existing 与 incoming wording")
  .option("--merged-text <text>", "merge 时可选覆盖默认 merge suggestion 的文本")
  .option("--all", "批量处理符合过滤条件的 conflicts")
  .option("--status <status>", "批量过滤状态：open / accepted-incoming / kept-existing / merged", "open")
  .option("--attention <attention>", `批量过滤生命周期：${CONFLICT_ATTENTION_LEVELS.join(" / ")}`)
  .option("--stale", "批量只处理 stale / escalated 的 open conflicts")
  .option("-k, --canonical-key <canonicalKey>", "批量时按 canonicalKey 过滤")
  .option("-n, --limit <n>", "批量处理上限", "20")
  .option("--notes <notes>", "可选备注")
  .option("--json", "JSON 格式输出")
  .action(async (conflictId: string | undefined, options) => {
    const keepExisting = Boolean(options.keepExisting);
    const acceptIncoming = Boolean(options.acceptIncoming);
    const merge = Boolean(options.merge);
    const selectedCount = [keepExisting, acceptIncoming, merge].filter(Boolean).length;
    if (selectedCount !== 1) {
      throw new Error("Choose exactly one of --keep-existing, --accept-incoming, or --merge");
    }
    if (options.all && conflictId) {
      throw new Error("Use either a conflictId or --all, not both");
    }
    if (!options.all && !conflictId) {
      throw new Error("Provide a conflictId or use --all");
    }
    if (options.mergedText && !merge) {
      throw new Error("--merged-text can only be used with --merge");
    }
    if (options.all && options.mergedText) {
      throw new Error("--merged-text is only supported when resolving a single conflict");
    }

    const resolution = keepExisting
      ? "keep_existing"
      : acceptIncoming
        ? "accept_incoming"
        : "merge";
    const config = loadConfig();
    const { store, embedder } = createComponents(config);
    const conflictStore = new ConflictCandidateStore();
    const deps = { store, embedder, conflictStore };

    if (options.all) {
      const limit = parseLimitOption(options.limit, 20, 1, 100);
      const status = parseConflictStatusOption(options.status) || "open";
      const attention = parseConflictAttention(options.attention);
      if (options.attention && !attention) {
        throw new Error(`Invalid attention level: ${options.attention}`);
      }
      const records = filterConflictsByAttention(await conflictStore.listRecent({
        status,
        canonicalKey: options.canonicalKey,
        limit: Math.max(limit * 2, limit),
      }), attention, Boolean(options.stale)).slice(0, limit);

      const results: Array<{ conflictId: string; status?: string; error?: string }> = [];
      for (const record of records) {
        try {
          const resolved = await resolveConflictCandidate(deps, {
            conflictId: record.conflictId,
            resolution,
            notes: options.notes,
          });
          results.push({ conflictId: resolved.conflictId, status: resolved.status });
        } catch (error) {
          results.push({ conflictId: record.conflictId, error: errorMessage(error) });
        }
      }

      if (options.json) {
        console.log(JSON.stringify({
          total: records.length,
          resolved: results.filter((item) => item.status).length,
          failed: results.filter((item) => item.error).length,
          results,
        }, null, 2));
        return;
      }

      const lines = [
        `Batch resolve: ${records.length} conflict(s)`,
        `Resolution  : ${resolution}`,
      ];
      if (options.canonicalKey) {
        lines.push(`Canonical   : ${options.canonicalKey}`);
      }
      lines.push("");
      for (const item of results) {
        lines.push(
          item.error
            ? `${item.conflictId.slice(0, 8)}  ERROR  ${item.error}`
            : `${item.conflictId.slice(0, 8)}  ${item.status}`,
        );
      }
      console.log(lines.join("\n"));
      return;
    }

    const result = await resolveConflictCandidate(deps, {
      conflictId,
      resolution,
      ...(options.mergedText ? { mergedText: options.mergedText } : {}),
      notes: options.notes,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(formatConflictResolution(result));
  });

program
  .command("seed-patterns [file]")
  .description("批量写入 continuity / workflow pattern seeds")
  .option("-s, --scope <scope>", "默认 scope（仅覆盖 seed 里未显式提供的项）")
  .option("--source <source>", "默认 source（manual / agent / api）", "agent")
  .option("--json", "JSON 输出")
  .action(async (file: string | undefined, options) => {
    const path = workflowPatternSeedsPath(file);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(`Pattern seeds file must be a JSON array: ${path}`);
    }

    const config = loadConfig();
    const { store, embedder } = createComponents(config);
    const conflictStore = new ConflictCandidateStore();
    const existing = await store.list(undefined, "patterns", 1000, 0);
    const existingKeys = new Set(
      existing
        .map((entry) => {
          const title = extractWorkflowPatternTitle(entry);
          return title ? workflowPatternIdentity(title, entry.scope) : "";
        })
        .filter(Boolean),
    );

    const stored: Array<{ title: string; id: string; scope: string }> = [];
    const skipped: Array<{ title: string; scope: string }> = [];

    for (const seed of raw) {
      const input = normalizeWorkflowPatternSeed(seed, {
        scope: options.scope,
        source: options.source,
      });
      const scope = input.scope;
      const key = workflowPatternIdentity(input.title, scope);
      if (existingKeys.has(key)) {
        skipped.push({ title: input.title, scope });
        continue;
      }

      const record = await persistWorkflowPattern({ store, embedder, conflictStore }, input);
      existingKeys.add(key);
      stored.push({ title: record.title, id: record.id, scope: record.resolvedScope });
    }

    if (options.json) {
      console.log(JSON.stringify({ path, stored, skipped }, null, 2));
      return;
    }

    const lines = [
      `Pattern seeds: ${path}`,
      `Stored      : ${stored.length}`,
      `Skipped     : ${skipped.length}`,
    ];

    if (stored.length > 0) {
      lines.push("");
      lines.push("Stored patterns:");
      for (const item of stored) {
        lines.push(`  ${item.id.slice(0, 8)}  ${item.scope}  ${item.title}`);
      }
    }

    if (skipped.length > 0) {
      lines.push("");
      lines.push("Skipped existing:");
      for (const item of skipped) {
        lines.push(`  ${item.scope}  ${item.title}`);
      }
    }

    console.log(lines.join("\n"));
  });

program
  .command("seed-cases [file]")
  .description("批量写入 continuity / reusable case seeds")
  .option("-s, --scope <scope>", "默认 scope（仅覆盖 seed 里未显式提供的项）")
  .option("--source <source>", "默认 source（manual / agent / api）", "agent")
  .option("--json", "JSON 输出")
  .action(async (file: string | undefined, options) => {
    const path = caseMemorySeedsPath(file);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(`Case seeds file must be a JSON array: ${path}`);
    }

    const config = loadConfig();
    const { store, embedder } = createComponents(config);
    const conflictStore = new ConflictCandidateStore();
    const existing = await store.list(undefined, "cases", 1000, 0);
    const existingKeys = new Set(
      existing
        .map((entry) => {
          const title = extractCaseMemoryTitle(entry);
          return title ? caseMemoryIdentity(title, entry.scope) : "";
        })
        .filter(Boolean),
    );

    const stored: Array<{ title: string; id: string; scope: string }> = [];
    const skipped: Array<{ title: string; scope: string }> = [];

    for (const seed of raw) {
      const input = normalizeCaseMemorySeed(seed, {
        scope: options.scope,
        source: options.source,
      });
      const scope = input.scope;
      const key = caseMemoryIdentity(input.title, scope);
      if (existingKeys.has(key)) {
        skipped.push({ title: input.title, scope });
        continue;
      }

      const record = await persistCaseMemory({ store, embedder, conflictStore }, input);
      existingKeys.add(key);
      stored.push({ title: record.title, id: record.id, scope: record.resolvedScope });
    }

    if (options.json) {
      console.log(JSON.stringify({ path, stored, skipped }, null, 2));
      return;
    }

    const lines = [
      `Case seeds: ${path}`,
      `Stored    : ${stored.length}`,
      `Skipped   : ${skipped.length}`,
    ];

    if (stored.length > 0) {
      lines.push("");
      lines.push("Stored cases:");
      for (const item of stored) {
        lines.push(`  ${item.id.slice(0, 8)}  ${item.scope}  ${item.title}`);
      }
    }

    if (skipped.length > 0) {
      lines.push("");
      lines.push("Skipped existing:");
      for (const item of skipped) {
        lines.push(`  ${item.scope}  ${item.title}`);
      }
    }

    console.log(lines.join("\n"));
  });

program
  .command("seed-memories [file]")
  .description("批量写入 durable project / continuity memory seeds")
  .option("-s, --scope <scope>", "默认 scope（仅覆盖 seed 里未显式提供的项）")
  .option("--source <source>", "默认 source（manual / agent / api）", "agent")
  .option("--json", "JSON 输出")
  .action(async (file: string | undefined, options) => {
    const path = memorySeedsPath(file);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(`Memory seeds file must be a JSON array: ${path}`);
    }

    const config = loadConfig();
    const { store, embedder } = createComponents(config);
    const conflictStore = new ConflictCandidateStore();
    const existing = await store.list(undefined, undefined, 2000, 0);
    const existingKeys = new Set(
      existing
        .map((entry) => storeMemoryIdentity({
          category: entry.category,
          scope: entry.scope,
          text: entry.text,
          canonicalKey: extractStoreMemoryCanonicalKey(entry),
        }))
        .filter(Boolean),
    );

    const stored: Array<{ category: string; id: string; scope: string; text: string }> = [];
    const skipped: Array<{ category: string; scope: string; text: string }> = [];

    for (const seed of raw) {
      const input = normalizeStoreMemorySeed(seed, {
        scope: options.scope,
        source: options.source,
      });
      const scope = input.scope;
      const key = storeMemoryIdentity(input);
      if (existingKeys.has(key)) {
        skipped.push({ category: input.category, scope, text: input.text });
        continue;
      }

      const record = await persistMemory({ store, embedder, conflictStore }, input);
      existingKeys.add(storeMemoryIdentity({
        category: input.category,
        scope: record.resolvedScope,
        text: input.text,
        canonicalKey: record.canonicalKey,
      }));
      stored.push({
        category: record.category,
        id: record.id,
        scope: record.resolvedScope,
        text: record.text,
      });
    }

    if (options.json) {
      console.log(JSON.stringify({ path, stored, skipped }, null, 2));
      return;
    }

    const lines = [
      `Memory seeds: ${path}`,
      `Stored      : ${stored.length}`,
      `Skipped     : ${skipped.length}`,
    ];

    if (stored.length > 0) {
      lines.push("");
      lines.push("Stored memories:");
      for (const item of stored) {
        lines.push(`  ${item.id.slice(0, 8)}  ${item.scope}  [${item.category}] ${seedTextPreview(item.text)}`);
      }
    }

    if (skipped.length > 0) {
      lines.push("");
      lines.push("Skipped existing:");
      for (const item of skipped) {
        lines.push(`  ${item.scope}  [${item.category}] ${seedTextPreview(item.text)}`);
      }
    }

    console.log(lines.join("\n"));
  });

// ─── demo ────────────────────────────────────────────────────────────────────

program
  .command("demo")
  .description("运行示例搜索，展示 RecallNest 工作效果")
  .action(async () => {
    const demoQueries = [
      "how to debug a failing bot",
      "telegram bridge setup",
      "memory search architecture",
    ];

    console.log("\n  RecallNest Demo\n");
    console.log("  Running sample queries to show what RecallNest can do.\n");

    const config = loadConfig();
    const { store } = createComponents(config);
    const stats = await store.stats();

    if (stats.totalCount === 0) {
      console.log("  Index is empty. Run `lm ingest --source all` first.\n");
      return;
    }

    console.log(`  Index: ${stats.totalCount} entries across ${Object.keys(stats.scopeCounts).length} scopes\n`);

    const { retriever, profile } = createComponents(config);
    for (const query of demoQueries) {
      console.log(`  Query: "${query}"`);
      const results = await retriever.retrieve({ query, limit: 3 });
      if (results.length === 0) {
        console.log("    (no results)\n");
        continue;
      }
      for (const r of results) {
        const preview = r.entry.text.slice(0, 80).replace(/\n/g, " ");
        console.log(`    [${r.score.toFixed(2)}] ${r.entry.scope} — ${preview}...`);
      }
      console.log();
    }

    console.log("  Try your own: lm search \"your question here\"\n");
  });

// ─── ingest ──────────────────────────────────────────────────────────────────

program
  .command("ingest")
  .description("导入对话记录到索引")
  .option("-s, --source <source>", "数据源: cc / codex / memory / desktop / all", "all")
  .option("-l, --limit <n>", "限制处理文件数（调试用）")
  .option("-v, --verbose", "详细输出")
  .option("--no-dedup", "跳过向量去重")
  .option("--no-llm", "禁用 LLM 提取（原始对话将跳过不存入，排入待处理队列）")
  .option("--recent [hours]", "快速模式：只处理最近 N 小时修改的文件（默认 2 小时），跳过 ingested-files 检查")
  .option("--obsidian <vault-path>", "导入 Obsidian vault（自动检测 .obsidian/ 目录）")
  .option("--connector <file-path>", "导入 connector-v1 格式 JSON 文件")
  .action(async (options) => {
    const config = loadConfig();
    const { store, embedder, llm } = createComponents(config);

    const source = options.source || "all";
    const limit = options.limit
      ? parseRequiredLimitOption(options.limit, "--limit", 1, Number.MAX_SAFE_INTEGER)
      : undefined;
    const verbose = options.verbose || false;
    const noDedup = options.dedup === false; // --no-dedup
    // --recent: quick mode — only process files modified within N hours, skip ingested-files check
    const recentHours: number | undefined = options.recent !== undefined
      ? (options.recent === true ? 2 : Number(options.recent))
      : undefined;
    if (recentHours !== undefined && (isNaN(recentHours) || recentHours <= 0)) {
      console.error("❌ --recent 参数必须是正数（小时数）");
      process.exitCode = 1;
      return;
    }
    const results: any[] = [];

    // Pre-flight: validate embedding API before processing any files
    console.log("\n🔑 验证 Embedding API...");
    const testResult = await embedder.test();
    if (!testResult.success) {
      console.error(`\n❌ Embedding API 验证失败: ${testResult.error}`);
      console.error("   → 检查 .env 中的 JINA_API_KEY 是否正确");
      console.error("   → 获取免费 key: https://jina.ai/embeddings/");
      console.error("   → 运行 lm doctor 查看完整诊断\n");
      process.exitCode = 1;
      return;
    }
    console.log(`  ✅ ${config.embedding.model} (${testResult.dimensions}d)`);

    // LLM status — respect --no-llm flag
    const effectiveLlm = options.noLlm ? null : llm;
    if (options.noLlm) {
      console.log("  ⚠️  LLM: 已通过 --no-llm 禁用，原始对话将跳过不存入");
    } else if (llm) {
      const llmTest = await llm.test();
      console.log(llmTest.success
        ? `  ✅ LLM: ${config.llm?.model} (L0 摘要 + 语义去重)`
        : `  ⚠️  LLM: ${config.llm?.model} 连接失败，原始对话将跳过不存入`);
    } else {
      console.log("  ⚠️  LLM: 未配置，原始对话将跳过不存入（配置 config.json → llm 以启用）");
    }

    // Drain pending queue if LLM is available
    if (effectiveLlm) {
      const { drainPendingQueue } = await import("./ingest.js");
      const drained = await drainPendingQueue(store, embedder, effectiveLlm);
      if (drained.processed > 0) {
        console.log(`  ♻️  Pending queue: ${drained.processed} processed, ${drained.errors} errors`);
      }
    }

    console.log(`  ${noDedup ? "⚠️  去重已禁用 (--no-dedup)" : "✅ 两阶段去重: vector + LLM 语义判断"}`);
    if (recentHours !== undefined) {
      console.log(`  ⚡ 快速模式: 只处理最近 ${recentHours} 小时修改的文件，跳过 ingested-files 检查`);
    }
    console.log();
    console.log(`🔄 开始导入记忆 (source: ${source})...\n`);

    const ingestOpts = { limit, verbose, noDedup, llm: effectiveLlm, recentHours };

    // CC Transcripts
    // CC 按 cwd 编码 project 子目录，所有有 jsonl 的子目录都要 ingest（不只是 jsonl 最多的那个）
    if (source === "all" || source === "cc") {
      console.log("📝 导入 Claude Code 对话...");
      const ccSource = config.sources.cc;
      if (ccSource) {
        const ccPaths = ccSource.path === "auto"
          ? detectCCPath()
          : [expandHome(ccSource.path)];
        if (ccPaths.length === 0) {
          throw new Error("Could not auto-detect Claude Code transcript path. Set sources.cc.path in config.json.");
        }
        for (const ccPath of ccPaths) {
          const r = await ingestCCTranscripts(store, embedder, ccPath, ingestOpts);
          results.push(r);
          console.log(`  ✅ CC [${basename(ccPath)}]: ${formatIngestSummary(r)}`);
          maybeWarnHighCCDedupRate(r);
        }
      }
    }

    // Codex Sessions
    if (source === "all" || source === "codex") {
      console.log("🤖 导入 Codex 对话...");
      const r = await ingestCodexSessions(store, embedder, ingestOpts);
      results.push(r);
      console.log(`  ✅ Codex: ${formatIngestSummary(r)}`);
    }

    // Gemini Sessions (JSON format under ~/.gemini/tmp/*/chats/)
    if (source === "all" || source === "gemini") {
      console.log("💎 导入 Gemini 对话...");
      const r = await ingestGeminiSessions(store, embedder, {
        limit,
        verbose,
        noDedup,
        llm,
        recentHours,
      });
      results.push(r);
      console.log(`  ✅ Gemini: ${formatIngestSummary(r)}`);
    }

    // Claude Desktop / claude.ai web conversations (CC transcript format)
    if (source === "all" || source === "desktop") {
      const desktopSource = config.sources.desktop;
      if (desktopSource) {
        const desktopPath = resolve(metaDir(import.meta), "..", desktopSource.path);
        if (existsSync(desktopPath)) {
          console.log("🖥️  导入 Claude Desktop 对话...");
          const r = await ingestCCTranscripts(store, embedder, desktopPath, ingestOpts);
          results.push(r);
          console.log(`  ✅ Desktop: ${formatIngestSummary(r)}`);
          maybeWarnHighCCDedupRate(r);
        } else if (source === "desktop") {
          console.log("⚠️  Desktop 目录不存在，请先运行: bun scripts/pull-claude-desktop.ts");
        }
      }
    }

    // Memory markdown files
    if (source === "all" || source === "memory") {
      console.log("📚 导入记忆文件...");
      const memSource = config.sources.memory;
      if (memSource) {
        const memPath = resolveSourcePath(memSource.path, "memory");
        const r = await ingestMarkdownFiles(store, embedder, memPath, "memory", {
          verbose,
          noDedup,
          llm,
          recentHours,
        });
        results.push(r);
        console.log(`  ✅ Memory: ${formatIngestSummary(r)}`);
      }
    }

    // Obsidian vault (--obsidian <path>)
    if (options.obsidian) {
      console.log("🗃️  导入 Obsidian vault...");
      const r = await ingestObsidianVault(store, embedder, options.obsidian, {
        verbose,
        noDedup,
        llm: effectiveLlm,
      });
      results.push(r);
      console.log(`  ✅ Obsidian: ${formatIngestSummary(r)}`);
    }

    // Connector-v1 file (--connector <path>)
    if (options.connector) {
      console.log("🔌 导入 connector-v1 文件...");
      const { readFileSync: readFs } = await import("node:fs");
      const connectorContent = readFs(options.connector, "utf-8");
      const r = await ingestConnectorFile(store, embedder, connectorContent, {
        verbose,
        noDedup,
        llm: effectiveLlm,
      });
      results.push(r);
      console.log(`  ✅ Connector: ${formatIngestSummary(r)}`);
    }

    // Summary
    console.log("\n📊 导入汇总:");
    let totalChunks = 0;
    let totalDeduped = 0;
    let totalErrors = 0;
    const totalDedupReasons = {
      hard: 0,
      exact: 0,
      "llm-skip": 0,
      "llm-merge": 0,
      unique: 0,
    } as IngestResult["dedupReasonCounts"];
    for (const r of results) {
      totalChunks += r.chunksIngested;
      totalDeduped += r.chunksDeduped;
      totalErrors += r.errors.length;
      for (const reason of Object.keys(totalDedupReasons) as Array<keyof typeof totalDedupReasons>) {
        totalDedupReasons[reason] += r.dedupReasonCounts[reason];
      }
      if (r.errors.length > 0 && verbose) {
        console.log(`  ⚠️  ${r.source} errors:`);
        for (const e of r.errors.slice(0, 5)) {
          console.log(`     ${e}`);
        }
      }
    }
    console.log(
      `  总计: ${totalChunks} chunks 已索引, ${totalDeduped} chunks 去重 (hard:${totalDedupReasons.hard}, exact:${totalDedupReasons.exact}, llm-skip:${totalDedupReasons["llm-skip"]}, llm-merge:${totalDedupReasons["llm-merge"]}), ${totalErrors} errors`,
    );
    console.log();
  });

// ─── stats ───────────────────────────────────────────────────────────────────

program
  .command("stats")
  .description("显示索引统计")
  .action(async () => {
    const config = loadConfig();
    const { store } = createComponents(config);

    const stats = await store.stats();

    console.log("\n📊 记忆索引统计:\n");
    console.log(`  总条目: ${stats.totalCount}`);
    console.log();

    console.log("  按来源:");
    for (const [scope, count] of Object.entries(stats.scopeCounts).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`    ${scope}: ${count}`);
    }
    console.log();

    console.log("  按类别:");
    for (const [cat, count] of Object.entries(stats.categoryCounts)) {
      console.log(`    ${cat}: ${count}`);
    }
    console.log();
  });

program
  .command("scope-audit")
  .description("扫描 legacy scope 异常行（missing / empty / global）")
  .option("-n, --limit <n>", "最多显示多少条示例", "20")
  .option("--json", "JSON 格式输出")
  .action(async (options) => {
    const config = loadConfig();
    const store = createStoreOnly(config);
    const limit = parseLimitOption(options.limit, 20, 1, 200);
    const audit = await store.auditLegacyScopes(limit);

    if (options.json) {
      console.log(JSON.stringify(audit, null, 2));
      return;
    }

    if (audit.totalCount === 0) {
      console.log("No legacy scope anomalies found.");
      return;
    }

    console.log("Legacy scope audit\n");
    console.log(`  Total anomalies: ${audit.totalCount}`);
    console.log(`  Missing scope : ${audit.counts.missing}`);
    console.log(`  Empty scope   : ${audit.counts.empty}`);
    console.log(`  Global scope  : ${audit.counts.global}`);

    if (audit.samples.length === 0) {
      return;
    }

    console.log("\n  Sample rows:");
    console.log("    ID        Kind     Scope        Category      Date        Text");
    console.log("    --------  -------  -----------  ------------  ----------  ----");
    for (const sample of audit.samples) {
      const date = new Date(sample.timestamp).toISOString().slice(0, 10);
      console.log(
        `    ${sample.id.slice(0, 8)}  ${sample.kind.padEnd(7)}  ${formatLegacyScope(sample.scope).padEnd(11)}  ${sample.category.padEnd(12)}  ${date}  ${seedTextPreview(sample.text, 56)}`
      );
    }

    console.log("\n  Use this report to migrate or delete historical unscoped rows before removing compatibility shims.");
  });

program
  .command("scope-inventory")
  .description("跨 memories / pins / checkpoints / workflow observations 统一盘点 legacy scope 异常")
  .option("-n, --limit <n>", "每层最多显示多少条示例", "20")
  .option("--json", "JSON 格式输出")
  .action(async (options) => {
    const config = loadConfig();
    const store = createStoreOnly(config);
    const limit = parseLimitOption(options.limit, 20, 1, 200);
    const report = await collectScopeInventory({
      store,
      sampleLimit: limit,
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(formatScopeInventoryReport(report));
  });

// ─── reset ───────────────────────────────────────────────────────────────────

program
  .command("reset")
  .description("清空索引（危险！）")
  .option("--yes", "跳过确认")
  .action(async (options) => {
    if (!options.yes) {
      console.log("⚠️  这会清空所有已索引的记忆。确认请加 --yes");
      return;
    }

    const config = loadConfig();
    const dbPath = resolve(metaDir(import.meta), "..", expandHome(config.dbPath));

    if (existsSync(dbPath)) {
      const { rmSync } = await import("node:fs");
      rmSync(dbPath, { recursive: true });
      console.log("✅ 索引已清空。");
    } else {
      console.log("索引目录不存在，无需清空。");
    }
  });

// ─── export ──────────────────────────────────────────────────────────────────

program
  .command("export-memories")
  .description("导出最近记忆为 markdown（供 digital-clone 等下游消费）")
  .option("-d, --days <n>", "导出最近 N 天的记忆", "7")
  .option("-n, --limit <n>", "最多导出条数", "200")
  .option("-o, --output <path>", "输出文件路径（默认 stdout）")
  .option("-s, --scope <scope>", "限定来源")
  .option("--json", "输出 JSONL 格式")
  .action(async (options) => {
    const config = loadConfig();
    const { store } = createComponents(config);
    const scopeFilter = toScopeFilter(options.scope);
    const limit = parseLimitOption(options.limit, 200, 1, 1000);
    const days = parseLimitOption(options.days, 7, 1, 365);
    const cutoff = Date.now() - days * 86_400_000;

    // List all entries, filter by time
    const entries = await store.list(scopeFilter, undefined, limit * 2, 0);
    const recent = entries
      .filter(e => e.timestamp >= cutoff)
      .slice(0, limit);

    if (recent.length === 0) {
      console.log(`最近 ${days} 天没有新记忆。`);
      return;
    }

    let output: string;

    if (options.json) {
      output = recent.map(e => JSON.stringify({
        id: e.id,
        text: e.text,
        category: e.category,
        scope: e.scope,
        importance: e.importance,
        timestamp: e.timestamp,
      })).join("\n") + "\n";
    } else {
      // Markdown format: grouped by scope, sorted by time
      const grouped: Record<string, typeof recent> = {};
      for (const e of recent) {
        const key = e.scope || "<missing>";
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(e);
      }

      const lines: string[] = [
        `# RecallNest 记忆导出`,
        ``,
        `> 导出时间: ${new Date().toISOString().slice(0, 10)}`,
        `> 范围: 最近 ${days} 天, ${recent.length} 条`,
        ``,
      ];

      for (const [scope, entries] of Object.entries(grouped)) {
        lines.push(`## ${scope}`);
        lines.push(``);
        for (const e of entries) {
          const date = new Date(e.timestamp).toISOString().slice(0, 10);
          const cat = e.category || "other";
          lines.push(`### [${cat}] ${date}`);
          lines.push(``);
          lines.push(e.text);
          lines.push(``);
          lines.push(`---`);
          lines.push(``);
        }
      }

      output = lines.join("\n");
    }

    if (options.output) {
      const { writeFileSync } = require("node:fs");
      const { mkdirSync } = require("node:fs");
      const { dirname } = require("node:path");
      mkdirSync(dirname(options.output), { recursive: true });
      writeFileSync(options.output, output, "utf-8");
      console.log(`✅ 导出 ${recent.length} 条记忆 → ${options.output}`);
    } else {
      console.log(output);
    }
  });

// ─── doctor ──────────────────────────────────────────────────────────────────

program
  .command("workflow-observe")
  .description("记录一条 workflow primitive observation，作为自进化观测层的 append-only 输入")
  .argument("<workflowId>", "workflow primitive id，如 resume_context / checkpoint_session")
  .argument("<summary>", "本次 observation 的简短说明")
  .option("--outcome <outcome>", "success | failure | corrected | missed", "success")
  .option("--scope <scope>", "可选 scope，如 project:recallnest")
  .option("--source <source>", "来源标签", "manual")
  .option("--signal <signal>", "失败/纠正信号标签")
  .option("--task <task>", "相关任务")
  .option("--tags <tags>", "逗号分隔 tags")
  .option("--tools <tools>", "逗号分隔 tools")
  .option("--json", "输出 JSON")
  .action(async (workflowId, summary, options) => {
    const store = new WorkflowObservationStore();
    const record = buildWorkflowObservationRecord({
      workflowId,
      summary,
      outcome: WorkflowObservationOutcomeSchema.parse(options.outcome),
      scope: options.scope,
      source: options.source,
      signal: options.signal,
      task: options.task,
      tags: splitCsvOption(options.tags),
      tools: splitCsvOption(options.tools),
    });
    const stored = await store.save(record);
    if (options.json) {
      console.log(JSON.stringify(stored, null, 2));
      return;
    }
    console.log(formatWorkflowObservationSaved(stored));
  });

program
  .command("workflow-health")
  .description("查看 workflow primitive 的健康度；不带 workflowId 时输出全局 dashboard")
  .argument("[workflowId]", "可选 workflow primitive id")
  .option("--scope <scope>", "可选 scope")
  .option("--limit <n>", "dashboard 返回数量上限")
  .option("--json", "输出 JSON")
  .action(async (workflowId, options) => {
    const store = new WorkflowObservationStore();
    if (workflowId) {
      const report = await inspectWorkflowHealth(store, {
        workflowId,
        scope: options.scope,
      });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(formatWorkflowHealthReport(report));
      return;
    }

    const dashboard = await inspectWorkflowDashboard(store, {
      scope: options.scope,
      limit: parseLimitOption(options.limit, 10, 1, 30),
    });
    if (options.json) {
      console.log(JSON.stringify(dashboard, null, 2));
      return;
    }
    console.log(formatWorkflowHealthDashboard(dashboard, options.scope));
  });

program
  .command("workflow-evidence")
  .description("为某个 workflow primitive 生成 evidence pack，方便后续做规则/测试收口")
  .argument("<workflowId>", "workflow primitive id")
  .option("--scope <scope>", "可选 scope")
  .option("--limit <n>", "最近 issue observation 数量上限")
  .option("--json", "输出 JSON")
  .action(async (workflowId, options) => {
    const store = new WorkflowObservationStore();
    const pack = await buildWorkflowEvidence(store, {
      workflowId,
      scope: options.scope,
      limit: parseLimitOption(options.limit, 5, 1, 20),
    });
    if (options.json) {
      console.log(JSON.stringify(pack, null, 2));
      return;
    }
    console.log(formatWorkflowEvidencePack(pack));
  });

program
  .command("workflow-scope-review")
  .description("审查指定 scope（默认 global）的 workflow observations，并按 cue 预览/回填目标 scope")
  .option("--current-scope <scope>", "要审查的当前 scope", "global")
  .option("--source <source>", "可选 source 过滤，如 managed")
  .option("--workflow-id <workflowId>", "可选 workflowId 过滤，如 resume_context")
  .option("--cue <needle=scope>", "可重复；把命中的 task/summary cue 映射到目标 scope", collectRepeatedOption, [])
  .option("--neighbor-window-seconds <n>", "允许从邻近 observation 继承唯一 scope 的时间窗（秒）", "90")
  .option("--apply", "把有唯一建议 scope 的记录直接回填到文件")
  .option("--keep-global-id <id>", "可重复；把指定 manual-review 记录标记为已审阅且允许保留当前 global", collectRepeatedOption, [])
  .option("--keep-global-reason <reason>", "给 --keep-global-id 使用的审阅原因")
  .option("--json", "输出 JSON")
  .action(async (options) => {
    const cues = (options.cue as string[]).map(parseWorkflowObservationScopeCue);
    const keepGlobalIds = (options.keepGlobalId as string[]) || [];
    if (keepGlobalIds.length > 0 && typeof options.keepGlobalReason !== "string") {
      throw new Error("workflow-scope-review --keep-global-id requires --keep-global-reason.");
    }

    const review = reviewWorkflowObservationScopes({
      currentScope: options.currentScope,
      source: options.source,
      workflowId: options.workflowId,
      cues,
      neighborWindowSeconds: parseLimitOption(options.neighborWindowSeconds, 90, 0, 3600),
    });

    const keepGlobalResult = keepGlobalIds.length > 0
      ? keepWorkflowObservationScopesGlobal(review, {
        ids: keepGlobalIds,
        reason: options.keepGlobalReason,
      })
      : undefined;

    if (options.apply || keepGlobalResult) {
      const result = options.apply
        ? applyWorkflowObservationScopeSuggestions(review)
        : undefined;
      const latestReview = reviewWorkflowObservationScopes({
        currentScope: options.currentScope,
        source: options.source,
        workflowId: options.workflowId,
        cues,
        neighborWindowSeconds: parseLimitOption(options.neighborWindowSeconds, 90, 0, 3600),
      });
      if (options.json) {
        console.log(JSON.stringify({ review: latestReview, result, keepGlobalResult }, null, 2));
        return;
      }

      console.log(formatWorkflowObservationScopeReview(latestReview));
      if (keepGlobalResult) {
        console.log();
        console.log(`Reviewed keep-global : ${keepGlobalResult.reviewedCount}`);
        console.log(`Skipped keep-global  : ${keepGlobalResult.skippedCount}`);
        if (keepGlobalResult.unmatchedIds.length > 0) {
          console.log(`Unmatched ids        : ${keepGlobalResult.unmatchedIds.join(", ")}`);
        }
        if (keepGlobalResult.ambiguousIds.length > 0) {
          console.log(`Ambiguous ids        : ${keepGlobalResult.ambiguousIds.join(", ")}`);
        }
      }
      if (options.apply) {
        console.log();
        console.log(`Applied : ${result?.updatedCount || 0}`);
        console.log(`Skipped : ${result?.skippedCount || 0}`);
      }
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(review, null, 2));
      return;
    }
    console.log(formatWorkflowObservationScopeReview(review));
  });

program
  .command("checkpoint-gc")
  .description("Clean up old session checkpoints: archive stale rich ones, delete expired minimal ones")
  .option("--dry-run", "Preview actions without modifying files")
  .option("--keep-per-scope <n>", "Rich checkpoints to keep per scope (default: 5)")
  .option("--archive-after-days <n>", "Archive rich checkpoints older than N days (default: 30)")
  .option("--minimal-ttl-days <n>", "Delete minimal checkpoints older than N days (default: 7)")
  .option("--archive-ttl-days <n>", "Hard-delete archived files older than N days (default: 90)")
  .action(async (options) => {
    const { SessionCheckpointStore } = await import("./session-store.js");
    const store = new SessionCheckpointStore();
    const result = store.gc({
      dryRun: Boolean(options.dryRun),
      keepPerScope: options.keepPerScope ? parseLimitOption(options.keepPerScope, 5, 1, 50) : undefined,
      archiveAfterDays: options.archiveAfterDays ? parseLimitOption(options.archiveAfterDays, 30, 1, 365) : undefined,
      minimalTtlDays: options.minimalTtlDays ? parseLimitOption(options.minimalTtlDays, 7, 1, 365) : undefined,
      archiveTtlDays: options.archiveTtlDays ? parseLimitOption(options.archiveTtlDays, 90, 1, 730) : undefined,
    });

    console.log(options.dryRun ? "=== Checkpoint GC (dry run) ===\n" : "=== Checkpoint GC ===\n");

    const archives = result.actions.filter((a) => a.action === "archive");
    const deletes = result.actions.filter((a) => a.action === "delete");

    if (archives.length > 0) {
      console.log(`Archive (${archives.length}):`);
      for (const a of archives) {
        console.log(`  ${a.checkpointId.slice(0, 8)}  ${a.resolvedScope}  ${a.updatedAt.slice(0, 10)}  ${a.reason}`);
      }
      console.log();
    }

    if (deletes.length > 0) {
      console.log(`Delete (${deletes.length}):`);
      for (const a of deletes) {
        console.log(`  ${a.checkpointId.slice(0, 8)}  ${a.resolvedScope}  ${a.updatedAt.slice(0, 10)}  ${a.reason}`);
      }
      console.log();
    }

    console.log([
      `Kept     : ${result.kept}`,
      `Archived : ${result.archived}`,
      `Deleted  : ${result.deleted}`,
      `Errors   : ${result.errors.length}`,
    ].join("\n"));

    if (result.errors.length > 0) {
      console.log("\nErrors:");
      for (const e of result.errors) console.log(`  ${e}`);
    }
  });

program
  .command("import <path>")
  .description("导入多格式对话文件到记忆索引")
  .option("-f, --format <format>", "格式: auto|claude-code|chatgpt|slack|claude-ai|plaintext", "auto")
  .option("-s, --scope <scope>", "目标 scope（必须）")
  .action(async (filePath: string, options) => {
    if (!options.scope) {
      console.error("❌ --scope is required");
      process.exitCode = 1;
      return;
    }
    const resolvedPath = resolve(filePath);
    if (!existsSync(resolvedPath)) {
      console.error(`❌ File not found: ${resolvedPath}`);
      process.exitCode = 1;
      return;
    }
    const validFormats = ["auto", "claude-code", "chatgpt", "slack", "claude-ai", "plaintext"] as const;
    if (!validFormats.includes(options.format)) {
      console.error(`❌ Invalid format: ${options.format}. Must be one of: ${validFormats.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    const config = loadConfig();
    const { store, embedder, llm } = createComponents(config);

    const { importConversation } = await import("./conversation-importer.js");
    const result = await importConversation(
      { store, embedder, llm },
      resolvedPath,
      options.scope,
      options.format as "auto" | "claude-code" | "chatgpt" | "slack" | "claude-ai" | "plaintext",
    );

    console.log(`\n📥 Import complete`);
    console.log(`  Total messages: ${result.total}`);
    console.log(`  Stored: ${result.stored}`);
    console.log(`  Rejected: ${result.rejected}`);
    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
      for (const e of result.errors) console.log(`    ${e}`);
    }
  });

program
  .command("doctor")
  .description("检查安装状态和配置")
  .option("--ci", "跳过 API key 在线验证（CI 模式）")
  .action(async (options) => {
    const results = await runDoctor({ ci: options.ci });
    console.log(formatDoctorResults(results));
    const hasFailure = results.some(r => r.status === "fail");
    if (hasFailure) process.exitCode = 1;
  });

program
  .command("lint")
  .description("Run memory quality lint checks")
  .option("--scope <scope>", "Limit to a specific scope")
  .option("--json", "Output raw JSON instead of formatted report")
  .option("--verbose", "Show all individual findings")
  .action(async (options) => {
    const { runMemoryLint, formatMemoryLintReport } = await import("./memory-lint.js");
    const config = loadConfig();
    const { store } = createComponents(config);

    const report = await runMemoryLint({
      store,
      scope: options.scope,
      verbose: options.verbose,
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log();
      console.log(formatMemoryLintReport(report));
    }
  });

program
  .command("graph")
  .description("Export interactive knowledge graph as HTML")
  .option("--scope <scope>", "Limit to a specific scope")
  .option("--max-nodes <n>", "Maximum nodes (default 200)", "200")
  .option("--out <path>", "Output file path")
  .option("--open", "Open in browser after export")
  .action(async (options) => {
    const { exportMemoryGraph, formatGraphExportResult } = await import("./graph-export.js");
    const config = loadConfig();
    const { store } = createComponents(config);

    const maxNodes = parseInt(options.maxNodes, 10) || 200;
    const { path, graph } = await exportMemoryGraph(store, {
      scope: options.scope,
      maxNodes,
      outputPath: options.out,
    });

    console.log();
    console.log(formatGraphExportResult(path, graph));

    if (options.open) {
      const { execFileSync } = await import("node:child_process");
      try {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        execFileSync(cmd, [path], { stdio: "ignore" });
      } catch {}
    }
  });

// Run
loadDotEnv();
program.parseAsync(process.argv).catch((error) => {
  console.error(`RecallNest CLI error: ${errorMessage(error)}`);
  process.exitCode = 1;
});
