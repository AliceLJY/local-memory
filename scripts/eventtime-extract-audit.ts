#!/usr/bin/env bun
/**
 * eventTime 抽取审计（只读 DRY-RUN，绝不写库）
 *
 * 回答半 A 的 go/no-go 问题：从存量记忆文本里，用 temporal-parser 的绝对时间锚
 * （年 / 年-月，无 Date.now 依赖）能抽到多少条 eventTime，抽出来的质量如何。
 *
 * 只统计 + dump 样例供人眼验证「抽到的时间是不是这条记忆真正的事件时间」。
 * 写库回填是看过质量后的独立后续，本脚本不做。
 *
 * Usage:
 *   bun scripts/eventtime-extract-audit.ts                          # 采样 4 万，dump 25 例
 *   bun scripts/eventtime-extract-audit.ts --scope cc --samples 40  # 只看 cc:* scope
 *   bun scripts/eventtime-extract-audit.ts --limit 5000
 */
import lancedb from "@lancedb/lancedb";
import { extractEventTimeFromText } from "../src/temporal-parser.js";
import { parseEvolution } from "../src/memory-evolution.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DB = arg("--db") ?? "$HOME/recallnest/data/lancedb";
const scopeFilter = (arg("--scope") ?? "").replace(/'/g, "");
const limit = Number(arg("--limit") ?? "40000");
const nSamples = Number(arg("--samples") ?? "25");
// Local-time formatting to match temporal-parser's local startOfYear/startOfMonth
// (toISOString would shift by the UTC offset and cross the day/year boundary).
const fmt = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type Row = Record<string, unknown>;

const db = await lancedb.connect(DB);
const table = await db.openTable("memories");
let q = table.query().select(["id", "text", "scope", "category", "timestamp", "metadata"]);
if (scopeFilter) q = q.where(`scope LIKE '${scopeFilter}%'`);
const rows = (await q.limit(limit).toArray()) as Row[];

let total = 0, hasAlready = 0, extractable = 0;
const byCat: Record<string, { n: number; ext: number }> = {};
const samples: { cat: string; anchor: string; ev: string; ts: string; text: string }[] = [];

for (const r of rows) {
  total++;
  const md = typeof r.metadata === "string" ? (r.metadata as string) : undefined;
  const evo = parseEvolution(md, typeof r.timestamp === "number" ? (r.timestamp as number) : undefined);
  const cat = String(r.category ?? "?");
  (byCat[cat] ??= { n: 0, ext: 0 }).n++;
  if (evo.eventTime != null) hasAlready++;

  const text = String(r.text ?? "");
  const hit = extractEventTimeFromText(text);
  if (hit) {
    extractable++;
    byCat[cat].ext++;
    if (samples.length < nSamples) {
      samples.push({
        cat,
        anchor: hit.anchor,
        ev: fmt(hit.eventTime),
        ts: typeof r.timestamp === "number" ? fmt(r.timestamp as number) : "?",
        text: text.replace(/\s+/g, " ").slice(0, 90),
      });
    }
  }
}

const p = (a: number, b: number) => (b === 0 ? "0" : ((a / b) * 100).toFixed(2)) + "%";
console.log(`\n=== eventTime 抽取审计（只读 DRY-RUN）===`);
console.log(`DB: ${DB}${scopeFilter ? ` | scope~${scopeFilter}*` : ""} | 采样 ${total} 条`);
console.log(`已有 eventTime : ${hasAlready} (${p(hasAlready, total)})`);
console.log(`可抽取(绝对锚): ${extractable} (${p(extractable, total)})`);

console.log(`\n=== 按 category 可抽取率 ===`);
for (const [c, v] of Object.entries(byCat).sort((a, b) => b[1].n - a[1].n).slice(0, 10))
  console.log(`  ${c.padEnd(14)} n=${String(v.n).padStart(6)}  可抽=${p(v.ext, v.n)}`);

console.log(`\n=== 质量样例（人眼验：抽到的时间是不是这条记忆的事件时间？）===`);
for (const s of samples)
  console.log(`  [${s.cat}] 锚"${s.anchor}" → 事件${s.ev} (存储${s.ts})\n     ${s.text}`);

console.log(`\n⚠️  DRY-RUN：未写入任何数据。`);
