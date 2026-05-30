#!/usr/bin/env bun
/**
 * Archive severed bridge/distill context-JSON fragments that leaked into cc:*
 * `events` evidence BEFORE the 2026-05-29 ingest fix (commits 2b1bf1e/7f023e9).
 * Long bridge self-decision / distill payloads embed structured JSON; old
 * transcript chunking split them, orphaning JSON field-lines as standalone
 * chunks. They carry misleading L0 abstracts ("用户对CC的反馈") and pollute
 * semantic recall. Reversible: sets evolution.status="archived" (data retained;
 * flip back to "active" to restore).
 *
 * Usage:
 *   bun scripts/archive-bridge-json-fragments.ts --dry-run   # preview, no writes
 *   bun scripts/archive-bridge-json-fragments.ts             # apply
 */
import { loadDotEnv, loadConfig, createStoreOnly } from "../src/runtime-config.js";
import { isNoise } from "../src/noise-filter.js";
import { patchEvolution, isActiveMemory } from "../src/memory-evolution.js";
import { extractBoundaryMetadata } from "../src/memory-boundaries.js";

loadDotEnv();
const config = loadConfig();
const dryRun = process.argv.includes("--dry-run");

// isNoise (the always-on filter) stays conservative and intentionally misses
// one storage-only shape: severed file-reference tails. Safe to catch HERE
// (one-shot + manual review) because they end in a file extension + a dangling
// bracket/quote — never a real sentence.
const PATH_FRAGMENT = /\.(jpe?g|png|gif|webp|txt|md|pdf|json|ts|js)\]["',]*\s*$/i;

function classify(text: string): string | null {
  const t = text.trim();
  if (isNoise(t)) return "isNoise";
  if (PATH_FRAGMENT.test(t)) return "path-fragment";
  return null;
}

// Only downgraded-from-profile/preferences evidence is in scope — the same
// population promote-scan clusters. Real cc bot work (code reviews, ops, life
// chat) lives as ORDINARY events (never downgraded), so it is never in range
// and never touched. This is the key guard against deleting genuine memories.
const DOWNGRADE_FROM = new Set(["profile", "preferences"]);
function isDowngraded(metadata: string | undefined): boolean {
  const from = extractBoundaryMetadata(metadata)?.downgradedFrom;
  return typeof from === "string" && DOWNGRADE_FROM.has(from);
}

function l0Of(metadata: string | undefined): string {
  try {
    const m = JSON.parse(metadata || "{}") as { l0_abstract?: unknown };
    return typeof m.l0_abstract === "string" ? m.l0_abstract : "";
  } catch {
    return "";
  }
}

async function main() {
  const store = createStoreOnly(config);
  const allEvents = await store.list(["cc"], "events", 100000, 0);
  const events = allEvents.filter((e) => isDowngraded(e.metadata));
  console.log(`=== Archive bridge JSON fragments${dryRun ? " (dry run)" : ""} ===`);
  console.log(`  cc:* events: ${allEvents.length} | downgraded (in scope): ${events.length}\n`);

  const toArchive: { id: string; imp: number; reason: string; l0: string; text: string; metadata: string }[] = [];
  const review: { id: string; imp: number; l0: string; text: string }[] = [];

  for (const e of events) {
    if (!isActiveMemory(e.metadata)) continue; // skip already-archived
    const reason = classify(e.text);
    const l0 = l0Of(e.metadata);
    if (reason) {
      toArchive.push({ id: e.id, imp: e.importance ?? 0, reason, l0, text: e.text, metadata: e.metadata ?? "{}" });
    } else {
      review.push({ id: e.id, imp: e.importance ?? 0, l0, text: e.text });
    }
  }

  console.log(`  TO ARCHIVE: ${toArchive.length}`);
  for (const r of toArchive) {
    console.log(`  [${r.reason}] ${r.id.slice(0, 8)} imp=${r.imp.toFixed(2)} l0=${JSON.stringify(r.l0.slice(0, 32))}`);
    console.log(`       ${JSON.stringify(r.text.slice(0, 130))}`);
  }

  console.log(`\n  KEEP — manual review for missed fragments: ${review.length}`);
  for (const r of review) {
    console.log(`  · ${r.id.slice(0, 8)} imp=${r.imp.toFixed(2)} l0=${JSON.stringify(r.l0.slice(0, 28))} ${JSON.stringify(r.text.slice(0, 70))}`);
  }

  if (dryRun) {
    console.log(`\n  (dry run — nothing written)`);
    return;
  }
  if (toArchive.length === 0) {
    console.log(`\n  Nothing to archive.`);
    return;
  }

  let done = 0;
  for (const r of toArchive) {
    const metadata = patchEvolution(r.metadata, {
      status: "archived",
      evolutionNote: "bridge-json-fragment-cleanup-2026-05-30",
    });
    await store.update(r.id, { metadata }, ["cc"]);
    done++;
    if (done % 25 === 0) console.log(`  archived ${done}/${toArchive.length}`);
  }
  console.log(`\nDone. Archived ${done} bridge JSON fragments (evolution.status → archived, reversible).`);
}

main().catch((err) => {
  console.error("Archive failed:", err);
  process.exit(1);
});
