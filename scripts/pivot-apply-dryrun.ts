#!/usr/bin/env bun
/**
 * pivot-apply 生产副本 dry-run（plan v2 Stage 0）
 *
 * 在生产库的 APFS 克隆副本上按真实链路（真 store、真 Jina embedder、真
 * conflict store）跑混合形态 fixture，断言每个 disposition 与预期完全一致，
 * 任何非预期 fail-closed 退出非零。
 *
 * 形态覆盖：
 *   1 新建 stored          2 修订 updated（preferences latest-wins，canonical id 不变）
 *   3 去重 deduped         4 跨类目冲突 conflict（零写入）
 *   5 噪音拒绝 rejected     7 跨 scope 撞 key（证明写入匹配面是全库 durable 层 → R5 必须全库比对）
 *   6 中途崩溃恢复由外层 bash 序列演（写批 halt → restore 快照 → 重跑全批）
 *
 * 用法：bun scripts/pivot-apply-dryrun.ts <replica-lancedb-dir> <workdir> [--phase=main|crash-batch|post-restore-batch]
 */
import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import * as lancedb from "@lancedb/lancedb";

import { createAuditLogger } from "../src/audit-log.js";
import { buildStructuredMetadata, writeDurableEntry } from "../src/capture-engine.js";
import { ConflictCandidateStore } from "../src/conflict-store.js";
import { detectLang, tokenizeFts } from "../src/language-hook.js";
import {
  PIVOT_SCOPE,
  persistPivotBatch,
  persistPivotCandidate,
} from "../src/pivot-apply.js";
import { loadConfig, createComponents, resolveDbPath } from "../src/runtime-config.js";

const REPORT_ID = "00b609834309b7b44d1e36fc7c93169e083abb66487073bfd64d8c5bafc337fa";
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

function cand(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "preference_rule",
    text: "dry-run 基准候选：验证 apply 通道在生产副本上的确定性行为，本行不短于三十字符。",
    anchor: "dry-run anchor 原话锚点样例。",
    canonicalKey: "pivot-dryrun-base-key",
    evidence: ["dry-run evidence 原文片段。"],
    proposedScope: PIVOT_SCOPE,
    proposedCategory: "preferences",
    tags: ["src:dryrun00", "date:2026-08-04", "harness:claude-code", "raw:claude"],
    sessionId: "dryrun-session-00000000",
    reportId: REPORT_ID,
    candidateHash: hash("a"),
    batchId: "dryrun-batch-1",
    importance: 0.7,
    ...overrides,
  };
}

