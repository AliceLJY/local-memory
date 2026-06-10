/**
 * Rebuild fts_text (+language) for every row in the memories table using
 * the currently-installed babel-memory tokenizer.
 *
 * Why this exists: babel-memory 2.0.0's published dist hardcoded the build
 * machine's paths (babel-memory#1), so on every other machine jieba never
 * loaded and Chinese fts_text was stored raw/character-level. 2.1.0 queries
 * produce word-level tokens (+bigrams) — old index and new queries share
 * almost no tokens, so Chinese BM25 recall on old rows collapses until the
 * fts_text column is rebuilt. Run this after any tokenizer upgrade that
 * changes segmentation output (see babel-memory CHANGELOG "Migration").
 *
 * Usage (from the repo root, where data/lancedb lives):
 *   bun scripts/reindex-fts.ts --verify-merge   # prove partial mergeInsert
 *                                               # preserves unspecified columns
 *   bun scripts/reindex-fts.ts --dry-run        # count + sample, no writes
 *   bun scripts/reindex-fts.ts                  # do it
 *
 * Safety: take a filesystem backup of data/lancedb first. The write path is
 * the same atomic mergeInsert("id") the production store uses.
 */
import * as lancedb from "@lancedb/lancedb";
import { autoRegisterBabelMemory, detectLang, tokenizeFts } from "../src/language-hook.js";

const DRY_RUN = process.argv.includes("--dry-run");
const VERIFY_MERGE = process.argv.includes("--verify-merge");
const BATCH = 500;
const TEST_TABLE = "_reindex_merge_test";

function fail(msg: string): never {
  console.error(`[reindex] ABORT: ${msg}`);
  process.exit(1);
}

const ok = await autoRegisterBabelMemory();
if (!ok) fail("babel-memory not installed — reindexing with passthrough would be pointless");
const probe = tokenizeFts("机器学习在自然语言处理中的应用", "zh");
if (!probe.includes(" ")) fail(`tokenizer not segmenting (probe: ${probe})`);
console.log(`[reindex] tokenizer probe OK: ${probe}`);

const db = await lancedb.connect("data/lancedb");
const table = await db.openTable("memories");
const total = await table.countRows();
console.log(`[reindex] memories rows: ${total}`);

// ── Mode 1: prove partial-column mergeInsert preserves other columns ──
if (VERIFY_MERGE) {
  const existing = await db.tableNames();
  if (existing.includes(TEST_TABLE)) await db.dropTable(TEST_TABLE);

  const sample = await table.query().limit(50).toArray();
  if (sample.length === 0) fail("no rows to sample");
  // rows from toArray() carry Arrow vector objects that defeat schema
  // inference — rebuild plain rows and create the table with the source
  // table's explicit schema instead
  const clean = sample.map((r) => ({
    ...r,
    vector: Array.from((r.vector ?? []) as Iterable<number>),
  }));
  const schema = await table.schema();
  const test = await db.createEmptyTable(TEST_TABLE, schema);
  await test.add(clean);

  const half = clean.slice(0, 25).map((r) => ({
    id: r.id,
    fts_text: "VERIFY_TOKEN reindex test",
    language: "zz",
  }));
  await test
    .mergeInsert("id")
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(half);

  const after = await test.query().toArray();
  const touched = after.filter((r) => r.language === "zz");
  const untouched = after.filter((r) => r.language !== "zz");
  const vectorsIntact = touched.every(
    (r) => r.vector && (r.vector as Float32Array | number[]).length > 0
  );
  const textIntact = touched.every((r) => typeof r.text === "string" && r.text.length > 0);
  const othersUnchanged = untouched.length === clean.length - 25;

  console.log(`[verify-merge] touched rows: ${touched.length}/25`);
  console.log(`[verify-merge] vector preserved on touched rows: ${vectorsIntact}`);
  console.log(`[verify-merge] text preserved on touched rows: ${textIntact}`);
  console.log(`[verify-merge] untouched rows intact: ${othersUnchanged}`);
  await db.dropTable(TEST_TABLE);

  if (touched.length === 25 && vectorsIntact && textIntact && othersUnchanged) {
    console.log("[verify-merge] PASS — partial-column mergeInsert is safe here");
    process.exit(0);
  }
  fail("partial-column mergeInsert does NOT preserve unspecified columns — do not run the real reindex with this SDK version");
}

// ── Mode 2/3: dry-run or real reindex ─────────────────────────────────
// Read only the light columns (no vector): ~100K rows is tens of MB.
const rows = await table
  .query()
  .select(["id", "text", "language", "fts_text"])
  .limit(total + 1000)
  .toArray();
console.log(`[reindex] loaded ${rows.length} rows for scan`);

interface Patch {
  id: string;
  fts_text: string;
  language: string;
}
const patches: Patch[] = [];
let unchanged = 0;
let emptyText = 0;
for (const r of rows) {
  const text = (r.text as string) ?? "";
  if (!text) {
    emptyText++;
    continue;
  }
  const language = detectLang(text);
  const fts_text = tokenizeFts(text, language);
  if (fts_text === r.fts_text && language === r.language) {
    unchanged++;
    continue;
  }
  patches.push({ id: r.id as string, fts_text, language });
}
console.log(
  `[reindex] to update: ${patches.length} | already current: ${unchanged} | empty text: ${emptyText}`
);

if (DRY_RUN) {
  console.log("\n[dry-run] sample of changes:");
  for (const p of patches.slice(0, 5)) {
    const old = rows.find((r) => r.id === p.id);
    console.log(`  id=${p.id}`);
    console.log(`    old(${old?.language}): ${String(old?.fts_text).slice(0, 90)}`);
    console.log(`    new(${p.language}): ${p.fts_text.slice(0, 90)}`);
  }
  process.exit(0);
}

let written = 0;
const started = Date.now();
for (let i = 0; i < patches.length; i += BATCH) {
  const batch = patches.slice(i, i + BATCH);
  // matched-only on purpose: a row deleted concurrently (dream/supersede)
  // must be skipped, not re-inserted as a 3-column stub with a null vector
  await table
    .mergeInsert("id")
    .whenMatchedUpdateAll()
    .execute(batch);
  written += batch.length;
  if ((i / BATCH) % 20 === 0 || written === patches.length) {
    const pct = ((written / patches.length) * 100).toFixed(1);
    console.log(`[reindex] ${written}/${patches.length} (${pct}%)`);
  }
}
console.log(`[reindex] writes done in ${((Date.now() - started) / 1000).toFixed(0)}s`);

console.log("[reindex] optimizing table (compaction + index refresh)...");
await table.optimize();
console.log("[reindex] DONE");
