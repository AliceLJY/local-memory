#!/usr/bin/env bun
/**
 * pivot-apply Stage 2 收尾：把 Alice 的三选一裁决转成 reviewed-allowlist.jsonl
 *
 * 输入：
 *   1. sample-<kind>-r<round>.json（抽验批全文，pivot-apply-sample.ts 产出）
 *   2. decisions.json：{ "<displayIndex 或 candidateHash 前 12 位>": "keep"|"project"|"unsure", ... }
 *      + "default" 键可设默认值（Alice 常用「都长期有用，除了…」的报例外方式）
 *   3. 干净池 draft（allowlist-draft.jsonl）—— 放行时给整池生成 approve 行
 *
 * 语义（plan v2）：
 *   - 抽验批放行判据：哨兵条目全部 keep + 整批 keep ≥27/30 → 整个干净池按批放行
 *   - keep = approve；project / unsure = reject（本轮不写，延期二轮）
 *   - 抽验批里被 Alice 点名 project/unsure 的条目：即使整批放行，该条也 reject
 *   - 每行带 payloadHash（canonical JSON of 实际写入载荷）+ textPreview（检索闸绑定用）
 *
 * 用法：
 *   bun scripts/pivot-apply-allowlist.ts judge  <sample.json> <decisions.json>
 *     —— 只算放行判定，打印哨兵/整批统计，不产出文件
 *   bun scripts/pivot-apply-allowlist.ts emit   <sample.json> <decisions.json> <draft.jsonl> <kind> <batchId> <out.jsonl>
 *     —— 判定通过后给该 kind 干净池生成 reviewed-allowlist（物理批拆分由 runner 的 ≤300 校验倒逼，
 *        本脚本按 <batchId>-p<N> 自动编物理批号）
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const RESULTS_DIR = resolve(process.env.HOME ?? "", "pivot-distill-runs/20260803/full/results");
const EXPECTED_REPORT_ID = "00b609834309b7b44d1e36fc7c93169e083abb66487073bfd64d8c5bafc337fa";
const MAX_PHYSICAL_BATCH = 300;
const KEEP_MIN = 27;

type Decision = "keep" | "project" | "unsure";

interface SampleRow {
  candidateHash: string;
  sessionId: string;
  sessionFingerprint: string;
  kind: string;
  canonicalKey: string;
  harness: string;
  sentinel: string[];
  text: string;
  displayIndex?: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function decisionFor(row: SampleRow, decisions: Record<string, string>): Decision {
  const byIndex = row.displayIndex != null ? decisions[String(row.displayIndex)] : undefined;
  const byHash = decisions[row.candidateHash.slice(0, 12)];
  const raw = byIndex ?? byHash ?? decisions.default;
  if (raw !== "keep" && raw !== "project" && raw !== "unsure") {
    throw new Error(`no decision for sample row ${row.displayIndex ?? row.candidateHash.slice(0, 12)} (set "default" or name it)`);
  }
  return raw;
}

function judge(samplePath: string, decisionsPath: string): { pass: boolean; rejectedHashes: Set<string> } {
  const sample = JSON.parse(readFileSync(samplePath, "utf8")) as SampleRow[];
  const decisions = JSON.parse(readFileSync(decisionsPath, "utf8")) as Record<string, string>;
  let keep = 0;
  const rejectedHashes = new Set<string>();
  const sentinelFails: string[] = [];
  for (const row of sample) {
    const d = decisionFor(row, decisions);
    if (d === "keep") keep++;
    else {
      rejectedHashes.add(row.candidateHash);
      const isSentinel = row.sentinel.some((s) => s !== "random");
      if (isSentinel) sentinelFails.push(`#${row.displayIndex ?? "?"} [${row.sentinel.join(",")}] -> ${d}`);
    }
  }
  const batchOk = keep >= KEEP_MIN;
  const sentinelOk = sentinelFails.length === 0;
  console.log(`keep ${keep}/${sample.length} (min ${KEEP_MIN}) -> ${batchOk ? "OK" : "FAIL"}`);
  console.log(`sentinels all-keep -> ${sentinelOk ? "OK" : "FAIL"}`);
  for (const s of sentinelFails) console.log(`  sentinel not-keep: ${s}`);
  const pass = batchOk && sentinelOk;
  console.log(pass ? "BATCH RELEASE: PASS（该 kind 干净池按批放行）" : "BATCH RELEASE: FAIL（归纳规则请 Alice 确认后回 Stage 1 重筛，≤2 轮）");
  return { pass, rejectedHashes };
}

function emit(
  samplePath: string,
  decisionsPath: string,
  draftPath: string,
  kind: string,
  batchIdBase: string,
  outPath: string,
): void {
  const { pass, rejectedHashes } = judge(samplePath, decisionsPath);
  if (!pass) {
    console.error("refusing to emit an allowlist for a failed batch");
    process.exit(2);
  }
  const draft = readFileSync(draftPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { candidateHash: string; sessionId: string; sessionFingerprint: string; reportId: string; kind: string; canonicalKey: string; marks: string[] });
  const pool = draft.filter((r) => r.kind === kind && r.marks.length === 0);
  if (pool.length === 0) throw new Error(`empty clean pool for kind=${kind}`);

  // 全文重建（payloadHash + textPreview 需要正文）
  const byFp = new Map<string, typeof pool>();
  for (const r of pool) {
    const list = byFp.get(r.sessionFingerprint) ?? [];
    list.push(r);
    byFp.set(r.sessionFingerprint, list);
  }
  const lines: string[] = [];
  let physIdx = 1;
  let inBatch = 0;
  let approved = 0;
  let rejected = 0;
  for (const [fp, group] of byFp) {
    const path = join(RESULTS_DIR, `${fp}.json`);
    if (!existsSync(path)) throw new Error(`result file missing: ${fp}`);
    const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const cands = (d.candidates as Array<Record<string, unknown>>) ?? [];
    for (const row of group) {
      const match = cands.find((c) => {
        const payload = canonicalJson({
          sessionFingerprint: fp,
          kind: c.kind,
          text: c.text,
          anchor: c.anchor,
          canonicalKey: c.canonicalKey,
          evidence: c.evidence,
          proposedScope: c.proposedScope,
          proposedCategory: c.proposedCategory,
          tags: c.tags,
        });
        return sha256(payload) === row.candidateHash;
      });
      if (!match) throw new Error(`candidate rebuild failed for ${row.candidateHash.slice(0, 12)} in ${fp}`);
      const importance = 0.7;
      const payloadHash = sha256(canonicalJson({
        kind: match.kind,
        text: match.text,
        anchor: match.anchor,
        canonicalKey: match.canonicalKey,
        evidence: match.evidence,
        proposedScope: match.proposedScope,
        proposedCategory: match.proposedCategory,
        tags: match.tags,
        importance,
      }));
      const isRejected = rejectedHashes.has(row.candidateHash);
      if (inBatch >= MAX_PHYSICAL_BATCH) {
        physIdx++;
        inBatch = 0;
      }
      const batchId = `${batchIdBase}-p${physIdx}`;
      lines.push(JSON.stringify({
        sessionId: row.sessionId,
        sessionFingerprint: row.sessionFingerprint,
        reportId: EXPECTED_REPORT_ID,
        candidateHash: row.candidateHash,
        decision: isRejected ? "reject" : "approve",
        reason: isRejected
          ? `alice-review r1: not-keep in sample (${batchIdBase})`
          : `alice-review r1: batch released, sentinel+${KEEP_MIN}/30 passed (${batchIdBase}, rules v2)`,
        payloadHash,
        batchId,
        kind,
        importance,
        textPreview: (match.text as string).slice(0, 120),
      }));
      if (isRejected) rejected++;
      else {
        approved++;
        inBatch++;
      }
    }
  }
  writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(`allowlist written: ${outPath}`);
  console.log(`rows ${lines.length} | approve ${approved} | reject ${rejected} | physical batches ${physIdx} (≤${MAX_PHYSICAL_BATCH} approve rows each)`);
}

const args = process.argv.slice(2);
if (args[0] === "judge" && args[1] && args[2]) {
  judge(args[1], args[2]);
} else if (args[0] === "emit" && args.length >= 7) {
  emit(args[1], args[2], args[3], args[4], args[5], args[6]);
} else {
  console.error("usage: judge <sample.json> <decisions.json> | emit <sample.json> <decisions.json> <draft.jsonl> <kind> <batchIdBase> <out.jsonl>");
  process.exit(1);
}
