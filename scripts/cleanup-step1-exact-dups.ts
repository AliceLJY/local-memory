/**
 * 清洗步骤 1：删除精确重复记忆
 * 每组重复保留 accessCount 最高的那条，其余删除
 *
 * 用法：
 *   bun run scripts/cleanup-step1-exact-dups.ts [--execute]
 *   不加 --execute 只统计，加了才真删
 */

import lancedb from "@lancedb/lancedb";
import { resolveDbPath } from "../src/runtime-config.js";

const DB_PATH = resolveDbPath();
const TABLE_NAME = "memories";
const EXECUTE = process.argv.includes("--execute");

interface MemoryRow {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
}

async function main() {
  console.log(`\n🧹 清洗步骤 1：精确重复删除 ${EXECUTE ? "[执行模式]" : "[预览模式]"}`);
  console.log("=".repeat(60));

  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable(TABLE_NAME);

  console.log("⏳ 读取全量数据...");
  const allRows: MemoryRow[] = await table
    .query()
    .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"])
    .toArray() as any;

  const total = allRows.length;
  console.log(`✅ ${total.toLocaleString()} 条记忆\n`);

  // Parse metadata
  const parsedRows = allRows.map(row => ({
    ...row,
    meta: row.metadata ? JSON.parse(row.metadata) : {},
  }));

  // Group by normalized text
  const textGroups = new Map<string, typeof parsedRows>();
  for (const row of parsedRows) {
    const key = row.text.trim().toLowerCase();
    if (!textGroups.has(key)) textGroups.set(key, []);
    textGroups.get(key)!.push(row);
  }

  // Find duplicates
  const dupGroups = [...textGroups.entries()].filter(([, rows]) => rows.length > 1);
  const idsToDelete: string[] = [];

  for (const [, rows] of dupGroups) {
    // Sort: highest accessCount first, then oldest timestamp as tiebreaker (keep oldest)
    rows.sort((a, b) => {
      const acA = a.meta.accessCount ?? a.meta.access_count ?? 0;
      const acB = b.meta.accessCount ?? b.meta.access_count ?? 0;
      if (acB !== acA) return acB - acA; // higher access first
      return a.timestamp - b.timestamp;  // older first
    });
    // Keep first, delete rest
    for (let i = 1; i < rows.length; i++) {
      idsToDelete.push(rows[i].id);
    }
  }

  console.log(`📊 统计结果:`);
  console.log(`  重复组数:     ${dupGroups.length.toLocaleString()}`);
  console.log(`  待删除条数:   ${idsToDelete.length.toLocaleString()}`);
  console.log(`  保留条数:     ${(total - idsToDelete.length).toLocaleString()}`);
  console.log(`  瘦身比例:     ${(idsToDelete.length / total * 100).toFixed(1)}%`);

  // Show top 10 largest duplicate groups
  const topGroups = dupGroups.sort((a, b) => b[1].length - a[1].length).slice(0, 10);
  console.log(`\n  Top 10 重复组:`);
  for (const [text, rows] of topGroups) {
    console.log(`    [×${rows.length}] ${text.slice(0, 70)}...`);
  }

  if (!EXECUTE) {
    console.log(`\n⚠️  预览模式，未执行删除。加 --execute 参数执行。`);
    return;
  }

  // Execute deletion in batches
  console.log(`\n🔥 开始删除 ${idsToDelete.length.toLocaleString()} 条...`);
  const batchSize = 100;
  let deleted = 0;

  for (let i = 0; i < idsToDelete.length; i += batchSize) {
    const batch = idsToDelete.slice(i, i + batchSize);
    // Build WHERE clause: id IN ('a', 'b', 'c')
    const escaped = batch.map(id => id.replace(/'/g, "''"));
    const whereClause = `id IN (${escaped.map(id => `'${id}'`).join(",")})`;
    await table.delete(whereClause);
    deleted += batch.length;
    if (deleted % 1000 === 0 || deleted === idsToDelete.length) {
      console.log(`  ✅ ${deleted.toLocaleString()} / ${idsToDelete.length.toLocaleString()}`);
    }
  }

  // Verify
  const remaining = await table.countRows();
  console.log(`\n✅ 删除完成！`);
  console.log(`  删除前: ${total.toLocaleString()} 条`);
  console.log(`  删除后: ${remaining.toLocaleString()} 条`);
  console.log(`  实际删除: ${(total - remaining).toLocaleString()} 条`);
}

main().catch(console.error);
