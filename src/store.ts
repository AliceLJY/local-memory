/**
 * LanceDB Storage Layer with Multi-Scope Support
 */

import type * as LanceDB from "@lancedb/lancedb";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, accessSync, constants, mkdirSync, realpathSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { logWarn } from "./stderr-log.js";
import type { DurableMemoryCategory } from "./memory-schema.js";
import { matchesScopeFilter } from "./scope-policy.js";
import { detectEmotionIfEnabled } from "./emotion-detector.js";
import type { MemoryStorePort, MemoryStoreStats, MemoryStoreUpdate } from "./memory-store-port.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Memory categories (v1.1 six-category system, inspired by OpenViking).
 *
 * User Memory (4):
 *   profile      — 用户身份/背景（静态，合并优先）
 *   preferences  — 偏好/倾向（合并优先）
 *   entities     — 持续存在的名词：项目/工具/人物（合并优先）
 *   events       — 发生过的事（追加，不合并）
 *
 * Agent Memory (2):
 *   cases        — 问题→解决方案对（追加，不合并）
 *   patterns     — 可复用的流程/模式（合并优先）
 *
 * Legacy categories kept for backward compatibility.
 */
export type MemoryCategory =
  | DurableMemoryCategory
  | "preference" | "fact" | "decision" | "entity" | "other";

export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  category: MemoryCategory;
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string; // JSON string for extensible metadata — includes l0_abstract/l1_overview/l2_content/tier
  language?: string;   // ISO 639-1: "zh"|"ja"|"ko"|"en"
  fts_text?: string;   // Pre-tokenized text for FTS indexing
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface StoreConfig {
  dbPath: string;
  vectorDim: number;
}

export type LegacyScopeIssueKind = "missing" | "empty" | "global";

export interface LegacyScopeAuditSample {
  id: string;
  kind: LegacyScopeIssueKind;
  scope: string | null;
  category: MemoryEntry["category"];
  timestamp: number;
  text: string;
}

export interface LegacyScopeAudit {
  totalCount: number;
  counts: Record<LegacyScopeIssueKind, number>;
  samples: LegacyScopeAuditSample[];
}

// ============================================================================
// Deterministic ID
// ============================================================================

const RECALLNEST_NS = "recallnest:v1";

/**
 * Generate a deterministic UUID-formatted ID from scope + text.
 * Same inputs always produce the same ID — prevents duplicate entries
 * with different random UUIDs.
 *
 * Format: 8-4-4-4-12 hex (same shape as crypto.randomUUID).
 */
export function deterministicId(scope: string, text: string): string {
  const hash = createHash("sha256")
    .update(`${RECALLNEST_NS}\0${scope}\0${text}`)
    .digest("hex");
  // Format as UUID: 8-4-4-4-12
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// ============================================================================
// LanceDB Dynamic Import
// ============================================================================

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;

export const loadLanceDB = async (): Promise<typeof import("@lancedb/lancedb")> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  try {
    return await lancedbImportPromise;
  } catch (err) {
    throw new Error(`memory-lancedb-pro: failed to load LanceDB. ${String(err)}`, { cause: err });
  }
};

// ============================================================================
// Utility Functions
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function classifyLegacyScope(scope: unknown): LegacyScopeIssueKind | undefined {
  if (scope == null) {
    return "missing";
  }
  if (typeof scope !== "string") {
    return "missing";
  }
  const normalized = scope.trim();
  if (normalized.length === 0) {
    return "empty";
  }
  if (normalized === "global") {
    return "global";
  }
  return undefined;
}

// ============================================================================
// Storage Path Validation
// ============================================================================

/**
 * Validate and prepare the storage directory before LanceDB connection.
 * Resolves symlinks, creates missing directories, and checks write permissions.
 * Returns the resolved absolute path on success, or throws a descriptive error.
 */
