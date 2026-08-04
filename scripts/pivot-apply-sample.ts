#!/usr/bin/env bun
/**
 * pivot-apply Stage 2 分层抽验采样器（plan v2）
 *
 * 从预筛干净池按 kind 抽一批 30 条 = 随机基底 + 强制风险哨兵配额：
 *   - agy/kimi 来源合计 ≥3（纯随机有 24–50% 概率完全漏掉小 harness 子群）
 *   - anchor 长度 top ≥2
 *   - text 最短 ≥2
 *   - 每个 harness ≥2
 *   子群在该批不足配额时全取该子群，不因配额缺口阻塞（plan R3 后补条款）。
 *
 * 随机基底用 seed 化 PRNG（mulberry32，seed = batchId 哈希）——同参数同样本，可复现。
 * 输出：
 *   sample-<kind>-r<round>.json   30 条全文（含哨兵身份，供裁决核对；呈现时不标）
 *   sample-<kind>-r<round>.md     给 Alice 的呈现稿（key 词根粗聚类分节，每条编号+上下文）
 *
 * 用法：bun scripts/pivot-apply-sample.ts <draft.jsonl> <kind> <round> <out-dir>
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const RESULTS_DIR = resolve(process.env.HOME ?? "", "pivot-distill-runs/20260803/full/results");
const BATCH_SIZE = 30;

interface DraftRow {
  candidateHash: string;
  sessionId: string;
  sessionFingerprint: string;
  reportId: string;
  kind: string;
  proposedCategory: string;
  canonicalKey: string;
  harness: string;
  anchorLength: number;
  textLength: number;
  marks: string[];
}

interface FullCandidate extends DraftRow {
  text: string;
  anchor: string;
  evidence: string[];
  tags: string[];
  date: string;
  sentinel: string[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(arr: T[], seedStr: string): T[] {
  const seed = parseInt(createHash("sha256").update(seedStr).digest("hex").slice(0, 8), 16);
  const rand = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function loadFull(rows: DraftRow[]): FullCandidate[] {
  const byFingerprint = new Map<string, DraftRow[]>();
  for (const r of rows) {
    const list = byFingerprint.get(r.sessionFingerprint) ?? [];
    list.push(r);
    byFingerprint.set(r.sessionFingerprint, list);
  }
  const out: FullCandidate[] = [];
  for (const [fp, drafts] of byFingerprint) {
    const d = JSON.parse(readFileSync(join(RESULTS_DIR, `${fp}.json`), "utf8")) as Record<string, unknown>;
    const cands = (d.candidates as Array<Record<string, unknown>>) ?? [];
    for (const draft of drafts) {
      const match = cands.find(
        (c) => c.canonicalKey === draft.canonicalKey && (c.text as string).length === draft.textLength,
      );
      if (!match) throw new Error(`candidate not found in ${fp}: ${draft.canonicalKey}`);
      const tags = (match.tags as string[]) ?? [];
      out.push({
        ...draft,
        text: match.text as string,
        anchor: match.anchor as string,
        evidence: (match.evidence as string[]) ?? [],
        tags,
        date: tags.find((t) => t.startsWith("date:"))?.slice(5) ?? "?",
        sentinel: [],
      });
    }
  }
  return out;
}

function pickBatch(pool: FullCandidate[], kind: string, round: number): FullCandidate[] {
  const seedStr = `pivot-apply:${kind}:r${round}`;
  const chosen = new Map<string, FullCandidate>();
  const take = (c: FullCandidate, label: string): void => {
    const existing = chosen.get(c.candidateHash);
    if (existing) {
      if (!existing.sentinel.includes(label)) existing.sentinel.push(label);
      return;
    }
    chosen.set(c.candidateHash, { ...c, sentinel: [label] });
  };

  // 哨兵 1：agy/kimi ≥3（子群不足全取）
  const smallHarness = seededShuffle(pool.filter((c) => c.harness === "agy" || c.harness === "kimi"), seedStr + ":agykimi");
  for (const c of smallHarness.slice(0, 3)) take(c, "agy-kimi");
  // 哨兵 2：anchor 长度 top ≥2
  for (const c of [...pool].sort((a, b) => b.anchorLength - a.anchorLength).slice(0, 2)) take(c, "anchor-top");
  // 哨兵 3：text 最短 ≥2
  for (const c of [...pool].sort((a, b) => a.textLength - b.textLength).slice(0, 2)) take(c, "text-shortest");
  // 哨兵 4：每 harness ≥2（子群不足全取）
  const harnesses = [...new Set(pool.map((c) => c.harness))];
  for (const h of harnesses) {
    const sub = seededShuffle(pool.filter((c) => c.harness === h), `${seedStr}:h:${h}`);
    let have = [...chosen.values()].filter((c) => c.harness === h).length;
    for (const c of sub) {
      if (have >= 2) break;
      if (!chosen.has(c.candidateHash)) {
        take(c, `harness:${h}`);
        have++;
      }
    }
  }
  // 随机基底补满 30
  for (const c of seededShuffle(pool, seedStr + ":base")) {
    if (chosen.size >= BATCH_SIZE) break;
    if (!chosen.has(c.candidateHash)) take(c, "random");
  }
  return [...chosen.values()];
}

/** key 词根粗聚类：canonicalKey 去掉 pivot-/kind 前缀后的首个有效词
 *  （首词 <3 字符或为否定/虚词时并入次词——r1 批「no」簇教训）。 */
