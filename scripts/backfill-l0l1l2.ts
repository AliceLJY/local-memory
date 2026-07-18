#!/usr/bin/env bun
/**
 * One-time backfill: normalize legacy l0/l1 short names to l0_abstract/l1_overview/l2_content
 * in metadata. Uses batch read + batch write for performance.
 *
 * Usage:
 *   bun scripts/backfill-l0l1l2.ts --dry-run   # preview
 *   bun scripts/backfill-l0l1l2.ts              # execute
 */

import { loadDotEnv, loadConfig, resolveDbPath } from "../src/runtime-config.js";
import { loadLanceDB } from "../src/store.js";

loadDotEnv();
const config = loadConfig();
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const lancedb = await loadLanceDB();
  const dbPath = resolveDbPath(config);
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable("memories");

  console.log(`=== L0/L1/L2 metadata backfill${dryRun ? " (dry run)" : ""} ===\n`);

  // Read all rows with metadata
  const allRows = await table.query()
    .select(["id", "text", "vector", "category", "scope", "importance", "timestamp", "metadata"])
    .toArray();

  console.log(`  Total entries: ${allRows.length}`);

  const toMigrate: any[] = [];

  for (const row of allRows) {
    const metaStr = row.metadata as string;
    if (!metaStr) continue;

    let meta: Record<string, unknown>;
    try { meta = JSON.parse(metaStr); } catch { continue; }

    const hasShortL0 = typeof meta.l0 === "string" && (meta.l0 as string).length > 0;
    const hasShortL1 = typeof meta.l1 === "string" && (meta.l1 as string).length > 0;
    const hasLongL0 = typeof meta.l0_abstract === "string";
    const hasLongL1 = typeof meta.l1_overview === "string";

    if (!hasShortL0 && !hasShortL1) continue;
    if (hasLongL0 && hasLongL1) continue;

    // Migrate field names
    if (hasShortL0 && !hasLongL0) meta.l0_abstract = meta.l0;
    if (hasShortL1 && !hasLongL1) meta.l1_overview = meta.l1;
    if (!meta.l2_content && row.text) meta.l2_content = row.text;
    delete meta.l0;
    delete meta.l1;

    toMigrate.push({
      id: row.id,
      text: row.text,
      vector: Array.from(row.vector as Iterable<number>),
      category: row.category,
      scope: row.scope ?? "",
      importance: Number(row.importance),
      timestamp: Number(row.timestamp),
      metadata: JSON.stringify(meta),
    });
  }

  console.log(`  Need migration: ${toMigrate.length}`);
  console.log(`  Skipped: ${allRows.length - toMigrate.length}`);

  if (dryRun) {
    console.log(`\n  (dry run — no changes made)`);
    return;
  }

  if (toMigrate.length === 0) {
    console.log(`\n  Nothing to do.`);
    return;
  }

  // Batch delete + batch add
  const batchSize = 1000;
  for (let i = 0; i < toMigrate.length; i += batchSize) {
    const batch = toMigrate.slice(i, i + batchSize);
    const ids = batch.map((r: any) => `'${r.id.replace(/'/g, "''")}'`).join(",");
    await table.delete(`id IN (${ids})`);
    await table.add(batch);
    console.log(`  Batch ${Math.floor(i / batchSize) + 1}: migrated ${batch.length} entries`);
  }

  console.log(`\nDone. Migrated ${toMigrate.length} entries.`);
}

main().catch(err => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