export function validateStoragePath(dbPath: string): string {
  let resolvedPath = dbPath;

  // Resolve symlinks if the path already exists
  try {
    if (existsSync(dbPath)) {
      const stats = lstatSync(dbPath);
      if (stats.isSymbolicLink()) {
        try {
          resolvedPath = realpathSync(dbPath);
        } catch (err: any) {
          throw new Error(
            `dbPath "${dbPath}" is a symlink whose target does not exist.\n` +
            `  Fix: Create the target directory, or update the symlink to point to a valid path.\n` +
            `  Details: ${err.code || ""} ${err.message}`
          );
        }
      }
    }
  } catch (err: any) {
    // Re-throw our own descriptive errors
    if (err.message.includes("symlink")) throw err;
    // Other lstat failures — continue with original path
  }

  // Create directory if it doesn't exist
  if (!existsSync(resolvedPath)) {
    try {
      mkdirSync(resolvedPath, { recursive: true });
    } catch (err: any) {
      throw new Error(
        `Failed to create dbPath directory "${resolvedPath}".\n` +
        `  Fix: Ensure the parent directory "${dirname(resolvedPath)}" exists and is writable,\n` +
        `       or create it manually: mkdir -p "${resolvedPath}"\n` +
        `  Details: ${err.code || ""} ${err.message}`
      );
    }
  }

  // Check write permissions
  try {
    accessSync(resolvedPath, constants.W_OK);
  } catch (err: any) {
    throw new Error(
      `dbPath directory "${resolvedPath}" is not writable.\n` +
      `  Fix: Check permissions with: ls -la "${dirname(resolvedPath)}"\n` +
      `       Or grant write access: chmod u+w "${resolvedPath}"\n` +
      `  Details: ${err.code || ""} ${err.message}`
    );
  }

  return resolvedPath;
}

// ============================================================================
// Memory Store
// ============================================================================

const TABLE_NAME = "memories";

export class MemoryStore implements MemoryStorePort {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private ftsIndexCreated = false;

  constructor(private readonly config: StoreConfig) {}

  get dbPath(): string {
    return this.config.dbPath;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();

    let db: LanceDB.Connection;
    try {
      db = await lancedb.connect(this.config.dbPath);
    } catch (err: any) {
      const code = err.code || "";
      const message = err.message || String(err);
      throw new Error(
        `Failed to open LanceDB at "${this.config.dbPath}": ${code} ${message}\n` +
        `  Fix: Verify the path exists and is writable. Check parent directory permissions.`
      );
    }

    let table: LanceDB.Table;

    // Idempotent table init: try openTable first, create only if missing,
    // and handle the race where tableNames() misses an existing table but
    // createTable then sees it (LanceDB eventual consistency).
    try {
      table = await db.openTable(TABLE_NAME);

      // Backward compatibility: add missing columns to existing tables
      try {
        const sample = await table.query().limit(1).toArray();
        if (sample.length > 0) {
          if (!("scope" in sample[0])) {
            logWarn("Adding scope column for backward compatibility with existing data");
          }
          if (!("language" in sample[0])) {
            logWarn("Adding language column for backward compatibility");
            await table.addColumns([{ name: "language", valueSql: "'en'" }]);
          }
          if (!("fts_text" in sample[0])) {
            logWarn("Adding fts_text column for backward compatibility");
            await table.addColumns([{ name: "fts_text", valueSql: "text" }]);
          }
        }
      } catch (err) {
        logWarn("Could not check/migrate table schema:", err);
      }
    } catch (_openErr) {
      // Table doesn't exist yet — create it
      const schemaEntry: MemoryEntry = {
        id: "__schema__",
        text: "",
        vector: Array.from({ length: this.config.vectorDim }).fill(0) as number[],
        category: "other",
        scope: "__schema__",
        importance: 0,
        timestamp: 0,
        metadata: "{}",
        language: "en",
        fts_text: "__schema__",
      };

      try {
        table = await db.createTable(TABLE_NAME, [schemaEntry]);
        await table.delete('id = "__schema__"');
      } catch (createErr) {
        // Race: another caller (or eventual consistency) created the table
        // between our failed openTable and this createTable — just open it.
        if (String(createErr).includes("already exists")) {
          table = await db.openTable(TABLE_NAME);
        } else {
          throw createErr;
        }
      }
    }

    // Validate vector dimensions
    // Note: LanceDB returns Arrow Vector objects, not plain JS arrays.
    // Array.isArray() returns false for Arrow Vectors, so use .length instead.
    const sample = await table.query().limit(1).toArray();
    if (sample.length > 0 && sample[0]?.vector?.length) {
      const existingDim = sample[0].vector.length;
      if (existingDim !== this.config.vectorDim) {
        throw new Error(
          `Vector dimension mismatch: table=${existingDim}, config=${this.config.vectorDim}. Create a new table/dbPath or set matching embedding.dimensions.`
        );
      }
    }

    // Create FTS index for BM25 search (graceful fallback if unavailable)
    try {
      await this.createFtsIndex(table);
      this.ftsIndexCreated = true;
    } catch (err) {
      logWarn("Failed to create FTS index, falling back to vector-only search:", err);
      this.ftsIndexCreated = false;
    }

    this.db = db;
    this.table = table;
  }

