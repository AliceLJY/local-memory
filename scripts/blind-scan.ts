/**
 * 盲扫脚本 — 模块 4：开放式探索
 * 不带预设地分析 38K 条记忆的文本内容
 * 只读，不写入任何内容
 *
 * 用法：bun run scripts/blind-scan.ts [lancedb-dir]
 */

import lancedb from "@lancedb/lancedb";
import { resolveDbPath } from "../src/runtime-config.js";

const DB_PATH = process.argv[2] || resolveDbPath();
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

// Simple CJK-aware tokenizer
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // Remove URLs
  const cleaned = text.replace(/https?:\/\/\S+/g, " ");
  // Split into words (English) and characters (CJK)
  const parts = cleaned.match(/[\u4e00-\u9fff\u3400-\u4dbf]+|[a-zA-Z][a-zA-Z0-9_'-]+/g) || [];
  for (const part of parts) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(part)) {
      // CJK: bigrams
      for (let i = 0; i < part.length - 1; i++) {
        tokens.push(part.slice(i, i + 2));
      }
    } else if (part.length > 1) {
      tokens.push(part.toLowerCase());
    }
  }
  return tokens;
}

// Stopwords (minimal)
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further",
  "then", "once", "here", "there", "when", "where", "why", "how",
  "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "just", "because", "but", "and", "or", "if",
  "while", "about", "up", "its", "it", "this", "that", "these", "those",
  "he", "she", "they", "we", "you", "me", "him", "her", "us", "them",
  "my", "your", "his", "our", "their", "what", "which", "who", "whom",
  "also", "been", "like", "get", "got", "make", "made", "use", "used",
]);

