/**
 * P0-2 存量 dup-id 迁移：memories 表按 id 去重，每个 id 只保留一行。
 *
 * 背景：上线 store.upsert（delete+add 入全局写锁，见 store.ts）之前，老的 store() 直接
 * table.add 追加 —— 同 (scope,text) 存两次 → 同 deterministicId 两行。upsert 上线后
 * update() 的 mergeInsert("id") 撞到存量多行会报 ambiguous，所以上线前需一次性清存量。
 *
 * keeper 策略（对齐 P0 分诊规格 item 2）：同 id 多行保留 **timestamp 最新** 的一行，
 * timestamp 相同则取 importance 最高。dup-id 行的 id = sha256(scope+text)，同 id ⟹ 同
 * (scope,text) ⟹ 同文本，因此去重不丢任何 distinct id 的记忆文本；保留最新则保住最新一次
 * 写入的 importance/metadata。
 *
 * 安全（本脚本只在副本上验证；生产执行留给主线）：
 *   - --db 必填，无默认值 —— 不会误命中生产库
 *   - 真删除需额外 --confirm；仅 --dry-run 时只读扫描出报告
 *   - journal-first：动手前把每一条受影响行 dump 到 JSONL，delete/add 之间崩溃可从 journal 恢复
 *
 * 用法（repo root）：
 *   bun scripts/migrate-dedup-ids.ts --db <lancedb路径> --dry-run
 *   bun scripts/migrate-dedup-ids.ts --db <lancedb路径> --confirm
 */
import * as lancedb from "@lancedb/lancedb";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface DedupRow {
  id: string;
  text: string;
  timestamp: number | bigint;
  importance: number;
  [k: string]: unknown;
}

export interface DedupPlan<T extends DedupRow> {
  /** ids that appear more than once. */
  dupIds: string[];
  /** the single row to keep for each dup id (latest timestamp, tiebreak highest importance). */
  keepers: T[];
  /** total rows that would be removed (sum of group.length - 1 over dup ids). */
  extraRows: number;
}

/**
 * Pure keeper selection over an in-memory row set. Only dup ids are reported;
 * unique-id rows are left untouched by the migration. Keeper = latest timestamp,
 * tiebreak = highest importance.
 */
export function planDedup<T extends DedupRow>(rows: T[]): DedupPlan<T> {
  const byId = new Map<string, T[]>();
  for (const r of rows) {
    const list = byId.get(r.id) ?? [];
    list.push(r);
    byId.set(r.id, list);
  }

  const dupIds: string[] = [];
  const keepers: T[] = [];
  let extraRows = 0;

  for (const [id, group] of byId) {
    if (group.length <= 1) continue;
    dupIds.push(id);
    extraRows += group.length - 1;
    const keeper = group.reduce((best, r) => {
      const rt = Number(r.timestamp);
      const bt = Number(best.timestamp);
      if (rt > bt) return r;
      if (rt === bt && Number(r.importance) > Number(best.importance)) return r;
      return best;
    });
    keepers.push(keeper);
  }

  return { dupIds, keepers, extraRows };
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dbPath = arg("--db");
  const dryRun = process.argv.includes("--dry-run");
  const confirmed = process.argv.includes("--confirm");

  if (!dbPath) {
    console.error("[migrate-dedup] --db <lancedb路径> 必填（无默认值以防误跑生产库）");
    process.exit(2);
  }
  if (!dryRun && !confirmed) {
    console.error("[migrate-dedup] 真删除需 --confirm（或用 --dry-run 只读扫描）");
    process.exit(2);
  }

  const db = await lancedb.connect(dbPath);
  const table = await db.openTable("memories");
  const before = await table.countRows();
  console.log(`[migrate-dedup] db=${dbPath}`);
  console.log(`[migrate-dedup] rows before: ${before}`);

  // Lightweight scan (id/timestamp/importance only — no vectors) for dup detection.
  // On a 100K+ row store, loading every full row with its 1024-dim vector would be
  // gigabytes; full rows are fetched later only for the (small) set of dup ids.
  const lite = (await table.query().select(["id", "timestamp", "importance"]).limit(before + 1000).toArray()) as DedupRow[];
  const plan = planDedup(lite);
  console.log(`[migrate-dedup] duplicate ids: ${plan.dupIds.length} | extra rows to remove: ${plan.extraRows}`);

  if (plan.dupIds.length === 0) {
    console.log("[migrate-dedup] nothing to do");
    return;
  }

  const DELETE_BATCH = 200;
  const plain = (r: DedupRow) => ({ ...r, vector: Array.from((r.vector ?? []) as Iterable<number>) });
  const escId = (id: string) => `'${String(id).replace(/'/g, "''")}'`;

  if (dryRun) {
    console.log(`[dry-run] would delete all rows for ${plan.dupIds.length} ids and re-add ${plan.keepers.length} keepers (latest-ts keeper), net -${plan.extraRows}`);
    console.log(`[dry-run] sample keeper decisions: ${plan.keepers.slice(0, 3).map((k) => `${k.id.slice(0, 8)}@ts${Number(k.timestamp)}`).join(", ")}`);
    return;
  }

  // Fetch FULL rows (with vectors) only for the dup ids, in batches.
  const fullDupRows: DedupRow[] = [];
  for (let i = 0; i < plan.dupIds.length; i += DELETE_BATCH) {
    const inList = plan.dupIds.slice(i, i + DELETE_BATCH).map(escId).join(",");
    const batch = (await table.query().where(`id IN (${inList})`).limit(before + 1000).toArray()) as DedupRow[];
    fullDupRows.push(...batch);
  }

  // 1. Journal every affected (full) row before touching anything — delete/add crash recoverable.
  const journalDir = join(dbPath, "..", "dedup-journals");
  mkdirSync(journalDir, { recursive: true });
  const journal = join(journalDir, `dedup-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  for (const r of fullDupRows) appendFileSync(journal, JSON.stringify(plain(r)) + "\n");
  console.log(`[migrate-dedup] journal written: ${journal} (${fullDupRows.length} rows)`);

  // 2. Delete all rows for dup ids, in batches.
  for (let i = 0; i < plan.dupIds.length; i += DELETE_BATCH) {
    const inList = plan.dupIds.slice(i, i + DELETE_BATCH).map(escId).join(",");
    await table.delete(`id IN (${inList})`);
  }
  console.log(`[migrate-dedup] deleted all rows for ${plan.dupIds.length} ids`);

  // 3. Re-add one keeper per dup id (full rows, same latest-ts policy re-applied).
  const keepers = planDedup(fullDupRows).keepers.map(plain);
  for (let i = 0; i < keepers.length; i += DELETE_BATCH) {
    await table.add(keepers.slice(i, i + DELETE_BATCH));
  }
  console.log(`[migrate-dedup] re-added ${keepers.length} keepers`);

  const after = await table.countRows();
  const expected = before - plan.extraRows;
  console.log(`[migrate-dedup] rows after: ${after} (expected ${expected})`);

  // 4. Re-verify no id appears twice.
  const check = (await table.query().select(["id"]).limit(after + 1000).toArray()) as { id: string }[];
  const seen = new Set<string>();
  let stillDup = 0;
  for (const r of check) {
    if (seen.has(r.id)) stillDup++;
    seen.add(r.id);
  }
  console.log(`[migrate-dedup] remaining duplicate rows: ${stillDup}`);

  await table.optimize();
  console.log(stillDup === 0 && after === expected ? "[migrate-dedup] DONE ✓" : "[migrate-dedup] DONE WITH CONCERNS — check counts above");
}

if (import.meta.main) {
  await main();
}
