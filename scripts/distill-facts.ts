#!/usr/bin/env bun
/**
 * Bulk distillation: Convert raw "fact" conversation fragments into
 * structured knowledge using smartExtractBatch().
 *
 * Usage:
 *   bun scripts/distill-facts.ts --dry-run          # Process 1 session, print results
 *   bun scripts/distill-facts.ts                     # Batch all sessions with checkpoint
 *   bun scripts/distill-facts.ts --scope cc:09541b9c # Process specific session only
 */

import path from "path";
import fs from "fs";
import { loadConfig, createComponents } from "../src/runtime-config.js";
import { dedupCheck } from "../src/ingest.js";
import { buildDistillationBoundary } from "../src/memory-boundaries.js";
import type { MemoryEntry } from "../src/store.js";
import type { SmartExtraction, LLMClient } from "../src/llm-client.js";
import type { MemoryStore } from "../src/store.js";
import type { Embedder } from "../src/embedder.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 20;
const PROGRESS_FILE = path.join(import.meta.dir, "..", "data", "distill-progress.json");

interface DistillProgress {
  startedAt: string;
  lastUpdated: string;
  completedScopes: string[];
  stats: {
    totalFacts: number;
    processedFacts: number;
    newRecords: number;
    dedupedSkips: number;
    errors: number;
  };
}

