# RecallNest Ingest Pipeline Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert 23K raw conversation fragments into structured knowledge, then upgrade the ingest pipeline so new ingests always extract before storing.

**Architecture:** Route B (bulk distillation script) runs first to clean existing data, then Route A (pipeline default change) prevents future garbage. Both share `smartExtractBatch()` as the extraction engine with qwen-turbo LLM.

**Tech Stack:** Bun + TypeScript, LanceDB, Jina v5 embeddings, qwen-turbo (via OpenAI-compatible API)

**Spec:** `docs/superpowers/specs/2026-03-19-ingest-pipeline-upgrade-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/distill-facts.ts` | **Create** | Bulk distillation: dry-run + batch + checkpoint |
| `src/memory-boundaries.ts` | **Modify** | Add `"distillation"` authority |
| `src/retriever.ts` | **Modify** | Filter `archived` records from search |
| `src/ingest.ts` | **Modify** | Skip raw slices when LLM unavailable |
| `src/cli.ts` | **Modify** | Add `--no-llm` flag |

---

## Task 1: Add `"distillation"` Authority to Memory Boundaries

**Files:**
- Modify: `src/memory-boundaries.ts:11-17` (MEMORY_AUTHORITIES array)
- Modify: `src/memory-boundaries.ts:84-94` (add builder function)

- [ ] **Step 1: Add authority constant**

In `src/memory-boundaries.ts`, add `"distillation"` to MEMORY_AUTHORITIES:

```typescript
export const MEMORY_AUTHORITIES = [
  "manual-document",
  "structured-memory",
  "document-ingest",
  "transcript-ingest",
  "session-checkpoint",
  "distillation",
] as const;
```

- [ ] **Step 2: Add boundary builder function**

After `buildStructuredMemoryBoundary()` (~line 94), add:

```typescript
export function buildDistillationBoundary(
  category: DurableMemoryCategory,
): MemoryBoundaryMetadata {
  return {
    layer: "durable",
    authority: "distillation",
    conflictPolicy: getConflictPolicyForCategory(category),
    originalCategory: category,
  };
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd ~/recallnest && bun build src/memory-boundaries.ts --no-bundle 2>&1 | head -5`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
cd ~/recallnest && git add src/memory-boundaries.ts && git commit -m "feat: add distillation authority to memory boundaries"
```

---

## Task 2: Add Archived Filter to Retriever

**Files:**
- Modify: `src/retriever.ts:70-79` (RetrievalContext)
- Modify: `src/retriever.ts:437-461` (runVectorSearch)
- Modify: `src/retriever.ts:463-480` (runBM25Search)

- [ ] **Step 1: Add `includeArchived` to RetrievalContext**

In `src/retriever.ts`, update RetrievalContext interface:

```typescript
export interface RetrievalContext {
  query: string;
  limit: number;
  scopeFilter?: string[];
  category?: string;
  source?: "manual" | "auto-recall" | "cli";
  includeArchived?: boolean; // default false — exclude archived records
}
```

- [ ] **Step 2: Add `includeArchived` parameter to private search methods**

`runVectorSearch` and `runBM25Search` receive individual parameters, not the full context. Add `includeArchived?: boolean` to both signatures:

In `runVectorSearch()` (line ~437):
```typescript
private async runVectorSearch(
  queryVector: number[],
  limit: number,
  scopeFilter?: string[],
  category?: string,
  includeArchived?: boolean,
): Promise<Array<MemorySearchResult & { rank: number }>>
```

In `runBM25Search()` (line ~463):
```typescript
private async runBM25Search(
  query: string,
  limit: number,
  scopeFilter?: string[],
  category?: string,
  includeArchived?: boolean,
): Promise<Array<MemorySearchResult & { rank: number }>>
```

- [ ] **Step 3: Forward `includeArchived` from retrieve() to private methods**

In `retrieve()` (line ~309), where it calls `runVectorSearch` and `runBM25Search`, pass `context.includeArchived`:

```typescript
// In vectorOnlyRetrieval or hybridRetrieval call sites:
const vectorResults = await this.runVectorSearch(queryVector, limit, scopeFilter, category, context.includeArchived);
const bm25Results = await this.runBM25Search(query, limit, scopeFilter, category, context.includeArchived);
```

- [ ] **Step 4: Filter archived records using existing `parseMetadata`**

In `runVectorSearch()`, after the existing category filter (around line 452-454), add using the existing `parseMetadata` function (already at line ~125 of retriever.ts):

```typescript
// Filter archived records (default: exclude)
const afterArchive = includeArchived
  ? filtered
  : filtered.filter(r => {
      const meta = parseMetadata(r.entry.metadata);
      return meta.archived !== true;
    });
