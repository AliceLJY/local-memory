/**
 * Remove duplicate-id rows from the memories table, keeping one row per id.
 *
 * Background: the legacy delete+add upsert (replaced by atomic mergeInsert,
 * see store.ts) could crash between steps and leave the same id stored
 * multiple times. A 2026-06 survey found 2165 affected ids / 4397 rows —
 * every group textually identical (LoCoMo benchmark re-ingestion from
 * 2026-03-28), so dedupe-keep-one is unambiguous. The current mergeInsert
 * write path cannot produce new duplicates.
 *
 * Strategy (journal first, then delete, then re-add):
 *   1. find all ids with >1 row, dump EVERY affected row to a JSONL journal
 *   2. per id pick the keeper (earliest timestamp = original write)
 *   3. batch-delete all rows for those ids, then add the keepers back
 *   A crash between 3's delete and add is recoverable from the journal.
 *
 * Usage (repo root):
 *   bun scripts/cleanup-duplicate-ids.ts --dry-run
 *   bun scripts/cleanup-duplicate-ids.ts
 */
import * as lancedb from "@lancedb/lancedb";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolveDbPath } from "../src/runtime-config.js";

const DRY_RUN = process.argv.includes("--dry-run");
const DELETE_BATCH = 200;

const db = await lancedb.connect(resolveDbPath());
const table = await db.openTable("memories");
const before = await table.countRows();
console.log(`[dedup] rows before: ${before}`);

// Full rows (vector included) — needed to re-add keepers verbatim
const rows = await table.query().limit(before + 1000).toArray();
const byId = new Map<string, any[]>();
for (const r of rows) {
  const list = byId.get(r.id as string) ?? [];
  list.push(r);
  byId.set(r.id as string, list);
}
const dupGroups = [...byId.entries()].filter(([, v]) => v.length > 1);
const extraRows = dupGroups.reduce((s, [, v]) => s + v.length - 1, 0);
console.log(`[dedup] duplicate ids: ${dupGroups.length} | extra rows to remove: ${extraRows}`);

if (dupGroups.length === 0) {
  console.log("[dedup] nothing to do");
  process.exit(0);
}

const plainRow = (r: any) => ({
  ...r,
  vector: Array.from((r.vector ?? []) as Iterable<number>),
});

const keepers: any[] = [];
for (const [, group] of dupGroups) {
  const sorted = [...group].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  keepers.push(plainRow(sorted[0]));
}

if (DRY_RUN) {
  console.log("[dry-run] sample keeper decisions:");
  for (const [id, group] of dupGroups.slice(0, 3)) {
    console.log(`  id=${id}: ${group.length} rows → keep earliest ts=${group.map((g: any) => Number(g.timestamp)).sort()[0]}`);
  }
  console.log(`[dry-run] would delete rows for ${dupGroups.length} ids and re-add ${keepers.length} keepers (net -${extraRows})`);
  process.exit(0);
}

// 1. Journal every affected row before touching anything
mkdirSync("data/dedup-journals", { recursive: true });
const journal = `data/dedup-journals/dedup-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
for (const [, group] of dupGroups) {
  for (const r of group) appendFileSync(journal, JSON.stringify(plainRow(r)) + "\n");
}
console.log(`[dedup] journal written: ${journal} (${dupGroups.length} groups)`);

// 2. Delete all rows for affected ids, in batches
const ids = dupGroups.map(([id]) => id);
for (let i = 0; i < ids.length; i += DELETE_BATCH) {
  const batch = ids.slice(i, i + DELETE_BATCH);
  const inList = batch.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(",");
  await table.delete(`id IN (${inList})`);
}
console.log(`[dedup] deleted all rows for ${ids.length} ids`);

// 3. Re-add one keeper per id
for (let i = 0; i < keepers.length; i += DELETE_BATCH) {
  await table.add(keepers.slice(i, i + DELETE_BATCH));
}
console.log(`[dedup] re-added ${keepers.length} keepers`);

const after = await table.countRows();
console.log(`[dedup] rows after: ${after} (expected ${before - extraRows})`);

// Re-verify no duplicates remain
const check = await table.query().select(["id"]).limit(after + 1000).toArray();
const seen = new Set<string>();
let stillDup = 0;
for (const r of check) {
  if (seen.has(r.id as string)) stillDup++;
  seen.add(r.id as string);
}
console.log(`[dedup] remaining duplicate rows: ${stillDup}`);

console.log("[dedup] optimizing table...");
await table.optimize();
console.log(stillDup === 0 && after === before - extraRows ? "[dedup] DONE ✓" : "[dedup] DONE WITH CONCERNS — check counts above");
