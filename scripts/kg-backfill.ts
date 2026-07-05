#!/usr/bin/env bun
/**
 * KG backfill: extract semantic triples from existing memories into kg_triples.
 * Phase 0/1 of the Memori-inspired mention-count adoption (research 2026-07-05).
 *
 * Subset-first by design (Q2 decision): defaults to importance ≥ 0.8 so extraction
 * quality can be inspected before committing to a full backfill.
 *
 * Writes ONLY the kg_triples table — never touches the memories table.
 * Idempotent: processed memory ids are journaled; re-runs skip them (and the
 * store-level source_memory_ids check makes double-processing count-safe anyway).
 *
 * Usage:
 *   bun scripts/kg-backfill.ts --dry-run                    # preview candidates, zero LLM calls
 *   bun scripts/kg-backfill.ts                              # importance ≥ 0.8, ~2 QPS
 *   bun scripts/kg-backfill.ts --scope global --limit 100   # narrow trial
 *   bun scripts/kg-backfill.ts --min-importance 0.6 --rate 4
 */

import { mkdirSync, readdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { loadDotEnv, loadConfig, expandHome } from "../src/runtime-config.js";
import { loadLanceDB } from "../src/store.js";
import { KGStore } from "../src/kg-store.js";
import { KGExtractor } from "../src/kg-extractor.js";
import { createLLMClient } from "../src/llm-client.js";
import { isActiveMemory } from "../src/memory-evolution.js";
import { parsePrivacyTier } from "../src/memory-schema.js";

loadDotEnv();
const config = loadConfig();

// --- CLI args ---
function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const dryRun = process.argv.includes("--dry-run");
const minImportance = Number(argValue("--min-importance") ?? "0.8");
const scopeFilter = argValue("--scope");
const limit = Number(argValue("--limit") ?? "0"); // 0 = no limit
const rate = Number(argValue("--rate") ?? "2"); // GLOBAL LLM calls per second target
const concurrency = Number(argValue("--concurrency") ?? "1"); // parallel extraction workers

const JOURNAL_DIR = "data/kg-backfill-journals";

interface JournalLine {
  memoryId: string;
  scope: string;
  triplesStored: number;
  ts: string;
}

/** Memory ids already processed in any previous run (journal is the source of truth). */
function loadProcessedIds(journalDir: string): Set<string> {
  const processed = new Set<string>();
  if (!existsSync(journalDir)) return processed;
  for (const file of readdirSync(journalDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const lines = readFileSync(join(journalDir, file), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JournalLine;
        if (parsed.memoryId) processed.add(parsed.memoryId);
      } catch { /* skip malformed journal line */ }
    }
  }
  return processed;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const lancedb = await loadLanceDB();
  const dbPath = expandHome(config.database?.path || "data/lancedb");
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable("memories");

  console.log(`=== KG backfill${dryRun ? " (dry run)" : ""} ===`);
  console.log(`  db: ${dbPath}`);
  console.log(`  min importance: ${minImportance}${scopeFilter ? ` | scope: ${scopeFilter}` : ""}${limit > 0 ? ` | limit: ${limit}` : ""} | rate: ${rate}/s\n`);

  const processed = loadProcessedIds(JOURNAL_DIR);
  if (processed.size > 0) console.log(`  Journal: ${processed.size} memories already processed in prior runs`);

  const rows = await table.query()
    .select(["id", "text", "scope", "importance", "metadata"])
    .toArray();

  let skippedInactive = 0;
  let skippedPrivacy = 0;
  let skippedImportance = 0;
  let skippedScope = 0;
  let skippedShort = 0;
  let skippedProcessed = 0;

  const candidates: Array<{ id: string; text: string; scope: string; importance: number }> = [];
  for (const row of rows) {
    const id = row.id as string;
    const text = (row.text as string) ?? "";
    const scope = (row.scope as string) ?? "global";
    const importance = Number(row.importance ?? 0);
    const metadata = row.metadata as string | undefined;

    if (processed.has(id)) { skippedProcessed++; continue; }
    if (scopeFilter && scope !== scopeFilter) { skippedScope++; continue; }
    if (importance < minImportance) { skippedImportance++; continue; }
    if (!isActiveMemory(metadata)) { skippedInactive++; continue; }
    const tier = parsePrivacyTier(metadata);
    if (tier === "ephemeral" || tier === "private") { skippedPrivacy++; continue; } // same gate as capture path
    if (text.length < 10) { skippedShort++; continue; } // extractor's own floor
    candidates.push({ id, text, scope, importance });
  }

  // Most important memories first — the trial subset should be the head, not random
  candidates.sort((a, b) => b.importance - a.importance);
  const toProcess = limit > 0 ? candidates.slice(0, limit) : candidates;

  console.log(`  Total rows: ${rows.length}`);
  console.log(`  Skipped: ${skippedProcessed} processed | ${skippedScope} scope | ${skippedImportance} importance | ${skippedInactive} inactive | ${skippedPrivacy} privacy | ${skippedShort} short`);
  console.log(`  Candidates: ${candidates.length}${limit > 0 ? ` → processing ${toProcess.length}` : ""}\n`);

  if (dryRun) {
    for (const c of toProcess.slice(0, 10)) {
      console.log(`  [sample] ${c.id.slice(0, 8)}… imp=${c.importance} scope=${c.scope} "${c.text.slice(0, 60).replace(/\n/g, " ")}…"`);
    }
    console.log(`\n  Dry run — no LLM calls, nothing written. Estimated LLM calls: ${toProcess.length}`);
    return;
  }

  if (toProcess.length === 0) {
    console.log("  Nothing to process.");
    return;
  }

  const llm = createLLMClient();
  if (!llm) {
    console.error("  ERROR: LLM client unavailable (QWEN_API_KEY missing?) — cannot extract. Aborting.");
    process.exit(1);
  }
  const kgStore = new KGStore({ dbPath });
  const extractor = new KGExtractor({ llmClient: llm, kgStore });

  mkdirSync(JOURNAL_DIR, { recursive: true });
  const journalPath = join(JOURNAL_DIR, `kg-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  console.log(`  Journal: ${journalPath}\n`);

  let done = 0;
  let totalTriples = 0;
  let failures = 0;
  let aborted = false;
  // Throughput is LLM-latency-bound (~3s/call serial), so concurrency is the
  // real lever; the per-worker sleep keeps the GLOBAL rate ≈ --rate.
  const intervalMs = Math.max((1000 / rate) * concurrency, 50);
  const startedAt = Date.now();
  let cursor = 0;

  async function worker(startDelayMs: number): Promise<void> {
    // Stagger start so --rate holds from the first second (no initial burst)
    if (startDelayMs > 0) await sleep(startDelayMs);
    while (!aborted) {
      const idx = cursor++;
      if (idx >= toProcess.length) return;
      const c = toProcess[idx];
      try {
        const stored = await extractor.extractAndStore(c.text, c.id, c.scope);
        totalTriples += stored;
        const line: JournalLine = { memoryId: c.id, scope: c.scope, triplesStored: stored, ts: new Date().toISOString() };
        appendFileSync(journalPath, JSON.stringify(line) + "\n");
      } catch (err) {
        failures++;
        console.error(`  FAIL ${c.id.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
        if (failures >= 10 && failures > done * 0.5) {
          console.error("  Too many failures — aborting (journal preserves progress).");
          aborted = true;
          return;
        }
      }
      done++;
      if (done % 20 === 0 || done === toProcess.length) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        process.stdout.write(`  ${done}/${toProcess.length} memories | ${totalTriples} triples | ${failures} failures | ${elapsed}s\r`);
      }
      if (cursor < toProcess.length) await sleep(intervalMs);
    }
  }

  const workers = Math.max(1, concurrency);
  await Promise.all(Array.from({ length: workers }, (_, i) => worker((i * intervalMs) / workers)));
  if (aborted) process.exit(1);

  const kgCount = await kgStore.countTriples();
  console.log(`\n\n  Done. ${done} memories processed, ${totalTriples} triples stored (${failures} failures).`);
  console.log(`  kg_triples total: ${kgCount}`);
  console.log(`  Journal: ${journalPath}`);
}

main().catch((err) => {
  console.error("KG backfill failed:", err);
  process.exit(1);
});
