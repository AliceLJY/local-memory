#!/usr/bin/env bun
/**
 * pivot-apply anchor↔evidence 一致性检测（Stage 2 追加闸，Alice 2026-08-05 批准）
 *
 * 背景：首批抽验哨兵（#5，agy 来源）探出锚点错配形态——text/evidence 正确，
 * anchor 却是同会话另一句无关话。响应哨兵信号的机械化规则就是本检测。
 *
 * 两层设计（ground truth 仅 2 点，拒绝硬调 embedding 阈值）：
 *   L1 字符串主闸：anchor 规范化后的最长连续片段出现在任一 evidence 内的
 *      占比 ≥ 0.5 → pass（anchor 机械可证出自 evidence）
 *   L2 低重叠子集 → 输出 review 清单，由执行者逐条人工核对
 *      （anchor 是否语义支撑 text——数据 provenance 核对，非内容价值判断）
 *
 * 用法：bun scripts/pivot-apply-anchor-check.ts <draft.jsonl> <kind> <out-dir>
 * 产出：anchor-check-<kind>.json（全量分数）+ anchor-review-<kind>.md（待人工清单）
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const RESULTS_DIR = resolve(process.env.HOME ?? "", "pivot-distill-runs/20260803/full/results");
const PASS_THRESHOLD = 0.5;

function norm(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s，。、！？：；""''"',.!?:;~～…—-]+/g, "");
}

/** anchor 规范化后的最长连续子串出现在任一 evidence 中的长度占比。 */
function overlapScore(anchor: string, evidences: string[]): number {
  const a = norm(anchor);
  const evs = evidences.map(norm).filter((e) => e.length > 0);
  if (a.length === 0 || evs.length === 0) return 0;
  const n = a.length;
  for (let len = n; len >= 1; len--) {
    for (let start = 0; start + len <= n; start++) {
      const sub = a.slice(start, start + len);
      if (evs.some((ev) => ev.includes(sub))) return len / n;
    }
  }
  return 0;
}

interface DraftRow {
  candidateHash: string;
  sessionFingerprint: string;
  kind: string;
  canonicalKey: string;
  harness: string;
  marks: string[];
}

const [draftPath, kind, outDir] = process.argv.slice(2);
if (!draftPath || !kind || !outDir) {
  console.error("usage: bun scripts/pivot-apply-anchor-check.ts <draft.jsonl> <kind> <out-dir>");
  process.exit(1);
}

const rows = readFileSync(draftPath, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as DraftRow)
  .filter((r) => r.kind === kind && r.marks.length === 0);
console.log(`clean pool for kind=${kind}: ${rows.length}`);

const byFp = new Map<string, DraftRow[]>();
for (const r of rows) {
  const list = byFp.get(r.sessionFingerprint) ?? [];
  list.push(r);
  byFp.set(r.sessionFingerprint, list);
}

interface CheckRow {
  candidateHash: string;
  harness: string;
  overlap: number;
  text: string;
  anchor: string;
  evidence: string[];
}
const results: CheckRow[] = [];
for (const [fp, group] of byFp) {
  const d = JSON.parse(readFileSync(join(RESULTS_DIR, `${fp}.json`), "utf8")) as Record<string, unknown>;
  const cands = (d.candidates as Array<Record<string, unknown>>) ?? [];
  for (const row of group) {
    const match = cands.find((c) => c.canonicalKey === row.canonicalKey && c.kind === row.kind);
    if (!match) throw new Error(`candidate not found: ${row.candidateHash.slice(0, 12)} in ${fp}`);
    results.push({
      candidateHash: row.candidateHash,
      harness: row.harness,
      overlap: overlapScore(match.anchor as string, match.evidence as string[]),
      text: match.text as string,
      anchor: match.anchor as string,
      evidence: match.evidence as string[],
    });
  }
}

const pass = results.filter((r) => r.overlap >= PASS_THRESHOLD);
const review = results.filter((r) => r.overlap < PASS_THRESHOLD).sort((a, b) => a.overlap - b.overlap);
const buckets: Record<string, number> = {};
for (const r of results) {
  const b = r.overlap >= 1 ? "1.0" : r.overlap >= 0.8 ? "0.8+" : r.overlap >= 0.5 ? "0.5+" : r.overlap >= 0.2 ? "0.2+" : "<0.2";
  buckets[b] = (buckets[b] ?? 0) + 1;
}
console.log("overlap buckets:", JSON.stringify(buckets));
console.log(`L1 pass (>=${PASS_THRESHOLD}): ${pass.length} | L2 review: ${review.length}`);
const byHarness: Record<string, number> = {};
for (const r of review) byHarness[r.harness] = (byHarness[r.harness] ?? 0) + 1;
console.log("review by harness:", JSON.stringify(byHarness));

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, `anchor-check-${kind}.json`),
  JSON.stringify(results.map((r) => ({ candidateHash: r.candidateHash, harness: r.harness, overlap: Number(r.overlap.toFixed(3)) })), null, 1),
);
const md: string[] = [`# anchor 低重叠人工核对清单 · ${kind}（${review.length} 条）`, "", "逐条判：anchor 是否语义支撑 text（provenance 核对）。`verdict` 填 legit / mismatch。", ""];
review.forEach((r, i) => {
  md.push(`## ${i + 1}. overlap=${r.overlap.toFixed(3)} 〔${r.harness}〕 ${r.candidateHash.slice(0, 12)}`);
  md.push(`- text: ${r.text}`);
  md.push(`- anchor: ${r.anchor}`);
  md.push(`- evidence: ${r.evidence.map((e) => e.slice(0, 100)).join(" ⁄⁄ ")}`);
  md.push(`- verdict: `);
  md.push("");
});
writeFileSync(join(outDir, `anchor-review-${kind}.md`), md.join("\n"));
console.log(`written: anchor-check-${kind}.json + anchor-review-${kind}.md`);