```

Use `afterArchive` in place of `filtered` downstream. Same pattern in `runBM25Search()` after category filter (around line 472-474).

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd ~/recallnest && bun build src/retriever.ts --no-bundle 2>&1 | head -5`

- [ ] **Step 6: Commit**

```bash
cd ~/recallnest && git add src/retriever.ts && git commit -m "feat: filter archived records from search results by default"
```

---

## Task 3: Create Bulk Distillation Script

**Files:**
- Create: `scripts/distill-facts.ts`

This is the largest task. The script:
1. Reads all `fact` records from LanceDB
2. Groups by scope (session)
3. Feeds batches through `smartExtractBatch()`
4. Stores new durable records, archives originals
5. Tracks progress for crash recovery

- [ ] **Step 1: Create the script with imports and config**

Create `scripts/distill-facts.ts`:

```typescript
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
import { MemoryStore, type MemoryEntry } from "../src/store.js";
import { loadConfig, createComponents } from "../src/runtime-config.js";
import { dedupCheck } from "../src/ingest.js";
import { buildDistillationBoundary } from "../src/memory-boundaries.js";
import type { SmartExtraction } from "../src/llm-client.js";

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
```

- [ ] **Step 2: Add the core distillation logic**

Append to `scripts/distill-facts.ts`:

```typescript
// ─── Core Logic ─────────────────────────────────────────────────────────────

async function distillBatch(
  texts: string[],
  originals: MemoryEntry[],
  store: MemoryStore,
  embedder: Awaited<ReturnType<typeof createComponents>>["embedder"],
  llm: Awaited<ReturnType<typeof createComponents>>["llm"],
  dryRun = false,
): Promise<{ newCount: number; dedupCount: number; errors: number }> {
  let newCount = 0;
  let dedupCount = 0;
  let errors = 0;

  // Step 1: Extract knowledge via LLM
  let extractions: SmartExtraction[];
  try {
    if (!llm) throw new Error("LLM not available");
    const llmResults = await llm.smartExtractBatch(texts);
    extractions = llmResults.map((r, i) => r ?? null).filter(Boolean) as SmartExtraction[];
    if (extractions.length === 0) {
      // All failed - skip this batch
      return { newCount: 0, dedupCount: 0, errors: texts.length };
    }
  } catch (e) {
    console.error(`    ❌ LLM extraction failed: ${e}`);
    return { newCount: 0, dedupCount: 0, errors: texts.length };
  }

  // Step 2: Generate embeddings for extracted L0 summaries
  const extractedTexts = extractions.map(e => e.l0 || e.l1 || "");
  const validIndices = extractedTexts.map((t, i) => t.length > 10 ? i : -1).filter(i => i >= 0);

  if (validIndices.length === 0) {
    return { newCount: 0, dedupCount: texts.length, errors: 0 };
  }

  const textsToEmbed = validIndices.map(i => extractions[i].l1 || extractions[i].l0);
  let vectors: number[][];
  try {
    vectors = await embedder.embedBatchPassage(textsToEmbed);
  } catch (e) {
    console.error(`    ❌ Embedding failed: ${e}`);
    return { newCount: 0, dedupCount: 0, errors: validIndices.length };
  }

  // Step 3: Dedup + store each extracted record
  // Track mapping: original index → new record ID (for correct archive linking)
  const idMapping = new Map<number, string>(); // validIndices index → new entry id
  for (let vi = 0; vi < validIndices.length; vi++) {
    const idx = validIndices[vi];
    const extraction = extractions[idx];
    const vector = vectors[vi];
    const original = originals[idx];

    // Dedup against existing non-fact records
    const dedup = await dedupCheck(store, vector, extraction.l0, llm);
    if (dedup.action === "skip") {
      dedupCount++;
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

    if (dryRun) {
      // Dry-run: print extraction result, don't write
      console.log(`\n    📝 [${extraction.category}] importance=${extraction.importance}`);
      console.log(`       原文: ${original.text.slice(0, 80)}...`);
      console.log(`       L0: ${extraction.l0}`);
      console.log(`       L1: ${(extraction.l1 || "").slice(0, 120)}`);
      newCount++;
      continue;
    }

    try {
      const entry = await store.store({
        text: extraction.l1 || extraction.l0,
        vector,
        category: extraction.category as any,
        scope: original.scope.replace(/^cc:/, "distill:"),
        importance: extraction.importance,
        metadata,
      });
      idMapping.set(idx, entry.id);
      newCount++;
    } catch (e) {
      console.error(`    ❌ Store failed: ${e}`);
      errors++;
    }
  }

  // Step 4: Archive originals — each links to its own distilled record (skip in dry-run)
  if (dryRun) return { newCount, dedupCount, errors };
  for (let vi = 0; vi < validIndices.length; vi++) {
    const idx = validIndices[vi];
    const original = originals[idx];
    const distilledId = idMapping.get(idx);
    if (!distilledId) continue; // Was deduped or failed — don't archive
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
      console.error(`    ⚠️  Archive mark failed for ${original.id}: ${e}`);
    }
  }

  return { newCount, dedupCount, errors };
}
```

- [ ] **Step 3: Add the main function**

Append to `scripts/distill-facts.ts`:

```typescript
// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const scopeArg = args.find(a => a.startsWith("--scope="))?.split("=")[1]
    || (args.includes("--scope") ? args[args.indexOf("--scope") + 1] : undefined);

  const config = loadConfig();
  const { store, embedder, llm } = createComponents(config);

  if (!llm) {
    console.error("❌ LLM 未配置，无法进行知识提炼。检查 config.json 的 llm 配置。");
    process.exit(1);
  }

  // Test LLM connectivity
  const llmTest = await llm.test();
  if (!llmTest.success) {
    console.error(`❌ LLM 连接失败: ${llmTest.error}`);
    process.exit(1);
  }
  console.log(`✅ LLM: ${config.llm?.model}`);

  // Fetch all fact records
  console.log("\n⏳ 正在读取 fact 记录...");
  const allFacts: MemoryEntry[] = await store.list(undefined, "fact", 50000, 0);
  console.log(`✅ 共 ${allFacts.length} 条 fact 记录\n`);

  // Filter out already-archived facts
  const unarchived = allFacts.filter(f => {
    if (!f.metadata) return true;
    try { return !JSON.parse(f.metadata).archived; } catch { return true; }
  });
  console.log(`📋 未归档: ${unarchived.length} 条 (已归档: ${allFacts.length - unarchived.length} 条)\n`);

  // Group by scope
  const byScope = new Map<string, MemoryEntry[]>();
  for (const f of unarchived) {
    const arr = byScope.get(f.scope) || [];
    arr.push(f);
    byScope.set(f.scope, arr);
  }
  const scopes = [...byScope.keys()].sort((a, b) => (byScope.get(b)!.length - byScope.get(a)!.length));
  console.log(`📦 ${scopes.length} 个 scope\n`);

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
      console.error(`❌ scope "${scopeArg}" 不存在`);
      process.exit(1);
    }
  }
  if (dryRun) {
    targetScopes = [targetScopes[0]]; // Only first scope
    console.log(`🔍 DRY RUN: 只处理 scope "${targetScopes[0]}" (${byScope.get(targetScopes[0])!.length} 条)\n`);
  }

  // Process scopes
  for (const scope of targetScopes) {
    if (progress.completedScopes.includes(scope)) {
      console.log(`⏭️  ${scope}: 已处理，跳过`);
      continue;
    }

    const facts = byScope.get(scope)!;
    console.log(`\n🔄 ${scope}: ${facts.length} 条 fact`);

    // Process in batches
    let scopeNew = 0, scopeDedup = 0, scopeErrors = 0;
    for (let i = 0; i < facts.length; i += BATCH_SIZE) {
      const batch = facts.slice(i, i + BATCH_SIZE);
      const texts = batch.map(f => f.text);

      process.stdout.write(`  batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(facts.length / BATCH_SIZE)}...`);
      const result = await distillBatch(texts, batch, store, embedder, llm, dryRun);

      scopeNew += result.newCount;
      scopeDedup += result.dedupCount;
      scopeErrors += result.errors;
      console.log(` +${result.newCount} new, ${result.dedupCount} dedup, ${result.errors} err`);
    }

    console.log(`  📊 ${scope} 完成: +${scopeNew} 新记忆, ${scopeDedup} 去重, ${scopeErrors} 错误`);

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
  console.log("📊 提炼完成汇总:");
  console.log(`  总 fact 记录: ${progress.stats.totalFacts}`);
  console.log(`  已处理: ${progress.stats.processedFacts}`);
  console.log(`  新知识记忆: ${progress.stats.newRecords}`);
  console.log(`  去重跳过: ${progress.stats.dedupedSkips}`);
  console.log(`  错误: ${progress.stats.errors}`);
  console.log(`  压缩比: ${(progress.stats.processedFacts / Math.max(progress.stats.newRecords, 1)).toFixed(1)}:1`);
  if (dryRun) {
    console.log("\n⚠️  DRY RUN 模式，未保存进度。确认质量后去掉 --dry-run 再跑。");
  }
}

main().catch(console.error);
```

- [ ] **Step 4: Verify script compiles**

Run: `cd ~/recallnest && bun build scripts/distill-facts.ts --no-bundle 2>&1 | head -10`

- [ ] **Step 5: Commit**

```bash
cd ~/recallnest && git add scripts/distill-facts.ts && git commit -m "feat: add bulk distillation script for converting fact fragments to knowledge"
```

---

## Task 4: Dry-Run Test

- [ ] **Step 1: Run dry-run on first session**

```bash
cd ~/recallnest && bun scripts/distill-facts.ts --dry-run 2>&1 | tee /tmp/distill-dry-run.log
```

Expected: Processes 1 session (~30-50 facts), prints extraction results, does NOT save progress.

- [ ] **Step 2: Review output quality**

Check the log:
- Are extractions meaningful? (not just repeating the original text)
- Are categories correct? (profile/preferences/entities/events/cases/patterns)
- Is importance scoring reasonable?
- Is dedup catching true duplicates?

If quality is poor → adjust `smartExtractBatch` prompts in `src/llm-client.ts` before proceeding.

- [ ] **Step 3: Get user sign-off**

Show the dry-run results to user. Only proceed to batch if user approves quality.

---

## Task 5: Batch Distillation Run

**Prerequisite:** Task 4 dry-run approved by user.

- [ ] **Step 1: Run full batch**

```bash
cd ~/recallnest && bun scripts/distill-facts.ts 2>&1 | tee /tmp/distill-batch.log
```

This will:
- Process all ~700 sessions
- Write checkpoint after each session (crash-safe)
- Skip already-completed sessions on resume

Estimated time: ~30-60 minutes (depends on qwen-turbo latency)