async function main() {
  console.log("\n🔍 盲扫报告 — RecallNest 开放式探索");
  console.log("=".repeat(70));
  console.log(`📅 时间: ${new Date().toISOString().slice(0, 19)}`);
  console.log(`📂 路径: ${DB_PATH}\n`);

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

  // ============================================
  // 1. 文本长度分布
  // ============================================
  console.log("📊 1. 文本长度分布");
  console.log("-".repeat(70));
  const lengths = parsedRows.map(r => r.text.length);
  lengths.sort((a, b) => a - b);
  const avgLen = lengths.reduce((s, l) => s + l, 0) / total;
  const medianLen = lengths[Math.floor(total / 2)];
  const p95Len = lengths[Math.floor(total * 0.95)];
  const p99Len = lengths[Math.floor(total * 0.99)];

  console.log(`  最短: ${lengths[0]} 字符`);
  console.log(`  中位: ${medianLen} 字符`);
  console.log(`  平均: ${Math.round(avgLen)} 字符`);
  console.log(`  P95:  ${p95Len} 字符`);
  console.log(`  P99:  ${p99Len} 字符`);
  console.log(`  最长: ${lengths[total - 1]} 字符`);

  // Length buckets
  const lenBuckets = new Map<string, number>();
  const lenRanges: Array<[number, number, string]> = [
    [0, 50, "0-50"],
    [50, 100, "50-100"],
    [100, 200, "100-200"],
    [200, 500, "200-500"],
    [500, 1000, "500-1K"],
    [1000, 2000, "1K-2K"],
    [2000, 5000, "2K-5K"],
    [5000, Infinity, "5K+"],
  ];
  for (const len of lengths) {
    for (const [lo, hi, label] of lenRanges) {
      if (len >= lo && len < hi) {
        lenBuckets.set(label, (lenBuckets.get(label) || 0) + 1);
        break;
      }
    }
  }
  console.log("\n  分布:");
  for (const [, , label] of lenRanges) {
    const count = lenBuckets.get(label) || 0;
    const pct = (count / total * 100).toFixed(1);
    const bar = "█".repeat(Math.round(parseFloat(pct) / 100 * 40));
    console.log(`    ${label.padEnd(10)} ${count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${bar}`);
  }

  // Extremely short texts (likely garbage)
  const ultraShort = parsedRows.filter(r => r.text.length < 20);
  if (ultraShort.length > 0) {
    console.log(`\n  ⚠️ 超短文本 (<20 字符): ${ultraShort.length} 条`);
    console.log("  示例:");
    for (const r of ultraShort.slice(0, 5)) {
      console.log(`    [${r.category}] "${r.text}"`);
    }
  }

  // ============================================
  // 2. 语言混合分析
  // ============================================
  console.log("\n📊 2. 语言混合分析");
  console.log("-".repeat(70));
  let pureEn = 0, pureCn = 0, mixed = 0, other = 0;
  for (const row of parsedRows) {
    const hasCJK = /[\u4e00-\u9fff]/.test(row.text);
    const hasEn = /[a-zA-Z]{3,}/.test(row.text);
    if (hasCJK && hasEn) mixed++;
    else if (hasCJK) pureCn++;
    else if (hasEn) pureEn++;
    else other++;
  }
  console.log(`  纯英文:     ${pureEn.toLocaleString()} (${(pureEn/total*100).toFixed(1)}%)`);
  console.log(`  纯中文:     ${pureCn.toLocaleString()} (${(pureCn/total*100).toFixed(1)}%)`);
  console.log(`  中英混合:   ${mixed.toLocaleString()} (${(mixed/total*100).toFixed(1)}%)`);
  console.log(`  其他:       ${other.toLocaleString()} (${(other/total*100).toFixed(1)}%)`);

  // ============================================
  // 3. 高频词分析（分语言）
  // ============================================
  console.log("\n📊 3. 高频词分析");
  console.log("-".repeat(70));
  const wordFreq = new Map<string, number>();
  for (const row of parsedRows) {
    const tokens = tokenize(row.text);
    for (const t of tokens) {
      if (!STOPWORDS.has(t) && t.length > 1) {
        wordFreq.set(t, (wordFreq.get(t) || 0) + 1);
      }
    }
  }
  const topWords = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);

  console.log("  Top 40 词频（去停用词）:");
  for (let i = 0; i < topWords.length; i++) {
    const [word, count] = topWords[i];
    const pctOfDocs = (count / total * 100).toFixed(1);
    console.log(`    ${(i+1).toString().padStart(2)}. ${word.padEnd(20)} ${count.toString().padStart(6)}  (${pctOfDocs}% 文档)`);
  }

  // ============================================
  // 4. 文本前缀聚类（发现模板化内容）
  // ============================================
  console.log("\n📊 4. 文本前缀聚类（发现模板化内容）");
  console.log("-".repeat(70));
  const prefixMap = new Map<string, number>();
  for (const row of parsedRows) {
    // Take first 40 chars as prefix fingerprint
    const prefix = row.text.slice(0, 40).trim();
    prefixMap.set(prefix, (prefixMap.get(prefix) || 0) + 1);
  }
  const repeatedPrefixes = [...prefixMap.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1]);

  console.log(`  独立前缀数: ${prefixMap.size.toLocaleString()}`);
  console.log(`  重复 ≥3 次的前缀: ${repeatedPrefixes.length}`);

  if (repeatedPrefixes.length > 0) {
    console.log("\n  Top 20 重复前缀:");
    for (const [prefix, count] of repeatedPrefixes.slice(0, 20)) {
      console.log(`    [×${count.toString().padStart(4)}] ${prefix}...`);
    }
  }

  // ============================================
  // 5. Scope × Category 交叉分析
  // ============================================
  console.log("\n📊 5. Scope × Category 交叉分析（Top 10 Scope）");
  console.log("-".repeat(70));
  const scopeCat = new Map<string, Map<string, number>>();
  for (const row of parsedRows) {
    const s = row.scope || "(empty)";
    if (!scopeCat.has(s)) scopeCat.set(s, new Map());
    const catMap = scopeCat.get(s)!;
    catMap.set(row.category, (catMap.get(row.category) || 0) + 1);
  }
  const topScopes = [...scopeCat.entries()]
    .map(([scope, cats]) => {
      const scopeTotal = [...cats.values()].reduce((s, c) => s + c, 0);
      return { scope, total: scopeTotal, cats };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const allCats = [...new Set(parsedRows.map(r => r.category))].sort();
  // Header
  let header = "  Scope".padEnd(35);
  for (const cat of allCats) header += cat.slice(0, 6).padStart(8);
  header += "   Total".padStart(8);
  console.log(header);

  for (const { scope, total: scopeTotal, cats } of topScopes) {
    const label = scope.length > 30 ? scope.slice(0, 27) + "..." : scope;
    let line = `  ${label.padEnd(33)}`;
    for (const cat of allCats) {
      line += (cats.get(cat) || 0).toString().padStart(8);
    }
    line += scopeTotal.toString().padStart(8);
    console.log(line);
  }

  // ============================================
  // 6. 时间模式分析
  // ============================================
  console.log("\n📊 6. 时间模式分析");
  console.log("-".repeat(70));

  // By month
  const monthMap = new Map<string, number>();
  // By hour of day
  const hourMap = new Map<number, number>();
  // By day of week
  const dowMap = new Map<number, number>();
  const DOW_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  for (const row of parsedRows) {
    const d = new Date(row.timestamp);
    const month = d.toISOString().slice(0, 7);
    monthMap.set(month, (monthMap.get(month) || 0) + 1);
    hourMap.set(d.getHours(), (hourMap.get(d.getHours()) || 0) + 1);
    dowMap.set(d.getDay(), (dowMap.get(d.getDay()) || 0) + 1);
  }

  // Monthly trend
  const months = [...monthMap.entries()].sort();
  console.log("  月度趋势:");
  const maxMonthCount = Math.max(...months.map(m => m[1]));
  for (const [month, count] of months) {
    const bar = "█".repeat(Math.round(count / maxMonthCount * 30));
    console.log(`    ${month}  ${count.toString().padStart(6)}  ${bar}`);
  }

  // Hourly pattern
  console.log("\n  小时分布:");
  const maxHourCount = Math.max(...[...hourMap.values()]);
  for (let h = 0; h < 24; h++) {
    const count = hourMap.get(h) || 0;
    const bar = "█".repeat(Math.round(count / maxHourCount * 20));
    console.log(`    ${h.toString().padStart(2)}:00  ${count.toString().padStart(5)}  ${bar}`);
  }

  // Day of week
  console.log("\n  星期分布:");
  for (let d = 0; d < 7; d++) {
    const count = dowMap.get(d) || 0;
    const pct = (count / total * 100).toFixed(1);
    console.log(`    ${DOW_NAMES[d]}  ${count.toString().padStart(6)}  (${pct}%)`);
  }

  // ============================================
  // 7. 过时内容检测
  // ============================================
  console.log("\n📊 7. 过时内容检测");
  console.log("-".repeat(70));

  // Look for date references in text
  const yearRefs = new Map<string, number>();
  for (const row of parsedRows) {
    const yearPattern = /20(2[0-6])/g;
    let match;
    while ((match = yearPattern.exec(row.text)) !== null) {
      const year = `20${match[1]}`;
      yearRefs.set(year, (yearRefs.get(year) || 0) + 1);
    }
  }
  console.log("  文本中提到的年份:");
  for (const [year, count] of [...yearRefs.entries()].sort()) {
    console.log(`    ${year}: ${count.toLocaleString()} 次`);
  }

  // Look for potentially outdated keywords
  const outdatedKeywords = [
    "deprecated", "removed", "old", "legacy", "TODO", "FIXME", "HACK",
    "temporary", "workaround", "临时", "废弃", "已删除", "待修复",
  ];
  console.log("\n  过时关键词扫描:");
  for (const kw of outdatedKeywords) {
    const count = parsedRows.filter(r =>
      r.text.toLowerCase().includes(kw.toLowerCase())
    ).length;
    if (count > 0) {
      console.log(`    "${kw}": ${count} 条`);
    }
  }

  // ============================================
  // 8. 文本精确重复检测
  // ============================================
  console.log("\n📊 8. 精确/近似文本重复");
  console.log("-".repeat(70));

  // Exact text duplicates
  const textMap = new Map<string, number>();
  for (const row of parsedRows) {
    const normalized = row.text.trim().toLowerCase();
    textMap.set(normalized, (textMap.get(normalized) || 0) + 1);
  }
  const exactDups = [...textMap.entries()].filter(([, count]) => count > 1);
  const totalDupRows = exactDups.reduce((s, [, c]) => s + c, 0);
  console.log(`  精确重复组: ${exactDups.length}`);
  console.log(`  重复行总数: ${totalDupRows} / ${total} (${(totalDupRows/total*100).toFixed(1)}%)`);

  if (exactDups.length > 0) {
    const topDups = exactDups.sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log("\n  Top 10 精确重复:");
    for (const [text, count] of topDups) {
      console.log(`    [×${count}] ${text.slice(0, 80)}...`);
    }
  }

  // Text fingerprint duplicates (first 100 chars match)
  const fpMap = new Map<string, number>();
  for (const row of parsedRows) {
    const fp = row.text.trim().slice(0, 100).toLowerCase();
    fpMap.set(fp, (fpMap.get(fp) || 0) + 1);
  }
  const fpDups = [...fpMap.entries()].filter(([, count]) => count > 1);
  const fpDupRows = fpDups.reduce((s, [, c]) => s + c, 0);
  console.log(`\n  前100字符重复组: ${fpDups.length}`);
  console.log(`  相关行总数: ${fpDupRows} / ${total} (${(fpDupRows/total*100).toFixed(1)}%)`);

  // ============================================
  // 9. Scope 生态分析
  // ============================================
  console.log("\n📊 9. Scope 生态分析");
  console.log("-".repeat(70));

  const scopeCounts = new Map<string, number>();
  for (const row of parsedRows) {
    const s = row.scope || "(empty)";
    scopeCounts.set(s, (scopeCounts.get(s) || 0) + 1);
  }
  const totalScopes = scopeCounts.size;
  const singletonScopes = [...scopeCounts.entries()].filter(([, c]) => c === 1).length;
  const tinyScopes = [...scopeCounts.entries()].filter(([, c]) => c <= 5 && c > 1).length;

  console.log(`  总 scope 数: ${totalScopes}`);
  console.log(`  单条 scope（孤儿）: ${singletonScopes} (${(singletonScopes/totalScopes*100).toFixed(1)}%)`);
  console.log(`  2-5 条 scope: ${tinyScopes}`);
  console.log(`  Top 1 scope 占比: ${(([...scopeCounts.values()].sort((a,b)=>b-a)[0] / total) * 100).toFixed(1)}%`);

  // ============================================
  // 10. 内容主题聚类（基于 embedding 采样）
  // ============================================
  const clusterSampleSize = 2000;
  console.log(`\n📊 10. Embedding 聚类采样（${clusterSampleSize} 条，K-Means k=8）`);
  console.log("-".repeat(70));
  console.log("  ⏳ 读取向量数据...");

  // Read vectors for sample
  const sampleWithVectors: MemoryRow[] = await table
    .query()
    .select(["id", "text", "vector", "category", "scope", "timestamp"])
    .limit(clusterSampleSize)
    .toArray() as any;

  // Simple K-Means
  const K = 8;
  const dim = sampleWithVectors[0]?.vector?.length || 0;
  if (dim === 0) {
    console.log("  ⚠️ 无向量数据，跳过聚类");
  } else {
    console.log(`  向量维度: ${dim}`);

    // Initialize centroids randomly
    const centroids: number[][] = [];
    const usedSet = new Set<number>();
    for (let i = 0; i < K; i++) {
      let idx: number;
      do { idx = Math.floor(Math.random() * sampleWithVectors.length); } while (usedSet.has(idx));
      usedSet.add(idx);
      centroids.push([...sampleWithVectors[idx].vector]);
    }

    // Run K-Means for 20 iterations
    const assignments = new Array(sampleWithVectors.length).fill(0);
    for (let iter = 0; iter < 20; iter++) {
      // Assign
      for (let i = 0; i < sampleWithVectors.length; i++) {
        let bestK = 0, bestSim = -1;
        for (let k = 0; k < K; k++) {
          const sim = cosineSimilarity(sampleWithVectors[i].vector, centroids[k]);
          if (sim > bestSim) { bestSim = sim; bestK = k; }
        }
        assignments[i] = bestK;
      }
      // Update centroids
      for (let k = 0; k < K; k++) {
        const members = sampleWithVectors.filter((_, i) => assignments[i] === k);
        if (members.length === 0) continue;
        for (let d = 0; d < dim; d++) {
          centroids[k][d] = members.reduce((s, m) => s + m.vector[d], 0) / members.length;
        }
      }
    }

    // Analyze clusters
    const clusters: Map<number, typeof sampleWithVectors> = new Map();
    for (let i = 0; i < sampleWithVectors.length; i++) {
      if (!clusters.has(assignments[i])) clusters.set(assignments[i], []);
      clusters.get(assignments[i])!.push(sampleWithVectors[i]);
    }

    console.log(`\n  聚类结果 (K=${K}):`);
    const sortedClusters = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [k, members] of sortedClusters) {
      console.log(`\n  ── Cluster ${k} (${members.length} 条, ${(members.length/sampleWithVectors.length*100).toFixed(1)}%) ──`);

      // Category distribution within cluster
      const clCatMap = new Map<string, number>();
      for (const m of members) {
        clCatMap.set(m.category, (clCatMap.get(m.category) || 0) + 1);
      }
      const catStr = [...clCatMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `${c}:${n}`)
        .join(", ");
      console.log(`    类别: ${catStr}`);

      // Top scopes
      const clScopeMap = new Map<string, number>();
      for (const m of members) {
        const s = m.scope || "(empty)";
        clScopeMap.set(s, (clScopeMap.get(s) || 0) + 1);
      }
      const topClScopes = [...clScopeMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      console.log(`    Top scope: ${topClScopes.map(([s, n]) => `${s.slice(0,30)}(${n})`).join(", ")}`);

      // Top keywords
      const clWordFreq = new Map<string, number>();
      for (const m of members) {
        const tokens = tokenize(m.text);
        const seen = new Set<string>();
        for (const t of tokens) {
          if (!STOPWORDS.has(t) && t.length > 1 && !seen.has(t)) {
            clWordFreq.set(t, (clWordFreq.get(t) || 0) + 1);
            seen.add(t);
          }
        }
      }
      const topClWords = [...clWordFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([w]) => w)
        .join(", ");
      console.log(`    关键词: ${topClWords}`);

      // Sample texts
      console.log(`    示例:`);
      const samples = members.slice(0, 3);
      for (const s of samples) {
        console.log(`      - ${s.text.slice(0, 100)}...`);
      }
    }
  }

  // ============================================
  // 11. 异常值检测
  // ============================================
  console.log("\n📊 11. 异常值检测");
  console.log("-".repeat(70));

  // Empty or near-empty scope
  const emptyScope = parsedRows.filter(r => !r.scope || r.scope.trim() === "").length;
  console.log(`  空 scope: ${emptyScope} 条 (${(emptyScope/total*100).toFixed(1)}%)`);

  // Suspiciously high importance + zero access
  const highImpZeroAccess = parsedRows.filter(r => {
    const ac = r.meta.accessCount ?? r.meta.access_count ?? 0;
    return r.importance >= 0.8 && ac === 0;
  }).length;
  console.log(`  高 importance(≥0.8) + 0 访问: ${highImpZeroAccess} 条`);

  // Very old memories that are still "working" tier
  const oldWorking = parsedRows.filter(r => {
    const tier = r.meta.tier ?? "unknown";
    const agedays = (Date.now() - r.timestamp) / (1000*60*60*24);
    return tier === "working" && agedays > 60;
  }).length;
  console.log(`  >60天的 working tier 记忆: ${oldWorking} 条（应降级？）`);

  // Memories with no metadata
  const noMeta = parsedRows.filter(r => !r.metadata || r.metadata === "{}").length;
  console.log(`  无 metadata: ${noMeta} 条`);

  // ============================================
  // 综合发现
  // ============================================
  console.log("\n" + "=".repeat(70));
  console.log("🔬 盲扫综合发现");
  console.log("=".repeat(70));

  const findings: string[] = [];

  if (exactDups.length > 0) {
    findings.push(`📌 精确重复 ${exactDups.length} 组 / ${totalDupRows} 条 — 有清理空间`);
  }
  if (ultraShort.length > 0) {
    findings.push(`📌 超短文本 (<20字符) ${ultraShort.length} 条 — 可能是垃圾数据`);
  }
  if (singletonScopes > totalScopes * 0.5) {
    findings.push(`📌 ${singletonScopes}/${totalScopes} scope 只有 1 条记忆 — scope 碎片化严重`);
  }
  if (highImpZeroAccess > 100) {
    findings.push(`📌 ${highImpZeroAccess} 条高重要性记忆从未被访问 — importance 标记可能虚高`);
  }
  if (mixed / total > 0.3) {
    findings.push(`📌 ${(mixed/total*100).toFixed(1)}% 记忆中英混合 — 可能影响检索一致性`);
  }
  if (emptyScope > total * 0.1) {
    findings.push(`📌 ${(emptyScope/total*100).toFixed(1)}% 记忆无 scope — 检索时无法按项目过滤`);
  }

  for (const f of findings) {
    console.log(`  ${f}`);
  }

  if (findings.length === 0) {
    console.log("  ✅ 未发现明显异常模式");
  }

  console.log("\n" + "=".repeat(70));
  console.log("📋 盲扫完成\n");
}

main().catch(console.error);
