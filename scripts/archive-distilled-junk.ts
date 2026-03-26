#!/usr/bin/env bun
/**
 * Archive raw fact fragments that have already been distilled.
 * Targets: entries in distill-completed scopes with importance < 0.4, no L0, category=fact.
 * Action: set tier="archived", importance=0.05 — they won't surface but data isn't lost.
 *
 * Usage:
 *   bun scripts/archive-distilled-junk.ts --dry-run   # preview
 *   bun scripts/archive-distilled-junk.ts              # execute
 */

import fs from "fs";
import path from "path";
import { loadDotEnv, loadConfig, expandHome } from "../src/runtime-config.js";
import { loadLanceDB } from "../src/store.js";

loadDotEnv();
const config = loadConfig();
const dryRun = process.argv.includes("--dry-run");

const PROGRESS_FILE = path.join(import.meta.dir, "..", "data", "distill-progress.json");

async function main() {
  // Load distill progress to know which scopes are done
  const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
  const completedScopes = new Set<string>(progress.completedScopes);
  console.log(`=== Archive distilled junk${dryRun ? " (dry run)" : ""} ===\n`);
  console.log(`  Distill-completed scopes: ${completedScopes.size}`);

  const lancedb = await loadLanceDB();
  const dbPath = expandHome(config.database?.path || "data/lancedb");
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable("memories");

  // Read all fact entries
  const allFacts = await table.query()
    .where("category = 'fact'")
    .select(["id", "text", "vector", "category", "scope", "importance", "timestamp", "metadata"])
    .toArray();

  console.log(`  Total fact entries: ${allFacts.length}`);

  // Filter: in completed scope, importance < 0.4, no L0
  const toArchive: any[] = [];
  const sampleJunk: string[] = [];

  for (const row of allFacts) {
    const scope = (row.scope as string) || "";
    if (!completedScopes.has(scope)) continue;

    const imp = Number(row.importance);
    if (imp >= 0.4) continue;

    const metaStr = (row.metadata as string) || "{}";
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(metaStr); } catch { continue; }

    // Has L0 = already a quality entry, skip
    if (typeof meta.l0_abstract === "string" && meta.l0_abstract.length > 0) continue;

    // Mark as archived
    meta.tier = "archived";
    meta.archived_reason = "distilled-junk-cleanup-2026-03-26";

    toArchive.push({
      id: row.id,
      text: row.text,
      vector: Array.from(row.vector as Iterable<number>),
      category: row.category,
      scope: scope,
      importance: 0.05, // near-zero so it never surfaces
      timestamp: Number(row.timestamp),
      metadata: JSON.stringify(meta),
    });

    // Collect samples
    if (sampleJunk.length < 10) {
      const text = (row.text as string).slice(0, 80);
      sampleJunk.push(`  ${(row.id as string).slice(0, 8)} imp=${imp.toFixed(2)} scope=${scope.slice(0, 15)} | ${text}`);
    }
  }

  console.log(`  Junk to archive: ${toArchive.length}`);
  console.log(`  Would keep: ${allFacts.length - toArchive.length} fact entries\n`);

  if (sampleJunk.length > 0) {
    console.log(`  Sample junk:\n${sampleJunk.join("\n")}\n`);
  }

  if (dryRun) {
    console.log(`  (dry run — no changes made)`);
    return;
  }

  if (toArchive.length === 0) {
    console.log(`  Nothing to archive.`);
    return;
  }

  // Batch update
  const batchSize = 1000;
  for (let i = 0; i < toArchive.length; i += batchSize) {
    const batch = toArchive.slice(i, i + batchSize);
    const ids = batch.map((r: any) => `'${r.id.replace(/'/g, "''")}'`).join(",");
    await table.delete(`id IN (${ids})`);
    await table.add(batch);
    console.log(`  Batch ${Math.floor(i / batchSize) + 1}: archived ${batch.length} entries`);
  }

  console.log(`\nDone. Archived ${toArchive.length} junk fact entries (importance → 0.05, tier → archived).`);
}

main().catch(err => {
  console.error("Archive failed:", err);
  process.exit(1);
});
