#!/usr/bin/env bun
/**
 * Delete raw fact fragments that have already been distilled.
 * Targets: entries in distill-completed scopes with importance < 0.4, no L0, category=fact.
 * Safe: distilled replacements already exist; transcript originals are in ~/.claude/projects.
 *
 * Usage:
 *   bun scripts/delete-distilled-junk.ts --dry-run   # preview
 *   bun scripts/delete-distilled-junk.ts              # execute
 */

import fs from "fs";
import path from "path";
import { loadDotEnv, loadConfig, resolveDbPath } from "../src/runtime-config.js";
import { loadLanceDB } from "../src/store.js";

loadDotEnv();
const config = loadConfig();
const dryRun = process.argv.includes("--dry-run");

const PROGRESS_FILE = path.join(import.meta.dir, "..", "data", "distill-progress.json");

async function main() {
  const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
  const completedScopes = new Set<string>(progress.completedScopes);
  console.log(`=== Delete distilled junk${dryRun ? " (dry run)" : ""} ===\n`);
  console.log(`  Distill-completed scopes: ${completedScopes.size}`);

  const lancedb = await loadLanceDB();
  const dbPath = resolveDbPath(config);
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable("memories");

  // Read all fact entries (only need id, scope, importance, metadata — skip vector for speed)
  const allFacts = await table.query()
    .where("category = 'fact'")
    .select(["id", "scope", "importance", "metadata"])
    .toArray();

  console.log(`  Total fact entries: ${allFacts.length}`);

  const toDelete: string[] = [];

  for (const row of allFacts) {
    const scope = (row.scope as string) || "";
    if (!completedScopes.has(scope)) continue;

    const imp = Number(row.importance);
    if (imp >= 0.4) continue;

    const metaStr = (row.metadata as string) || "{}";
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(metaStr); } catch { continue; }

    if (typeof meta.l0_abstract === "string" && meta.l0_abstract.length > 0) continue;

    toDelete.push(row.id as string);
  }

  console.log(`  Junk to delete: ${toDelete.length}`);
  console.log(`  Would keep: ${allFacts.length - toDelete.length} fact entries\n`);

  if (dryRun) {
    console.log(`  (dry run — no changes made)`);
    return;
  }

  if (toDelete.length === 0) {
    console.log(`  Nothing to delete.`);
    return;
  }

  // Batch delete — no need to re-add
  const batchSize = 2000;
  for (let i = 0; i < toDelete.length; i += batchSize) {
    const batch = toDelete.slice(i, i + batchSize);
    const ids = batch.map(id => `'${id.replace(/'/g, "''")}'`).join(",");
    await table.delete(`id IN (${ids})`);
    console.log(`  Batch ${Math.floor(i / batchSize) + 1}: deleted ${batch.length} entries`);
  }

  console.log(`\nDone. Deleted ${toDelete.length} junk fact entries. Freed ~${Math.round(toDelete.length * 6 / 1024)} MB (est).`);
}

main().catch(err => {
  console.error("Delete failed:", err);
  process.exit(1);
});
