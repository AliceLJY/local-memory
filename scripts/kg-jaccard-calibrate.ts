#!/usr/bin/env bun
/**
 * Calibrate the consolidation tripleJaccardThreshold on real data (plan Q3).
 *
 * Samples memory pairs in three vector-similarity bands:
 *   HIGH ≥ 0.92          — above the current merge bar (proxy for true duplicates)
 *   GREY 0.82–0.92       — the zone triple evidence is meant to arbitrate
 *   LOW  0.70–0.82       — below cluster bar (proxy for non-duplicates)
 * and prints the triple-set Jaccard distribution per band. A good threshold
 * separates HIGH (should merge) from LOW (must not merge).
 *
 * Read-only: writes nothing. Requires backfilled kg_triples for coverage.
 *
 * Usage:
 *   bun scripts/kg-jaccard-calibrate.ts                 # all scopes, 40 pairs/band
 *   bun scripts/kg-jaccard-calibrate.ts --scope global --per-band 60
 */

import { loadDotEnv, loadConfig, createStoreOnly } from "../src/runtime-config.js";
import { KGStore } from "../src/kg-store.js";
import { tripleJaccard } from "../src/consolidation-engine.js";
import { isActiveMemory } from "../src/memory-evolution.js";

loadDotEnv();
const config = loadConfig();

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const scopeFilter = argValue("--scope");
const perBand = Number(argValue("--per-band") ?? "40");
const minTriples = Number(argValue("--min-triples") ?? "2");
const seedLimit = Number(argValue("--seed-limit") ?? "600");

interface Band {
  name: string;
  min: number;
  max: number;
  jaccards: number[];
  pairsSeen: number;
  pairsSkippedNoTriples: number;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  // Read-only workload — store-only avoids requiring embedding credentials
  const store = createStoreOnly(config);
  const kg = new KGStore({ dbPath: store.dbPath });

  const bands: Band[] = [
    { name: "HIGH ≥0.92", min: 0.92, max: 1.01, jaccards: [], pairsSeen: 0, pairsSkippedNoTriples: 0 },
    { name: "GREY 0.82–0.92", min: 0.82, max: 0.92, jaccards: [], pairsSeen: 0, pairsSkippedNoTriples: 0 },
    { name: "LOW 0.70–0.82", min: 0.70, max: 0.82, jaccards: [], pairsSeen: 0, pairsSkippedNoTriples: 0 },
  ];

  console.log(`=== tripleJaccard calibration${scopeFilter ? ` (scope: ${scopeFilter})` : " (all scopes)"} ===`);
  console.log(`  per band target: ${perBand} | min triples/side: ${minTriples}\n`);

  // Seeds: prefer high-importance (backfill coverage) active memories with vectors
  const scopes = scopeFilter ? [scopeFilter] : undefined;
  const all = await store.list(scopes, undefined, 100000, 0);
  const seeds = all
    .filter((e) => isActiveMemory(e.metadata) && (e.importance ?? 0) >= 0.8)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, seedLimit);
  console.log(`  Seeds: ${seeds.length} (importance ≥ 0.8, active)`);

  const seenPairs = new Set<string>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}\x00${b}` : `${b}\x00${a}`);

  for (const seed of seeds) {
    if (bands.every((b) => b.jaccards.length >= perBand)) break;

    const full = await store.getById(seed.id);
    if (!full?.vector?.length) continue;
    const neighbors = await store.vectorSearch(full.vector, 15, 0.70, scopes ? scopes : [seed.scope]);

    for (const n of neighbors) {
      if (n.entry.id === seed.id) continue;
      const key = pairKey(seed.id, n.entry.id);
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);

      const band = bands.find((b) => n.score >= b.min && n.score < b.max);
      if (!band || band.jaccards.length >= perBand) continue;
      band.pairsSeen++;

      const triples = await kg.getTriplesBySourceMemories([seed.id, n.entry.id]);
      const setA = new Set((triples.get(seed.id) ?? []).map((t) => t.id));
      const setB = new Set((triples.get(n.entry.id) ?? []).map((t) => t.id));
      if (setA.size < minTriples || setB.size < minTriples) {
        band.pairsSkippedNoTriples++;
        continue;
      }
      band.jaccards.push(tripleJaccard(setA, setB, minTriples));
    }
  }

  console.log();
  for (const band of bands) {
    const sorted = [...band.jaccards].sort((a, b) => a - b);
    const mean = sorted.length ? sorted.reduce((s, x) => s + x, 0) / sorted.length : NaN;
    console.log(`  ${band.name}`);
    console.log(`    measured pairs: ${sorted.length} (seen ${band.pairsSeen}, skipped for thin triples: ${band.pairsSkippedNoTriples})`);
    if (sorted.length > 0) {
      console.log(
        `    jaccard mean=${mean.toFixed(3)} P50=${pct(sorted, 50).toFixed(3)} P90=${pct(sorted, 90).toFixed(3)} max=${sorted[sorted.length - 1].toFixed(3)}`,
      );
      const over = (thr: number) => sorted.filter((x) => x >= thr).length;
      console.log(`    ≥0.3: ${over(0.3)} | ≥0.5: ${over(0.5)} | ≥0.7: ${over(0.7)}`);
    }
    console.log();
  }

  const high = bands[0].jaccards.slice().sort((a, b) => a - b);
  const low = bands[2].jaccards.slice().sort((a, b) => a - b);
  if (high.length >= 10 && low.length >= 10) {
    const suggestion = Math.max(0.3, Math.min(0.7, (pct(high, 50) + pct(low, 90)) / 2));
    console.log(`  Suggestion: midpoint of HIGH-P50 (${pct(high, 50).toFixed(3)}) and LOW-P90 (${pct(low, 90).toFixed(3)}) → ~${suggestion.toFixed(2)}`);
    console.log(`  (current default 0.5 — adjust DEFAULT_CONSOLIDATION_CONFIG.tripleJaccardThreshold if far off)`);
  } else {
    console.log("  Not enough measured pairs for a suggestion — increase backfill coverage or --seed-limit.");
  }
}

main().catch((err) => {
  console.error("Calibration failed:", err);
  process.exit(1);
});