  private async createFtsIndex(table: LanceDB.Table): Promise<void> {
    try {
      // Check if FTS index already exists
      const indices = await table.listIndices();
      const hasFtsIndex = indices?.some((idx: any) =>
        idx.indexType === "FTS" || idx.columns?.includes("fts_text")
      );

      if (!hasFtsIndex) {
        // LanceDB @lancedb/lancedb >=0.26: use Index.fts() config
        const lancedb = await loadLanceDB();
        await table.createIndex("fts_text", {
          config: (lancedb as any).Index.fts(),
        });
      }
    } catch (err) {
      throw new Error(`FTS index creation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async store(entry: Omit<MemoryEntry, "id" | "timestamp"> & { id?: string }): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const fullEntry: MemoryEntry = {
      ...entry,
      id: entry.id || deterministicId(entry.scope, entry.text),
      timestamp: Date.now(),
      metadata: entry.metadata || "{}",
      language: entry.language || "en",
      fts_text: entry.fts_text || entry.text,
    };

    const emotionResult = detectEmotionIfEnabled(fullEntry.text);
    if (emotionResult) {
      const existingMeta = JSON.parse(fullEntry.metadata || "{}");
      existingMeta.emotion = emotionResult;
      fullEntry.metadata = JSON.stringify(existingMeta);
    }

    try {
      await this.table!.add([fullEntry]);
    } catch (err: any) {
      const code = err.code || "";
      const message = err.message || String(err);
      throw new Error(
        `Failed to store memory in "${this.config.dbPath}": ${code} ${message}`
      );
    }
    return fullEntry;
  }

  /**
   * Batch store multiple entries at once — much faster than individual store() calls.
   * LanceDB handles bulk inserts efficiently with a single index update.
   */
  async storeBatch(entries: Omit<MemoryEntry, "id" | "timestamp">[]): Promise<number> {
    if (entries.length === 0) return 0;
    await this.ensureInitialized();

    const fullEntries: MemoryEntry[] = entries.map(entry => ({
      ...entry,
      id: deterministicId(entry.scope, entry.text),
      timestamp: Date.now(),
      metadata: entry.metadata || "{}",
      language: entry.language || "en",
      fts_text: entry.fts_text || entry.text,
    }));

    const enrichedEntries = fullEntries.map(e => {
      const emotionResult = detectEmotionIfEnabled(e.text);
      if (emotionResult) {
        const meta = JSON.parse(e.metadata || "{}");
        meta.emotion = emotionResult;
        return { ...e, metadata: JSON.stringify(meta) };
      }
      return e;
    });

    try {
      await this.table!.add(enrichedEntries);
    } catch (err: any) {
      const code = err.code || "";
      const message = err.message || String(err);
      throw new Error(
        `Failed to batch store ${entries.length} memories in "${this.config.dbPath}": ${code} ${message}`
      );
    }
    return fullEntries.length;
  }

  /**
   * Import a pre-built entry while preserving its id/timestamp.
   * Used for re-embedding / migration / A/B testing across embedding models.
   * Intentionally separate from `store()` to keep normal writes simple.
   */
  async importEntry(entry: MemoryEntry): Promise<MemoryEntry> {
    await this.ensureInitialized();

    if (!entry.id || typeof entry.id !== "string") {
      throw new Error("importEntry requires a stable id");
    }

    const vector = entry.vector || [];
    if (!Array.isArray(vector) || vector.length !== this.config.vectorDim) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.config.vectorDim}, got ${Array.isArray(vector) ? vector.length : 'non-array'}`
      );
    }

    const full: MemoryEntry = {
      ...entry,
      scope: entry.scope,
      importance: Number.isFinite(entry.importance) ? entry.importance : 0.5,
      timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
      metadata: entry.metadata || "{}",
      language: entry.language || "en",
      fts_text: entry.fts_text || entry.text,
    };

    // HP-emo: Backfill emotion if absent during import
    try {
      const metaParsed = JSON.parse(full.metadata || "{}");
      if (!metaParsed.emotion) {
        const emotionResult = detectEmotionIfEnabled(full.text);
        if (emotionResult) {
          metaParsed.emotion = emotionResult;
          full.metadata = JSON.stringify(metaParsed);
        }
      }
    } catch { /* malformed metadata — skip backfill */ }

    await this.table!.add([full]);
    return full;
  }

