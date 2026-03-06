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
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import { MemoryStore, validateStoragePath } from "./store.js";
import { createEmbedder, type EmbeddingConfig } from "./embedder.js";
import { createRetriever, type RetrievalConfig, DEFAULT_RETRIEVAL_CONFIG, type RetrievalResult } from "./retriever.js";
import { applyRetrievalProfile, listRetrievalProfiles } from "./retrieval-profiles.js";
import { distillResults, formatExplainResults, formatSearchResults, selectBriefSeedResults, summarizeResults } from "./memory-output.js";
import { archiveDirtyBriefAsset, assetSummaryLine, buildBriefAsset, buildPinAsset, listDirtyBriefAssets, listMemoryAssets, listPinAssets, pinSummaryLine, saveBriefAsset, savePinAsset, writeExportArtifact } from "./memory-assets.js";
import { indexAsset, indexPinnedAsset } from "./asset-sync.js";
import {
  ingestCCTranscripts,
  ingestCodexSessions,
  ingestGeminiSessions,
  ingestMarkdownFiles,
} from "./ingest.js";

// ============================================================================
// Config
// ============================================================================

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

// Load .env file (simple parser, no dependency)
function loadDotEnv(): void {
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

function loadConfig(): LocalMemoryConfig {
  const configPath = resolve(import.meta.dir, "../config.json");
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as LocalMemoryConfig;
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
// Initialize
// ============================================================================

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

  const store = new MemoryStore({
    dbPath,
    vectorDim: embedder.dimensions,
  });

  const baseRetrievalConfig = {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...(config.retrieval || {}),
  };
  const { profile, config: retrieverConfig } = applyRetrievalProfile(baseRetrievalConfig, profileName);
  const retriever = createRetriever(store, embedder, retrieverConfig);

  return { store, embedder, retriever, profile };
}

// ============================================================================
// CLI
// ============================================================================

const program = new Command();

program
  .name("recallnest")
  .description("本地优先 AI 对话记忆搜索与蒸馏层")
  .version("1.1.0");

async function runRetrievalView(
  view: "search" | "explain" | "distill",
  query: string,
  options: { limit?: string; scope?: string; json?: boolean; profile?: string; explain?: boolean },
) {
  const config = loadConfig();
  const { retriever, profile } = createComponents(config, options.profile);

  const limit = parseInt(options.limit || "5") || 5;
  const scopeFilter = options.scope ? [options.scope] : undefined;
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
    const limit = parseInt(options.limit || "8") || 8;
    const scopeFilter = options.scope ? [options.scope] : undefined;
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
    const limit = parseInt(options.limit || "10") || 10;
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
    const limit = parseInt(options.limit || "12") || 12;
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
    const limit = parseInt(options.limit || "8") || 8;
    const scopeFilter = options.scope ? [options.scope] : undefined;
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

// ─── ingest ──────────────────────────────────────────────────────────────────

program
  .command("ingest")
  .description("导入对话记录到索引")
  .option("-s, --source <source>", "数据源: cc / codex / memory / all", "all")
  .option("-l, --limit <n>", "限制处理文件数（调试用）")
  .option("-v, --verbose", "详细输出")
  .action(async (options) => {
    const config = loadConfig();
    const { store, embedder } = createComponents(config);

    const source = options.source || "all";
    const limit = options.limit ? parseInt(options.limit) : undefined;
    const verbose = options.verbose || false;
    const results: any[] = [];

    console.log(`\n🔄 开始导入记忆 (source: ${source})...\n`);

    // CC Transcripts
    if (source === "all" || source === "cc") {
      console.log("📝 导入 Claude Code 对话...");
      const ccSource = config.sources.cc;
      if (ccSource) {
        const ccPath = resolveSourcePath(ccSource.path, "cc");
        const r = await ingestCCTranscripts(store, embedder, ccPath, {
          limit,
          verbose,
        });
        results.push(r);
        console.log(
          `  ✅ CC: ${r.filesProcessed} files, ${r.chunksIngested} chunks, ${r.errors.length} errors`,
        );
      }
    }

    // Codex Sessions
    if (source === "all" || source === "codex") {
      console.log("🤖 导入 Codex 对话...");
      const r = await ingestCodexSessions(store, embedder, { limit, verbose });
      results.push(r);
      console.log(
        `  ✅ Codex: ${r.filesProcessed} files, ${r.chunksIngested} chunks, ${r.errors.length} errors`,
      );
    }

    // Gemini Sessions
    if (source === "all" || source === "gemini") {
      console.log("💎 导入 Gemini 对话...");
      const r = await ingestGeminiSessions(store, embedder, { limit, verbose });
      results.push(r);
      console.log(
        `  ✅ Gemini: ${r.filesProcessed} files, ${r.chunksIngested} chunks, ${r.errors.length} errors`,
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
        });
        results.push(r);
        console.log(
          `  ✅ Memory: ${r.filesProcessed} files, ${r.chunksIngested} chunks, ${r.errors.length} errors`,
        );
      }
    }

    // Summary
    console.log("\n📊 导入汇总:");
    let totalChunks = 0;
    let totalErrors = 0;
    for (const r of results) {
      totalChunks += r.chunksIngested;
      totalErrors += r.errors.length;
      if (r.errors.length > 0 && verbose) {
        console.log(`  ⚠️  ${r.source} errors:`);
        for (const e of r.errors.slice(0, 5)) {
          console.log(`     ${e}`);
        }
      }
    }
    console.log(`  总计: ${totalChunks} chunks 已索引, ${totalErrors} errors`);
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

// Run
loadDotEnv();
program.parse();
