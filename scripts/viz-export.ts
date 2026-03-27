/**
 * 可视化数据导出 + HTML 仪表盘生成
 * 模块 6：把体检数据做成交互式可视化
 *
 * 用法：bun run scripts/viz-export.ts [lancedb-dir]
 * 输出：scripts/viz-dashboard.html（本地打开即可）
 */

import lancedb from "@lancedb/lancedb";
import { writeFileSync } from "fs";
import { join, dirname } from "path";

const DB_PATH = process.argv[2] || "./data/lancedb";
const TABLE_NAME = "memories";
const OUTPUT_HTML = join(dirname(new URL(import.meta.url).pathname), "viz-dashboard.html");

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

async function main() {
  console.log("⏳ 读取数据...");
  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable(TABLE_NAME);

  const allRows: MemoryRow[] = await table
    .query()
    .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"])
    .toArray() as any;

  const total = allRows.length;
  console.log(`✅ ${total.toLocaleString()} 条记忆`);

  const parsedRows = allRows.map(row => ({
    ...row,
    meta: row.metadata ? JSON.parse(row.metadata) : {},
  }));

  // ── Prepare visualization data ──

  // 1. Category distribution
  const catMap = new Map<string, number>();
  for (const r of parsedRows) {
    catMap.set(r.category, (catMap.get(r.category) || 0) + 1);
  }
  const categoryData = Object.fromEntries([...catMap.entries()].sort((a, b) => b[1] - a[1]));

  // 2. Tier distribution
  const tierMap = new Map<string, number>();
  for (const r of parsedRows) {
    const tier = r.meta.tier ?? "unknown";
    tierMap.set(tier, (tierMap.get(tier) || 0) + 1);
  }
  const tierData = Object.fromEntries([...tierMap.entries()].sort((a, b) => b[1] - a[1]));

  // 3. Monthly timeline
  const monthMap = new Map<string, {total: number, cats: Record<string, number>}>();
  for (const r of parsedRows) {
    const month = new Date(r.timestamp).toISOString().slice(0, 7);
    if (!monthMap.has(month)) monthMap.set(month, { total: 0, cats: {} });
    const m = monthMap.get(month)!;
    m.total++;
    m.cats[r.category] = (m.cats[r.category] || 0) + 1;
  }
  const timelineData = Object.fromEntries([...monthMap.entries()].sort());

  // 4. Daily timeline (last 90 days)
  const now = Date.now();
  const dayMap = new Map<string, number>();
  for (const r of parsedRows) {
    if (now - r.timestamp < 90 * 24 * 60 * 60 * 1000) {
      const day = new Date(r.timestamp).toISOString().slice(0, 10);
      dayMap.set(day, (dayMap.get(day) || 0) + 1);
    }
  }
  const dailyData = Object.fromEntries([...dayMap.entries()].sort());

  // 5. Hourly pattern
  const hourData: number[] = new Array(24).fill(0);
  for (const r of parsedRows) {
    hourData[new Date(r.timestamp).getHours()]++;
  }

  // 6. Day of week
  const dowData: number[] = new Array(7).fill(0);
  for (const r of parsedRows) {
    dowData[new Date(r.timestamp).getDay()]++;
  }

  // 7. Importance distribution (histogram)
  const impBins = 20;
  const impHist: number[] = new Array(impBins).fill(0);
  for (const r of parsedRows) {
    const bin = Math.min(impBins - 1, Math.floor(r.importance * impBins));
    impHist[bin]++;
  }

  // 8. Access count distribution
  const accessBuckets: Record<string, number> = {
    "0 (死记忆)": 0, "1-2": 0, "3-5": 0, "6-10": 0, "11-50": 0, "50+": 0,
  };
  for (const r of parsedRows) {
    const ac = r.meta.accessCount ?? r.meta.access_count ?? 0;
    if (ac === 0) accessBuckets["0 (死记忆)"]++;
    else if (ac <= 2) accessBuckets["1-2"]++;
    else if (ac <= 5) accessBuckets["3-5"]++;
    else if (ac <= 10) accessBuckets["6-10"]++;
    else if (ac <= 50) accessBuckets["11-50"]++;
    else accessBuckets["50+"]++;
  }

  // 9. Top scopes
  const scopeMap = new Map<string, number>();
  for (const r of parsedRows) {
    const s = r.scope || "(empty)";
    scopeMap.set(s, (scopeMap.get(s) || 0) + 1);
  }
  const topScopes = Object.fromEntries(
    [...scopeMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  );

  // 10. Text length distribution
  const lenBins = 30;
  const maxLen = 3000; // cap for histogram
  const lenHist: number[] = new Array(lenBins).fill(0);
  for (const r of parsedRows) {
    const bin = Math.min(lenBins - 1, Math.floor(r.text.length / maxLen * lenBins));
    lenHist[bin]++;
  }

  // 11. Embedding 2D projection (PCA on sample)
  console.log("⏳ 读取向量样本做 PCA 投影...");
  const pca_sample_size = 3000;
  const sampleRows: MemoryRow[] = await table
    .query()
    .select(["id", "text", "vector", "category", "scope", "timestamp"])
    .limit(pca_sample_size)
    .toArray() as any;

  // Simple PCA: project onto top 2 principal components
  const dim = sampleRows[0]?.vector?.length || 0;
  let pcaPoints: Array<{x: number, y: number, category: string, scope: string, text: string}> = [];

  if (dim > 0) {
    // Compute mean
    const mean = new Array(dim).fill(0);
    for (const r of sampleRows) {
      for (let d = 0; d < dim; d++) mean[d] += r.vector[d];
    }
    for (let d = 0; d < dim; d++) mean[d] /= sampleRows.length;

    // Center data (vector may be Float32Array, convert to plain array)
    const centered = sampleRows.map(r => {
      const vec = Array.from(r.vector);
      return vec.map((v, d) => v - mean[d]);
    });

    // Power iteration for top 2 eigenvectors
    function powerIteration(data: number[][], deflateVec?: number[]): number[] {
      const n = data.length;
      const d = data[0].length;
      let v = new Array(d).fill(0).map(() => Math.random() - 0.5);
      // Normalize
      let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      v = v.map(x => x / norm);

      // If deflating, project out previous component
      let dataToUse = data;
      if (deflateVec) {
        dataToUse = data.map(row => {
          const proj = row.reduce((s, x, i) => s + x * deflateVec[i], 0);
          return row.map((x, i) => x - proj * deflateVec[i]);
        });
      }

      for (let iter = 0; iter < 50; iter++) {
        // v_new = X^T * X * v
        const Xv = dataToUse.map(row => row.reduce((s, x, i) => s + x * v[i], 0));
        const newV = new Array(d).fill(0);
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < d; j++) {
            newV[j] += dataToUse[i][j] * Xv[i];
          }
        }
        norm = Math.sqrt(newV.reduce((s, x) => s + x * x, 0));
        v = newV.map(x => x / norm);
      }
      return v;
    }

    const pc1 = powerIteration(centered);
    const pc2 = powerIteration(centered, pc1);

    // Project
    pcaPoints = sampleRows.map((r, i) => ({
      x: centered[i].reduce((s, v, d) => s + v * pc1[d], 0),
      y: centered[i].reduce((s, v, d) => s + v * pc2[d], 0),
      category: r.category,
      scope: (r.scope || "").slice(0, 40),
      text: r.text.slice(0, 80),
    }));
  }

  // 12. Scope × Category heatmap (top 10 scopes × all categories)
  const scopeCatMatrix: Record<string, Record<string, number>> = {};
  const heatmapScopes = [...scopeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([s]) => s);
  const allCats = [...catMap.keys()].sort();

  for (const s of heatmapScopes) {
    scopeCatMatrix[s] = {};
    for (const c of allCats) scopeCatMatrix[s][c] = 0;
  }
  for (const r of parsedRows) {
    const s = r.scope || "(empty)";
    if (scopeCatMatrix[s]) {
      scopeCatMatrix[s][r.category] = (scopeCatMatrix[s][r.category] || 0) + 1;
    }
  }

  // ── Summary stats ──
  const summaryStats = {
    total,
    categories: catMap.size,
    scopes: scopeMap.size,
    deadMemories: accessBuckets["0 (死记忆)"],
    deadPct: (accessBuckets["0 (死记忆)"] / total * 100).toFixed(1),
    oldest: new Date(Math.min(...parsedRows.map(r => r.timestamp))).toISOString().slice(0, 10),
    newest: new Date(Math.max(...parsedRows.map(r => r.timestamp))).toISOString().slice(0, 10),
    avgImportance: (parsedRows.reduce((s, r) => s + r.importance, 0) / total).toFixed(3),
  };

  // ── Generate HTML ──
  const vizData = {
    summaryStats,
    categoryData,
    tierData,
    timelineData,
    dailyData,
    hourData,
    dowData,
    impHist,
    accessBuckets,
    topScopes,
    lenHist,
    pcaPoints,
    scopeCatMatrix,
    heatmapScopes,
    allCats,
  };

  const html = generateHTML(vizData);
  writeFileSync(OUTPUT_HTML, html, "utf-8");
  console.log(`\n✅ 仪表盘已生成: ${OUTPUT_HTML}`);
  console.log("   用浏览器打开即可查看交互图表");
}

