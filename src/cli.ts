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
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import type { RetrievalResult } from "./retriever.js";
import { applyRetrievalProfile, listRetrievalProfiles } from "./retrieval-profiles.js";
import { distillResults, formatExplainResults, formatSearchResults, selectBriefSeedResults, summarizeResults } from "./memory-output.js";
import { archiveDirtyBriefAsset, assetSummaryLine, buildBriefAsset, buildPinAsset, listDirtyBriefAssets, listMemoryAssets, listPinAssets, pinSummaryLine, saveBriefAsset, savePinAsset, writeExportArtifact } from "./memory-assets.js";
import { indexAsset, indexPinnedAsset } from "./asset-sync.js";
import { createComponents, expandHome, loadConfig, loadDotEnv, type LocalMemoryConfig } from "./runtime-config.js";
import {
  ingestCCTranscripts,
  ingestCodexSessions,
  ingestGeminiSessions,
  ingestMarkdownFiles,
} from "./ingest.js";
import { runDoctor, formatDoctorResults } from "./doctor.js";

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
  .version("1.2.0");

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
