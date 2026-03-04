#!/usr/bin/env bun
/**
 * local-memory CLI — Local AI conversation memory search
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
import { createRetriever, type RetrievalConfig, DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";
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

function createComponents(config: LocalMemoryConfig) {
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

  const retrieverConfig = {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...(config.retrieval || {}),
  };
  const retriever = createRetriever(store, embedder, retrieverConfig);

  return { store, embedder, retriever };
}

// ============================================================================
// CLI
// ============================================================================

const program = new Command();

program
  .name("local-memory")
  .description("本地 AI 对话记忆搜索 — 基于 memory-lancedb-pro")
  .version("1.0.0");

// ─── search ──────────────────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("搜索记忆（混合向量+关键词）")
  .option("-n, --limit <n>", "返回结果数", "5")
  .option("-s, --scope <scope>", "限定来源（cc/codex/gemini/memory）")
  .option("--json", "JSON 格式输出")
  .action(async (query: string, options) => {
    const config = loadConfig();
    const { retriever } = createComponents(config);

    const limit = parseInt(options.limit) || 5;
    let scopeFilter: string[] | undefined;
    if (options.scope) {
      scopeFilter = [options.scope];
    }

    console.log(`搜索: "${query}"...\n`);

    const results = await retriever.retrieve({ query, limit, scopeFilter });

    if (results.length === 0) {
      console.log("没有找到相关记忆。");
      return;
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          results.map((r) => ({
            score: r.score,
            scope: r.entry.scope,
            text: r.entry.text,
            metadata: r.entry.metadata,
          })),
          null,
          2,
        ),
      );
      return;
    }

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const score = (r.score * 100).toFixed(0);
      const sources: string[] = [];
      if (r.sources.vector) sources.push("向量");
      if (r.sources.bm25) sources.push("关键词");
      if (r.sources.reranked) sources.push("重排");

      let meta: any = {};
      try {
        meta = JSON.parse(r.entry.metadata || "{}");
      } catch {}

      const date = new Date(r.entry.timestamp).toISOString().split("T")[0];
      const sourceLabel = meta.source || r.entry.scope || "?";

      console.log(
        `${i + 1}. [${score}%] [${sourceLabel}] ${date}`,
      );

      // Show text with reasonable length
      const text = r.entry.text;
      const maxLen = 300;
      if (text.length > maxLen) {
        console.log(`   ${text.slice(0, maxLen)}...`);
      } else {
        console.log(`   ${text}`);
      }

      if (meta.file) {
        console.log(`   📁 ${meta.file}`);
      }
      console.log(`   (${sources.join("+")})`);
      console.log();
    }
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
