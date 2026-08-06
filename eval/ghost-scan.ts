// ghost-scan.ts —— 结构性幽灵记忆量化（只读扫库）
//
// 【复原说明 2026-08-06】本脚本原为 2026-07-25 session c2639386 的一次性临时脚本，
// 写在 scratchpad 里、从未入库，scratchpad 事后被清理 → 它产出的
// 「阈值风险队列 40012/120816 = 33.12%（改前 52.25%）」一度被判定为"出处不明、不可复核"，
// 并连累 open-loops 第 8 条的验收标准③变成一条永远无法判定通过的验收。
// 2026-08-06 从会话 jsonl 的 tool_use 记录中完整复原（3114 字符），逐字未改算法，
// 只改最后一行明细输出路径（原 scratchpad 路径已不存在）。
//
// 【教训，别再犯】被引用进结论的数据，其生产脚本必须入库。
// 「中间产物用完即清」与「日后可复核」在这里是直接冲突的，清理纪律要给复核让路。
//
// 【指标定义】不是 query-dependent 的实际检索分，而是**冷启动天花板分**：
// 假设某条记忆被完美匹配（score=1.0），让它过一遍完整生产评分链，得到它在最好情况下
// 能拿到的分；若这个天花板仍低于该 category 的 min_score 阈值，则它是「结构性幽灵」——
// 无论 query 写得多好都召不回（exact-token BM25 补偿路径除外）。
//
// 【可复算性】复用生产 applySharedScoring + minScoreFor，公式零漂移，任何时候都能重跑。
// 但**新旧数字不可直接比**：库构成会变（如 2026-08-03~05 删掉 133,755 条 evidence 碎片），
// 比例的分母和成分都不同。要比就比同一次快照内的 before/after。
//
// 【已知噪声】store.list 分页每页重读实时表，并发写入会让行在页间移动 —— 2026-07-25
// 同日两次运行实测差 22 行 active / 13 条 ghost。故结论必须附快照时间戳；要严格可复现
// 应改用 LanceDB checkout(version) 钉版本后扫描。
//
// 用法：cd ~/recallnest && set -a && source ~/.config/recallnest/mcp.env && set +a \
//       && ~/.bun/bin/bun run eval/ghost-scan.ts

import { loadConfig, createComponents } from "/Users/anxianjingya/recallnest/src/runtime-config.ts";
import { DEFAULT_CATEGORY_MIN_SCORES } from "/Users/anxianjingya/recallnest/src/retriever.ts";

const config = loadConfig();
const { store, retriever } = createComponents(config);

const r: any = retriever;
const minScoreFor = (cat: string) => r.minScoreFor(cat, false);

// 逐批拉全库(list 假空向量坑不影响:评分链不读 vector)
const BATCH = 2000;
let offset = 0;
let total = 0;
const ghosts: any[] = [];
const byCategory: Record<string, { total: number; ghost: number }> = {};
const bySource: Record<string, { total: number; ghost: number }> = {};
let activeTotal = 0;

for (;;) {
  const batch = await store.list(undefined, undefined, BATCH, offset);
  if (batch.length === 0) break;
  offset += batch.length;
  total += batch.length;

  for (const entry of batch) {
    // 只统计 active 行(archived/superseded 本来就不该被搜到)
    let evoStatus = "active";
    try {
      const evo = JSON.parse(entry.metadata || "{}")?.evolution;
      if (evo?.status) evoStatus = evo.status;
    } catch {}
    if (evoStatus !== "active" && evoStatus !== "pending_review") continue;
    activeTotal++;

    const cat = entry.category || "events";
    const src = (() => { try { return JSON.parse(entry.metadata || "{}")?.source || "?"; } catch { return "?"; } })();
    byCategory[cat] ??= { total: 0, ghost: 0 };
    bySource[src] ??= { total: 0, ghost: 0 };
    byCategory[cat].total++;
    bySource[src].total++;

    // 冷启动天花板:完美匹配 1.0 → 生产评分链(recency/importance/confidence/
    // boundary/asset/length/timeDecay/evoBlend/access/hotness/frequency)
    const fake = [{ entry, score: 1.0 }];
    let scored;
    try {
      scored = r.applySharedScoring(fake, "");
    } catch (e) {
      continue; // 病行(malformed metadata 等)不崩整扫
    }
    const ceiling = scored[0]?.score ?? 0;
    const threshold = minScoreFor(cat);
    if (ceiling < threshold) {
      byCategory[cat].ghost++;
      bySource[src].ghost++;
      ghosts.push({
        id: entry.id.slice(0, 8),
        cat,
        src,
        ceiling: +ceiling.toFixed(4),
        threshold,
        scope: entry.scope,
        len: (entry.text || "").length,
        ts: new Date(Number(entry.timestamp)).toISOString().slice(0, 10),
        head: (entry.text || "").slice(0, 40).replace(/\n/g, " "),
      });
    }
  }
  if (offset % 20000 === 0) console.error(`.. scanned ${offset}`);
}

console.log(JSON.stringify({
  totalRows: total,
  activeRows: activeTotal,
  structuralGhosts: ghosts.length,
  ghostPct: +(ghosts.length / Math.max(1, activeTotal) * 100).toFixed(2),
  byCategory,
  bySource,
  thresholds: DEFAULT_CATEGORY_MIN_SCORES,
}, null, 1));

// 幽灵明细存文件
const fs = await import("node:fs");
fs.writeFileSync(
  process.env.GHOST_OUT || "/tmp/ghost-list.json",
  JSON.stringify(ghosts, null, 1),
);
console.error(`ghost detail -> scratchpad/ghost-list.json (${ghosts.length} rows)`);
