// lengthnorm-shadow.ts —— lengthNormAnchor 改动的挤占效应影子采集
//
// 【它回答什么，不回答什么】
// ghost-scan.ts 回答「有多少条记忆的天花板过不了阈值」——离线、不发请求、免费。
// 本脚本回答 ghost-scan 答不了的那一半：**救回来的长记忆会不会挤掉本来召得回的短结论**。
// top-k 容量固定，added > 0 必然 removed > 0，所以「零掉出」不是通过标准；
// 标准是**每条掉出都能逐条说明性质**（见 open-loops 第 8 条的 shadow 判据）。
//
// 【为什么不直接用 la1-shadow/shadow.sh】它是为 LA-1 写的：按 RECALLNEST_LAYER_ADMISSION
// 环境变量切 4 个配置，而 lengthNormAnchor 没有环境变量开关；且它走 CLI，
// CLI 硬编码 `source: "cli"`（cli.ts:186），会触发三条强化写入
// （frequencyTracker.recordHits / recordEvolutionAccess / accessTracker.recordAccess，
// retriever.ts:848-874，全部门控在 `source !== "auto-recall"`）——
// 同一 query 跑两臂时，第一臂返回的条目会被 bump，第二臂就不是干净对照了，
// 而且会真写脏生产库（80 次检索 × 6 条 ≈ 480 条记录的 accessCount）。
// 本脚本用 `source: "auto-recall"` 走同一条检索路径但零强化，可重复、不写库。
// （context.source 全仓只有 4 处用途：3 个强化门控 + 1 个审计 actor 字段，
//   不影响评分/过滤/limit，所以两条路径的分数是可比的。）
//
// 【query 集】逐字沿用 la1-shadow/shadow.sh 的 20 条——它们是刻意混合
// 「老主题（沉淀多）」与「新主题（沉淀少）」挑的，换一批会让结果不可比。
//
// 【绝对路径 import】与 ghost-scan.ts 同款：即使本文件在 worktree 里，
// 也要读主 checkout 的 src 与 data/lancedb，避免撞上「孤儿空库、失败无声」。
// **cwd 无关**（查过才这么写）：dataDir 由 resolveDataDir = resolve(dbPath, "..") 推导
// （runtime-config.ts:142），dbPath 又钉在模块所在 repo root 而非 cwd；
// frequency-tracker.ts:47 那个 `join(process.cwd(), ...)` 只是默认值，
// createComponents 每次都显式覆盖 filePath，实际不走。
//
// 用法：~/.bun/bin/bun run <本文件绝对路径>
//       （凭证自己从 ~/.config/recallnest/mcp.env 读，不必先 source）
// 可选：ANCHOR_B=1000 换处理臂的 anchor；OUT=<路径> 指定明细落点。

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 自带 env 加载：mcp.env 是生产 MCP 启动器（~/.local/bin/recallnest-mcp）读的同一份，
// 里面除了 JINA_API_KEY 还有 RECALLNEST_LAYER_ADMISSION —— 要按生产真实态跑就得带上它。
const envFile = join(homedir(), ".config", "recallnest", "mcp.env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0 && !process.env[t.slice(0, i).trim()]) {
      process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
}

const { loadConfig, createComponents } = await import("/Users/anxianjingya/recallnest/src/runtime-config.ts");

const QUERIES = [
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

const LIMIT = Number(process.env.LIMIT || 6);
const ANCHOR_B = Number(process.env.ANCHOR_B || 800);
// 诊断用：ONLY=11,13,20 只跑这几条 query（1-based，对应上面 QUERIES 的序号）。
// 配合 LIMIT 放大可区分「被去重阶段杀掉」和「只是被挤出 limit 窗口」——
// 后者在放大 limit 后会重新出现，前者不会。
const ONLY = (process.env.ONLY || "")
  .split(",").map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n >= 1);

interface Row {
  id: string;
  score: number;
  len: number;
  cat: string;
  scope: string;
  source: string;
  head: string;
}

const baseConfig = loadConfig();
const anchorA = baseConfig.retrieval?.lengthNormAnchor ?? 500; // 未设则用 DEFAULT_RETRIEVAL_CONFIG 的 500

const configB = structuredClone(baseConfig);
configB.retrieval = { ...(configB.retrieval || {}), lengthNormAnchor: ANCHOR_B };