const failures: string[] = [];
function assertEq(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${String(actual)}${ok ? "" : ` (expected ${String(expected)})`}`);
  if (!ok) failures.push(label);
}

async function main(): Promise<void> {
  const [replicaPath, workdir, ...rest] = process.argv.slice(2);
  if (!replicaPath || !workdir) {
    console.error("usage: bun scripts/pivot-apply-dryrun.ts <replica-lancedb-dir> <workdir> [--phase=main]");
    process.exit(1);
  }
  const phase = (rest.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "main") as
    | "main"
    | "crash-batch"
    | "post-restore-batch";

  const replica = resolve(replicaPath);
  // realpath both sides: the configured dbPath reaches production through a
  // symlink (~/recallnest/data/lancedb -> ~/Projects/recallnest/data/lancedb),
  // so a plain string compare would only refuse one of the two spellings.
  const realOrSelf = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  if (realOrSelf(replica) === realOrSelf(resolveDbPath(loadConfig()))) {
    console.error("REFUSING to run a dry-run against the production database path");
    process.exit(1);
  }
  mkdirSync(workdir, { recursive: true });

  const config = { ...loadConfig(), dbPath: replica };
  const { store, embedder } = createComponents(config);
  const conflictStore = new ConflictCandidateStore(resolve(workdir, "conflict-candidates"));
  const auditLogger = createAuditLogger(resolve(workdir, "audit.jsonl"));
  const deps = { store, embedder, conflictStore, auditLogger };

  const countRows = async (): Promise<number> => {
    const db = await lancedb.connect(replica);
    const table = await db.openTable("memories");
    return table.countRows();
  };

  const rowsBefore = await countRows();
  console.log(`replica rows before: ${rowsBefore} | phase: ${phase}`);

  if (phase === "crash-batch") {
    // 形态 6 上半场：批中第 2 条与第 1 条同 key 同文本 → deduped → fail-closed halt，
    // 第 3 条永不尝试。外层脚本随后 restore 快照，再跑 post-restore-batch。
    const batch = [
      cand({ candidateHash: hash("1"), canonicalKey: "pivot-dryrun-crash-key-1", text: "崩溃演练第一条：正常写入的候选文本，长度超过三十个字符没问题。" }),
      cand({ candidateHash: hash("2"), canonicalKey: "pivot-dryrun-crash-key-1", text: "崩溃演练第一条：正常写入的候选文本，长度超过三十个字符没问题。" }),
      cand({ candidateHash: hash("3"), canonicalKey: "pivot-dryrun-crash-key-3", text: "崩溃演练第三条：halt 之后绝不该被尝试写入的候选文本。" }),
    ];
    const report = await persistPivotBatch(deps as never, "dryrun-batch-1", batch);
    assertEq("crash-batch halted", report.halted, true);
    assertEq("crash-batch written before halt", report.written, 1);
    assertEq("crash-batch outcomes recorded", report.outcomes.length, 2);
  } else if (phase === "post-restore-batch") {
    // 形态 6 下半场：还原快照后同批重跑（修正第 2 条为独立 key），应全量写入成功。
    const batch = [
      cand({ candidateHash: hash("1"), canonicalKey: "pivot-dryrun-crash-key-1", text: "崩溃演练第一条：正常写入的候选文本，长度超过三十个字符没问题。" }),
      cand({ candidateHash: hash("2"), canonicalKey: "pivot-dryrun-crash-key-2", text: "崩溃演练修正第二条：换成独立 key 后应正常写入的候选文本。" }),
      cand({ candidateHash: hash("3"), canonicalKey: "pivot-dryrun-crash-key-3", text: "崩溃演练第三条：halt 之后绝不该被尝试写入的候选文本。" }),
    ];
    const report = await persistPivotBatch(deps as never, "dryrun-batch-1", batch);
    assertEq("post-restore batch clean", report.halted, false);
    assertEq("post-restore written", report.written, 3);
  } else {
    // ---- 形态 1：新建 ----
    const stored = await persistPivotCandidate(deps as never, cand({}));
    assertEq("1 stored disposition", stored.disposition, "stored");
    assertEq("1 stored verified", stored.verified, true);

    // ---- 形态 3：同 key 同文本 → deduped ----
    const deduped = await persistPivotCandidate(deps as never, cand({ candidateHash: hash("b") }));
    assertEq("3 deduped disposition", deduped.disposition, "deduped");
    assertEq("3 deduped id equals original", deduped.memoryId, stored.memoryId);

    // ---- 形态 2：同 key 不同文本（preferences latest-wins）→ updated，canonical id 不变 ----
    const updated = await persistPivotCandidate(
      deps as never,
      cand({ candidateHash: hash("c"), text: "dry-run 修订版候选：同 key 新文本应触发 latest-wins 原地修订，旧版归档为历史行。" }),
    );
    assertEq("2 updated disposition", updated.disposition, "updated");
    assertEq("2 canonical id stable", updated.memoryId, stored.memoryId);
    assertEq("2 updated verified", updated.verified, true);

    // ---- 形态 4：跨类目同 key → conflict，零写入 ----
    const before4 = await countRows();
    const conflict = await persistPivotCandidate(
      deps as never,
      cand({
        kind: "decision",
        proposedCategory: "events",
        candidateHash: hash("d"),
        text: "dry-run 冲突演练：同一 key 被 events 类目引用时必须报 conflict 并拒绝写入。",
      }),
    );
    const after4 = await countRows();
    assertEq("4 conflict disposition", conflict.disposition, "conflict");
    assertEq("4 conflict has conflictId", Boolean(conflict.conflictId), true);
    assertEq("4 conflict wrote nothing", after4, before4);

    // ---- 形态 5：噪音 → rejected，零写入 ----
    const rejected = await persistPivotCandidate(
      deps as never,
      cand({ candidateHash: hash("e"), canonicalKey: "pivot-dryrun-noise-key", text: "好的好的，收到收到。" }),
    );
    assertEq("5 rejected disposition", rejected.disposition, "rejected");
    assertEq("5 rejected null memoryId", rejected.memoryId, null);

    // ---- 形态 7：跨 scope 撞 key（写入匹配面是全库 durable 层的实证）----
    // 先以正常 durable 形态往另一个 scope 写一行，再用同 key 提交 pivot 候选。
    const probeKey = "pivot-dryrun-cross-scope-probe";
    const probeText = "跨 scope 探针行：先落在 memory:dryrun-probe scope 的 durable 行。";
    const probeVector = await embedder.embedPassage(probeText);
    await writeDurableEntry(deps as never, {
      text: probeText,
      vector: probeVector,
      category: "preferences",
      scope: "memory:dryrun-probe",
      importance: 0.7,
      metadata: buildStructuredMetadata({
        source: "agent",
        tags: ["dryrun-probe"],
        capture: "dryrun_probe_v1",
        category: "preferences",
        canonicalKey: probeKey,
      }),
      canonicalKey: probeKey,
      source: "agent",
      language: detectLang(probeText),
      fts_text: tokenizeFts(probeText, detectLang(probeText)),
    });
    const crossScope = await persistPivotCandidate(
      deps as never,
      cand({
        candidateHash: hash("f"),
        canonicalKey: probeKey,
        text: "跨 scope 撞 key 的 pivot 候选：验证同 key 匹配不受 scope 边界保护。",
      }),
    );
    // 同 category (preferences) + 同 key + 不同文本 → latest-wins 会修订**另一个 scope 的行**。
    // 这就是 R5 必须做全库比对的实证：预期 updated（而非 stored）。
    assertEq("7 cross-scope collision disposition", crossScope.disposition, "updated");

    const rowsAfter = await countRows();
    console.log(`replica rows after: ${rowsAfter} (delta ${rowsAfter - rowsBefore})`);
  }

  if (failures.length > 0) {
    console.error(`\nDRY-RUN FAILED: ${failures.length} assertion(s) failed: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("\nDRY-RUN PHASE OK");
  process.exit(0);
}

await main();