function loadProgress(): DistillProgress | null {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveProgress(progress: DistillProgress): void {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ─── Core Logic ─────────────────────────────────────────────────────────────

async function distillBatch(
  texts: string[],
  originals: MemoryEntry[],
  store: MemoryStore,
  embedder: Embedder,
  llm: LLMClient,
  dryRun = false,
): Promise<{ newCount: number; dedupCount: number; errors: number }> {
  let newCount = 0;
  let dedupCount = 0;
  let errors = 0;

  // Step 1: Extract knowledge via LLM
  // smartExtractBatch returns (SmartExtraction | null)[] with same length as input
  let rawExtractions: (SmartExtraction | null)[];
  try {
    rawExtractions = await llm.smartExtractBatch(texts);
  } catch (e) {
    console.error(`    LLM extraction failed: ${e}`);
    return { newCount: 0, dedupCount: 0, errors: texts.length };
  }

  const validIndices: number[] = [];
  for (let i = 0; i < rawExtractions.length; i++) {
    const ext = rawExtractions[i];
    if (ext && (ext.l0.length > 10 || ext.l1.length > 10)) {
      validIndices.push(i);
    }
  }

  if (validIndices.length === 0) {
    return { newCount: 0, dedupCount: texts.length, errors: 0 };
  }

  // Step 3: Generate embeddings
  const textsToEmbed = validIndices.map(i => {
    const ext = rawExtractions[i]!;
    return ext.l1 || ext.l0;
  });

  let vectors: number[][];
  try {
    vectors = await embedder.embedBatchPassage(textsToEmbed);
  } catch (e) {
    console.error(`    Embedding failed: ${e}`);
    return { newCount: 0, dedupCount: 0, errors: validIndices.length };
  }

  // Step 4: Dedup + store each extracted record
  const idMapping = new Map<number, string>();
  for (let vi = 0; vi < validIndices.length; vi++) {
    const idx = validIndices[vi];
    const extraction = rawExtractions[idx]!;
    const vector = vectors[vi];
    const original = originals[idx];

    // Dedup against existing non-fact records
    const dedup = await dedupCheck(store, vector, extraction.l0, llm);
    if (dedup.action === "skip") {
      dedupCount++;
      continue;
    }

    if (dryRun) {
      console.log(`\n    [${extraction.category}] importance=${extraction.importance}`);
      console.log(`       src: ${original.text.slice(0, 80)}...`);
      console.log(`       L0: ${extraction.l0}`);
      console.log(`       L1: ${(extraction.l1 || "").slice(0, 120)}`);
      newCount++;
      continue;
    }

    // Build new record
    const boundary = buildDistillationBoundary(extraction.category as any);
    const metadata = JSON.stringify({
      source: "distillation",
      distilledFrom: original.id,
      originalScope: original.scope,
      l0: extraction.l0,
      l1: extraction.l1,
      tier: extraction.importance >= 0.8 ? "working" : "peripheral",
      boundary,
    });

    try {
      const entry = await store.store({
        text: extraction.l1 || extraction.l0,
        vector,
        category: extraction.category as any,
        scope: original.scope,
        importance: extraction.importance,
        metadata,
      });
      idMapping.set(idx, entry.id);
      newCount++;
    } catch (e) {
      console.error(`    Store failed: ${e}`);
      errors++;
    }
  }

  // Step 5: Archive originals (skip in dry-run)
  if (dryRun) return { newCount, dedupCount, errors };
  for (let vi = 0; vi < validIndices.length; vi++) {
    const idx = validIndices[vi];
    const original = originals[idx];
    const distilledId = idMapping.get(idx);
    if (!distilledId) continue; // Was deduped or failed
    try {
      const existingMeta = original.metadata ? JSON.parse(original.metadata) : {};
      const updatedMeta = JSON.stringify({
        ...existingMeta,
        archived: true,
        archivedAt: new Date().toISOString(),
        distilledTo: [distilledId],
        originalCategory: "fact",
      });
      await store.update(original.id, { metadata: updatedMeta });
    } catch (e) {
      console.error(`    Archive mark failed for ${original.id}: ${e}`);
    }
  }

  return { newCount, dedupCount, errors };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const scopeIdx = args.indexOf("--scope");
  const scopeArg = args.find(a => a.startsWith("--scope="))?.split("=")[1]
    || (scopeIdx >= 0 ? args[scopeIdx + 1] : undefined);

  const config = loadConfig();
  const { store, embedder, llm } = createComponents(config);

  if (!llm) {
    console.error("LLM not configured. Check config.json llm section.");
    process.exit(1);
  }

  const llmTest = await llm.test();
  if (!llmTest.success) {
    console.error(`LLM connection failed: ${llmTest.error}`);
    process.exit(1);
  }
  console.log(`LLM: ${config.llm?.model}`);

  // Fetch all fact records
  console.log("\nReading fact records...");
  const allFacts: MemoryEntry[] = await store.list(undefined, "fact", 50000, 0);
  console.log(`Total: ${allFacts.length} fact records\n`);

  // Filter out already-archived facts
  const unarchived = allFacts.filter(f => {
    if (!f.metadata) return true;
    try { return !JSON.parse(f.metadata).archived; } catch { return true; }
  });
  console.log(`Unarchived: ${unarchived.length} (already archived: ${allFacts.length - unarchived.length})\n`);

  // Group by scope
  const byScope = new Map<string, MemoryEntry[]>();
  for (const f of unarchived) {
    const arr = byScope.get(f.scope) || [];
    arr.push(f);
    byScope.set(f.scope, arr);
  }
  const scopes = [...byScope.keys()].sort((a, b) => byScope.get(b)!.length - byScope.get(a)!.length);
  console.log(`${scopes.length} scopes\n`);

  // Load or create progress
  let progress = loadProgress();
  if (!progress) {
    progress = {
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      completedScopes: [],
      stats: { totalFacts: unarchived.length, processedFacts: 0, newRecords: 0, dedupedSkips: 0, errors: 0 },
    };
  }

  // Filter scopes
  let targetScopes = scopes;
  if (scopeArg) {
    targetScopes = scopes.filter(s => s === scopeArg);
    if (targetScopes.length === 0) {
      console.error(`Scope "${scopeArg}" not found`);
      process.exit(1);
    }
  }
  if (dryRun) {
    targetScopes = [targetScopes[0]];
    console.log(`DRY RUN: processing scope "${targetScopes[0]}" (${byScope.get(targetScopes[0])!.length} records)\n`);
  }

  // Process scopes
  for (const scope of targetScopes) {
    if (progress.completedScopes.includes(scope)) {
      console.log(`SKIP ${scope}: already processed`);
      continue;
    }

    const facts = byScope.get(scope)!;
    console.log(`\n${scope}: ${facts.length} facts`);

    let scopeNew = 0, scopeDedup = 0, scopeErrors = 0;
    for (let i = 0; i < facts.length; i += BATCH_SIZE) {
      const batch = facts.slice(i, i + BATCH_SIZE);
      const texts = batch.map(f => f.text);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(facts.length / BATCH_SIZE);

      process.stdout.write(`  batch ${batchNum}/${totalBatches}...`);
      const result = await distillBatch(texts, batch, store, embedder, llm, dryRun);

      scopeNew += result.newCount;
      scopeDedup += result.dedupCount;
      scopeErrors += result.errors;
      console.log(` +${result.newCount} new, ${result.dedupCount} dedup, ${result.errors} err`);
    }

    console.log(`  Done: +${scopeNew} new, ${scopeDedup} dedup, ${scopeErrors} errors`);

    // Update progress
    progress.completedScopes.push(scope);
    progress.stats.processedFacts += facts.length;
    progress.stats.newRecords += scopeNew;
    progress.stats.dedupedSkips += scopeDedup;
    progress.stats.errors += scopeErrors;
    progress.lastUpdated = new Date().toISOString();

    if (!dryRun) {
      saveProgress(progress);
    }
  }

  // Final summary
  console.log("\n" + "=".repeat(60));
  console.log("Distillation summary:");
  console.log(`  Total facts: ${progress.stats.totalFacts}`);
  console.log(`  Processed: ${progress.stats.processedFacts}`);
  console.log(`  New knowledge: ${progress.stats.newRecords}`);
  console.log(`  Dedup skipped: ${progress.stats.dedupedSkips}`);
  console.log(`  Errors: ${progress.stats.errors}`);
  console.log(`  Compression: ${(progress.stats.processedFacts / Math.max(progress.stats.newRecords, 1)).toFixed(1)}:1`);
  if (dryRun) {
    console.log("\nDRY RUN — no data was written. Remove --dry-run to run for real.");
  }
}

main().catch(console.error);