const CLUSTER_STOPWORDS = new Set(["no", "not", "use", "the", "for", "new", "all"]);
function clusterLabel(c: FullCandidate): string {
  const k = c.canonicalKey
    .replace(/^pivot-/, "")
    .replace(/^(preference-rule|preference|judgment-shift|decision|case[s]?)-/, "");
  const parts = k.split("-").filter(Boolean);
  if (parts.length === 0) return "其他";
  const head = parts[0];
  if ((head.length < 3 && !/[一-鿿]/.test(head)) || CLUSTER_STOPWORDS.has(head.toLowerCase())) {
    return parts.length > 1 ? `${head}-${parts[1]}` : head;
  }
  return head;
}

function render(batch: FullCandidate[], kind: string, round: number): string {
  const clusters = new Map<string, FullCandidate[]>();
  for (const c of batch) {
    const label = clusterLabel(c);
    const list = clusters.get(label) ?? [];
    list.push(c);
    clusters.set(label, list);
  }
  // 大簇在前，孤条归入「其他」
  const grouped: Array<[string, FullCandidate[]]> = [];
  const misc: FullCandidate[] = [];
  for (const [label, list] of [...clusters.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (list.length >= 2) grouped.push([label, list]);
    else misc.push(...list);
  }
  if (misc.length > 0) grouped.push(["其他", misc]);

  const lines: string[] = [];
  lines.push(`## ${kind} 批 · 第 ${round} 轮抽验（${batch.length} 条）`);
  lines.push("");
  lines.push(`三选一：**长期有用 / 仅当前项目或任务 / 看不准**。`);
  let idx = 0;
  for (const [label, list] of grouped) {
    lines.push(`### ${label}（${list.length} 条）`);
    for (const c of list) {
      idx++;
      (c as FullCandidate & { displayIndex?: number }).displayIndex = idx;
      lines.push(`**${idx}.** 〔${c.date} · ${c.harness}〕${c.text}`);
      lines.push(`   ↳ 原话锚点：「${c.anchor.length > 120 ? c.anchor.slice(0, 120) + "…" : c.anchor}」`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

const [draftPath, kind, roundStr, outDir] = process.argv.slice(2);
if (!draftPath || !kind || !roundStr || !outDir) {
  console.error("usage: bun scripts/pivot-apply-sample.ts <draft.jsonl> <kind> <round> <out-dir>");
  process.exit(1);
}
const round = Number(roundStr);
const rows = readFileSync(draftPath, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as DraftRow);
const pool = rows.filter((r) => r.kind === kind && r.marks.length === 0);
console.log(`clean pool for kind=${kind}: ${pool.length}`);
if (pool.length === 0) process.exit(1);

const full = loadFull(pool);
const batch = pickBatch(full, kind, round);
mkdirSync(outDir, { recursive: true });
const md = render(batch, kind, round);
const jsonPath = join(outDir, `sample-${kind}-r${round}.json`);
const mdPath = join(outDir, `sample-${kind}-r${round}.md`);
writeFileSync(jsonPath, JSON.stringify(batch, null, 1));
writeFileSync(mdPath, md);
const sentinels = batch.filter((c) => c.sentinel.some((s) => s !== "random"));
console.log(`batch: ${batch.length} | sentinel rows: ${sentinels.length}`);
console.log(`written: ${jsonPath}`);
console.log(`written: ${mdPath}`);
