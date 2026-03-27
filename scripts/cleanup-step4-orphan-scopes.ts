/**
 * 清洗步骤 4：分析孤儿 scope（只有 1 条记忆的 scope）
 * 策略：不删记忆，而是把孤儿 scope 的记忆重新归类到更有意义的 scope
 * - accessCount=0 的孤儿 → 直接删（死记忆 + 孤儿 scope 双重废）
 * - accessCount>0 的孤儿 → 保留，只报告（不乱动有价值的）
 *
 * 用法：
 *   bun run scripts/cleanup-step4-orphan-scopes.ts [--execute]
 */

import lancedb from "@lancedb/lancedb";

const DB_PATH = "./data/lancedb";
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
  console.log(`\n🧹 清洗步骤 4：孤儿 scope 清理 ${EXECUTE ? "[执行模式]" : "[预览模式]"}`);
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

  const parsedRows = allRows.map(row => ({
    ...row,
    meta: row.metadata ? JSON.parse(row.metadata) : {},
  }));

  // Find orphan scopes (only 1 memory)
  const scopeCounts = new Map<string, number>();
  for (const row of parsedRows) {
    const s = row.scope || "(empty)";
    scopeCounts.set(s, (scopeCounts.get(s) || 0) + 1);
  }

  const orphanScopes = new Set(
    [...scopeCounts.entries()].filter(([, c]) => c === 1).map(([s]) => s)
  );

  const orphanRows = parsedRows.filter(r => orphanScopes.has(r.scope || "(empty)"));

  // Split: dead orphans vs alive orphans
  const deadOrphans = orphanRows.filter(r => (r.meta.accessCount ?? r.meta.access_count ?? 0) === 0);
  const aliveOrphans = orphanRows.filter(r => (r.meta.accessCount ?? r.meta.access_count ?? 0) > 0);

  console.log(`📊 孤儿 scope 统计:`);
  console.log(`  孤儿 scope 总数:   ${orphanScopes.size}`);
  console.log(`  死记忆孤儿:        ${deadOrphans.length} 条 → 可安全删除`);
  console.log(`  活记忆孤儿:        ${aliveOrphans.length} 条 → 保留不动`);

  // Category breakdown
  const deadCatMap = new Map<string, number>();
  for (const r of deadOrphans) {
    deadCatMap.set(r.category, (deadCatMap.get(r.category) || 0) + 1);
  }
  console.log(`\n  死记忆孤儿按类别:`);
  for (const [cat, count] of [...deadCatMap.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cat.padEnd(14)} ${count}`);
  }

  // Show alive orphan samples (these we keep)
  if (aliveOrphans.length > 0) {
    console.log(`\n  活记忆孤儿示例（保留）:`);
    for (const r of aliveOrphans.slice(0, 5)) {
      const ac = r.meta.accessCount ?? r.meta.access_count ?? 0;
      console.log(`    [${r.category}] [ac=${ac}] [scope=${r.scope.slice(0, 25)}] ${r.text.slice(0, 60)}...`);
    }
  }

  // Show dead orphan samples
  console.log(`\n  死记忆孤儿示例（待删）:`);
  const samples = deadOrphans.sort(() => Math.random() - 0.5).slice(0, 10);
  for (const r of samples) {
    console.log(`    [${r.category}] [scope=${r.scope.slice(0, 25)}] ${r.text.slice(0, 60)}...`);
  }

  const idsToDelete = deadOrphans.map(r => r.id);

  console.log(`\n📊 清理计划:`);
  console.log(`  待删除:    ${idsToDelete.length} 条（死记忆 + 孤儿 scope）`);
  console.log(`  保留:      ${(total - idsToDelete.length).toLocaleString()} 条`);
  console.log(`  瘦身比例:  ${(idsToDelete.length / total * 100).toFixed(1)}%`);

  if (!EXECUTE) {
    console.log(`\n⚠️  预览模式，未执行删除。加 --execute 参数执行。`);
    return;
  }

  console.log(`\n🔥 开始删除 ${idsToDelete.length} 条...`);
  const batchSize = 100;
  let deleted = 0;

  for (let i = 0; i < idsToDelete.length; i += batchSize) {
    const batch = idsToDelete.slice(i, i + batchSize);
    const escaped = batch.map(id => id.replace(/'/g, "''"));
    const whereClause = `id IN (${escaped.map(id => `'${id}'`).join(",")})`;
    await table.delete(whereClause);
    deleted += batch.length;
    if (deleted % 100 === 0 || deleted === idsToDelete.length) {
      console.log(`  ✅ ${deleted} / ${idsToDelete.length}`);
    }
  }

  const remaining = await table.countRows();
  console.log(`\n✅ 删除完成！`);
  console.log(`  删除前: ${total.toLocaleString()} 条`);
  console.log(`  删除后: ${remaining.toLocaleString()} 条`);
  console.log(`  实际删除: ${(total - remaining).toLocaleString()} 条`);
  console.log(`  消灭孤儿 scope: ${deadOrphans.length} 个`);
}

main().catch(console.error);
