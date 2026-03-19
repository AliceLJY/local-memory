import lancedb from "@lancedb/lancedb";

import {
  buildMemoryHealthRebalancePlan,
  summarizeMemoryHealthPlans,
} from "../src/memory-health-rebalance.js";

const TABLE_NAME = "memories";
const DEFAULT_DB_PATH = "./data/lancedb";
const DEFAULT_BATCH_SIZE = 2000;

interface MemoryUpdateRow {
  id: string;
  text: string;
  vector: Iterable<number>;
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function formatPercent(count: number, total: number): string {
  if (total <= 0) return "0.0%";
  return `${((count / total) * 100).toFixed(1)}%`;
}

function parseArgs(argv: string[]): {
  dbPath: string;
  batchSize: number;
  apply: boolean;
  optimize: boolean;
} {
  const positional: string[] = [];
  let batchSize = DEFAULT_BATCH_SIZE;
  let apply = false;
  let optimize = true;

  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--skip-optimize") {
      optimize = false;
      continue;
    }
    if (arg.startsWith("--batch-size=")) {
      const value = Number(arg.slice("--batch-size=".length));
      if (Number.isFinite(value) && value > 0) {
        batchSize = Math.floor(value);
      }
      continue;
    }
    positional.push(arg);
  }

  return {
    dbPath: positional[0] || DEFAULT_DB_PATH,
    batchSize,
    apply,
    optimize,
  };
}

async function loadPlanningRows(table: Awaited<ReturnType<typeof lancedb.connect>> extends { openTable(name: string): infer T } ? Awaited<T> : never) {
  return await table
    .query()
    .select(["id", "importance", "timestamp", "metadata"])
    .toArray() as Array<{ id: string; importance: number; timestamp: number; metadata?: string }>;
}

async function loadBatchRows(
  table: Awaited<ReturnType<typeof lancedb.connect>> extends { openTable(name: string): infer T } ? Awaited<T> : never,
  ids: string[],
): Promise<MemoryUpdateRow[]> {
  const where = `id IN (${ids.map((id) => `'${escapeSqlLiteral(id)}'`).join(", ")})`;
  return await table
    .query()
    .where(where)
    .select(["id", "text", "vector", "category", "scope", "importance", "timestamp", "metadata"])
    .toArray() as MemoryUpdateRow[];
}

async function main() {
  const { dbPath, batchSize, apply, optimize } = parseArgs(process.argv.slice(2));

  console.log(`\n🛠️  Memory health rebalance`);
  console.log(`📂 DB path: ${dbPath}`);
  console.log(`📦 Batch size: ${batchSize}`);
  console.log(`🧪 Mode: ${apply ? "apply" : "dry-run"}\n`);

  const db = await lancedb.connect(dbPath);
  const table = await db.openTable(TABLE_NAME);

  console.log("⏳ Loading planning rows...");
  const planningRows = await loadPlanningRows(table);
  const accessCounts = planningRows.map((row) =>
    buildMemoryHealthRebalancePlan(row, {
      maxAccessCount: 1,
      minTimestamp: row.timestamp,
      maxTimestamp: row.timestamp,
    }).accessCount
  );
  const effectiveMaxAccessCount = Math.max(1, ...accessCounts);
  const minTimestamp = Math.min(...planningRows.map((row) => row.timestamp));
  const maxTimestamp = Math.max(...planningRows.map((row) => row.timestamp));
  const plans = planningRows.map((row) =>
    buildMemoryHealthRebalancePlan(row, {
      maxAccessCount: effectiveMaxAccessCount,
      minTimestamp,
      maxTimestamp,
    })
  );
  const summary = summarizeMemoryHealthPlans(plans);

  console.log(`✅ Planned ${summary.totalRows.toLocaleString()} rows`);
  console.log(`  dead memory rows   : ${summary.deadMemoryRows.toLocaleString()} (${formatPercent(summary.deadMemoryRows, summary.totalRows)})`);
  console.log(`  tier backfills     : ${summary.tierBackfills.toLocaleString()} (${formatPercent(summary.tierBackfills, summary.totalRows)})`);
  console.log(`  tier changes       : ${summary.tierChanges.toLocaleString()} (${formatPercent(summary.tierChanges, summary.totalRows)})`);
  console.log(`  importance changes : ${summary.importanceChanges.toLocaleString()} (${formatPercent(summary.importanceChanges, summary.totalRows)})`);
  console.log(`  rows to rewrite    : ${summary.changedRows.toLocaleString()} (${formatPercent(summary.changedRows, summary.totalRows)})`);

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply after backing up the LanceDB directory.");
    return;
  }

  const changedPlans = plans.filter((plan) => plan.changed);
  const planById = new Map(changedPlans.map((plan) => [plan.id, plan]));

  let processed = 0;
  for (let start = 0; start < changedPlans.length; start += batchSize) {
    const batchPlans = changedPlans.slice(start, start + batchSize);
    const ids = batchPlans.map((plan) => plan.id);
    const rows = await loadBatchRows(table, ids);
    const mergeRows = rows.map((row) => {
      const plan = planById.get(row.id);
      if (!plan) {
        throw new Error(`Missing plan for row ${row.id}`);
      }
      return {
        id: row.id,
        text: row.text,
        vector: Array.from(row.vector),
        category: row.category,
        scope: row.scope,
        importance: plan.nextImportance,
        timestamp: row.timestamp,
        metadata: JSON.stringify(plan.nextMetadata),
      };
    });

    await table
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .execute(mergeRows, { timeoutMs: 120_000 });

    processed += mergeRows.length;
    console.log(`  batch ${Math.floor(start / batchSize) + 1}/${Math.ceil(changedPlans.length / batchSize)}: ${processed.toLocaleString()}/${changedPlans.length.toLocaleString()} rows`);
  }

  if (optimize) {
    console.log("\n⏳ Optimizing Lance table after batched rewrites...");
    await table.optimize();
  }

  console.log("\n✅ Memory health rebalance complete");
  console.log(`  dead memory rows kept but downgraded: ${summary.deadMemoryRows.toLocaleString()}`);
  console.log(`  tier backfills applied             : ${summary.tierBackfills.toLocaleString()}`);
  console.log(`  importance updates applied         : ${summary.importanceChanges.toLocaleString()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
