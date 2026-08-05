#!/usr/bin/env bun
/**
 * pivot-apply Stage 4 机器可读检索闸（plan v2）
 *
 * freeze（写批前，快照窗口内）：
 *   - gold 20 query（固化自 eval/la1-shadow/shadow.sh）各跑一次，记录写前 Top-10 id 基线
 *   - 本批 approved 候选抽 ≤10 条代表，绑定 query = 候选 text 前 60 字符（自身语义自然应召回自身）
 *   - 负向探针集：与 pivot 池正交的固定日常主题 query
 *   输出 query-manifest-<batchId>.json（冻结，check 阶段只读它）
 *
 * check（写批后，同窗口内）：
 *   ① 绑定 query：该候选写入的 memoryId 进 Top-10（rank ≤10）
 *   ② gold 回归：每条 gold query 写前 Top-3 成员，写后仍在 Top-10 内；批级 ≥19/20 条 query 通过
 *   ③ 负向探针：探针 query Top-3 内零本批 memoryId；批级零侵入
 *   任一层不过 → exit 2（外层还原快照）
 *
 * 分数纪律：只比 rank/集合，绝不比分数绝对值——管线含 access-count/hotness/frequency
 * 流行度信号，重复查询会抬分（LA-1 shadow 实证 0.710→0.946），rank 集合比较不受影响。
 *
 * 用法：
 *   bun scripts/pivot-apply-query-gate.ts freeze <approved-allowlist.jsonl> <batchId> <out-manifest.json> [--db-path <dir>]
 *   bun scripts/pivot-apply-query-gate.ts check  <manifest.json> <ledger.jsonl> <batchId> [--db-path <dir>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createComponents, loadConfig } from "../src/runtime-config.js";

const GOLD_QUERIES: readonly string[] = [
  "双机 契约 同步 漂移",
  "公众号 配图 排版",
  "deja 索引 会话检索",
  "记忆衰减 召回 命中率",
  "bot 挂了 容器 重启",
  "hippo wiki 装订 活页",
  "凭证 脱敏 泄露",
  "worktree 隔离 后台会话",
  "写文章 选题 真空",
  "codex 调用 headless",
  "kimi 封装 看门狗",
  "launchd 定时任务 失败",
  "小红书 搜索 socai",
  "生图 兜底 通道",
  "open-loops 闭环 验收",
  "skill 瘦身 触发面",
  "互审 冷读 隔离",
  "磁盘 空间 清理",
  "周报 视频 管线",
  "借鉴 审计 三写",
];

const NEGATIVE_PROBES: readonly string[] = [
  "广州 演出 排期 剧场",
  "AWS 账单 抵扣金 到期",
  "小说 章节 剧情 走向",
  "微信 支付 报销 发票",
  "天气 出行 航班 酒店",
];

const BOUND_SAMPLE = 10;
const GOLD_PASS_MIN = 19;

interface RetrieverLike {
  retrieve(ctx: { query: string; limit: number }): Promise<Array<{ entry: { id: string } }>>;
}

async function topIds(retriever: RetrieverLike, query: string, k: number): Promise<string[]> {
  const results = await retriever.retrieve({ query, limit: k });
  return results.map((r) => r.entry.id);
}

function buildComponents(dbPathArg?: string): RetrieverLike {
  const config = dbPathArg ? { ...loadConfig(), dbPath: resolve(dbPathArg) } : loadConfig();
  const { retriever } = createComponents(config) as unknown as { retriever: RetrieverLike };
  return retriever;
}

async function freeze(allowlistPath: string, batchId: string, outPath: string, dbPathArg?: string): Promise<void> {
  const rows = readFileSync(allowlistPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { candidateHash: string; decision: string; batchId: string; textPreview?: string });
  const approved = rows.filter((r) => r.decision === "approve" && r.batchId === batchId);
  if (approved.length === 0) throw new Error("no approved rows for this batch");
  const withPreview = approved.filter((r) => typeof r.textPreview === "string" && r.textPreview.length >= 20);
  if (withPreview.length === 0) {
    throw new Error("allowlist rows carry no textPreview — Stage 2 must emit textPreview (first 120 chars) for gate binding");
  }
  const step = Math.max(1, Math.floor(withPreview.length / BOUND_SAMPLE));
  const bound = withPreview.filter((_, i) => i % step === 0).slice(0, BOUND_SAMPLE);

  const retriever = buildComponents(dbPathArg);
  const gold: Array<{ query: string; baselineTop10: string[] }> = [];
  for (const q of GOLD_QUERIES) {
    gold.push({ query: q, baselineTop10: await topIds(retriever, q, 10) });
  }
  const manifest = {
    batchId,
    frozenAt: new Date().toISOString(),
    // k=20（retriever clamp 上限）。首跑 k=10 在「临床意义」这类高密度主题区
    // 误伤：候选写入成功且 verified，但被同族老内容挤出前十（2026-08-05 p2 实测）。
    // 闸的语义是「写入后可被检索到」，rank≤20 在 145k 行库里仍是强召回证明。
    k: 20,
    goldPassMin: GOLD_PASS_MIN,
    gold,
    bound: bound.map((r) => ({
      candidateHash: r.candidateHash,
      query: (r.textPreview as string).slice(0, 60),
    })),
    negativeProbes: [...NEGATIVE_PROBES],
    // probe baseline：真空区判据用。批行进 top-3 但没挤出任何 baseline 成员
    // （= 填的是本就空/弱的位）不算侵入——r2-admit-p1 实测「微信 支付 报销 发票」
    // 主题真空，批行 cosine 仅 0.406 也进了 top-3，绝对占位判据在真空区必误伤。
    probeBaselines: await (async () => {
      const out: Record<string, string[]> = {};
      for (const q of NEGATIVE_PROBES) out[q] = await topIds(retriever, q, 3);
      return out;
    })(),
  };
  writeFileSync(outPath, JSON.stringify(manifest, null, 1));
  console.log(`manifest frozen: ${outPath} (gold ${gold.length}, bound ${manifest.bound.length}, probes ${NEGATIVE_PROBES.length})`);
}

async function check(manifestPath: string, ledgerPath: string, batchId: string, dbPathArg?: string): Promise<void> {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    batchId: string;
    k: number;
    goldPassMin: number;
    gold: Array<{ query: string; baselineTop10: string[] }>;
    bound: Array<{ candidateHash: string; query: string }>;
    negativeProbes: string[];
  };
  if (manifest.batchId !== batchId) throw new Error(`manifest is for batch ${manifest.batchId}, not ${batchId}`);

  const ledger = readFileSync(ledgerPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { batchId: string; candidateHash: string; memoryId: string | null; disposition: string });
  const batchRows = ledger.filter((r) => r.batchId === batchId && r.memoryId);
  const idByHash = new Map(batchRows.map((r) => [r.candidateHash, r.memoryId as string]));
  const batchIds = new Set(batchRows.map((r) => r.memoryId as string));
  if (batchIds.size === 0) throw new Error("ledger has no written rows for this batch");

  const retriever = buildComponents(dbPathArg);
  const failures: string[] = [];

  // ① 绑定 query 召回（记录实际 rank，诊断友好）
  let boundPass = 0;
  for (const b of manifest.bound) {
    const expectId = idByHash.get(b.candidateHash);
    if (!expectId) {
      failures.push(`bound: candidate ${b.candidateHash.slice(0, 12)} not in ledger (halted before write?)`);
      continue;
    }
    const ids = await topIds(retriever, b.query, manifest.k);
    const rank = ids.indexOf(expectId) + 1;
    if (rank > 0) {
      boundPass++;
      console.log(`  bound ${b.candidateHash.slice(0, 12)} rank=${rank}`);
    } else {
      failures.push(`bound: ${b.candidateHash.slice(0, 12)} not in top-${manifest.k} for its own query`);
    }
  }
  console.log(`① bound recall: ${boundPass}/${manifest.bound.length}`);

  // ② gold 回归：写前 Top-3 成员写后仍在 Top-10（固定 10，不随 bound 的 k 放宽）
  let goldPass = 0;
  for (const g of manifest.gold) {
    const nowTop = new Set(await topIds(retriever, g.query, 10));
    const top3 = g.baselineTop10.slice(0, 3);
    const kept = top3.filter((id) => nowTop.has(id)).length;
    if (kept === top3.length) goldPass++;
    else failures.push(`gold: "${g.query}" lost ${top3.length - kept} of baseline top-3`);
  }
  console.log(`② gold regression: ${goldPass}/${manifest.gold.length} (min ${manifest.goldPassMin})`);

  // ③ 负向探针：批行不得把 baseline 成员挤出 Top-3（占空位不算侵入，见 freeze 注释）
  const probeBaselines = (manifest as { probeBaselines?: Record<string, string[]> }).probeBaselines;
  let probeClean = 0;
  for (const q of manifest.negativeProbes) {
    const top3 = await topIds(retriever, q, 3);
    const intruders = top3.filter((id) => batchIds.has(id));
    const baseline = probeBaselines?.[q];
    const displaced = baseline ? baseline.filter((id) => !top3.includes(id)) : null;
    // 旧 manifest 无 baseline → 沿用绝对占位判据（兼容）；有 baseline → 挤出成员才算失守
    const dirty = baseline ? intruders.length > 0 && (displaced?.length ?? 0) > 0 : intruders.length > 0;
    if (!dirty) probeClean++;
    else failures.push(`probe: "${q}" has ${intruders.length} batch row(s) in top-3, displacing ${displaced?.length ?? "?"} baseline member(s)`);
  }
  console.log(`③ negative probes clean: ${probeClean}/${manifest.negativeProbes.length}`);

  const boundOk = boundPass === manifest.bound.length && manifest.bound.length > 0;
  const goldOk = goldPass >= manifest.goldPassMin;
  const probeOk = probeClean === manifest.negativeProbes.length;
  for (const f of failures) console.log(`  FAIL ${f}`);
  if (boundOk && goldOk && probeOk) {
    console.log("QUERY GATE PASS");
    process.exit(0);
  }
  console.error("QUERY GATE FAIL — restore the pre-batch snapshot.");
  process.exit(2);
}

const args = process.argv.slice(2);
const dbPathArg = args.includes("--db-path") ? args[args.indexOf("--db-path") + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--db-path");
if (positional[0] === "freeze" && positional[1] && positional[2] && positional[3]) {
  await freeze(positional[1], positional[2], positional[3], dbPathArg);
} else if (positional[0] === "check" && positional[1] && positional[2] && positional[3]) {
  await check(positional[1], positional[2], positional[3], dbPathArg);
} else {
  console.error("usage: freeze <approved.jsonl> <batchId> <out.json> [--db-path <dir>] | check <manifest.json> <ledger.jsonl> <batchId> [--db-path <dir>]");
  process.exit(1);
}
