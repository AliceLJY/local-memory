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
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import type { RetrievalResult } from "./retriever.js";
import { applyRetrievalProfile, listRetrievalProfiles } from "./retrieval-profiles.js";
import { distillResults, formatExplainResults, formatSearchResults, selectBriefSeedResults, summarizeResults } from "./memory-output.js";
import { archiveDirtyBriefAsset, assetSummaryLine, buildBriefAsset, buildPinAsset, getExportsDir, listDirtyBriefAssets, listMemoryAssets, listPinAssets, pinSummaryLine, saveBriefAsset, savePinAsset, writeExportArtifact } from "./memory-assets.js";
import { indexAsset, indexPinnedAsset } from "./asset-sync.js";
import { createComponents, expandHome, loadConfig, loadDotEnv, type LocalMemoryConfig } from "./runtime-config.js";
import {
  ingestCCTranscripts,
  ingestCodexSessions,
  ingestGeminiSessions,
  ingestMarkdownFiles,
} from "./ingest.js";
import { runDoctor, formatDoctorResults } from "./doctor.js";
import { persistCaseMemory, persistWorkflowPattern } from "./capture-engine.js";
import {
  CaseMemoryInputSchema,
  type CaseMemoryInput,
  WorkflowPatternInputSchema,
  type WorkflowPatternInput,
} from "./memory-schema.js";
import type { MemoryEntry } from "./store.js";
import { ConflictStatusSchema } from "./conflict-schema.js";
import { resolveConflictCandidate } from "./conflict-engine.js";
import { escalateConflicts } from "./conflict-escalation.js";
import { ConflictCandidateStore } from "./conflict-store.js";
import { formatConflictAudit, formatConflictAuditMarkdown, formatConflictClusters, formatConflictEscalation, formatConflictList, formatConflictRecord, formatConflictResolution } from "./conflict-output.js";
import { CONFLICT_ATTENTION_LEVELS, parseConflictAttention, summarizeConflictLifecycle } from "./conflict-lifecycle.js";
import { buildConflictAuditSummary, clusterConflicts, summarizeConflictAdvice } from "./conflict-advisor.js";

/**
 * Auto-detect Claude Code transcript directory.
 * Scans ~/.claude/projects/ for subdirectories containing .jsonl files.
 */
function detectCCPath(): string | null {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;
  try {
    const dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(projectsDir, d.name));
    // Pick the directory with most .jsonl files
    let best = "";
    let bestCount = 0;
    for (const dir of dirs) {
      const jsonlCount = readdirSync(dir).filter(f => f.endsWith(".jsonl")).length;
      if (jsonlCount > bestCount) {
        bestCount = jsonlCount;
        best = dir;
      }
    }
    return best || null;
  } catch {
    return null;
  }
}

/**
 * Resolve "auto" paths in config to actual directories.
 */
function resolveSourcePath(source: string, key: string): string {
  if (source !== "auto") return expandHome(source);

  if (key === "cc") {
    const detected = detectCCPath();
    if (!detected) throw new Error("Could not auto-detect Claude Code transcript path. Set sources.cc.path in config.json.");
    return detected;
  }
  if (key === "memory") {
    const ccPath = detectCCPath();
    if (!ccPath) throw new Error("Could not auto-detect memory path. Set sources.memory.path in config.json.");
    return join(ccPath, "memory");
  }
  throw new Error(`Cannot auto-detect path for source "${key}". Set it manually in config.json.`);
}

// ============================================================================
// CLI
// ============================================================================

const program = new Command();

program
  .name("recallnest")
  .description("本地优先 AI 对话记忆搜索与蒸馏层")
  .version("1.3.1");

async function runRetrievalView(
  view: "search" | "explain" | "distill",
  query: string,
  options: { limit?: string; scope?: string; json?: boolean; profile?: string; explain?: boolean },
) {
  const config = loadConfig();
  const { retriever, profile } = createComponents(config, options.profile);

  const limit = parseLimitOption(options.limit, 5, 1, 20);
  const scopeFilter = toScopeFilter(options.scope);
  const results = await retriever.retrieve({ query, limit, scopeFilter });

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
    : resolve(import.meta.dir, "../eval/continuity/pattern-seeds.json");
}

