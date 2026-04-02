/**
 * 诊断脚本：验证跨进程 vectorSearch 的 _distance 值
 *
 * 用法: bun run scripts/diagnose-vector-search.ts
 *
 * 做三件事:
 * 1. list() 确认数据存在
 * 2. 取第一条记录的 vector，用它自己做 vectorSearch（理论上 distance=0, score=1.0）
 * 3. 打印 raw _distance 值，看是不是 NaN 或异常大
 */

import lancedb from "@lancedb/lancedb";
import { resolve } from "node:path";

const DB_PATH = resolve(import.meta.dir, "../data/lancedb");
const TABLE_NAME = "memories";

async function main() {
  console.log(`[1] Opening LanceDB at: ${DB_PATH}`);
  const db = await lancedb.connect(DB_PATH);

  let table: lancedb.Table;
  try {
    table = await db.openTable(TABLE_NAME);
  } catch (err) {
    console.error(`Failed to open table "${TABLE_NAME}":`, err);
    process.exit(1);
  }

  // Step 1: list a few entries to confirm data exists
  console.log(`\n[2] Listing first 3 entries (SQL query, no vector)...`);
  const sample = await table.query().limit(3).toArray();
  console.log(`  Found ${sample.length} entries`);

  if (sample.length === 0) {
    console.log("  ❌ No data in table. Nothing to diagnose.");
    process.exit(0);
  }

  for (const row of sample) {
    const vec = row.vector;
    const vecType = Object.prototype.toString.call(vec);
    const isArray = Array.isArray(vec);
    const len = vec?.length ?? "N/A";
    const first3 = vec ? Array.from(vec).slice(0, 3) : "N/A";
    console.log(`  id=${(row.id as string).slice(0, 8)}  vector.type=${vecType}  isArray=${isArray}  dim=${len}  first3=${JSON.stringify(first3)}`);
  }

  // Step 2: use the first entry's vector as the query (self-search, should be distance≈0)
  const firstVec = sample[0].vector;
  if (!firstVec || !firstVec.length) {
    console.log("  ❌ First entry has no vector.");
    process.exit(1);
  }

  // Convert to plain number[] in case it's a Float32Array or Arrow vector
  const queryVec: number[] = Array.from(firstVec);
  console.log(`\n[3] Self-search: using first entry's vector (dim=${queryVec.length}) as query...`);
  console.log(`  Query vector first 5: ${queryVec.slice(0, 5)}`);

  // Test 3a: vectorSearch WITH distanceType('cosine')
  console.log(`\n[3a] vectorSearch with distanceType('cosine')...`);
  try {
    const results = await table.vectorSearch(queryVec).distanceType('cosine').limit(5).toArray();
    console.log(`  Returned ${results.length} results`);
    for (const r of results) {
      const dist = r._distance;
      const distNum = Number(dist);
      const score = 1 / (1 + distNum);
      const vecLen = r.vector?.length ?? "N/A";
      const vecType = Object.prototype.toString.call(r.vector);
      console.log(`    id=${(r.id as string).slice(0, 8)}  _distance=${dist} (Number: ${distNum})  score=${score.toFixed(4)}  vec.type=${vecType}  vec.dim=${vecLen}`);
    }
  } catch (err) {
    console.error(`  ❌ vectorSearch(cosine) failed:`, err);
  }

  // Test 3b: vectorSearch WITHOUT distanceType (default = L2)
  console.log(`\n[3b] vectorSearch without distanceType (default L2)...`);
  try {
    const results = await table.vectorSearch(queryVec).limit(5).toArray();
    console.log(`  Returned ${results.length} results`);
    for (const r of results) {
      const dist = r._distance;
      const distNum = Number(dist);
      console.log(`    id=${(r.id as string).slice(0, 8)}  _distance=${dist} (Number: ${distNum})`);
    }
  } catch (err) {
    console.error(`  ❌ vectorSearch(L2) failed:`, err);
  }

  // Test 3c: check if the vector round-trips correctly
  console.log(`\n[4] Vector round-trip check...`);
  const refetched = await table.query().where(`id = '${sample[0].id}'`).limit(1).toArray();
  if (refetched.length > 0) {
    const storedVec = Array.from(refetched[0].vector);
    const match = queryVec.every((v, i) => Math.abs(v - storedVec[i]) < 1e-6);
    console.log(`  Vectors match: ${match}`);
    if (!match) {
      console.log(`  First 5 query:  ${queryVec.slice(0, 5)}`);
      console.log(`  First 5 stored: ${storedVec.slice(0, 5)}`);
      const diffs = queryVec.slice(0, 5).map((v, i) => Math.abs(v - storedVec[i]));
      console.log(`  Diffs: ${diffs}`);
    }
  }

  // Test 3d: manual cosine similarity computation
  console.log(`\n[5] Manual cosine similarity (sanity check)...`);
  if (sample.length >= 2) {
    const vec1: number[] = Array.from(sample[0].vector);
    const vec2: number[] = Array.from(sample[1].vector);

    let dot = 0, norm1 = 0, norm2 = 0;
    for (let i = 0; i < vec1.length; i++) {
      dot += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }
    const cosSim = dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
    const cosDist = 1 - cosSim;
    const score = 1 / (1 + cosDist);
    console.log(`  Manual cosine(entry0, entry1): sim=${cosSim.toFixed(6)}  dist=${cosDist.toFixed(6)}  score=${score.toFixed(4)}`);
    console.log(`  vec1 norm=${Math.sqrt(norm1).toFixed(4)}  vec2 norm=${Math.sqrt(norm2).toFixed(4)}`);
  }

  console.log(`\n✅ Diagnosis complete.`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
