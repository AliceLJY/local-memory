#!/usr/bin/env bun
/**
 * Stage 5 旧池 evidence 层删除（防护版，plan v2 + Alice 2026-07 拍板）
 *
 * 删除集（三重条件，2026-08-05 实测校准）：
 *   metadata LIKE '%"layer":"evidence"%'          —— 主条件（列上 LIKE，lance 不能查 JSON 字段）
 *   AND NOT scope IN 保护前缀 (memory/project/user/profile)  —— 5,185 手写口径的 scope 保护
 *   AND id NOT IN 显式排除清单                     —— 2 条 promote 晋升行（真 durable，
 *       metadata 嵌源 evidence boundary 文本被子串误中；另 2 条同病但已被 scope 保护拦住）
 * 实测预期删除数：133,840（LIKE 133,846 − scope 保护 4 − 显式排除 2）
 *
 * survivor 等值检查：删除前后全部保留行 (id, scope, importance, text-md5, metadata-md5)
 * 逐条全等 —— 比 plan 的「5,185 条手写」口径更强（survivor 全量 ~13,232 行）。
 *
 * 用法（全部在 supervisor 停写窗口 + 快照之后）：
 *   bun scripts/pivot-apply-prune-evidence.ts preview            —— 只算账出清单
 *   bun scripts/pivot-apply-prune-evidence.ts baseline <out.json> —— 导出 survivor 基线
 *   bun scripts/pivot-apply-prune-evidence.ts execute <baseline.json> —— 校验基线新鲜后执行删除
 *   bun scripts/pivot-apply-prune-evidence.ts verify <baseline.json>  —— 删除后逐条等值 + 守恒
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import * as lancedb from "@lancedb/lancedb";

import { loadConfig, resolveDbPath } from "../src/runtime-config.js";

const DB = resolveDbPath(loadConfig());
const PROTECTED = ["memory:", "project:", "user:", "profile:"];
// promote 晋升行，metadata 嵌源 evidence boundary 被 LIKE 误中，且不在保护 scope（global）
const EXPLICIT_KEEP_IDS = [
  "aa8674a6", // global · promote_memory_schema_v1
  "18f1c83d", // global · promote_memory_schema_v1
];

const md5 = (s: string): string => createHash("md5").update(s, "utf8").digest("hex");

interface Row {
  id: string;
  scope: string;
  importance: number;
  text: string;
  metadata: string;
}

function isProtectedScope(scope: string): boolean {
  return PROTECTED.some((p) => (scope || "").startsWith(p));
}
function isDeletable(r: Row): boolean {
  if (!r.metadata.includes('"layer":"evidence"')) return false;
  if (isProtectedScope(r.scope)) return false;
  if (EXPLICIT_KEEP_IDS.some((p) => r.id.startsWith(p))) return false;
  // 深防线：metadata 可解析时用真实 layer 复核（LIKE 只是初筛）
  try {
    const m = JSON.parse(r.metadata) as { boundary?: { layer?: string } };
    if (m?.boundary?.layer !== "evidence") return false;
  } catch {
    // 不可解析 → 保守不删
    return false;
  }
  return true;
}

async function loadAll(): Promise<Row[]> {
  const db = await lancedb.connect(DB);
  const t = await db.openTable("memories");
  const rows = await t.query().select(["id", "scope", "importance", "text", "metadata"]).toArray();
  return rows as unknown as Row[];
}

function survivorFingerprint(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (!isDeletable(r)) {
      out[r.id] = md5(`${r.scope}|${r.importance}|${md5(r.text)}|${md5(r.metadata)}`);
    }
  }
  return out;
}

const mode = process.argv[2];
const argPath = process.argv[3];

if (mode === "preview") {
  const rows = await loadAll();
  const del = rows.filter(isDeletable);
  const byPrefix: Record<string, number> = {};
  for (const r of del) {
    const p = (r.scope || "").split(":")[0] || "(none)";
    byPrefix[p] = (byPrefix[p] ?? 0) + 1;
  }
  console.log(`total rows: ${rows.length}`);
  console.log(`DELETE candidates: ${del.length}`);
  console.log(`survivors: ${rows.length - del.length}`);
  console.log("delete by scope prefix:", JSON.stringify(byPrefix, null, 1));
} else if (mode === "baseline" && argPath) {
  const rows = await loadAll();
  const fp = survivorFingerprint(rows);
  writeFileSync(argPath, JSON.stringify({ at: new Date().toISOString(), total: rows.length, survivors: Object.keys(fp).length, fp }));
  console.log(`baseline written: ${argPath} (${Object.keys(fp).length} survivors of ${rows.length} rows)`);
} else if (mode === "execute" && argPath) {
  const baseline = JSON.parse(readFileSync(argPath, "utf8")) as { at: string; total: number; survivors: number };
  const rows = await loadAll();
  if (rows.length !== baseline.total) {
    console.error(`REFUSING: row count ${rows.length} != baseline total ${baseline.total} — the DB moved since baseline; redo baseline inside the stop-write window.`);
    process.exit(1);
  }
  const del = rows.filter(isDeletable);
  const expected = rows.length - baseline.survivors;
  if (del.length !== expected) {
    console.error(`REFUSING: delete-set ${del.length} != expected ${expected} (baseline survivors ${baseline.survivors})`);
    process.exit(1);
  }
  console.log(`deleting ${del.length} rows in id batches…`);
  const db = await lancedb.connect(DB);
  const t = await db.openTable("memories");
  const BATCH = 2000;
  for (let i = 0; i < del.length; i += BATCH) {
    const ids = del.slice(i, i + BATCH).map((r) => `'${r.id.replace(/'/g, "''")}'`);
    await t.delete(`id IN (${ids.join(",")})`);
    if ((i / BATCH) % 10 === 0) console.log(`  … ${Math.min(i + BATCH, del.length)}/${del.length}`);
  }
  const after = await t.countRows();
  console.log(`delete done. rows now: ${after} (expect ${baseline.survivors})`);
  process.exit(after === baseline.survivors ? 0 : 1);
} else if (mode === "verify" && argPath) {
  const baseline = JSON.parse(readFileSync(argPath, "utf8")) as { survivors: number; fp: Record<string, string> };
  const rows = await loadAll();
  if (rows.length !== baseline.survivors) {
    console.error(`FAIL: row count ${rows.length} != baseline survivors ${baseline.survivors}`);
    process.exit(1);
  }
  const nowFp = survivorFingerprint(rows);
  let missing = 0, drifted = 0, extra = 0;
  for (const [id, hash] of Object.entries(baseline.fp)) {
    if (!(id in nowFp)) { missing++; if (missing <= 5) console.error(`  missing: ${id.slice(0, 8)}`); }
    else if (nowFp[id] !== hash) { drifted++; if (drifted <= 5) console.error(`  drifted: ${id.slice(0, 8)}`); }
  }
  for (const id of Object.keys(nowFp)) if (!(id in baseline.fp)) { extra++; if (extra <= 5) console.error(`  extra: ${id.slice(0, 8)}`); }
  console.log(`survivor equivalence: missing ${missing} / drifted ${drifted} / extra ${extra} (all must be 0)`);
  process.exit(missing + drifted + extra === 0 ? 0 : 1);
} else {
  console.error("usage: preview | baseline <out.json> | execute <baseline.json> | verify <baseline.json>");
  process.exit(1);
}