function caseMemorySeedsPath(file?: string): string {
  return file
    ? resolve(file)
    : resolve(import.meta.dir, "../eval/continuity/case-seeds.json");
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
  .option("-s, --scope <scope>", "限定来源（cc/codex/gemini/memory）")
  .option("-p, --profile <profile>", "检索画像：default / writing / debug / fact-check", "default")
  .option("--explain", "显示命中原因与检索路径")
  .option("--json", "JSON 格式输出")
  .action(async (query: string, options) => {
    await runRetrievalView(options.explain ? "explain" : "search", query, options);
  });

program
  .command("explain <query>")
  .description("解释为什么召回这些记忆")
  .option("-n, --limit <n>", "返回结果数", "5")
  .option("-s, --scope <scope>", "限定来源（cc/codex/gemini/memory）")
  .option("-p, --profile <profile>", "检索画像：default / writing / debug / fact-check", "default")
  .action(async (query: string, options) => {
    await runRetrievalView("explain", query, options);
  });

program
  .command("distill <query>")
  .description("把命中结果蒸馏成可复用 briefing")
  .option("-n, --limit <n>", "返回结果数", "8")
  .option("-s, --scope <scope>", "限定来源（cc/codex/gemini/memory）")
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
  .option("-p, --profile <profile>", "检索画像：default / writing / debug / fact-check", "default")
  .option("-q, --query <query>", "记录这条记忆来自哪个查询")
  .option("-t, --title <title>", "自定义 asset 标题")
  .option("--summary <summary>", "自定义 asset 摘要")
  .action(async (memoryId: string, options) => {
    const config = loadConfig();
    const { store, embedder } = createComponents(config, options.profile);
    const entry = await store.get(memoryId);
    if (!entry) {
      console.log(`Memory not found: ${memoryId}`);
      return;
    }

    const pinnedImportance = Math.max(entry.importance || 0.7, 0.95);
    await store.update(entry.id, { importance: pinnedImportance });

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
  .option("-s, --scope <scope>", "限定来源（cc/codex/gemini/memory）")
  .option("-p, --profile <profile>", "检索画像：default / writing / debug / fact-check", "writing")
  .option("-t, --title <title>", "自定义 brief 标题")
  .action(async (query: string, options) => {
    const config = loadConfig();
    const { retriever, profile, store, embedder } = createComponents(config, options.profile);
    const limit = parseLimitOption(options.limit, 8, 1, 20);
    const scopeFilter = toScopeFilter(options.scope);
    const results = await retriever.retrieve({ query, limit, scopeFilter });
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
  .option("-s, --scope <scope>", "限定来源（cc/codex/gemini/memory）")
  .option("-p, --profile <profile>", "检索画像：default / writing / debug / fact-check", "writing")
  .option("-f, --format <format>", "导出格式：md / json", "md")
  .action(async (query: string, options) => {
    const format = options.format === "json" ? "json" : "md";
    const config = loadConfig();
    const { retriever, profile } = createComponents(config, options.profile);
    const limit = parseLimitOption(options.limit, 8, 1, 20);
    const scopeFilter = toScopeFilter(options.scope);
    const results = await retriever.retrieve({ query, limit, scopeFilter });
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
      const scope = input.scope || `memory:${input.source}`;
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
      const scope = input.scope || `memory:${input.source}`;
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
  .option("-s, --source <source>", "数据源: cc / codex / memory / all", "all")
  .option("-l, --limit <n>", "限制处理文件数（调试用）")
  .option("-v, --verbose", "详细输出")
  .option("--no-dedup", "跳过向量去重")
  .action(async (options) => {
    const config = loadConfig();
    const { store, embedder, llm } = createComponents(config);

    const source = options.source || "all";
    const limit = options.limit
      ? parseRequiredLimitOption(options.limit, "--limit", 1, Number.MAX_SAFE_INTEGER)
      : undefined;
    const verbose = options.verbose || false;
    const noDedup = options.dedup === false; // --no-dedup
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

    // LLM status
    if (llm) {
      const llmTest = await llm.test();
      console.log(llmTest.success
        ? `  ✅ LLM: ${config.llm?.model} (L0 摘要 + 语义去重)`
        : `  ⚠️  LLM: ${config.llm?.model} 连接失败，降级为提取式摘要`);
    } else {
      console.log("  ℹ️  LLM: 未配置，使用提取式 L0 摘要");
    }

    console.log(`  ${noDedup ? "⚠️  去重已禁用 (--no-dedup)" : "✅ 两阶段去重: vector + LLM 语义判断"}\n`);
    console.log(`🔄 开始导入记忆 (source: ${source})...\n`);

    const ingestOpts = { limit, verbose, noDedup, llm };

    // CC Transcripts
    if (source === "all" || source === "cc") {
      console.log("📝 导入 Claude Code 对话...");
      const ccSource = config.sources.cc;
      if (ccSource) {
        const ccPath = resolveSourcePath(ccSource.path, "cc");
        const r = await ingestCCTranscripts(store, embedder, ccPath, ingestOpts);
        results.push(r);
        console.log(
          `  ✅ CC: ${r.filesProcessed} files, ${r.chunksIngested} ingested, ${r.chunksDeduped} deduped, ${r.errors.length} errors`,
        );
      }
    }

    // Codex Sessions
    if (source === "all" || source === "codex") {
      console.log("🤖 导入 Codex 对话...");
      const r = await ingestCodexSessions(store, embedder, ingestOpts);
      results.push(r);
      console.log(
        `  ✅ Codex: ${r.filesProcessed} files, ${r.chunksIngested} ingested, ${r.chunksDeduped} deduped, ${r.errors.length} errors`,
      );
    }

    // Gemini Sessions (JSON format under ~/.gemini/tmp/*/chats/)
    if (source === "all" || source === "gemini") {
      console.log("💎 导入 Gemini 对话...");
      const r = await ingestGeminiSessions(store, embedder, {
        limit,
        verbose,
        noDedup,
        llm,
      });
      results.push(r);
      console.log(
        `  ✅ Gemini: ${r.filesProcessed} files, ${r.chunksIngested} ingested, ${r.chunksDeduped} deduped, ${r.errors.length} errors`,
      );
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
        });
        results.push(r);
        console.log(
          `  ✅ Memory: ${r.filesProcessed} files, ${r.chunksIngested} ingested, ${r.chunksDeduped} deduped, ${r.errors.length} errors`,
        );
      }
    }

    // Summary
    console.log("\n📊 导入汇总:");
    let totalChunks = 0;
    let totalDeduped = 0;
    let totalErrors = 0;
    for (const r of results) {
      totalChunks += r.chunksIngested;
      totalDeduped += r.chunksDeduped;
      totalErrors += r.errors.length;
      if (r.errors.length > 0 && verbose) {
        console.log(`  ⚠️  ${r.source} errors:`);
        for (const e of r.errors.slice(0, 5)) {
          console.log(`     ${e}`);
        }
      }
    }
    console.log(`  总计: ${totalChunks} chunks 已索引, ${totalDeduped} chunks 去重, ${totalErrors} errors`);
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
    const dbPath = resolve(import.meta.dir, "..", expandHome(config.dbPath));

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
        const key = e.scope || "global";
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
  .command("doctor")
  .description("检查安装状态和配置")
  .option("--ci", "跳过 API key 在线验证（CI 模式）")
  .action(async (options) => {
    const results = await runDoctor({ ci: options.ci });
    console.log(formatDoctorResults(results));
    const hasFailure = results.some(r => r.status === "fail");
    if (hasFailure) process.exitCode = 1;
  });

// Run
loadDotEnv();
program.parseAsync(process.argv).catch((error) => {
  console.error(`RecallNest CLI error: ${errorMessage(error)}`);
  process.exitCode = 1;
});