const armA = createComponents(baseConfig);
const armB = createComponents(configB);

const toRow = (r: { entry: { id: string; text: string; category?: string; scope: string; metadata?: string }; score: number }): Row => {
  let source = "?";
  try { source = JSON.parse(r.entry.metadata || "{}")?.source || "?"; } catch { /* 病行不崩整跑 */ }
  return {
    id: r.entry.id.slice(0, 8),
    score: +r.score.toFixed(4),
    len: (r.entry.text || "").length,
    cat: r.entry.category || "events",
    scope: r.entry.scope,
    source,
    head: (r.entry.text || "").slice(0, 70).replace(/\s+/g, " "),
  };
};

const perQuery: Array<{
  query: string;
  a: Row[];
  b: Row[];
  dropped: Row[];   // A 有 B 无 —— 被挤掉的
  entered: Row[];   // B 有 A 无 —— 新救回的
  kept: number;
}> = [];

const selected = ONLY.length ? ONLY.map(n => QUERIES[n - 1]).filter(Boolean) : QUERIES;

for (const [i, query] of selected.entries()) {
  const [ra, rb] = await Promise.all([
    armA.retriever.retrieve({ query, limit: LIMIT, source: "auto-recall" }),
    armB.retriever.retrieve({ query, limit: LIMIT, source: "auto-recall" }),
  ]);
  const a = ra.map(toRow);
  const b = rb.map(toRow);
  const aIds = new Set(a.map(r => r.id));
  const bIds = new Set(b.map(r => r.id));
  perQuery.push({
    query,
    a,
    b,
    dropped: a.filter(r => !bIds.has(r.id)),
    entered: b.filter(r => !aIds.has(r.id)),
    kept: a.filter(r => bIds.has(r.id)).length,
  });
  console.error(`q${String(i + 1).padStart(2)} ${query}  A=${a.length} B=${b.length} dropped=${perQuery[i].dropped.length}`);
}

const allDropped = perQuery.flatMap(q => q.dropped.map(r => ({ ...r, query: q.query })));
const allEntered = perQuery.flatMap(q => q.entered.map(r => ({ ...r, query: q.query })));
const mean = (xs: number[]) => (xs.length ? +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1) : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const byCat = (rows: Row[]) => rows.reduce<Record<string, number>>((m, r) => { m[r.cat] = (m[r.cat] || 0) + 1; return m; }, {});

const aAll = perQuery.flatMap(q => q.a);
const bAll = perQuery.flatMap(q => q.b);

console.log(JSON.stringify({
  anchorA,
  anchorB: ANCHOR_B,
  queries: selected.length,
  limit: LIMIT,
  totalSlotsA: aAll.length,
  totalSlotsB: bAll.length,
  dropped: allDropped.length,
  entered: allEntered.length,
  churnPct: +(allDropped.length / Math.max(1, aAll.length) * 100).toFixed(1),
  queriesUnchanged: perQuery.filter(q => q.dropped.length === 0).length,
  lenStats: {
    aMean: mean(aAll.map(r => r.len)), aMedian: median(aAll.map(r => r.len)),
    bMean: mean(bAll.map(r => r.len)), bMedian: median(bAll.map(r => r.len)),
    droppedMean: mean(allDropped.map(r => r.len)), droppedMedian: median(allDropped.map(r => r.len)),
    enteredMean: mean(allEntered.map(r => r.len)), enteredMedian: median(allEntered.map(r => r.len)),
  },
  overAnchorA: { a: aAll.filter(r => r.len > anchorA).length, b: bAll.filter(r => r.len > anchorA).length },
  droppedByCat: byCat(allDropped),
  enteredByCat: byCat(allEntered),
  droppedBySource: allDropped.reduce<Record<string, number>>((m, r) => { m[r.source] = (m[r.source] || 0) + 1; return m; }, {}),
  enteredBySource: allEntered.reduce<Record<string, number>>((m, r) => { m[r.source] = (m[r.source] || 0) + 1; return m; }, {}),
}, null, 1));

const fs = await import("node:fs");
const out = process.env.OUT || "/tmp/lengthnorm-shadow.json";
fs.writeFileSync(out, JSON.stringify({ anchorA, anchorB: ANCHOR_B, perQuery }, null, 1));
console.error(`detail -> ${out}`);

armA.accessTracker?.destroy();
armB.accessTracker?.destroy();
process.exit(0);