function generateHTML(data: any): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RecallNest 记忆体检仪表盘</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #0f0f23;
    color: #e0e0e0;
    padding: 20px;
  }
  h1 {
    text-align: center;
    font-size: 28px;
    color: #00d4ff;
    margin-bottom: 8px;
  }
  .subtitle {
    text-align: center;
    color: #888;
    margin-bottom: 30px;
    font-size: 14px;
  }
  .stats-bar {
    display: flex;
    justify-content: center;
    gap: 30px;
    margin-bottom: 30px;
    flex-wrap: wrap;
  }
  .stat-card {
    background: #1a1a3e;
    border: 1px solid #333;
    border-radius: 12px;
    padding: 16px 24px;
    text-align: center;
    min-width: 140px;
  }
  .stat-card .value {
    font-size: 28px;
    font-weight: bold;
    color: #00d4ff;
  }
  .stat-card .label {
    font-size: 12px;
    color: #888;
    margin-top: 4px;
  }
  .stat-card.alert .value { color: #ff6b6b; }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    max-width: 1400px;
    margin: 0 auto;
  }
  .chart-box {
    background: #1a1a3e;
    border: 1px solid #333;
    border-radius: 12px;
    padding: 16px;
  }
  .chart-box.full-width {
    grid-column: 1 / -1;
  }
  .chart-box h3 {
    color: #00d4ff;
    font-size: 16px;
    margin-bottom: 12px;
  }
  .chart-container {
    width: 100%;
    min-height: 350px;
  }
  .chart-container.tall {
    min-height: 500px;
  }
  footer {
    text-align: center;
    color: #555;
    margin-top: 40px;
    font-size: 12px;
  }
  @media (max-width: 900px) {
    .grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<h1>🧠 RecallNest 记忆体检仪表盘</h1>
<p class="subtitle">生成时间: ${new Date().toISOString().slice(0, 19)} · 数据来源: LanceDB memories table</p>

<div class="stats-bar">
  <div class="stat-card">
    <div class="value">${data.summaryStats.total.toLocaleString()}</div>
    <div class="label">总记忆数</div>
  </div>
  <div class="stat-card alert">
    <div class="value">${data.summaryStats.deadPct}%</div>
    <div class="label">死记忆率</div>
  </div>
  <div class="stat-card">
    <div class="value">${data.summaryStats.categories}</div>
    <div class="label">类别数</div>
  </div>
  <div class="stat-card">
    <div class="value">${data.summaryStats.scopes}</div>
    <div class="label">Scope 数</div>
  </div>
  <div class="stat-card">
    <div class="value">${data.summaryStats.avgImportance}</div>
    <div class="label">平均 Importance</div>
  </div>
  <div class="stat-card">
    <div class="value">${data.summaryStats.oldest}</div>
    <div class="label">最早记忆</div>
  </div>
</div>

<div class="grid">

  <!-- 1. Category Distribution -->
  <div class="chart-box">
    <h3>📊 类别分布</h3>
    <div class="chart-container" id="chart-category"></div>
  </div>

  <!-- 2. Tier Distribution -->
  <div class="chart-box">
    <h3>📊 Tier 分布</h3>
    <div class="chart-container" id="chart-tier"></div>
  </div>

  <!-- 3. Monthly Timeline -->
  <div class="chart-box full-width">
    <h3>📈 月度记忆增长</h3>
    <div class="chart-container" id="chart-timeline"></div>
  </div>

  <!-- 4. Daily Timeline (last 90 days) -->
  <div class="chart-box full-width">
    <h3>📈 近 90 天每日记忆量</h3>
    <div class="chart-container" id="chart-daily"></div>
  </div>

  <!-- 5. Hourly Pattern -->
  <div class="chart-box">
    <h3>⏰ 小时分布</h3>
    <div class="chart-container" id="chart-hourly"></div>
  </div>

  <!-- 6. Day of Week -->
  <div class="chart-box">
    <h3>📅 星期分布</h3>
    <div class="chart-container" id="chart-dow"></div>
  </div>

  <!-- 7. Access Count -->
  <div class="chart-box">
    <h3>🔍 访问次数分布</h3>
    <div class="chart-container" id="chart-access"></div>
  </div>

  <!-- 8. Importance Distribution -->
  <div class="chart-box">
    <h3>⚖️ Importance 分布</h3>
    <div class="chart-container" id="chart-importance"></div>
  </div>

  <!-- 9. Top Scopes -->
  <div class="chart-box full-width">
    <h3>🏷️ Top 15 Scopes</h3>
    <div class="chart-container" id="chart-scopes"></div>
  </div>

  <!-- 10. Scope × Category Heatmap -->
  <div class="chart-box full-width">
    <h3>🗺️ Scope × Category 热力图</h3>
    <div class="chart-container" id="chart-heatmap"></div>
  </div>

  <!-- 11. Text Length Distribution -->
  <div class="chart-box">
    <h3>📏 文本长度分布</h3>
    <div class="chart-container" id="chart-textlen"></div>
  </div>

  <!-- 12. Embedding PCA Scatter -->
  <div class="chart-box full-width">
    <h3>🧬 Embedding PCA 散点图 (采样 ${data.pcaPoints.length} 条)</h3>
    <div class="chart-container tall" id="chart-pca"></div>
  </div>

</div>

<footer>RecallNest Data Checkup · Module 6 Visualization · ${new Date().toISOString().slice(0, 10)}</footer>

<script>
const DATA = ${JSON.stringify(data)};
const DARK_LAYOUT = {
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
  font: { color: '#e0e0e0', size: 12 },
  margin: { t: 30, r: 20, b: 50, l: 60 },
};
const COLORS = ['#00d4ff', '#ff6b6b', '#ffd93d', '#6bcb77', '#9b59b6', '#e67e22', '#1abc9c', '#e74c3c', '#3498db'];

// 1. Category Donut
Plotly.newPlot('chart-category', [{
  type: 'pie',
  labels: Object.keys(DATA.categoryData),
  values: Object.values(DATA.categoryData),
  hole: 0.45,
  marker: { colors: COLORS },
  textinfo: 'label+percent',
  textfont: { size: 11 },
}], { ...DARK_LAYOUT, showlegend: false });

// 2. Tier Donut
Plotly.newPlot('chart-tier', [{
  type: 'pie',
  labels: Object.keys(DATA.tierData),
  values: Object.values(DATA.tierData),
  hole: 0.45,
  marker: { colors: ['#ff6b6b', '#ffd93d', '#6bcb77'] },
  textinfo: 'label+percent',
  textfont: { size: 12 },
}], { ...DARK_LAYOUT, showlegend: false });

// 3. Monthly Timeline (stacked area)
{
  const months = Object.keys(DATA.timelineData);
  const allCats = [...new Set(months.flatMap(m => Object.keys(DATA.timelineData[m].cats)))];
  const traces = allCats.map((cat, i) => ({
    x: months,
    y: months.map(m => DATA.timelineData[m].cats[cat] || 0),
    name: cat,
    type: 'bar',
    marker: { color: COLORS[i % COLORS.length] },
  }));
  Plotly.newPlot('chart-timeline', traces, {
    ...DARK_LAYOUT,
    barmode: 'stack',
    xaxis: { title: '月份' },
    yaxis: { title: '记忆数' },
    legend: { orientation: 'h', y: -0.2 },
  });
}

// 4. Daily Timeline
{
  const days = Object.keys(DATA.dailyData);
  Plotly.newPlot('chart-daily', [{
    x: days,
    y: days.map(d => DATA.dailyData[d]),
    type: 'bar',
    marker: { color: '#00d4ff', opacity: 0.7 },
  }], {
    ...DARK_LAYOUT,
    xaxis: { title: '日期' },
    yaxis: { title: '记忆数' },
  });
}

// 5. Hourly Pattern
Plotly.newPlot('chart-hourly', [{
  x: DATA.hourData.map((_, i) => i + ':00'),
  y: DATA.hourData,
  type: 'bar',
  marker: {
    color: DATA.hourData.map((v, i) =>
      (i >= 22 || i <= 6) ? '#9b59b6' : (i >= 9 && i <= 18) ? '#00d4ff' : '#ffd93d'
    ),
  },
}], {
  ...DARK_LAYOUT,
  xaxis: { title: '小时' },
  yaxis: { title: '记忆数' },
});

// 6. Day of Week
{
  const dowNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  Plotly.newPlot('chart-dow', [{
    x: dowNames,
    y: DATA.dowData,
    type: 'bar',
    marker: { color: COLORS.slice(0, 7) },
  }], {
    ...DARK_LAYOUT,
    xaxis: { title: '星期' },
    yaxis: { title: '记忆数' },
  });
}

// 7. Access Count
Plotly.newPlot('chart-access', [{
  x: Object.keys(DATA.accessBuckets),
  y: Object.values(DATA.accessBuckets),
  type: 'bar',
  marker: {
    color: Object.keys(DATA.accessBuckets).map((k, i) =>
      k.includes('死记忆') ? '#ff6b6b' : COLORS[i]
    ),
  },
}], {
  ...DARK_LAYOUT,
  xaxis: { title: '访问次数' },
  yaxis: { title: '记忆数', type: 'log' },
});

// 8. Importance Histogram
Plotly.newPlot('chart-importance', [{
  x: DATA.impHist.map((_, i) => (i / DATA.impHist.length).toFixed(2)),
  y: DATA.impHist,
  type: 'bar',
  marker: {
    color: DATA.impHist.map((_, i) => {
      const v = i / DATA.impHist.length;
      return v < 0.3 ? '#ff6b6b' : v < 0.6 ? '#ffd93d' : '#6bcb77';
    }),
  },
}], {
  ...DARK_LAYOUT,
  xaxis: { title: 'Importance' },
  yaxis: { title: '记忆数' },
});

// 9. Top Scopes
Plotly.newPlot('chart-scopes', [{
  y: Object.keys(DATA.topScopes),
  x: Object.values(DATA.topScopes),
  type: 'bar',
  orientation: 'h',
  marker: { color: '#00d4ff' },
}], {
  ...DARK_LAYOUT,
  margin: { ...DARK_LAYOUT.margin, l: 250 },
  xaxis: { title: '记忆数' },
});

// 10. Heatmap
Plotly.newPlot('chart-heatmap', [{
  z: DATA.heatmapScopes.map(s => DATA.allCats.map(c => DATA.scopeCatMatrix[s]?.[c] || 0)),
  x: DATA.allCats,
  y: DATA.heatmapScopes.map(s => s.length > 35 ? s.slice(0, 32) + '...' : s),
  type: 'heatmap',
  colorscale: [[0, '#0f0f23'], [0.5, '#00d4ff'], [1, '#ff6b6b']],
  showscale: true,
}], {
  ...DARK_LAYOUT,
  margin: { ...DARK_LAYOUT.margin, l: 250 },
});

// 11. Text Length
{
  const maxLen = 3000;
  Plotly.newPlot('chart-textlen', [{
    x: DATA.lenHist.map((_, i) => Math.round(i / DATA.lenHist.length * maxLen)),
    y: DATA.lenHist,
    type: 'bar',
    marker: { color: '#1abc9c' },
  }], {
    ...DARK_LAYOUT,
    xaxis: { title: '字符数' },
    yaxis: { title: '记忆数' },
  });
}

// 12. PCA Scatter
if (DATA.pcaPoints.length > 0) {
  const cats = [...new Set(DATA.pcaPoints.map(p => p.category))];
  const traces = cats.map((cat, i) => {
    const points = DATA.pcaPoints.filter(p => p.category === cat);
    return {
      x: points.map(p => p.x),
      y: points.map(p => p.y),
      text: points.map(p => p.text),
      name: cat,
      mode: 'markers',
      type: 'scattergl',
      marker: {
        size: 3,
        color: COLORS[i % COLORS.length],
        opacity: 0.6,
      },
      hovertemplate: '<b>%{text}</b><br>scope: ' + points.map(p => p.scope).join('<br>') + '<extra>%{fullData.name}</extra>',
    };
  });
  // Fix hover: use customdata
  const pcaTraces = cats.map((cat, i) => {
    const points = DATA.pcaPoints.filter(p => p.category === cat);
    return {
      x: points.map(p => p.x),
      y: points.map(p => p.y),
      customdata: points.map(p => [p.text, p.scope]),
      name: cat,
      mode: 'markers',
      type: 'scattergl',
      marker: {
        size: 3,
        color: COLORS[i % COLORS.length],
        opacity: 0.6,
      },
      hovertemplate: '%{customdata[0]}<br><i>scope: %{customdata[1]}</i><extra>%{fullData.name}</extra>',
    };
  });
  Plotly.newPlot('chart-pca', pcaTraces, {
    ...DARK_LAYOUT,
    xaxis: { title: 'PC1', zeroline: false },
    yaxis: { title: 'PC2', zeroline: false },
    legend: { orientation: 'h', y: -0.15 },
    margin: { ...DARK_LAYOUT.margin, b: 80 },
  });
}
</script>
</body>
</html>`;
}

main().catch(console.error);
