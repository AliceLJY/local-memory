#!/usr/bin/env bun
/**
 * pivot-apply Stage 3 物理批执行器（plan v2）
 *
 * 职责：读 reviewed-allowlist → fail-closed 校验 → 停写状态断言 → 写批前现库
 * key 复扫 → persistPivotBatch（非预期 disposition 即停）→ ledger 逐条落盘。
 *
 * 编排契约（谁在外层做什么）：
 *   - 本脚本必须在 supervisor 停写窗口 + 表级快照之后运行。外层序列：
 *       supervisor -- '(snapshot.sh snapshot <dir> && runner … && query-gate check …)'
 *   - 脚本自带停写断言：SUPERVISED_TASKS 里 required 任务仍在 launchctl 挂载则拒跑
 *   - halt / gate fail 后的还原由外层用 snapshot.sh restore 执行（有损动作不自动做）
 *
 * allowlist 行格式（Stage 2 产出）：
 *   { sessionId, sessionFingerprint, reportId, candidateHash, decision: "approve"|"reject",
 *     reason, payloadHash, batchId, kind }
 *
 * 用法：
 *   bun scripts/pivot-apply-runner.ts <reviewed-allowlist.jsonl> <batchId> \
 *     [--db-path <lancedb-dir>] [--ledger <ledger.jsonl>] [--skip-stop-assert]
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

import * as lancedb from "@lancedb/lancedb";

import { createAuditLogger } from "../src/audit-log.js";
import { ConflictCandidateStore } from "../src/conflict-store.js";
import { persistPivotBatch, PIVOT_SCOPE } from "../src/pivot-apply.js";
import { createComponents, loadConfig } from "../src/runtime-config.js";
import { SUPERVISED_TASKS } from "./pivot-distill-supervisor.js";
import { createHash } from "node:crypto";

const RESULTS_DIR = resolve(process.env.HOME ?? "", "pivot-distill-runs/20260803/full/results");
const EXPECTED_REPORT_ID = "00b609834309b7b44d1e36fc7c93169e083abb66487073bfd64d8c5bafc337fa";
const MAX_PHYSICAL_BATCH = 300;

interface AllowlistRow {
  sessionId: string;
  sessionFingerprint: string;
  reportId: string;
  candidateHash: string;
  decision: string;
  reason: string;
  payloadHash: string;
  batchId: string;
  kind: string;
  importance?: number;
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

function die(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

function assertWritersStopped(): void {
  const out = execSync("launchctl list", { encoding: "utf8" });
  const stillLoaded = SUPERVISED_TASKS.filter(
    (t) => t.tier === "required" && out.includes(t.label),
  ).map((t) => t.label);
  if (stillLoaded.length > 0) {
    die(
      `stop-write assertion failed — required writer tasks still loaded:\n  ${stillLoaded.join("\n  ")}\n` +
        "Run inside the supervisor window (pivot-distill-supervisor.ts --mode sync-only -- …).",
    );
  }
}

interface RebuiltCandidate {
  kind: string;
  text: string;
  anchor: string;
  canonicalKey: string;
  evidence: string[];
  proposedScope: string;
  proposedCategory: string;
  tags: string[];
  sessionId: string;
  reportId: string;
  candidateHash: string;
  batchId: string;
  importance: number;
}

function rebuildCandidates(rows: AllowlistRow[], batchId: string): RebuiltCandidate[] {
  const byFp = new Map<string, AllowlistRow[]>();
  for (const r of rows) {
    const list = byFp.get(r.sessionFingerprint) ?? [];
    list.push(r);
    byFp.set(r.sessionFingerprint, list);
  }
  const out: RebuiltCandidate[] = [];
  for (const [fp, group] of byFp) {
    const path = join(RESULTS_DIR, `${fp}.json`);
    if (!existsSync(path)) die(`result file missing for fingerprint ${fp}`);
    const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const cands = (d.candidates as Array<Record<string, unknown>>) ?? [];
    for (const row of group) {
      // 用 candidateHash 反查：重算每条的 hash 找到唯一匹配 —— 内容寻址，杜绝错位
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
      if (!match) die(`candidateHash ${row.candidateHash.slice(0, 12)} not found in ${fp} (content drifted?)`);
      out.push({
        kind: match.kind as string,
        text: match.text as string,
        anchor: match.anchor as string,
        canonicalKey: match.canonicalKey as string,
        evidence: match.evidence as string[],
        proposedScope: match.proposedScope as string,
        proposedCategory: match.proposedCategory as string,
        tags: match.tags as string[],
        sessionId: row.sessionId,
        reportId: row.reportId,
        candidateHash: row.candidateHash,
        batchId,
        importance: row.importance ?? 0.7,
      });
    }
  }
  return out;
}

async function precheckLiveKeys(dbPath: string, batch: RebuiltCandidate[]): Promise<void> {
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable("memories");
  const rows = await table.query().select(["id", "scope", "metadata"]).toArray();
  const liveKeys = new Set<string>();
  for (const row of rows) {
    try {
      const m = JSON.parse((row.metadata as string) || "{}") as Record<string, unknown>;
      const boundary = m.boundary as Record<string, unknown> | undefined;
      const evolution = m.evolution as Record<string, unknown> | undefined;
      if (boundary?.layer !== "durable") continue;
      if ((evolution?.status ?? "active") !== "active") continue;
      if (typeof m.canonicalKey === "string") liveKeys.add(m.canonicalKey);
    } catch {
      /* unparseable metadata never blocks the scan */
    }
  }
  const collisions = batch.filter((c) => liveKeys.has(c.canonicalKey));
  if (collisions.length > 0) {
    die(
      `write-time key precheck failed — ${collisions.length} candidate key(s) now collide with live durable rows ` +
        `(the pool moved since prescreen):\n  ${collisions.map((c) => c.canonicalKey).slice(0, 10).join("\n  ")}\n` +
        "Re-run prescreen R5 against the current pool before applying this batch.",
    );
  }
  console.log(`write-time key precheck OK: 0 collisions against ${liveKeys.size} live durable keys`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const [allowlistPath, batchId] = positional;
  if (!allowlistPath || !batchId) {
    console.error("usage: bun scripts/pivot-apply-runner.ts <reviewed-allowlist.jsonl> <batchId> [--db-path <dir>] [--ledger <file>] [--skip-stop-assert]");
    process.exit(1);
  }
  const dbPathArg = args.includes("--db-path") ? args[args.indexOf("--db-path") + 1] : undefined;
  const ledgerPath = args.includes("--ledger")
    ? args[args.indexOf("--ledger") + 1]
    : resolve(process.env.HOME ?? "", "pivot-distill-runs/20260803/apply/ledger.jsonl");
  const skipStopAssert = args.includes("--skip-stop-assert");

  // ---- fail-closed allowlist 校验 ----
  const lines = readFileSync(allowlistPath, "utf8").trim().split("\n");
  const rows = lines.map((l, i) => {
    try {
      return JSON.parse(l) as AllowlistRow;
    } catch {
      return die(`allowlist line ${i + 1} is not valid JSON`);
    }
  });
  const required: Array<keyof AllowlistRow> = ["sessionId", "sessionFingerprint", "reportId", "candidateHash", "decision", "reason", "payloadHash", "batchId"];
  rows.forEach((r, i) => {
    for (const k of required) {
      if (!r[k]) die(`allowlist line ${i + 1} missing field "${k}"`);
    }
    if (r.reportId !== EXPECTED_REPORT_ID) die(`allowlist line ${i + 1} has foreign reportId ${r.reportId.slice(0, 12)}`);
    if (r.batchId !== batchId) die(`allowlist line ${i + 1} belongs to batch "${r.batchId}", not "${batchId}"`);
  });
  const hashes = new Set(rows.map((r) => r.candidateHash));
  if (hashes.size !== rows.length) die(`allowlist has duplicate candidateHash entries (${rows.length} rows, ${hashes.size} unique)`);
  const approved = rows.filter((r) => r.decision === "approve");
  if (approved.length === 0) die("allowlist has no approved rows");
  if (approved.length > MAX_PHYSICAL_BATCH) die(`physical batch too large: ${approved.length} > ${MAX_PHYSICAL_BATCH}`);
  console.log(`allowlist OK: ${rows.length} rows, ${approved.length} approved, batch ${batchId}`);

  // ---- 重建候选全文（内容寻址）并校验 payloadHash ----
  const batch = rebuildCandidates(approved, batchId);
  if (batch.length !== approved.length) die(`rebuilt ${batch.length} != approved ${approved.length}`);
  for (const row of approved) {
    const cand = batch.find((c) => c.candidateHash === row.candidateHash);
    if (!cand) die(`rebuilt candidate missing for ${row.candidateHash.slice(0, 12)}`);
    const payloadHash = sha256(canonicalJson({
      kind: cand.kind,
      text: cand.text,
      anchor: cand.anchor,
      canonicalKey: cand.canonicalKey,
      evidence: cand.evidence,
      proposedScope: cand.proposedScope,
      proposedCategory: cand.proposedCategory,
      tags: cand.tags,
      importance: cand.importance,
    }));
    if (payloadHash !== row.payloadHash) {
      die(`payloadHash mismatch for ${row.candidateHash.slice(0, 12)} — allowlist approved a different payload than what would be written`);
    }
  }
  console.log("payloadHash verification OK: every approved row matches its rebuild");

  // ---- 停写断言 + 写批前 key 复扫 ----
  if (skipStopAssert) console.log("WARN: --skip-stop-assert (replica rehearsal only — never for production)");
  else assertWritersStopped();

  const config = dbPathArg ? { ...loadConfig(), dbPath: resolve(dbPathArg) } : loadConfig();
  const { store, embedder } = createComponents(config);
  const dbPathResolved = dbPathArg ? resolve(dbPathArg) : resolve(process.env.HOME ?? "", "Projects/recallnest/data/lancedb");
  await precheckLiveKeys(dbPathResolved, batch);

  const conflictStore = new ConflictCandidateStore();
  const auditLogger = createAuditLogger();
  const deps = { store, embedder, conflictStore, auditLogger };

  // ---- 写批（fail-closed）+ ledger ----
  const report = await persistPivotBatch(deps as never, batchId, batch as unknown as Record<string, unknown>[]);
  for (const o of report.outcomes) {
    appendFileSync(
      ledgerPath,
      JSON.stringify({
        at: new Date().toISOString(),
        batchId,
        candidateHash: o.candidateHash,
        memoryId: o.memoryId,
        disposition: o.disposition,
        ...(o.conflictId ? { conflictId: o.conflictId } : {}),
        ...(o.rejectionReason ? { rejectionReason: o.rejectionReason } : {}),
        piiRedactedCount: o.piiRedactedCount,
        canonicalKey: o.canonicalKey,
        verified: o.verified,
        ...(o.verifyIssues.length > 0 ? { verifyIssues: o.verifyIssues } : {}),
      }) + "\n",
    );
  }
  console.log(`ledger appended: ${report.outcomes.length} rows -> ${ledgerPath}`);
  console.log(JSON.stringify({ batchId, total: report.total, written: report.written, halted: report.halted, haltReason: report.haltReason ?? null }, null, 2));
  if (report.halted) {
    console.error("BATCH HALTED — restore the pre-batch snapshot before retrying:");
    console.error("  bash scripts/pivot-apply-snapshot.sh restore <snapshot-dir>");
    process.exit(2);
  }
  console.log("BATCH OK — run the query gate before committing this batch.");
}

await main();
