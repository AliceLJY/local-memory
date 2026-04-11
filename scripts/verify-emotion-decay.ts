#!/usr/bin/env bun
/**
 * Phase 1 Manual Verification: Emotional Valence in Decay
 *
 * Demonstrates:
 * 1. detectEmotion → salience + source fields
 * 2. adjustHalfLifeForEmotion → emotional memories get longer half-life
 * 3. computeDecayScore → emotion-aware weights
 * 4. End-to-end: emotional memory scores higher than neutral at same age
 */

import { detectEmotion } from "../src/emotion-detector.js";
import { adjustHalfLifeForEmotion, computeArousalBoost, weibullDecay, resolveTier } from "../src/decay-engine.js";
import { computeDecayScore, type EvolutionMetadata } from "../src/memory-evolution.js";
import { parseEmotion } from "../src/memory-schema.js";

// Force emotion flag on for verification
process.env.RECALLNEST_EMOTION_SCORING = "true";

const DIVIDER = "─".repeat(60);

// ── 1. detectEmotion: salience + source ──────────────────────

console.log("\n" + DIVIDER);
console.log("1️⃣  detectEmotion: salience + source");
console.log(DIVIDER);

const samples = [
  { label: "愤怒调试", text: "CRITICAL BUG! 这个问题搞了三天还是崩溃，太frustrating了！" },
  { label: "成功修复", text: "Finally fixed it! Everything works perfectly, all tests pass!" },
  { label: "中性日志", text: "Updated the config file and ran the migration script." },
  { label: "中文负面", text: "这个方案不好用，不开心，又失败了" },
];

for (const s of samples) {
  const e = detectEmotion(s.text);
  console.log(`\n  [${s.label}]`);
  console.log(`  text:     "${s.text.slice(0, 50)}..."`);
  console.log(`  valence:  ${e.valence.toFixed(2)}  arousal: ${e.arousal.toFixed(2)}  label: ${e.label}`);
  console.log(`  salience: ${e.salience?.toFixed(3)}  source: ${e.source}`);
}

// ── 2. Half-life adjustment ──────────────────────────────────

console.log("\n" + DIVIDER);
console.log("2️⃣  adjustHalfLifeForEmotion: half-life extension");
console.log(DIVIDER);

const baseHL = 60; // 60 days
for (const s of samples) {
  const e = detectEmotion(s.text);
  const adjustedHL = adjustHalfLifeForEmotion(baseHL, e);
  const boost = computeArousalBoost(e);
  const delta = ((adjustedHL / baseHL - 1) * 100).toFixed(1);
  console.log(`\n  [${s.label}]`);
  console.log(`  base HL:     ${baseHL}d → adjusted: ${adjustedHL.toFixed(1)}d (+${delta}%)`);
  console.log(`  arousal boost: ${boost.toFixed(3)}x`);
}

// ── 3. Weibull decay comparison at 30d, 60d, 90d ────────────

console.log("\n" + DIVIDER);
console.log("3️⃣  Weibull decay: emotional vs neutral at different ages");
console.log(DIVIDER);

const emotionalText = "CRITICAL BUG! 这个问题搞了三天还是崩溃，太frustrating了！";
const neutralText = "Updated the config file and ran the migration script.";
const emotionalEmo = detectEmotion(emotionalText);
const neutralEmo = detectEmotion(neutralText);
const emotionalHL = adjustHalfLifeForEmotion(baseHL, emotionalEmo);
const neutralHL = adjustHalfLifeForEmotion(baseHL, neutralEmo);
const emotionalBoost = computeArousalBoost(emotionalEmo);
const neutralBoost = computeArousalBoost(neutralEmo);

console.log(`\n  ${"Age".padEnd(8)} ${"Emotional".padEnd(14)} ${"Neutral".padEnd(14)} ${"Δ advantage".padEnd(14)}`);
for (const ageDays of [7, 30, 60, 90, 120]) {
  const emoDecay = weibullDecay(ageDays, emotionalHL, "working") * emotionalBoost;
  const neuDecay = weibullDecay(ageDays, neutralHL, "working") * neutralBoost;
  const advantage = ((emoDecay / neuDecay - 1) * 100).toFixed(1);
  console.log(`  ${(ageDays + "d").padEnd(8)} ${emoDecay.toFixed(4).padEnd(14)} ${neuDecay.toFixed(4).padEnd(14)} +${advantage}%`);
}

// ── 4. computeDecayScore: full formula comparison ────────────

console.log("\n" + DIVIDER);
console.log("4️⃣  computeDecayScore: emotion-aware weights (0.15/0.25/0.45/0.15)");
console.log(DIVIDER);

const now = Date.now();
const makeEvo = (ageDays: number, accessCount: number): EvolutionMetadata => ({
  status: "active",
  version: 1,
  accessCount,
  lastAccessedAt: now - 7 * 86_400_000,
  supersededBy: null,
  supersedes: null,
  evolutionNote: null,
  consolidatedInto: null,
  contributedToPattern: null,
  sourceMemories: [],
  validFrom: now - ageDays * 86_400_000,
  validUntil: null,
});

const scenarios = [
  { label: "新记忆(7d), 3次访问, importance=0.7", age: 7, access: 3, importance: 0.7 },
  { label: "旧记忆(60d), 3次访问, importance=0.7", age: 60, access: 3, importance: 0.7 },
  { label: "很旧(120d), 低访问, importance=0.5", age: 120, access: 1, importance: 0.5 },
];

for (const sc of scenarios) {
  const evo = makeEvo(sc.age, sc.access);
  const emotionalMeta = JSON.stringify({
    emotion: detectEmotion(emotionalText),
  });
  const neutralMeta = JSON.stringify({
    emotion: detectEmotion(neutralText),
  });

  const emoScore = computeDecayScore(evo, sc.importance, now, emotionalMeta);
  const neuScore = computeDecayScore(evo, sc.importance, now, neutralMeta);
  const noMetaScore = computeDecayScore(evo, sc.importance, now); // backward compat

  console.log(`\n  [${sc.label}]`);
  console.log(`  emotional:  ${emoScore.toFixed(4)}`);
  console.log(`  neutral:    ${neuScore.toFixed(4)}`);
  console.log(`  no-meta:    ${noMetaScore.toFixed(4)}  (backward compat, base weights)`);
  console.log(`  Δ emotion:  +${((emoScore / neuScore - 1) * 100).toFixed(1)}% vs neutral`);
}

// ── 5. parseEmotion backward compat ──────────────────────────

console.log("\n" + DIVIDER);
console.log("5️⃣  parseEmotion: backward compatibility");
console.log(DIVIDER);

const oldMeta = JSON.stringify({ emotion: { valence: 0.5, arousal: 0.3, label: "positive" } }); // no salience/source
const newMeta = JSON.stringify({ emotion: { valence: 0.5, arousal: 0.3, label: "positive", salience: 0.4, source: "keyword" } });
const noEmoMeta = JSON.stringify({ tier: "working" });

console.log(`\n  old format (no salience): ${JSON.stringify(parseEmotion(oldMeta))}`);
console.log(`  new format (with salience): ${JSON.stringify(parseEmotion(newMeta))}`);
console.log(`  no emotion field: ${parseEmotion(noEmoMeta)}`);
console.log(`  undefined: ${parseEmotion(undefined)}`);

console.log("\n" + DIVIDER);
console.log("✅ Phase 1 Verification Complete");
console.log(DIVIDER + "\n");
