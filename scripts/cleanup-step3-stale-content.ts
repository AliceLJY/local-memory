/**
 * 清洗步骤 3：标记/清理过时内容
 * 扫描含 temporary/临时/HACK/TODO/FIXME 的记忆
 * 只删 accessCount=0 且含这些关键词的（从未被用过的过时内容）
 *
 * 用法：
 *   bun run scripts/cleanup-step3-stale-content.ts [--execute]
 */

import lancedb from "@lancedb/lancedb";
import { resolveDbPath } from "../src/runtime-config.js";

const DB_PATH = resolveDbPath();
const TABLE_NAME = "memories";
const EXECUTE = process.argv.includes("--execute");

const STALE_KEYWORDS = [
  "temporary", "临时", "HACK", "TODO", "FIXME",
  "workaround", "deprecated", "废弃", "待修复",
];

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
  console.log(`\n🧹 清洗步骤 3：过时内容清理 ${EXECUTE ? "[执行模式]" : "[预览模式]"}`);
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

  // Scan for stale keywords
  const keywordHits = new Map<string, typeof parsedRows>();
  for (const kw of STALE_KEYWORDS) {
    keywordHits.set(kw, []);
  }

  for (const row of parsedRows) {
    const textLower = row.text.toLowerCase();
    for (const kw of STALE_KEYWORDS) {
      if (textLower.includes(kw.toLowerCase())) {
        keywordHits.get(kw)!.push(row);
      }
    }
  }

  console.log("📊 关键词命中统计:");
  let totalHits = 0;
  for (const kw of STALE_KEYWORDS) {
    const hits = keywordHits.get(kw)!;
    if (hits.length > 0) {
      const deadHits = hits.filter(r => (r.meta.accessCount ?? r.meta.access_count ?? 0) === 0);
      console.log(`  "${kw}": ${hits.length} 条 (其中 ${deadHits.length} 条从未访问)`);
    }
  }

  // Collect: only delete if accessCount=0 (dead memory with stale keyword)
  const idsToDeleteSet = new Set<string>();
  const deleteCandidates: typeof parsedRows = [];

  for (const row of parsedRows) {
    const ac = row.meta.accessCount ?? row.meta.access_count ?? 0;
    if (ac > 0) continue; // keep anything that was ever accessed

    const textLower = row.text.toLowerCase();
    for (const kw of STALE_KEYWORDS) {
      if (textLower.includes(kw.toLowerCase())) {
        if (!idsToDeleteSet.has(row.id)) {
          idsToDeleteSet.add(row.id);
          deleteCandidates.push(row);
        }
        break;
      }
    }
  }

  const idsToDelete = [...idsToDeleteSet];

  console.log(`\n📊 清理范围（仅 accessCount=0 + 含过时关键词）:`);
  console.log(`  待删除条数:   ${idsToDelete.length.toLocaleString()}`);
  console.log(`  保留条数:     ${(total - idsToDelete.length).toLocaleString()}`);
  console.log(`  瘦身比例:     ${(idsToDelete.length / total * 100).toFixed(1)}%`);

  // Category breakdown of what we're deleting
  const catBreakdown = new Map<string, number>();
  for (const row of deleteCandidates) {
    catBreakdown.set(row.category, (catBreakdown.get(row.category) || 0) + 1);
  }
  console.log(`\n  待删除按类别:`);
  for (const [cat, count] of [...catBreakdown.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cat.padEnd(14)} ${count}`);
  }

  // Show samples
  console.log(`\n  待删除示例（随机 10 条）:`);
  const shuffled = deleteCandidates.sort(() => Math.random() - 0.5).slice(0, 10);
  for (const row of shuffled) {
    const matched = STALE_KEYWORDS.find(kw => row.text.toLowerCase().includes(kw.toLowerCase()));
    console.log(`    [${row.category}] [kw="${matched}"] ${row.text.slice(0, 80)}...`);
  }

  if (!EXECUTE) {
    console.log(`\n⚠️  预览模式，未执行删除。加 --execute 参数执行。`);
    return;
  }

  console.log(`\n🔥 开始删除 ${idsToDelete.length.toLocaleString()} 条...`);
  const batchSize = 100;
  let deleted = 0;

  for (let i = 0; i < idsToDelete.length; i += batchSize) {
    const batch = idsToDelete.slice(i, i + batchSize);
    const escaped = batch.map(id => id.replace(/'/g, "''"));
    const whereClause = `id IN (${escaped.map(id => `'${id}'`).join(",")})`;
    await table.delete(whereClause);
    deleted += batch.length;
    if (deleted % 500 === 0 || deleted === idsToDelete.length) {
      console.log(`  ✅ ${deleted.toLocaleString()} / ${idsToDelete.length.toLocaleString()}`);
    }
  }

  const remaining = await table.countRows();
  console.log(`\n✅ 删除完成！`);
  console.log(`  删除前: ${total.toLocaleString()} 条`);
  console.log(`  删除后: ${remaining.toLocaleString()} 条`);
  console.log(`  实际删除: ${(total - remaining).toLocaleString()} 条`);
}

main().catch(console.error);
