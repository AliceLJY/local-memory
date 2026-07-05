/**
 * Knowledge Graph Triple Store
 * Stores (subject, predicate, object) triples in a dedicated LanceDB table.
 * Pure relational — no vector columns.
 */

import type * as LanceDB from "@lancedb/lancedb";
import { createHash } from "node:crypto";
import { loadLanceDB } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface KGTriple {
  /** Deterministic ID: sha256(scope + subject + predicate + object) */
  id: string;
  scope: string;
  subject: string;
  predicate: string;
  object: string;
  /** Extraction confidence 0-1 (max across all extractions of this triple) */
  confidence: number;
  /** First source memory that contributed this triple (read-path compat) */
  source_memory_id: string;
  /** Original text snippet used for extraction */
  source_text: string;
  /** Last time this triple was (re-)extracted */
  timestamp: number;
  /** Number of distinct source memories that mentioned this fact (frequency = importance signal) */
  mention_count: number;
  /** Timestamp of the first extraction of this triple */
  first_seen: number;
  /** JSON array of contributing source memory ids, capped at SOURCE_IDS_CAP */
  source_memory_ids: string;
}

/** Caller-facing input: counting fields are managed internally by the store. */
export type KGTripleInput = Omit<KGTriple, "id" | "timestamp" | "mention_count" | "first_seen" | "source_memory_ids">;

export interface KGStoreConfig {
  /** Reuse the same LanceDB connection path as MemoryStore */
  dbPath: string;
}

export interface NeighborhoodResult {
  entity: string;
  triples: KGTriple[];
  /** How many hops from the seed entity */
  hops: number;
}

// ============================================================================
// Helpers
// ============================================================================

const KG_TABLE_NAME = "kg_triples";

