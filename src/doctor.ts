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

import { existsSync, accessSync, constants, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { metaDir } from "./compat.js";
import { loadConfig, expandHome, resolveEnv, findConfigPath, loadDotEnv } from "./runtime-config.js";
import { createEmbedder, type EmbeddingConfig } from "./embedder.js";
import { extractCanonicalKey, normalizeCanonicalKey } from "./memory-boundaries.js";
import {
  CaseMemoryInputSchema,
  type CaseMemoryInput,
  StoreMemoryInputSchema,
  type StoreMemoryInput,
  WorkflowPatternInputSchema,
  type WorkflowPatternInput,
} from "./memory-schema.js";
import { collectScopeInventory, type ScopeInventoryReport } from "./scope-inventory.js";
import { MemoryStore, type MemoryEntry, validateStoragePath } from "./store.js";

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
  fix?: string;
}

interface ContinuityBaselineSeeds {
  patterns: WorkflowPatternInput[];
  cases: CaseMemoryInput[];
  memories: StoreMemoryInput[];
}

interface ContinuityBaselineAssessment {
  expected: { patterns: number; cases: number; memories: number };
  found: { patterns: number; cases: number; memories: number };
  missing: { patterns: string[]; cases: string[]; memories: string[] };
}

type ContinuityBaselineEntryStore = Pick<MemoryStore, "list">;

function pass(name: string, message: string): CheckResult {
  return { name, status: "pass", message };
}

function fail(name: string, message: string, fix?: string): CheckResult {
  return { name, status: "fail", message, fix };
}

function warn(name: string, message: string, fix?: string): CheckResult {
  return { name, status: "warn", message, fix };
}

function summarizeScopeInventoryLayers(report: ScopeInventoryReport): string {
  return report.layers
    .filter((layer) => layer.anomalyCount > 0 || layer.invalidCount > 0)
    .map((layer) => {
      const parts = [`${layer.layer}:${layer.anomalyCount}`];
      if (layer.invalidCount > 0) {
        parts.push(`invalid ${layer.invalidCount}`);
      }
      return parts.join(" ");
    })
    .join(", ");
}

export function assessScopeInventoryReport(report: ScopeInventoryReport): CheckResult {
  const cleanSummary = `0 unresolved anomalies across ${report.totalScannedCount} records`;
  if (report.totalAnomalyCount === 0 && report.totalInvalidCount === 0) {
    const reviewedSuffix = report.totalReviewedCount > 0
      ? `; reviewed keeps ${report.totalReviewedCount}`
      : "";
    return pass("Scope inventory", `${cleanSummary}${reviewedSuffix}`);
  }

  const layerSummary = summarizeScopeInventoryLayers(report);
  const firstSample = report.layers.flatMap((layer) => layer.samples).at(0);
  const sampleSummary = firstSample
    ? `; sample ${firstSample.layer}:${firstSample.kind}:${firstSample.id.slice(0, 8)}`
    : "";

  return warn(
    "Scope inventory",
    `${report.totalAnomalyCount} unresolved anomalies, ${report.totalInvalidCount} invalid file(s) across ${report.totalScannedCount} records${layerSummary ? ` (${layerSummary})` : ""}${sampleSummary}`,
    "bun run scope-inventory",
  );
}

function workflowPatternSeedsPath(): string {
  return resolve(metaDir(import.meta), "../eval/continuity/pattern-seeds.json");
}

function caseMemorySeedsPath(): string {
  return resolve(metaDir(import.meta), "../eval/continuity/case-seeds.json");
}

function memorySeedsPath(): string {
  return resolve(metaDir(import.meta), "../eval/continuity/memory-seeds.json");
}