  async hasId(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const safeId = escapeSqlLiteral(id);
    const res = await this.table!.query().select(["id"]).where(`id = '${safeId}'`).limit(1).toArray();
    return res.length > 0;
  }

  async vectorSearch(vector: number[], limit = 5, minScore = 0.3, scopeFilter?: string[]): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    const safeLimit = clampInt(limit, 1, 20);
    const fetchLimit = Math.min(safeLimit * 10, 200); // Over-fetch for scope filtering

    let query = this.table!.vectorSearch(vector).distanceType('cosine').limit(fetchLimit);

    // Apply scope filter if provided
    // Support both exact match ("cc:abc123") and prefix match ("cc")
    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map(scope => {
          const safe = escapeSqlLiteral(scope);
          // If scope contains ":", treat as exact match; otherwise prefix match
          return scope.includes(":")
            ? `scope = '${safe}'`
            : `scope LIKE '${safe}%'`;
        })
        .join(" OR ");
      query = query.where(`(${scopeConditions})`);
    }

    const results = await query.toArray();
    const mapped: MemorySearchResult[] = [];

    for (const row of results) {
      const distance = Number(row._distance ?? 0);
      const score = 1 / (1 + distance);

      if (score < minScore) continue;

      const rowScope = (row.scope as string | undefined) ?? "";

      // Double-check scope filter in application layer (prefix-aware)
      if (!matchesScopeFilter(rowScope, scopeFilter)) {
        continue;
      }

      mapped.push({
        entry: {
          id: row.id as string,
          text: row.text as string,
          vector: row.vector as number[],
          category: row.category as MemoryEntry["category"],
          scope: rowScope,
          importance: Number(row.importance),
          timestamp: Number(row.timestamp),
          metadata: (row.metadata as string) || "{}",
        },
        score,
      });

      if (mapped.length >= safeLimit) break;
    }

    return mapped;
  }

  async bm25Search(query: string, limit = 5, scopeFilter?: string[]): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    if (!this.ftsIndexCreated) {
      return []; // Fallback to vector-only if FTS unavailable
    }

    const safeLimit = clampInt(limit, 1, 20);

    try {
      // Use FTS query type explicitly
      let searchQuery = this.table!.search(query, "fts").limit(safeLimit);

      // Apply scope filter if provided (prefix-aware, same as vectorSearch)
      if (scopeFilter && scopeFilter.length > 0) {
        const scopeConditions = scopeFilter
          .map(scope => {
            const safe = escapeSqlLiteral(scope);
            return scope.includes(":")
              ? `scope = '${safe}'`
              : `scope LIKE '${safe}%'`;
          })
          .join(" OR ");
        searchQuery = searchQuery.where(`(${scopeConditions})`);
      }

      const results = await searchQuery.toArray();
      const mapped: MemorySearchResult[] = [];

      for (const row of results) {
        const rowScope = (row.scope as string | undefined) ?? "";

        // Double-check scope filter in application layer (prefix-aware)
        if (!matchesScopeFilter(rowScope, scopeFilter)) {
          continue;
        }

        // LanceDB FTS _score is raw BM25 (unbounded). Normalize with sigmoid.
        // LanceDB may return BigInt for numeric columns; coerce safely.
        const rawScore = (row._score != null) ? Number(row._score) : 0;
        const normalizedScore = rawScore > 0 ? 1 / (1 + Math.exp(-rawScore / 5)) : 0.5;

        mapped.push({
          entry: {
            id: row.id as string,
            text: row.text as string,
            vector: row.vector as number[],
            category: row.category as MemoryEntry["category"],
            scope: rowScope,
            importance: Number(row.importance),
            timestamp: Number(row.timestamp),
            metadata: (row.metadata as string) || "{}",
          },
          score: normalizedScore,
        });
      }

      return mapped;
    } catch (err) {
      logWarn("BM25 search failed, falling back to empty results:", err);
      return [];
    }
  }

  async delete(id: string, scopeFilter?: string[]): Promise<boolean> {
    await this.ensureInitialized();

    // Support both full UUID and short prefix (8+ hex chars)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const prefixRegex = /^[0-9a-f]{8,}$/i;
    const isFullId = uuidRegex.test(id);
    const isPrefix = !isFullId && prefixRegex.test(id);

    if (!isFullId && !isPrefix) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    let candidates: any[];
    if (isFullId) {
      candidates = await this.table!.query().where(`id = '${id}'`).limit(1).toArray();
    } else {
      // v2.5.2 (2026-05-27): Use SQL LIKE for prefix lookup instead of app-layer scan
      // with limit(1000) — the old `.select().limit(1000).filter()` pattern silently
      // missed entries beyond row 1000 in 90K+ libraries (Codex trio review finding,
      // ref: ~/Desktop/codex-v2.5.1-fix-review-20260527.md, store.delete limit 漏洞).
      // Now mirrors getById prefix behavior: LIKE with limit(2) detects ambiguity.
      const safeId = escapeSqlLiteral(id);
      candidates = await this.table!.query()
        .select(["id", "scope"])
        .where(`id LIKE '${safeId}%'`)
        .limit(2)
        .toArray();
      if (candidates.length > 1) {
        throw new Error(`Ambiguous prefix "${id}" matches ${candidates.length}+ memories. Use a longer prefix or full ID.`);
      }
    }
    if (candidates.length === 0) {
      return false;
    }

    const resolvedId = candidates[0].id as string;
    const rowScope = (candidates[0].scope as string | undefined) ?? "";

    // Check scope permissions
    if (!matchesScopeFilter(rowScope, scopeFilter)) {
      throw new Error(`Memory ${resolvedId} is outside accessible scopes`);
    }

    await this.table!.delete(`id = '${resolvedId}'`);
    return true;
  }

  async list(scopeFilter?: string[], category?: string, limit = 20, offset = 0): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    let query = this.table!.query();

    // Build where conditions
    const conditions: string[] = [];

    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map(scope => {
          const safe = escapeSqlLiteral(scope);
          return scope.includes(":")
            ? `scope = '${safe}'`
            : `scope LIKE '${safe}%'`;
        })
        .join(" OR ");
      conditions.push(`((${scopeConditions}))`);
    }

    if (category) {
      conditions.push(`category = '${escapeSqlLiteral(category)}'`);
    }

    if (conditions.length > 0) {
      query = query.where(conditions.join(" AND "));
    }

    // Fetch all matching rows (no pre-limit) so app-layer sort is correct across full dataset
    const results = await query
      .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"])
      .toArray();

    return results
      .map((row): MemoryEntry => ({
        id: row.id as string,
        text: row.text as string,
        vector: [], // Don't include vectors in list results for performance
        category: row.category as MemoryEntry["category"],
        scope: (row.scope as string | undefined) ?? "",
        importance: Number(row.importance),
        timestamp: Number(row.timestamp),
        metadata: (row.metadata as string) || "{}",
      }))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(offset, offset + limit);
  }

  async get(id: string, scopeFilter?: string[]): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const prefixRegex = /^[0-9a-f]{8,}$/i;
    const isFullId = uuidRegex.test(id);
    const isPrefix = !isFullId && prefixRegex.test(id);

    if (!isFullId && !isPrefix) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    let rows: any[];
    if (isFullId) {
      const safeId = escapeSqlLiteral(id);
      rows = await this.table!
        .query()
        .select(["id", "text", "vector", "category", "scope", "importance", "timestamp", "metadata"])
        .where(`id = '${safeId}'`)
        .limit(1)
        .toArray();
    } else {
      const all = await this.table!
        .query()
        .select(["id", "text", "vector", "category", "scope", "importance", "timestamp", "metadata"])
        .toArray();
      rows = all.filter((r: any) => (r.id as string).startsWith(id));
      if (rows.length > 1) {
        throw new Error(`Ambiguous prefix "${id}" matches ${rows.length} memories. Use a longer prefix or full ID.`);
      }
    }

    if (rows.length === 0) return null;

    const row = rows[0];
    const rowScope = (row.scope as string | undefined) ?? "";
    if (!matchesScopeFilter(rowScope, scopeFilter)) {
      throw new Error(`Memory ${id} is outside accessible scopes`);
    }

    return {
      id: row.id as string,
      text: row.text as string,
      vector: Array.from(row.vector as Iterable<number>),
      category: row.category as MemoryEntry["category"],
      scope: rowScope,
      importance: Number(row.importance),
      timestamp: Number(row.timestamp),
      metadata: (row.metadata as string) || "{}",
    };
  }

  /**
   * Get a single entry by ID (full UUID) or 8+ hex prefix.
   * Lightweight read used by AccessTracker for metadata updates and by skill-engine
   * for outcome recording.
   *
   * v2.5.1 (2026-05-27) — 加 prefix lookup support：和 update() / delete() 行为对齐，
   * 让 agent 拿到 short id（如 store_skill 返回的 8 位前缀、人类粘贴的截断 id）也能
   * resolve 到完整 entry。歧义 prefix（匹配 >1 条）返回 null 让 caller 处理。
   * 现有 caller 全部传完整 UUID，向后兼容。
   */
  async getById(id: string): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    // Support both full UUID and 8+ hex prefix (same pattern as update() / delete()).
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const prefixRegex = /^[0-9a-f]{8,}$/i;
    const isFullId = uuidRegex.test(id);
    const isPrefix = !isFullId && prefixRegex.test(id);
    if (!isFullId && !isPrefix) return null;

    const safeId = escapeSqlLiteral(id);
    const whereClause = isFullId ? `id = '${safeId}'` : `id LIKE '${safeId}%'`;

    const rows = await this.table!.query()
      .select(["id", "text", "vector", "category", "scope", "importance", "timestamp", "metadata"])
      .where(whereClause)
      .limit(2) // detect ambiguous prefix (matches >1)
      .toArray();
    if (rows.length === 0) return null;
    if (isPrefix && rows.length > 1) return null; // ambiguous prefix
    const row = rows[0];
    return {
      id: row.id as string,
      text: row.text as string,
      vector: Array.from(row.vector as Iterable<number>),
      category: row.category as MemoryEntry["category"],
      scope: (row.scope as string | undefined) ?? "",
      importance: Number(row.importance),
      timestamp: Number(row.timestamp),
      metadata: (row.metadata as string) || "{}",
    };
  }

  /**
   * Batch-fetch vectors for a list of entry IDs.
   * Used by graph-export for cross-scope semantic bridge computation.
   * Single LanceDB query — much faster than N individual getById calls.
   */
  async getVectors(ids: string[]): Promise<Map<string, number[]>> {
    await this.ensureInitialized();
    if (ids.length === 0) return new Map();

    const conditions = ids.map(id => `id = '${escapeSqlLiteral(id)}'`).join(" OR ");
    const rows = await this.table!.query()
      .select(["id", "vector"])
      .where(conditions)
      .limit(ids.length)
      .toArray();

    const result = new Map<string, number[]>();
    for (const row of rows) {
      const vec = Array.from(row.vector as Iterable<number>);
      if (vec.length > 0) result.set(row.id as string, vec);
    }
    return result;
  }

  async stats(scopeFilter?: string[]): Promise<MemoryStoreStats> {
    await this.ensureInitialized();

    let query = this.table!.query();

    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map(scope => {
          const safe = escapeSqlLiteral(scope);
          return scope.includes(":")
            ? `scope = '${safe}'`
            : `scope LIKE '${safe}%'`;
        })
        .join(" OR ");
      query = query.where(`((${scopeConditions}))`);
    }

    const results = await query.select(["scope", "category"]).toArray();

    const scopeCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};

    for (const row of results) {
      const scope = (row.scope as string | undefined) ?? "";
      const category = row.category as string;

      scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    }

    return {
      totalCount: results.length,
      scopeCounts,
      categoryCounts,
    };
  }

  async auditLegacyScopes(limit = 20): Promise<LegacyScopeAudit> {
    await this.ensureInitialized();

    const safeLimit = clampInt(limit, 1, 200);
    const rows = await this.table!
      .query()
      .select(["id", "text", "category", "scope", "timestamp"])
      .toArray();

    const counts: Record<LegacyScopeIssueKind, number> = {
      missing: 0,
      empty: 0,
      global: 0,
    };

    const samples = rows
      .map((row) => {
        const scopeValue = (row.scope as string | null | undefined) ?? null;
        const kind = classifyLegacyScope(scopeValue);
        if (!kind) return null;
        counts[kind] += 1;
        return {
          id: row.id as string,
          kind,
          scope: scopeValue,
          category: row.category as MemoryEntry["category"],
          timestamp: Number(row.timestamp),
          text: row.text as string,
        } satisfies LegacyScopeAuditSample;
      })
      .filter((row): row is LegacyScopeAuditSample => row !== null)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, safeLimit);

    return {
      totalCount: counts.missing + counts.empty + counts.global,
      counts,
      samples,
    };
  }

  async update(
    id: string,
    updates: MemoryStoreUpdate,
    scopeFilter?: string[]
  ): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    // Support both full UUID and short prefix (8+ hex chars), same as delete()
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const prefixRegex = /^[0-9a-f]{8,}$/i;
    const isFullId = uuidRegex.test(id);
    const isPrefix = !isFullId && prefixRegex.test(id);

    if (!isFullId && !isPrefix) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    let rows: any[];
    if (isFullId) {
      const safeId = escapeSqlLiteral(id);
      rows = await this.table!.query().where(`id = '${safeId}'`).limit(1).toArray();
    } else {
      // Prefix match
      const all = await this.table!.query().select(["id", "text", "vector", "category", "scope", "importance", "timestamp", "metadata", "language", "fts_text"]).toArray();
      rows = all.filter((r: any) => (r.id as string).startsWith(id));
      if (rows.length > 1) {
        throw new Error(`Ambiguous prefix "${id}" matches ${rows.length} memories. Use a longer prefix or full ID.`);
      }
    }

    if (rows.length === 0) return null;

    const row = rows[0];
    const rowScope = (row.scope as string | undefined) ?? "";

    // Check scope permissions
    if (!matchesScopeFilter(rowScope, scopeFilter)) {
      throw new Error(`Memory ${id} is outside accessible scopes`);
    }

    // Build updated entry, preserving original timestamp and language fields
    const updated: MemoryEntry = {
      id: row.id as string,
      text: updates.text ?? (row.text as string),
      vector: updates.vector ?? (Array.from(row.vector as Iterable<number>)),
      category: updates.category ?? (row.category as MemoryEntry["category"]),
      scope: rowScope,
      importance: updates.importance ?? Number(row.importance),
      timestamp: updates.timestamp ?? Number(row.timestamp),
      metadata: updates.metadata ?? ((row.metadata as string) || "{}"),
      language: updates.language ?? ((row.language as string) || "en"),
      fts_text: updates.fts_text ?? ((row.fts_text as string) || (updates.text ?? (row.text as string))),
    };

    // HP-emo: Re-detect emotion when text changes
    if (updates.text) {
      const emotionResult = detectEmotionIfEnabled(updates.text);
      if (emotionResult) {
        const meta = JSON.parse(updated.metadata || "{}");
        meta.emotion = emotionResult;
        updated.metadata = JSON.stringify(meta);
      }
    }

    // LanceDB doesn't support in-place update; delete + re-add
    const resolvedId = escapeSqlLiteral(row.id as string);
    await this.table!.delete(`id = '${resolvedId}'`);
    await this.table!.add([updated]);

    return updated;
  }

  async bulkDelete(scopeFilter: string[], beforeTimestamp?: number): Promise<number> {
    await this.ensureInitialized();

    const conditions: string[] = [];

    if (scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map(scope => {
          const safe = escapeSqlLiteral(scope);
          return scope.includes(":")
            ? `scope = '${safe}'`
            : `scope LIKE '${safe}%'`;
        })
        .join(" OR ");
      conditions.push(`(${scopeConditions})`);
    }

    if (beforeTimestamp) {
      conditions.push(`timestamp < ${beforeTimestamp}`);
    }

    if (conditions.length === 0) {
      throw new Error("Bulk delete requires at least scope or timestamp filter for safety");
    }

    const whereClause = conditions.join(" AND ");

    // Count first
    const countResults = await this.table!.query().where(whereClause).toArray();
    const deleteCount = countResults.length;

    // Then delete
    if (deleteCount > 0) {
      await this.table!.delete(whereClause);
    }

    return deleteCount;
  }

  get hasFtsSupport(): boolean {
    return this.ftsIndexCreated;
  }
}
