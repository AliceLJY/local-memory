#!/usr/bin/env bun
/**
 * P0.1 backfill: generate retrieval anchors for existing memories that lack one.
 * Anchors are short (≤80 chars) text summaries stored in metadata.anchor,
 * used by the retriever to boost short query recall.
 *
 * Usage:
 *   bun scripts/backfill-anchors.ts --dry-run   # preview changes
 *   bun scripts/backfill-anchors.ts              # execute
 */

import { loadDotEnv, loadConfig, resolveDbPath } from "../src/runtime-config.js";
import { loadLanceDB } from "../src/store.js";
import { generateAnchor } from "../src/anchor-generator.js";

loadDotEnv();
const config = loadConfig();
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const lancedb = await loadLanceDB();
  const dbPath = resolveDbPath(config);
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable("memories");

  console.log(`=== Anchor backfill${dryRun ? " (dry run)" : ""} ===\n`);

  const allRows = await table.query()
    .select(["id", "text", "vector", "category", "scope", "importance", "timestamp", "metadata"])
    .toArray();

  console.log(`  Total entries: ${allRows.length}`);

  let skippedShort = 0;
  let skippedHasAnchor = 0;
  let generated = 0;
  const toUpdate: Array<{
    id: string;
    text: string;
    vector: number[];
    category: string;
    scope: string;
    importance: number;
    timestamp: number;
    metadata: string;
  }> = [];

  for (const row of allRows) {
    const text = row.text as string;
    const metaStr = row.metadata as string;

    let meta: Record<string, unknown>;
    try { meta = JSON.parse(metaStr || "{}"); } catch { meta = {}; }

    // Skip if already has anchor
    if (typeof meta.anchor === "string" && meta.anchor.length > 0) {
      skippedHasAnchor++;
      continue;
    }

    // Generate anchor
    const anchor = generateAnchor(text, meta);
    if (!anchor) {
      skippedShort++;
      continue;
    }

    meta.anchor = anchor;
    generated++;

    if (!dryRun) {
      toUpdate.push({
        id: row.id as string,
        text,
        vector: Array.from(row.vector as Iterable<number>),
        category: row.category as string,
        scope: row.scope as string,
        importance: row.importance as number,
        timestamp: row.timestamp as number,
        metadata: JSON.stringify(meta),
      });
    }

    if (generated <= 5) {
      console.log(`  [sample] id=${(row.id as string).slice(0, 8)}… anchor="${anchor}"`);
    }
  }

  console.log(`\n  Summary:`);
  console.log(`    Already has anchor: ${skippedHasAnchor}`);
  console.log(`    Text too short (≤80 chars): ${skippedShort}`);
  console.log(`    Anchors generated: ${generated}`);

  if (dryRun) {
    console.log(`\n  Dry run — no changes written. Run without --dry-run to apply.`);
    return;
  }

  if (toUpdate.length === 0) {
    console.log(`\n  Nothing to update.`);
    return;
  }

  // Deduplicate by ID (keep last occurrence — handles duplicate rows in source data)
  const deduped = new Map<string, (typeof toUpdate)[0]>();
  for (const entry of toUpdate) {
    deduped.set(entry.id, entry);
  }
  const uniqueUpdates = [...deduped.values()];
  if (uniqueUpdates.length < toUpdate.length) {
    console.log(`  Deduplicated: ${toUpdate.length} → ${uniqueUpdates.length} unique IDs`);
  }

  // Batch upsert (LanceDB mergeInsert with overwrite)
  console.log(`\n  Writing ${uniqueUpdates.length} updates...`);
  const BATCH = 200;
  for (let i = 0; i < uniqueUpdates.length; i += BATCH) {
    const batch = uniqueUpdates.slice(i, i + BATCH);
    await table.mergeInsert("id")
      .whenMatchedUpdateAll()
      .execute(batch);
    process.stdout.write(`  ${Math.min(i + BATCH, uniqueUpdates.length)}/${uniqueUpdates.length}\r`);
  }
  console.log(`\n  Done! ${uniqueUpdates.length} entries updated with anchors.`);
}

main().catch(err => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