function parseMetadata(raw?: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeIdentityValue(value?: string): string {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveSeedScope(scope?: string, source?: string): string {
  return scope || `memory:${source || "agent"}`;
}

function workflowPatternIdentity(title: string, scope: string): string {
  return `${scope.toLowerCase()}::${normalizeIdentityValue(title)}`;
}

function caseMemoryIdentity(title: string, scope: string): string {
  return `${scope.toLowerCase()}::${normalizeIdentityValue(title)}`;
}

function storeMemoryIdentity(params: {
  category: string;
  scope: string;
  text: string;
  canonicalKey?: string;
}): string {
  const identity = params.canonicalKey
    ? normalizeCanonicalKey(params.canonicalKey)
    : normalizeIdentityValue(params.text);
  return `${params.scope.toLowerCase()}::${params.category.toLowerCase()}::${identity}`;
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

function normalizeWorkflowPatternSeed(raw: unknown): WorkflowPatternInput {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return WorkflowPatternInputSchema.parse({
    ...record,
    source: typeof record.source === "string" ? record.source : "agent",
  });
}

function normalizeCaseMemorySeed(raw: unknown): CaseMemoryInput {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return CaseMemoryInputSchema.parse({
    ...record,
    source: typeof record.source === "string" ? record.source : "agent",
  });
}

function normalizeStoreMemorySeed(raw: unknown): StoreMemoryInput {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return StoreMemoryInputSchema.parse({
    ...record,
    source: typeof record.source === "string" ? record.source : "agent",
  });
}

export function loadContinuityBaselineSeeds(): ContinuityBaselineSeeds {
  const patternsRaw = JSON.parse(readFileSync(workflowPatternSeedsPath(), "utf-8")) as unknown;
  const casesRaw = JSON.parse(readFileSync(caseMemorySeedsPath(), "utf-8")) as unknown;
  const memoriesRaw = JSON.parse(readFileSync(memorySeedsPath(), "utf-8")) as unknown;

  if (!Array.isArray(patternsRaw) || !Array.isArray(casesRaw) || !Array.isArray(memoriesRaw)) {
    throw new Error("Continuity seed files must all be JSON arrays.");
  }

  return {
    patterns: patternsRaw.map((item) => normalizeWorkflowPatternSeed(item)),
    cases: casesRaw.map((item) => normalizeCaseMemorySeed(item)),
    memories: memoriesRaw.map((item) => normalizeStoreMemorySeed(item)),
  };
}

export async function loadContinuityBaselineEntries(
  store: ContinuityBaselineEntryStore,
  totalCountHint: number,
): Promise<MemoryEntry[]> {
  const limit = Number.isFinite(totalCountHint)
    ? Math.max(5000, Math.ceil(totalCountHint))
    : 5000;
  return store.list(undefined, undefined, limit, 0);
}

function seedPreview(text: string, maxLen = 80): string {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length <= maxLen ? compact : `${compact.slice(0, maxLen - 3).trimEnd()}...`;
}

export function assessContinuityBaseline(
  entries: MemoryEntry[],
  seeds: ContinuityBaselineSeeds = loadContinuityBaselineSeeds(),
): ContinuityBaselineAssessment {
  const patternKeys = new Set(
    entries
      .filter((entry) => entry.category === "patterns")
      .map((entry) => {
        const title = extractWorkflowPatternTitle(entry);
        return title ? workflowPatternIdentity(title, entry.scope) : "";
      })
      .filter(Boolean),
  );
  const caseKeys = new Set(
    entries
      .filter((entry) => entry.category === "cases")
      .map((entry) => {
        const title = extractCaseMemoryTitle(entry);
        return title ? caseMemoryIdentity(title, entry.scope) : "";
      })
      .filter(Boolean),
  );
  const memoryKeys = new Set(
    entries.map((entry) => storeMemoryIdentity({
      category: entry.category,
      scope: entry.scope,
      text: entry.text,
      canonicalKey: extractCanonicalKey(entry.metadata) || undefined,
    })),
  );

  const missingPatterns = seeds.patterns
    .filter((seed) => !patternKeys.has(workflowPatternIdentity(seed.title, resolveSeedScope(seed.scope, seed.source))))
    .map((seed) => seed.title);
  const missingCases = seeds.cases
    .filter((seed) => !caseKeys.has(caseMemoryIdentity(seed.title, resolveSeedScope(seed.scope, seed.source))))
    .map((seed) => seed.title);
  const missingMemories = seeds.memories
    .filter((seed) => !memoryKeys.has(storeMemoryIdentity({
      category: seed.category,
      scope: resolveSeedScope(seed.scope, seed.source),
      text: seed.text,
      canonicalKey: seed.canonicalKey,
    })))
    .map((seed) => seedPreview(seed.canonicalKey || seed.text));

  return {
    expected: {
      patterns: seeds.patterns.length,
      cases: seeds.cases.length,
      memories: seeds.memories.length,
    },
    found: {
      patterns: seeds.patterns.length - missingPatterns.length,
      cases: seeds.cases.length - missingCases.length,
      memories: seeds.memories.length - missingMemories.length,
    },
    missing: {
      patterns: missingPatterns,
      cases: missingCases,
      memories: missingMemories,
    },
  };
}

export async function runDoctor(options: { ci?: boolean } = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. Runtime check
  const bunVersion = typeof Bun !== "undefined" ? Bun.version : null;
  if (bunVersion) {
    results.push(pass("Runtime", `Bun v${bunVersion}`));
  } else {
    const nodeVersion = process.version;
    results.push(pass("Runtime", `Node.js ${nodeVersion} (Bun recommended for best performance)`));
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
  } else if (options.ci) {
    results.push(warn(
      "JINA_API_KEY",
      jinaKey === "your_jina_api_key_here" ? "still placeholder value" : "not set (CI mode, skipped)",
    ));
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

    try {
      const entries = await loadContinuityBaselineEntries(store, stats.totalCount);
      const baseline = assessContinuityBaseline(entries);
      const expectedTotal = baseline.expected.patterns + baseline.expected.cases + baseline.expected.memories;
      const foundTotal = baseline.found.patterns + baseline.found.cases + baseline.found.memories;
      const missingTotal = expectedTotal - foundTotal;
      const summary = `patterns ${baseline.found.patterns}/${baseline.expected.patterns}, cases ${baseline.found.cases}/${baseline.expected.cases}, memories ${baseline.found.memories}/${baseline.expected.memories}`;

      if (missingTotal === 0) {
        results.push(pass("Continuity baseline", summary));
      } else {
        const missingPreview = [
          ...baseline.missing.patterns.slice(0, 1),
          ...baseline.missing.cases.slice(0, 1),
          ...baseline.missing.memories.slice(0, 1),
        ].join(" | ");
        results.push(warn(
          "Continuity baseline",
          `${summary}; missing ${missingTotal} canonical seed(s)${missingPreview ? ` (${missingPreview})` : ""}`,
          "bun run seed:continuity"
        ));
      }
    } catch (error: any) {
      results.push(warn(
        "Continuity baseline",
        error?.message || "unable to inspect canonical continuity seeds",
        "bun run seed:continuity"
      ));
    }

    try {
      const report = await collectScopeInventory({
        store,
        sampleLimit: 5,
      });
      results.push(assessScopeInventoryReport(report));
    } catch (error: any) {
      results.push(warn(
        "Scope inventory",
        error?.message || "unable to audit scoped records across memories, pins, checkpoints, and workflow observations",
        "bun run scope-inventory",
      ));
    }
  } catch {
    results.push(warn("Index", "not yet created (will be created on first ingest)"));
    results.push(warn(
      "Continuity baseline",
      "not yet seeded",
      "bun run seed:continuity"
    ));
    results.push(warn(
      "Scope inventory",
      "not yet audited",
      "bun run scope-inventory"
    ));
  }

  return results;
}

export function formatDoctorResults(results: CheckResult[]): string {
  const lines: string[] = ["\n  RecallNest Doctor\n"];

  const icons = { pass: "  ✅", fail: "  ❌", warn: "  ⚠️ " };
  let hasFailure = false;
  let hasWarning = false;

  for (const r of results) {
    lines.push(`${icons[r.status]} ${r.name}: ${r.message}`);
    if (r.fix) {
      lines.push(`     → ${r.fix}`);
    }
    if (r.status === "fail") hasFailure = true;
    if (r.status === "warn") hasWarning = true;
  }

  lines.push("");
  if (hasFailure) {
    lines.push("  Fix the ❌ items above before running `lm ingest`.");
  } else if (hasWarning) {
    lines.push("  Review the ⚠️ items above before relying on this environment as a clean baseline.");
  } else {
    lines.push("  All clear. Run `lm ingest --source all` to get started.");
  }
  lines.push("");

  return lines.join("\n");
}
