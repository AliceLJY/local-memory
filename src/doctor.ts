/**
 * RecallNest Doctor — pre-flight checks for installation & configuration.
 *
 * Validates:
 *   1. Bun runtime available
 *   2. .env file + JINA_API_KEY set
 *   3. Jina API key valid (test embedding)
 *   4. CC transcript path accessible
 *   5. LanceDB data directory writable
 *   6. Existing index stats (if any)
 */

import { existsSync, accessSync, constants } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, expandHome, resolveEnv, findConfigPath, loadDotEnv } from "./runtime-config.js";
import { createEmbedder, type EmbeddingConfig } from "./embedder.js";
import { MemoryStore, validateStoragePath } from "./store.js";

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
  fix?: string;
}

function pass(name: string, message: string): CheckResult {
  return { name, status: "pass", message };
}

function fail(name: string, message: string, fix?: string): CheckResult {
  return { name, status: "fail", message, fix };
}

function warn(name: string, message: string, fix?: string): CheckResult {
  return { name, status: "warn", message, fix };
}

export async function runDoctor(options: { ci?: boolean } = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. Bun runtime
  const bunVersion = typeof Bun !== "undefined" ? Bun.version : null;
  if (bunVersion) {
    results.push(pass("Bun runtime", `v${bunVersion}`));
  } else {
    results.push(fail(
      "Bun runtime",
      "Bun not detected (running under Node?)",
      "Install Bun: curl -fsSL https://bun.sh/install | bash"
    ));
  }

  // 2. Config file
  let configPath: string | null = null;
  try {
    configPath = findConfigPath();
    results.push(pass("Config file", configPath));
  } catch {
    results.push(fail(
      "Config file",
      "config.json not found",
      "cp config.json.example config.json (or set LOCAL_MEMORY_CONFIG env)"
    ));
    return results; // can't continue without config
  }

  // 3. .env + JINA_API_KEY
  loadDotEnv();
  const jinaKey = process.env.JINA_API_KEY;
  if (jinaKey && jinaKey !== "your_jina_api_key_here") {
    results.push(pass("JINA_API_KEY", `set (${jinaKey.slice(0, 8)}...)`));
  } else {
    results.push(fail(
      "JINA_API_KEY",
      jinaKey === "your_jina_api_key_here" ? "still placeholder value" : "not set",
      "Get a free key at https://jina.ai/embeddings/ → paste into .env"
    ));
  }

  // 4. Load config and check paths
  let config;
  try {
    config = loadConfig();
    results.push(pass("Config parse", "valid JSON"));
  } catch (e: any) {
    results.push(fail("Config parse", e.message));
    return results;
  }

  // 5. LanceDB data directory
  const dbPath = resolve(configPath ? join(configPath, "..") : process.cwd(), expandHome(config.dbPath));
  try {
    validateStoragePath(dbPath);
    results.push(pass("Data directory", dbPath));
  } catch (e: any) {
    results.push(fail("Data directory", e.message));
  }

  // 6. CC transcript path
  const ccSource = config.sources?.cc;
  if (ccSource) {
    if (ccSource.path === "auto") {
      const projectsDir = join(homedir(), ".claude", "projects");
      if (existsSync(projectsDir)) {
        results.push(pass("CC transcripts", `auto-detected: ${projectsDir}`));
      } else {
        results.push(warn(
          "CC transcripts",
          "~/.claude/projects/ not found (auto-detect will fail)",
          `Set sources.cc.path in config.json, e.g.: "${join(homedir(), ".claude", "projects", "-Users-" + homedir().split("/").pop())}"`
        ));
      }
    } else {
      const ccPath = expandHome(ccSource.path);
      if (existsSync(ccPath)) {
        results.push(pass("CC transcripts", ccPath));
      } else {
        results.push(fail("CC transcripts", `path not found: ${ccPath}`));
      }
    }
  }

  // 7. Codex sessions
  const codexSource = config.sources?.codex;
  if (codexSource) {
    const codexPath = expandHome(codexSource.path);
    if (existsSync(codexPath)) {
      results.push(pass("Codex sessions", codexPath));
    } else {
      results.push(warn("Codex sessions", `path not found: ${codexPath} (optional)`));
    }
  }

  // 8. Gemini sessions (known limitation)
  const geminiSource = config.sources?.gemini;
  if (geminiSource) {
    results.push(warn(
      "Gemini sessions",
      "Gemini CLI sessions are encrypted protobuf; ingestion not yet supported",
      "This source will be skipped during ingest. No action needed."
    ));
  }

  // 9. Jina API key validation (skip in CI mode)
  if (!options.ci && jinaKey && jinaKey !== "your_jina_api_key_here") {
    try {
      const resolvedKey = resolveEnv(config.embedding.apiKey);
      const embeddingConfig: EmbeddingConfig = {
        provider: "openai-compatible",
        apiKey: resolvedKey,
        model: config.embedding.model,
        baseURL: config.embedding.baseURL,
        dimensions: config.embedding.dimensions,
        taskQuery: config.embedding.taskQuery,
        taskPassage: config.embedding.taskPassage,
      };
      const embedder = createEmbedder(embeddingConfig);
      const testResult = await embedder.test();

      if (testResult.success) {
        results.push(pass("Embedding API", `${config.embedding.model} (${testResult.dimensions}d)`));
      } else {
        results.push(fail(
          "Embedding API",
          testResult.error || "test embedding failed",
          "Check your JINA_API_KEY at https://jina.ai/embeddings/"
        ));
      }
    } catch (e: any) {
      results.push(fail("Embedding API", e.message));
    }
  } else if (options.ci) {
    results.push(warn("Embedding API", "skipped (CI mode)"));
  }

  // 10. Index stats (if data exists)
  try {
    const store = new MemoryStore({ dbPath, vectorDim: config.embedding.dimensions || 1024 });
    const stats = await store.stats();
    if (stats.totalCount > 0) {
      const scopes = Object.entries(stats.scopeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${v}`)
        .join(", ");
      results.push(pass("Index", `${stats.totalCount} entries (${scopes})`));
    } else {
      results.push(warn(
        "Index",
        "empty — run `lm ingest` to populate",
        "lm ingest --source all"
      ));
    }
  } catch {
    results.push(warn("Index", "not yet created (will be created on first ingest)"));
  }

  return results;
}

export function formatDoctorResults(results: CheckResult[]): string {
  const lines: string[] = ["\n  RecallNest Doctor\n"];

  const icons = { pass: "  ✅", fail: "  ❌", warn: "  ⚠️ " };
  let hasFailure = false;

  for (const r of results) {
    lines.push(`${icons[r.status]} ${r.name}: ${r.message}`);
    if (r.fix) {
      lines.push(`     → ${r.fix}`);
    }
    if (r.status === "fail") hasFailure = true;
  }

  lines.push("");
  if (hasFailure) {
    lines.push("  Fix the ❌ items above before running `lm ingest`.");
  } else {
    lines.push("  All clear. Run `lm ingest --source all` to get started.");
  }
  lines.push("");

  return lines.join("\n");
}