- [ ] **Step 2: Monitor progress**

If interrupted, resume with same command — it reads `data/distill-progress.json` and skips completed scopes.

- [ ] **Step 3: Verify results**

```bash
cd ~/recallnest && bun src/cli.ts stats
```

Expected:
- `fact` count should still be ~23K (archived but not deleted)
- New categories (entities, cases, patterns, etc.) should increase by ~3-5K
- Total records ~33-35K

- [ ] **Step 4: Run health check**

```bash
cd ~/recallnest && bun scripts/health-check.ts
```

Compare dead memory rate before/after. Should drop significantly.

- [ ] **Step 5: Commit progress file**

```bash
cd ~/recallnest && git add data/distill-progress.json && git commit -m "data: distillation batch complete — 23K facts processed"
```

**Rollback plan** (if results are poor): Un-archive originals and delete distilled records:
```bash
cd ~/recallnest && bun -e "
import lancedb from '@lancedb/lancedb';
const db = await lancedb.connect('data/lancedb');
const t = await db.openTable('memories');
// Find all distilled records and their source originals
const distilled = await t.query().where(\"metadata LIKE '%distillation%'\").toArray();
console.log('Would delete', distilled.length, 'distilled records');
// To actually rollback: delete distilled, then un-archive originals by removing archived flag
"
```

---

## Task 6: Upgrade Ingest Pipeline (Route A)

**Files:**
- Modify: `src/ingest.ts:337-352` (smartExtractBatch behavior)
- Modify: `src/cli.ts:1281-1287` (add --no-llm flag)

- [ ] **Step 1: Change ingest behavior when LLM unavailable**

In `src/ingest.ts`, modify the section where chunks are stored. The key change is: when `llm` is null and `smartExtractBatch` returns fallback results, log a warning and skip storing the raw chunk. Instead, append to a pending queue file.

Add a helper function after the existing `fallbackExtraction` function (~line 332):

```typescript
const PENDING_EXTRACTION_FILE = path.join(
  import.meta.dir, "..", "data", "pending-extraction.json"
);

function queueForLaterExtraction(chunk: { text: string; scope: string; timestamp: string }): void {
  let pending: Array<typeof chunk> = [];
  try {
    pending = JSON.parse(fs.readFileSync(PENDING_EXTRACTION_FILE, "utf-8"));
  } catch { /* empty or missing */ }
  pending.push(chunk);
  fs.writeFileSync(PENDING_EXTRACTION_FILE, JSON.stringify(pending, null, 2));
}
```

Add import at top of `ingest.ts`:
```typescript
import fs from "fs";
import path from "path";
```

- [ ] **Step 2: Guard the store path in ingestCCTranscripts**

In `ingestCCTranscripts()`, around the `smartExtractBatch` call (line ~1138), wrap the store logic:

```typescript
const extractions = await smartExtractBatch(dedupedTexts, options.llm);

// If no LLM, queue raw chunks for later extraction instead of storing garbage
if (!options.llm) {
  for (let i = 0; i < dedupedTexts.length; i++) {
    queueForLaterExtraction({
      text: dedupedTexts[i],
      scope: `cc:${sessionId.slice(0, 8)}`,
      timestamp: chunks[0]?.timestamp || new Date().toISOString(),
    });
  }
  result.chunksSkipped = (result.chunksSkipped || 0) + dedupedTexts.length;
  continue; // Skip to next file
}
```

Apply the same guard in `ingestCodexSessions()` (line ~667, same pattern — check `!options.llm` before the store path, queue chunks instead) and `ingestGeminiSessions()` (line ~848).

- [ ] **Step 3: Add pending queue drain at start of ingest**

In `src/ingest.ts`, add a function to process the pending queue when LLM is available:

```typescript
export async function drainPendingQueue(
  store: MemoryStore,
  embedder: Embedder,
  llm: LLMClient,
): Promise<{ processed: number; errors: number }> {
  let pending: Array<{ text: string; scope: string; timestamp: string }> = [];
  try {
    pending = JSON.parse(fs.readFileSync(PENDING_EXTRACTION_FILE, "utf-8"));
  } catch { return { processed: 0, errors: 0 }; }

  if (pending.length === 0) return { processed: 0, errors: 0 };

  let processed = 0, errors = 0;
  for (let i = 0; i < pending.length; i += 20) {
    const batch = pending.slice(i, i + 20);
    const texts = batch.map(c => c.text);
    const extractions = await smartExtractBatch(texts, llm);
    const vectors = await embedder.embedBatchPassage(
      extractions.map(e => e.l1 || e.l0),
    );
    for (let j = 0; j < extractions.length; j++) {
      try {
        await store.store({
          text: extractions[j].l1 || extractions[j].l0,
          vector: vectors[j],
          category: extractions[j].category as any,
          scope: batch[j].scope,
          importance: extractions[j].importance,
          metadata: JSON.stringify({ source: batch[j].scope.split(":")[0], l0: extractions[j].l0 }),
        });
        processed++;
      } catch { errors++; }
    }
  }

  // Clear the queue
  fs.writeFileSync(PENDING_EXTRACTION_FILE, "[]");
  return { processed, errors };
}
```

In `src/cli.ts`, call `drainPendingQueue` at the start of the ingest action (after LLM test, around line 1324), before processing new files:

```typescript
if (llm) {
  const { drainPendingQueue } = await import("./ingest.js");
  const drained = await drainPendingQueue(store, embedder, llm);
  if (drained.processed > 0) {
    console.log(`  ♻️  Pending queue: ${drained.processed} processed, ${drained.errors} errors`);
  }
}
```

- [ ] **Step 4: Add `--no-llm` CLI flag (and update step numbering)**

In `src/cli.ts`, add the flag to the ingest command (around line 1287):

```typescript
.option("--no-llm", "禁用 LLM 提取（仅用于调试，会跳过原始对话不存入）")
```

And in the action handler (around line 1326):

```typescript
const effectiveLlm = options.noLlm ? null : llm;
const ingestOpts = { limit, verbose, noDedup, llm: effectiveLlm };
```

Update the LLM status message (around line 1319-1321):

```typescript
if (options.noLlm) {
  console.log("  ⚠️  LLM: 已通过 --no-llm 禁用，原始对话将跳过不存入");
} else if (!llm) {
  console.log("  ⚠️  LLM: 未配置，原始对话将跳过不存入（配置 config.json → llm 以启用）");
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd ~/recallnest && bun build src/ingest.ts --no-bundle 2>&1 | head -5 && bun build src/cli.ts --no-bundle 2>&1 | head -5`

- [ ] **Step 6: Test ingest with LLM**

```bash
cd ~/recallnest && bun src/cli.ts ingest --source cc --limit 1 --verbose
```

Expected: Should use LLM extraction, store structured records (not raw slices).

- [ ] **Step 7: Test ingest with --no-llm**

```bash
cd ~/recallnest && bun src/cli.ts ingest --source cc --limit 1 --no-llm --verbose
```

Expected: Should skip storing, queue to `data/pending-extraction.json`.

- [ ] **Step 8: Commit**

```bash
cd ~/recallnest && git add src/ingest.ts src/cli.ts && git commit -m "feat: ingest pipeline now requires LLM extraction — raw slices queued when LLM unavailable"
```

---

## Task 7: Final Verification & Push

- [ ] **Step 1: Run full stats**

```bash
cd ~/recallnest && bun src/cli.ts stats
```

- [ ] **Step 2: Test search excludes archived**

```bash
cd ~/recallnest && bun src/cli.ts search "OpenClaw 压缩上下文"
```

Verify results come from distilled records, not raw `[助手]`/`[用户]` fragments.

- [ ] **Step 3: Push all changes**

```bash
cd ~/recallnest && git push origin main
```
