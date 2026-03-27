/**
 * RecallNest 记忆体检脚本
 * 只读分析 LanceDB 数据，不写入任何内容
 *
 * 检查项：
 * 1. Category 分布（含百分比）
 * 2. Tier 分布（peripheral/working/core）
 * 3. 死记忆（accessCount = 0 或无 accessCount）
 * 4. Importance 分布
 * 5. 来源分布（CC/Codex/Gemini/manual）
 * 6. 年龄分布
 * 7. 近似重复检测（采样 cosine similarity）
 */

import lancedb from "@lancedb/lancedb";
import path from "path";

const DB_PATH = path.join(import.meta.dir, "..", "data", "lancedb");
const TABLE_NAME = "memories";

interface MemoryRow {
  id: string;
  text: string;
  vector: number[];
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function percentBar(pct: number, width = 30): string {
  const filled = Math.round(pct / 100 * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function main() {
  console.log("\n🏥 RecallNest 记忆体检报告");
  console.log("=" .repeat(60));
  console.log(`📅 检查时间: ${new Date().toISOString().slice(0, 19)}`);
  console.log(`📂 数据路径: ${DB_PATH}\n`);

  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable(TABLE_NAME);

  // Fetch all rows (without vectors first for speed)
  console.log("⏳ 正在读取全量数据...");
  const allRows: MemoryRow[] = await table
    .query()
    .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"])
    .toArray() as any;

  const total = allRows.length;
  console.log(`✅ 读取完成: ${total.toLocaleString()} 条记忆\n`);

  // ============================================
  // 1. Category 分布
  // ============================================
  console.log("📊 1. Category 分布");
  console.log("-".repeat(60));
  const catMap = new Map<string, number>();
  for (const row of allRows) {
    catMap.set(row.category, (catMap.get(row.category) || 0) + 1);
  }
  const catSorted = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of catSorted) {
    const pct = (count / total * 100).toFixed(1);
    console.log(`  ${cat.padEnd(14)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${percentBar(parseFloat(pct))}`);
  }

  // ============================================
  // 2. Tier 分布
  // ============================================
  console.log("\n📊 2. Tier 分布");
  console.log("-".repeat(60));
  const tierMap = new Map<string, number>();
  let noTier = 0;
  for (const row of allRows) {
    const meta = row.metadata ? JSON.parse(row.metadata) : {};
    const tier = meta.tier || "unknown";
    if (tier === "unknown") noTier++;
    tierMap.set(tier, (tierMap.get(tier) || 0) + 1);
  }
  const tierSorted = [...tierMap.entries()].sort((a, b) => b[1] - a[1]);
  for (const [tier, count] of tierSorted) {
    const pct = (count / total * 100).toFixed(1);
    console.log(`  ${tier.padEnd(14)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${percentBar(parseFloat(pct))}`);
  }

  // ============================================
  // 3. 死记忆（从未被 recall 命中）
  // ============================================
  console.log("\n📊 3. 死记忆分析（accessCount = 0 或无记录）");
  console.log("-".repeat(60));
  let deadCount = 0;
  let aliveCount = 0;
  let totalAccess = 0;
  let maxAccess = 0;
  let maxAccessId = "";
  let maxAccessText = "";
  const accessDistribution = new Map<string, number>();

  for (const row of allRows) {
    const meta = row.metadata ? JSON.parse(row.metadata) : {};
    const ac = meta.accessCount || 0;
    totalAccess += ac;

    if (ac === 0) {
      deadCount++;
    } else {
      aliveCount++;
    }

    if (ac > maxAccess) {
      maxAccess = ac;
      maxAccessId = row.id;
      maxAccessText = row.text.slice(0, 80);
    }

    // Bucket access counts
    let bucket: string;
    if (ac === 0) bucket = "0 (死记忆)";
    else if (ac <= 2) bucket = "1-2";
    else if (ac <= 5) bucket = "3-5";
    else if (ac <= 10) bucket = "6-10";
    else if (ac <= 50) bucket = "11-50";
    else bucket = "50+";
    accessDistribution.set(bucket, (accessDistribution.get(bucket) || 0) + 1);
  }

  const deadPct = (deadCount / total * 100).toFixed(1);
  const alivePct = (aliveCount / total * 100).toFixed(1);
  console.log(`  死记忆:   ${deadCount.toLocaleString()} / ${total.toLocaleString()}  (${deadPct}%)`);
  console.log(`  活记忆:   ${aliveCount.toLocaleString()} / ${total.toLocaleString()}  (${alivePct}%)`);
  console.log(`  总访问次: ${totalAccess.toLocaleString()}`);
  console.log(`  平均访问: ${(totalAccess / total).toFixed(2)} 次/条`);
  console.log(`  最热记忆: [${maxAccess}次] ${maxAccessText}...`);

  console.log("\n  访问次数分布:");
  const bucketOrder = ["0 (死记忆)", "1-2", "3-5", "6-10", "11-50", "50+"];
  for (const bucket of bucketOrder) {
    const count = accessDistribution.get(bucket) || 0;
    const pct = (count / total * 100).toFixed(1);
    console.log(`    ${bucket.padEnd(14)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${percentBar(parseFloat(pct))}`);
  }

  // ============================================
  // 4. Importance 分布
  // ============================================
  console.log("\n📊 4. Importance 分布");
  console.log("-".repeat(60));
  const impBuckets = new Map<string, number>();
  let impSum = 0;
  for (const row of allRows) {
    const imp = row.importance || 0;
    impSum += imp;
    let bucket: string;
    if (imp < 0.2) bucket = "0.0-0.2 (低)";
    else if (imp < 0.4) bucket = "0.2-0.4";
    else if (imp < 0.6) bucket = "0.4-0.6 (中)";
    else if (imp < 0.8) bucket = "0.6-0.8";
    else bucket = "0.8-1.0 (高)";
    impBuckets.set(bucket, (impBuckets.get(bucket) || 0) + 1);
  }
  console.log(`  平均 importance: ${(impSum / total).toFixed(3)}`);
  const impOrder = ["0.0-0.2 (低)", "0.2-0.4", "0.4-0.6 (中)", "0.6-0.8", "0.8-1.0 (高)"];
  for (const bucket of impOrder) {
    const count = impBuckets.get(bucket) || 0;
    const pct = (count / total * 100).toFixed(1);
    console.log(`    ${bucket.padEnd(16)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${percentBar(parseFloat(pct))}`);
  }

  // ============================================
  // 5. 来源分类汇总
  // ============================================
  console.log("\n📊 5. 来源分类汇总");
  console.log("-".repeat(60));
  let ccCount = 0, codexCount = 0, geminiCount = 0, memoryCount = 0, otherCount = 0;
  const scopeSet = new Set<string>();
  for (const row of allRows) {
    scopeSet.add(row.scope);
    const meta = row.metadata ? JSON.parse(row.metadata) : {};
    const source = meta.source || row.scope || "";
    if (source.startsWith("cc:") || row.scope.startsWith("cc:")) ccCount++;
    else if (source.startsWith("codex:") || row.scope.startsWith("codex:")) codexCount++;
    else if (source.startsWith("gemini:") || row.scope.startsWith("gemini:")) geminiCount++;
    else if (source === "memory" || row.scope === "memory" || source === "manual" || source === "agent") memoryCount++;
    else otherCount++;
  }
  console.log(`  Claude Code:  ${ccCount.toLocaleString().padStart(6)}  (${(ccCount/total*100).toFixed(1)}%)`);
  console.log(`  Codex:        ${codexCount.toLocaleString().padStart(6)}  (${(codexCount/total*100).toFixed(1)}%)`);
  console.log(`  Gemini:       ${geminiCount.toLocaleString().padStart(6)}  (${(geminiCount/total*100).toFixed(1)}%)`);
  console.log(`  手动记忆:     ${memoryCount.toLocaleString().padStart(6)}  (${(memoryCount/total*100).toFixed(1)}%)`);
  console.log(`  其他:         ${otherCount.toLocaleString().padStart(6)}  (${(otherCount/total*100).toFixed(1)}%)`);
  console.log(`  独立 scope 数: ${scopeSet.size}`);

  // ============================================
  // 6. 年龄分布
  // ============================================
  console.log("\n📊 6. 年龄分布");
  console.log("-".repeat(60));
  const now = Date.now();
  const ageBuckets = new Map<string, number>();
  let oldest = Infinity, newest = 0;
  for (const row of allRows) {
    const ts = row.timestamp;
    if (ts < oldest) oldest = ts;
    if (ts > newest) newest = ts;
    const ageHours = (now - ts) / (1000 * 60 * 60);
    let bucket: string;
    if (ageHours < 24) bucket = "< 1 天";
    else if (ageHours < 24 * 7) bucket = "1-7 天";
    else if (ageHours < 24 * 30) bucket = "7-30 天";
    else if (ageHours < 24 * 90) bucket = "30-90 天";
    else bucket = "> 90 天";
    ageBuckets.set(bucket, (ageBuckets.get(bucket) || 0) + 1);
  }
  console.log(`  最早: ${formatDate(oldest)}`);
  console.log(`  最新: ${formatDate(newest)}`);
  const ageOrder = ["< 1 天", "1-7 天", "7-30 天", "30-90 天", "> 90 天"];
  for (const bucket of ageOrder) {
    const count = ageBuckets.get(bucket) || 0;
    const pct = (count / total * 100).toFixed(1);
    console.log(`    ${bucket.padEnd(12)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${percentBar(parseFloat(pct))}`);
  }

  // ============================================
  // 7. 近似重复检测（采样）
  // ============================================
  console.log("\n📊 7. 近似重复检测（采样 500 条，cosine > 0.95）");
  console.log("-".repeat(60));
  console.log("  ⏳ 正在读取向量数据（采样）...");

  // Sample 500 random rows with vectors
  const sampleSize = 500;
  const sampleRows: MemoryRow[] = await table
    .query()
    .select(["id", "text", "vector", "category"])
    .limit(sampleSize)
    .toArray() as any;

  let dupPairs = 0;
  const dupExamples: Array<{sim: number, textA: string, textB: string}> = [];

  for (let i = 0; i < sampleRows.length; i++) {
    for (let j = i + 1; j < sampleRows.length; j++) {
      if (sampleRows[i].vector && sampleRows[j].vector) {
        const sim = cosineSimilarity(sampleRows[i].vector, sampleRows[j].vector);
        if (sim > 0.95) {
          dupPairs++;
          if (dupExamples.length < 3) {
            dupExamples.push({
              sim,
              textA: sampleRows[i].text.slice(0, 60),
              textB: sampleRows[j].text.slice(0, 60),
            });
          }
        }
      }
    }
  }

  const totalPairs = sampleSize * (sampleSize - 1) / 2;
  const dupRate = (dupPairs / totalPairs * 100).toFixed(3);
  console.log(`  采样对数:   ${totalPairs.toLocaleString()}`);
  console.log(`  高相似对:   ${dupPairs} (>${dupRate}%)`);
  console.log(`  推算全库:   ~${Math.round(dupPairs / totalPairs * total * (total-1) / 2).toLocaleString()} 对潜在重复`);

  if (dupExamples.length > 0) {
    console.log("\n  示例重复对:");
    for (const ex of dupExamples) {
      console.log(`    [sim=${ex.sim.toFixed(3)}]`);
      console.log(`      A: ${ex.textA}...`);
      console.log(`      B: ${ex.textB}...`);
    }
  }

  // ============================================
  // 8. 综合诊断
  // ============================================
  console.log("\n" + "=".repeat(60));
  console.log("🩺 综合诊断");
  console.log("=".repeat(60));

  const issues: string[] = [];
  const healthy: string[] = [];

  // Check dead memory ratio
  const deadRatio = deadCount / total;
  if (deadRatio > 0.9) {
    issues.push(`🔴 ${deadPct}% 记忆从未被访问（死记忆率过高）`);
  } else if (deadRatio > 0.7) {
    issues.push(`🟡 ${deadPct}% 记忆从未被访问（死记忆率偏高）`);
  } else {
    healthy.push(`✅ 死记忆率 ${deadPct}% 在合理范围`);
  }

  // Check category balance
  const factRatio = (catMap.get("fact") || 0) / total;
  if (factRatio > 0.8) {
    issues.push(`🟡 fact 类别占 ${(factRatio*100).toFixed(1)}%，结构化记忆（entities/patterns/cases）占比偏低`);
  } else {
    healthy.push(`✅ 类别分布均衡`);
  }

  // Check tier distribution
  const coreCount = tierMap.get("core") || 0;
  const workingCount = tierMap.get("working") || 0;
  if (coreCount < 10) {
    issues.push(`🟡 core tier 仅 ${coreCount} 条，高价值记忆太少`);
  } else {
    healthy.push(`✅ core tier 有 ${coreCount} 条高价值记忆`);
  }

  // Check dup rate
  if (parseFloat(dupRate) > 1) {
    issues.push(`🟡 采样重复率 ${dupRate}%，全库可能存在大量近似重复`);
  } else {
    healthy.push(`✅ 采样重复率 ${dupRate}%，重复可控`);
  }

  for (const h of healthy) console.log(`  ${h}`);
  for (const i of issues) console.log(`  ${i}`);

  console.log("\n" + "=".repeat(60));
  console.log("📋 体检完成\n");
}

main().catch(console.error);