/** Deterministic triple ID for dedup */
export function tripleId(scope: string, subject: string, predicate: string, object: string): string {
  const raw = `${scope}\x00${subject}\x00${predicate}\x00${object}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Cap on the source_memory_ids list (row-bloat guard). mention_count itself is
 * NOT capped: once the list is full, a returning 201st+ source can no longer be
 * recognized and would double-count on re-extraction. Accepted error — a fact
 * mentioned by 200+ distinct memories is extreme head-of-distribution either way.
 */
const SOURCE_IDS_CAP = 200;

/** Parse the JSON source id list, falling back to the legacy single-id column. */
function parseSourceIds(raw: string | undefined | null, fallbackId?: string): string[] {
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string");
    } catch { /* malformed — fall back below */ }
  }
  return fallbackId ? [fallbackId] : [];
}

// ============================================================================
// KG Store
// ============================================================================

export class KGStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly config: KGStoreConfig) {}

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();
    const db = await lancedb.connect(this.config.dbPath);

    let table: LanceDB.Table;
    try {
      table = await db.openTable(KG_TABLE_NAME);
    } catch {
      // Table doesn't exist — create with schema entry then remove it
      const schemaEntry: KGTriple = {
        id: "__schema__",
        scope: "global",
        subject: "",
        predicate: "",
        object: "",
        confidence: 0,
        source_memory_id: "",
        source_text: "",
        timestamp: 0,
        mention_count: 0,
        first_seen: 0,
        source_memory_ids: "[]",
      };

      try {
        table = await db.createTable(KG_TABLE_NAME, [schemaEntry]);
        await table.delete('id = "__schema__"');
      } catch (createErr) {
        if (String(createErr).includes("already exists")) {
          table = await db.openTable(KG_TABLE_NAME);
        } else {
          throw createErr;
        }
      }
    }

    // Defensive migration for pre-mention-count tables. Production has never
    // created this table (KG mode was never enabled), so this only guards
    // stale dev/test databases. Best-effort: on failure we log and continue —
    // rowToTriple() still reads legacy rows via fallbacks.
    try {
      const schema = await table.schema();
      const fields = new Set(schema.fields.map((f) => f.name));
      const missing: Array<{ name: string; valueSql: string }> = [];
      if (!fields.has("mention_count")) missing.push({ name: "mention_count", valueSql: "1" });
      if (!fields.has("first_seen")) missing.push({ name: "first_seen", valueSql: `"timestamp"` });
      if (!fields.has("source_memory_ids")) {
        missing.push({ name: "source_memory_ids", valueSql: `concat('["', source_memory_id, '"]')` });
      }
      if (missing.length > 0) {
        await table.addColumns(missing);
      }
    } catch (err) {
      console.error(
        "[recallnest] KG schema migration check failed (legacy rows still readable via fallbacks):",
        err instanceof Error ? err.message : String(err),
      );
    }

    // Create FTS index on subject for entity lookup (optional)
    try {
      const indices = await table.listIndices();
      const hasSubjectFts = indices?.some(
        (idx: any) => idx.indexType === "FTS" && idx.columns?.includes("subject"),
      );
      if (!hasSubjectFts) {
        const lance = await loadLanceDB();
        await table.createIndex("subject", { config: (lance as any).Index.fts() });
      }
    } catch (err) {
      // FTS on subject is optional — BFS still works without it
      console.error("[recallnest] KG FTS index creation skipped:", err instanceof Error ? err.message : String(err));
    }

    this.db = db;
    this.table = table;
  }

  // --------------------------------------------------------------------------
  // Write
  // --------------------------------------------------------------------------

  async createTriple(triple: KGTripleInput): Promise<KGTriple> {
    const [result] = await this.createTriples([triple]);
    return result;
  }

  /**
   * Upsert triples with mention counting (Memori-style: a repeated fact does
   * not create a new row — its mention_count grows and timestamp refreshes).
   *
   * Counting semantics:
   * - mention_count = number of DISTINCT source memories that contributed the triple
   * - the same source memory re-contributing (e.g. memory re-edit) refreshes
   *   timestamp and confidence (max) but does NOT increment the count
   * - first_seen is preserved from the first extraction
   *
   * Concurrency: read-modify-write — two processes racing on the same triple id
   * may lose one count increment (accepted: the count is a best-effort signal).
   * Row loss is NOT possible: the final write is an atomic mergeInsert, the same
   * primitive the main memories table adopted in the 2026-07-02 surgery.
   */
  async createTriples(triples: KGTripleInput[]): Promise<KGTriple[]> {
    if (triples.length === 0) return [];
    await this.ensureInitialized();

    const now = Date.now();

    // 1. Aggregate within batch: same triple id → union of contributing sources
    const byId = new Map<string, { input: KGTripleInput; sources: string[]; confidence: number }>();
    for (const t of triples) {
      const id = tripleId(t.scope, t.subject, t.predicate, t.object);
      const agg = byId.get(id);
      if (agg) {
        if (!agg.sources.includes(t.source_memory_id)) agg.sources.push(t.source_memory_id);
        agg.confidence = Math.max(agg.confidence, t.confidence);
      } else {
        byId.set(id, { input: t, sources: [t.source_memory_id], confidence: t.confidence });
      }
    }

    // 2. Fetch existing rows for these ids
    const idList = [...byId.keys()].map((id) => `'${escapeSql(id)}'`).join(", ");
    const existingRows = await this.table!.query().where(`id IN (${idList})`).limit(byId.size).toArray();
    const existingById = new Map<string, KGTriple>(
      existingRows.map((r) => [r.id as string, rowToTriple(r)]),
    );

    // 3. Merge counts in memory
    const toWrite: KGTriple[] = [];
    for (const [id, agg] of byId) {
      const prev = existingById.get(id);
      if (prev) {
        const knownIds = parseSourceIds(prev.source_memory_ids, prev.source_memory_id);
        const knownSet = new Set(knownIds);
        let count = prev.mention_count;
        for (const s of agg.sources) {
          if (knownSet.has(s)) continue;
          count++;
          knownSet.add(s);
          if (knownIds.length < SOURCE_IDS_CAP) knownIds.push(s);
        }
        toWrite.push({
          ...prev,
          confidence: Math.max(prev.confidence, agg.confidence),
          timestamp: now,
          mention_count: count,
          source_memory_ids: JSON.stringify(knownIds),
        });
      } else {
        toWrite.push({
          ...agg.input,
          id,
          confidence: agg.confidence,
          source_memory_id: agg.sources[0],
          timestamp: now,
          mention_count: agg.sources.length,
          first_seen: now,
          source_memory_ids: JSON.stringify(agg.sources.slice(0, SOURCE_IDS_CAP)),
        });
      }
    }

    // 4. Atomic idempotent write
    await this.table!.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(toWrite);
    return toWrite;
  }

  // --------------------------------------------------------------------------
  // Read — Edge queries
  // --------------------------------------------------------------------------

  /** Get all triples where entity is the subject */
  async getOutgoingEdges(entity: string, scope?: string): Promise<KGTriple[]> {
    await this.ensureInitialized();

    let filter = `subject = '${escapeSql(entity)}'`;
    if (scope) filter += ` AND scope = '${escapeSql(scope)}'`;

    const rows = await this.table!.query().where(filter).limit(500).toArray();
    return rows.map(rowToTriple);
  }

  /** Get all triples where entity is the object */
  async getIncomingEdges(entity: string, scope?: string): Promise<KGTriple[]> {
    await this.ensureInitialized();

    let filter = `object = '${escapeSql(entity)}'`;
    if (scope) filter += ` AND scope = '${escapeSql(scope)}'`;

    const rows = await this.table!.query().where(filter).limit(500).toArray();
    return rows.map(rowToTriple);
  }

  /**
   * BFS neighborhood traversal up to `maxHops` hops.
   * Returns all triples reachable from the seed entity.
   */
  async getNeighborhood(
    seedEntities: string[],
    maxHops = 2,
    scope?: string,
  ): Promise<NeighborhoodResult[]> {
    await this.ensureInitialized();

    const visited = new Map<string, number>(); // entity -> min hops
    const allTriples: KGTriple[] = [];
    let frontier = [...seedEntities];

    for (const seed of seedEntities) {
      visited.set(seed, 0);
    }

    for (let hop = 1; hop <= maxHops; hop++) {
      if (frontier.length === 0) break;

      const nextFrontier: string[] = [];

      for (const entity of frontier) {
        const [outgoing, incoming] = await Promise.all([
          this.getOutgoingEdges(entity, scope),
          this.getIncomingEdges(entity, scope),
        ]);

        for (const t of [...outgoing, ...incoming]) {
          allTriples.push(t);

          for (const neighbor of [t.subject, t.object]) {
            if (!visited.has(neighbor)) {
              visited.set(neighbor, hop);
              nextFrontier.push(neighbor);
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    // Group by entity
    const results: NeighborhoodResult[] = [];
    for (const [entity, hops] of visited) {
      const related = allTriples.filter(
        (t) => t.subject === entity || t.object === entity,
      );
      if (related.length > 0 || seedEntities.includes(entity)) {
        results.push({ entity, triples: related, hops });
      }
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // Read — Entity listing
  // --------------------------------------------------------------------------

  /** Get all unique entities in scope */
  async getAllEntities(scope?: string): Promise<string[]> {
    await this.ensureInitialized();

    const filter = scope ? `scope = '${escapeSql(scope)}'` : "1=1";
    const rows = await this.table!.query()
      .select(["subject", "object"])
      .where(filter)
      .limit(10000)
      .toArray();

    const entities = new Set<string>();
    for (const row of rows) {
      if (row.subject) entities.add(row.subject as string);
      if (row.object) entities.add(row.object as string);
    }
    return [...entities];
  }

  /** Check if an entity exists in the KG */
  async hasEntity(entity: string, scope?: string): Promise<boolean> {
    await this.ensureInitialized();

    const safeEntity = escapeSql(entity);
    let filter = `subject = '${safeEntity}' OR object = '${safeEntity}'`;
    if (scope) filter = `(${filter}) AND scope = '${escapeSql(scope)}'`;

    const rows = await this.table!.query().where(filter).limit(1).toArray();
    return rows.length > 0;
  }

  // --------------------------------------------------------------------------
  // Delete
  // --------------------------------------------------------------------------

  /**
   * Remove a source memory's contribution from the KG (forget path).
   *
   * Multi-source semantics: a triple evidenced by OTHER memories survives with
   * its count decremented — forgetting one memory must not erase a fact that
   * other memories still prove. Only when the last evidence is removed does the
   * row get deleted. If the forgotten memory supplied the stored source_text
   * snippet, the snippet is cleared (no forgotten-content residue).
   */
  async deleteBySource(sourceMemoryId: string): Promise<void> {
    await this.ensureInitialized();
    const safe = escapeSql(sourceMemoryId);

    // LIKE on the JSON array is an exact match thanks to the quotes:
    // '%"mem-1"%' never matches "mem-12". source_memory_id covers legacy rows.
    const rows = await this.table!.query()
      .where(`source_memory_id = '${safe}' OR source_memory_ids LIKE '%"${safe}"%'`)
      .limit(100000)
      .toArray();
    if (rows.length === 0) return;

    const toDelete: string[] = [];
    const toUpdate: KGTriple[] = [];
    for (const row of rows) {
      const t = rowToTriple(row);
      const ids = parseSourceIds(t.source_memory_ids, t.source_memory_id);
      if (!ids.includes(sourceMemoryId)) continue; // LIKE prefilter false positive — exact check in JS
      const remaining = ids.filter((s) => s !== sourceMemoryId);
      if (remaining.length === 0) {
        toDelete.push(t.id);
      } else {
        toUpdate.push({
          ...t,
          // count never drops below the remaining evidence count (cap-era divergence guard)
          mention_count: Math.max(t.mention_count - 1, remaining.length),
          source_memory_id: remaining[0],
          source_memory_ids: JSON.stringify(remaining),
          source_text: t.source_memory_id === sourceMemoryId ? "" : t.source_text,
        });
      }
    }

    if (toUpdate.length > 0) {
      await this.table!.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(toUpdate);
    }
    if (toDelete.length > 0) {
      const idList = toDelete.map((id) => `'${escapeSql(id)}'`).join(", ");
      await this.table!.delete(`id IN (${idList})`);
    }
  }

  /** Delete all triples in scope */
  async deleteByScope(scope: string): Promise<void> {
    await this.ensureInitialized();
    await this.table!.delete(`scope = '${escapeSql(scope)}'`);
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  async countTriples(scope?: string): Promise<number> {
    await this.ensureInitialized();
    const filter = scope ? `scope = '${escapeSql(scope)}'` : "1=1";
    const rows = await this.table!.query().where(filter).select(["id"]).limit(100000).toArray();
    return rows.length;
  }
}

// ============================================================================
// Row mapping
// ============================================================================

function rowToTriple(row: Record<string, unknown>): KGTriple {
  const sourceMemoryId = row.source_memory_id as string;
  return {
    id: row.id as string,
    scope: (row.scope as string) ?? "global",
    subject: row.subject as string,
    predicate: row.predicate as string,
    object: row.object as string,
    confidence: Number(row.confidence),
    source_memory_id: sourceMemoryId,
    source_text: row.source_text as string,
    timestamp: Number(row.timestamp),
    // Legacy-row fallbacks (pre-mention-count schema)
    mention_count: row.mention_count != null ? Number(row.mention_count) : 1,
    first_seen: row.first_seen != null ? Number(row.first_seen) : Number(row.timestamp),
    source_memory_ids:
      typeof row.source_memory_ids === "string" && row.source_memory_ids.length > 0
        ? row.source_memory_ids
        : JSON.stringify(sourceMemoryId ? [sourceMemoryId] : []),
  };
}
