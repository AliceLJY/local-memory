// term-registry-shadow.ts —— 检索术语簇（端清单）改动的影子采集
//
// 【它回答什么】term-registry.ts 里两张 specificity 表被改后：
//   ① 哪些记忆的「被滤掉 / 被保留」判定翻转了（穷尽、可逐条归因）
//   ② 生产形状（limitPerSection=3）的 resume_context 输出，前后各出现/掉出哪几行
// 「零掉出」不是通过标准 —— top-k 容量固定，added > 0 必然 removed > 0；
// 标准是**每条掉出都能逐条说明性质**（open-loops 第 9 条的 shadow 判据）。
//
// 【被改的两张表是负向过滤器，不是加权】判据在
//   context-composer-stable-selection.ts:154-157 与 context-composer-task-selection.ts:96-99：
//     group.resultTerms.some(命中记忆正文) && !group.taskTerms.some(命中任务)  →  丢弃这条记忆
//   所以两个字段方向相反：taskTerms 加词 = 放宽（召回变多），resultTerms 加词 = 收紧（召回变少）。
//   看报告时别把两者当同一个方向。
//
// 【为什么 Pass A 不重实现判据】selectStableResults / selectTaskResults 都是 export 的，
//   直接喂单条候选进去，看它出不出来 —— 判定由生产代码自己给，零重实现风险。
//   单元素数组还顺带隔掉了排序、dedup、limit 抢位这三个混淆项，翻转可精确归因到过滤器本身。
//   （groupHit 那一列是**解释用**的二次计算，不承载判定；判定只认 verdict。）
//
// 【Pass A 的预筛是可证明的，不是抽样】过滤器的必要条件是 resultTerms 命中记忆正文。
//   两臂的 resultTerms 并集都不命中的记忆，两臂判据都短路成 false，判定必然相同。
//   所以只扫「命中并集」的那部分即穷尽，不是抽样。并集写死在 RESULT_TERMS_UNION，
//   改表时要同步扩它，否则预筛会漏掉新增词覆盖的记忆。
//
// 【Pass B 不写脏库】沿用 composeResumeContext 的 source:"auto-recall"（context-composer.ts:68/78/84），
//   而三条强化写入（frequencyTracker.recordHits / recordEvolutionAccess / accessTracker.recordAccess，
//   retriever.ts:848-874）全部门控在 source !== "auto-recall" —— 两臂之间不会互相污染。
//   不带 scope、不取 checkpoint、不取 pin：这三样每天在变，是跨臂噪声源，钉死它们把差异收敛到本次改动。
//
// 【Pass B 为什么不直接调 composeResumeContext】它最后一步 ResumeContextResponseSchema.parse
//   （context-composer.ts:541）在真实库上会抛 ZodError："stableContext must be at most 220 characters"。
//   根因与本次改动无关，是既有的长度口径不一致：formatStableResult 截到 **230**
//   （context-composer-stable-selection.ts:165），而 session-schema.ts:61 的 stableContext 上限是 **220**，
//   仓库其他 5 处 cleanText 全是 220；interleaveUnique（context-composer-stable.ts:199-206）不再截一次，
//   所以 221–230 字符的行会直接把响应校验打挂。**这是本次范围外的生产 bug，本脚本不修、只绕开。**
//   绕法：照抄 composeResumeContext 自己的检索参数取候选，再调同一批 export 的选择器，
//   只跳过最后那步坏掉的装配+校验。被改动的代码路径（两张 specificity 表所在的过滤器）全程真实执行。
//
// 【怎么复现】两臂各跑一次，中间换 src/term-registry.ts 的版本。<C> = 引入本脚本的那个 commit：
//   cd ~/recallnest && set -a && source ~/.config/recallnest/mcp.env && set +a
//   git stash push -- src/term-registry.ts            # 先存好当前版本（若有未提交改动）
//   git checkout <C>^ -- src/term-registry.ts         # 退到改词表之前
//   ARM=baseline  ~/.bun/bin/bun run eval/term-registry-shadow.ts
//   git checkout <C> -- src/term-registry.ts          # 回到改后
//   ARM=treatment ~/.bun/bin/bun run eval/term-registry-shadow.ts
//   ~/.bun/bin/bun run eval/term-registry-shadow.ts --diff             # 出对照
// 只跑离线那一半（不发请求、不要 JINA_API_KEY）：加 PASS=A
// ⚠️ PASS=A 与 PASS=B 单跑会各自覆盖整个 arm 文件（只写自己那半），要完整对照就别加 PASS。
// 报告落 eval/reports/（该目录已 gitignore，数据不入库、靠本脚本重跑复现）。
//
// 【噪声底已实测】2026-08-08：同一份代码连跑两臂，Pass A 29204 组判定零翻转、
//   Pass B 逐行零差异。所以打补丁后看到的差异可直接归因到改动，不必再扣本底。
//
// 【快照有效性】Pass A 扫的是实时库，并发写入会让行在页间移动（ghost-scan.ts 同款已知噪声）。
//   两臂要连着跑，中间只改代码不 ingest；报告附条目数，数不对就重跑。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 仓库根：优先 RECALLNEST_ROOT，否则 ~/recallnest（与此前写死的绝对路径解析结果一致）
const REPO = process.env.RECALLNEST_ROOT || join(homedir(), "recallnest");
const repoSrc = (file: string) => join(REPO, "src", file);
const { loadConfig, createComponents } = await import(repoSrc("runtime-config.ts"));
const { selectStableResults } = await import(repoSrc("context-composer-stable-selection.ts"));
const { selectTaskResults } = await import(repoSrc("context-composer-task-selection.ts"));
const {
  buildStableQuery,
  buildStylePreferenceFallbackQuery,
  buildTaskQuery,
} = await import(repoSrc("context-composer-queries.ts"));
const { dedupeText, stripConversationMarkers } = await import(repoSrc("context-composer-text.ts"));
const {
  PREFERENCE_SPECIFICITY_GROUPS,
  TASK_RESULT_SPECIFICITY_GROUPS,
  buildTaskHintTerms,
  looksLikeStyleTask,
  normalizeText,
} = await import(repoSrc("term-registry.ts"));
const OUT_DIR = join(REPO, "eval", "reports");
const ARM = process.env.ARM || "baseline";
const PASS = process.env.PASS || "AB";
const DIFF_MODE = process.argv.includes("--diff");

// 生产默认值：mcp-tools-core.ts:242 limitPerSection 默认 3 → stableLimit = taskLimit = 3
const LIMIT_PER_SECTION = 3;

// 两臂 resultTerms 的并集（见抬头「预筛是可证明的」）。改表时同步扩这里。
const RESULT_TERMS_UNION = [
  // TASK_RESULT_SPECIFICITY_GROUPS 里那个三端历史事件组
  "three-terminal continuity trigger validation",
  "continue-style prompts triggered recall reliably",
  "managed continuity rules",
  "global instruction file",
  // PREFERENCE_SPECIFICITY_GROUPS
  "claude code", "codex", "gemini cli", "smoke", "integration",
  "验收", "验证视角", "独立验证", "sidecar", "cc 介入",
  // 本轮评估过但最终没加进 resultTerms 的端名 —— 仍纳入预筛，
  // 这样报告能回答「如果当时加了会怎样」，而不是只报告已选方案。
  "kimi", "antigravity", "agy",
];

/** Alice 实际会怎么问。分四桶，每桶的验收含义不同。 */
const SEEDS: Array<{ id: string; bucket: string; task: string; note: string }> = [
  // G1 新端 —— 本次要修的目标：问 kimi / agy 时不该再被误滤
  { id: "g1-kimi-verify", bucket: "G1-新端", task: "kimi 那边的独立验证是怎么做的", note: "目标 fixture：应召回 CC/Codex 的验收偏好作参照" },
  { id: "g1-agy-view", bucket: "G1-新端", task: "agy 的验收视角和 cc 有什么不一样", note: "目标 fixture" },
  { id: "g1-anti-ingest", bucket: "G1-新端", task: "antigravity 的会话是怎么接进来的", note: "目标 fixture" },
  { id: "g1-kimi-review", bucket: "G1-新端", task: "kimi 互审的时候要注意什么", note: "目标 fixture：不含验收/验证字样" },

  // G2 老端 —— 不许退化
  { id: "g2-codex-verify", bucket: "G2-老端", task: "codex 的独立验证视角是什么", note: "对照：改前能召回的，改后不许掉" },
  { id: "g2-cc-smoke", bucket: "G2-老端", task: "claude code 的 smoke 怎么跑", note: "对照" },
  { id: "g2-gemini-setup", bucket: "G2-老端", task: "gemini cli 接入验收怎么做", note: "对照" },

  // G3 端拓扑 —— 三端历史事件组的目标问法
  { id: "g3-three", bucket: "G3-端拓扑", task: "三端的连续性触发验证结论还成立吗", note: "「三端」今天匹配不上（表里只有「三终端」）" },
  { id: "g3-four", bucket: "G3-端拓扑", task: "四端的触发规则都装好了吗", note: "「四端」同上" },

  // G4 对照 —— 与端清单无关，两臂必须完全一致
  { id: "g4-kimi-down", bucket: "G4-对照", task: "kimi 挂了", note: "反例对照：只提端名、不问验收/触发，三端历史不该被放进来" },
  { id: "g4-article", bucket: "G4-对照", task: "帮我写一篇公众号文章", note: "无关对照" },
  { id: "g4-bot", bucket: "G4-对照", task: "hermes bot 挂了怎么修", note: "无关对照" },
  { id: "g4-recallnest", bucket: "G4-对照", task: "继续 RecallNest 那个记忆层", note: "无关对照（连续性任务）" },
  { id: "g4-netdisk", bucket: "G4-对照", task: "百度网盘上传断链怎么排查", note: "无关对照" },
];

interface VerdictRow {
  seedId: string;
  entryId: string;
  category: string;
  scope: string;
  /** 生产代码给的判定：true = 这条被留下了 */
  kept: boolean;
  /** 解释用：哪个组、因为哪个 resultTerm 命中而触发（不承载判定） */
  groupHit: string | null;
  textHead: string;
}

/** 解释用的二次计算，逐字照抄生产判据的形状，只用于给翻转配一句「为什么」。 */
function explainGroupHit(
  groups: ReadonlyArray<{ resultTerms: string[]; taskTerms: string[] }>,
  label: string,
  entryText: string,
  taskSeed: string,
): string | null {
  const taskHaystack = normalizeText(`${taskSeed} ${buildTaskHintTerms(taskSeed).join(" ")}`);
  const resultHaystack = normalizeText(stripConversationMarkers(entryText));
  for (const [index, group] of groups.entries()) {
    const hitTerm = group.resultTerms.find((term) => resultHaystack.includes(term));
    if (!hitTerm) continue;
    const taskTerm = group.taskTerms.find((term) => taskHaystack.includes(term));
    if (!taskTerm) return `${label}[${index}] 命中 resultTerm="${hitTerm}"，任务无豁免词 → 滤掉`;
    return `${label}[${index}] 命中 resultTerm="${hitTerm}"，任务含 taskTerm="${taskTerm}" → 放行`;
  }
  return null;
}

async function runPassA(): Promise<{ rows: VerdictRow[]; scanned: number; candidates: number }> {
  const config = loadConfig();
  const { store } = createComponents(config);

  const BATCH = 2000;
  let offset = 0;
  let scanned = 0;
  const candidates: Array<{ id: string; text: string; category: string; scope: string; entry: unknown }> = [];

  for (;;) {
    const batch = await store.list(undefined, undefined, BATCH, offset);
    if (batch.length === 0) break;
    offset += batch.length;
    scanned += batch.length;

    for (const entry of batch) {
      // 只统计 active（archived/superseded 本来就不该被搜到）—— 与 ghost-scan.ts 同款口径
      let evoStatus = "active";
      try {
        const evo = JSON.parse(entry.metadata || "{}")?.evolution;
        if (evo?.status) evoStatus = evo.status;
      } catch { /* metadata 不是 JSON 就按 active 处理 */ }
      if (evoStatus !== "active" && evoStatus !== "pending_review") continue;

      const haystack = normalizeText(stripConversationMarkers(entry.text || ""));
      if (!RESULT_TERMS_UNION.some((term) => haystack.includes(term))) continue;
      candidates.push({
        id: entry.id,
        text: entry.text,
        category: entry.category,
        scope: entry.scope,
        entry,
      });
    }
  }

  const rows: VerdictRow[] = [];
  for (const seed of SEEDS) {
    for (const cand of candidates) {
      // 单元素数组：隔掉排序 / dedup / limit 抢位，判定只反映过滤器本身
      const one = [{ entry: cand.entry, score: 1, sources: {} }] as never[];

      let kept = false;
      let groupHit: string | null = null;
      if (cand.category === "preferences") {
        kept = selectStableResults("preferences", one, 1, { taskSeed: seed.task }).length > 0;
        groupHit = explainGroupHit(PREFERENCE_SPECIFICITY_GROUPS, "PREF", cand.text, seed.task);
      } else if (cand.category === "cases" || cand.category === "patterns") {
        kept = selectTaskResults(cand.category, one, 1, { taskSeed: seed.task }).length > 0;
        groupHit = explainGroupHit(TASK_RESULT_SPECIFICITY_GROUPS, "TASK", cand.text, seed.task);
      } else {
        continue;
      }

      rows.push({
        seedId: seed.id,
        entryId: cand.id,
        category: cand.category,
        scope: cand.scope,
        kept,
        groupHit,
        textHead: (cand.text || "").replace(/\s+/g, " ").slice(0, 160),
      });
    }
  }

  return { rows, scanned, candidates: candidates.length };
}

/** 逐字照抄 context-composer.ts:99-111（未导出）。只按 entry.id 去重，无评分，保真风险低。 */
function mergeRetrievalResults<T extends { entry: { id: string } }>(sets: T[][], limit: number): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const set of sets) {
    for (const result of set) {
      if (seen.has(result.entry.id)) continue;
      seen.add(result.entry.id);
      merged.push(result);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}

async function runPassB(): Promise<Record<string, string[]>> {
  const config = loadConfig();
  const { retriever } = createComponents(config);
  const out: Record<string, string[]> = {};

  // 与生产同参：stableLimit = taskLimit = limitPerSection（context-composer.ts:313-314）
  const stableLimit = LIMIT_PER_SECTION;
  const taskLimit = LIMIT_PER_SECTION;
  // 不带 scope → retrieveCandidates 走单查询分支（context-composer.ts:63-70）
  const recall = (category: string, query: string, limit: number) =>
    retriever.retrieve({ query, limit, category, source: "auto-recall" } as never);

  for (const seed of SEEDS) {
    const styleFocused = looksLikeStyleTask(seed.task);
    const lines: string[] = [];

    // preferences —— 本次改动直接影响的一路（context-composer.ts:318-321, 335-342, 364）
    const preferenceQueries = dedupeText([
      buildStableQuery("preferences", seed.task),
      ...(styleFocused ? [buildStylePreferenceFallbackQuery(seed.task)] : []),
    ], 2);
    const preferenceSets = await Promise.all(
      preferenceQueries.map((query) => recall("preferences", query, Math.max(2, stableLimit))),
    );
    const preferenceResults = mergeRetrievalResults(preferenceSets, Math.max(4, stableLimit * 3));

    // 候选层诊断：top-k 之前，检索真正送进选择器的这几条各自怎么了。
    // 没有这一层，"Pass B 零变化"就只能报成"没变化"，说不出是"改动无效"还是
    // "改动有效但检索压根没把被滤的条目送上来"—— 这两者的处置完全不同。
    // ⚠️ survived 是**全部**过滤器的合成结果（还含 isStableCandidateUseful 的
    // 低信号/超长/指令样三条），不等于 specificity 组的判定；所以另出 spec 一列单独归因，
    // 两列不要混着读 —— 第一版就是把两者混成一个「被过滤」计数，差点把
    // isStableCandidateUseful 拦下的条目算到本次改动头上。
    for (const cand of preferenceResults) {
      const survived = selectStableResults("preferences", [cand] as never[], 1, {
        taskSeed: seed.task,
        styleFocused,
      }).length > 0;
      const hit = explainGroupHit(PREFERENCE_SPECIFICITY_GROUPS, "PREF", cand.entry.text, seed.task);
      const spec = hit === null ? "none" : (hit.endsWith("滤掉") ? "DROP" : "pass");
      lines.push(
        `__diag__ :: ${cand.entry.id.slice(0, 8)} survived=${survived} spec=${spec} | ` +
        `${(cand.entry.text || "").replace(/\s+/g, " ").slice(0, 70)}`,
      );
    }

    for (const line of selectStableResults("preferences", preferenceResults, Math.max(2, stableLimit), {
      taskSeed: seed.task,
      styleFocused,
    })) {
      lines.push(`preferences :: ${line}`);
    }

    // patterns / cases —— 另一张表影响的一路（context-composer.ts:351-362）
    for (const category of ["patterns", "cases"] as const) {
      const results = await recall(category, buildTaskQuery(category, seed.task), taskLimit);
      for (const line of selectTaskResults(category, results, taskLimit, { taskSeed: seed.task })) {
        lines.push(`${category} :: ${line}`);
      }
    }

    out[seed.id] = lines;
  }

  return out;
}

function armPath(arm: string): string {
  return join(OUT_DIR, `term-registry-shadow-${arm}.json`);
}

function printDiff(): void {
  const base = JSON.parse(readFileSync(armPath("baseline"), "utf-8"));
  const treat = JSON.parse(readFileSync(armPath("treatment"), "utf-8"));

  console.log("=".repeat(78));
  console.log("Pass A —— 过滤器判定翻转（穷尽，逐条归因）");
  console.log("=".repeat(78));
  console.log(`候选条目：baseline ${base.passA?.candidates ?? "n/a"} / treatment ${treat.passA?.candidates ?? "n/a"}`);
  console.log(`全库扫描：baseline ${base.passA?.scanned ?? "n/a"} / treatment ${treat.passA?.scanned ?? "n/a"}`);

  const keyOf = (r: VerdictRow) => `${r.seedId} ${r.entryId}`;
  const baseMap = new Map<string, VerdictRow>((base.passA?.rows || []).map((r: VerdictRow) => [keyOf(r), r]));
  const treatMap = new Map<string, VerdictRow>((treat.passA?.rows || []).map((r: VerdictRow) => [keyOf(r), r]));

  const flips: Array<{ dir: string; row: VerdictRow; was: VerdictRow }> = [];
  for (const [key, tRow] of treatMap) {
    const bRow = baseMap.get(key);
    if (!bRow) continue;
    if (bRow.kept !== tRow.kept) {
      flips.push({ dir: tRow.kept ? "ADDED (改后被保留)" : "REMOVED (改后被滤掉)", row: tRow, was: bRow });
    }
  }

  if (flips.length === 0) {
    console.log("\n判定翻转：0 条");
  } else {
    const bySeed = new Map<string, typeof flips>();
    for (const f of flips) {
      const list = bySeed.get(f.row.seedId) || [];
      list.push(f);
      bySeed.set(f.row.seedId, list);
    }
    for (const [seedId, list] of bySeed) {
      const seed = SEEDS.find((s) => s.id === seedId);
      console.log(`\n--- ${seedId} [${seed?.bucket}] "${seed?.task}"`);
      for (const f of list) {
        console.log(`  ${f.dir}  <${f.row.category}> ${f.row.entryId}`);
        console.log(`    改前: ${f.was.groupHit || "(无组命中)"}`);
        console.log(`    改后: ${f.row.groupHit || "(无组命中)"}`);
        console.log(`    正文: ${f.row.textHead}`);
      }
    }
  }

  console.log("\n" + "=".repeat(78));
  console.log(`Pass B —— resume_context 生产形状输出（limitPerSection=${LIMIT_PER_SECTION}）`);
  console.log("=".repeat(78));

  if (!base.passB || !treat.passB) {
    console.log("(某一臂没有 Pass B 数据，跳过)");
    return;
  }

  let totalAdded = 0;
  let totalRemoved = 0;
  for (const seed of SEEDS) {
    const b: string[] = base.passB[seed.id] || [];
    const t: string[] = treat.passB[seed.id] || [];
    const bSet = new Set(b);
    const tSet = new Set(t);
    const added = t.filter((x) => !bSet.has(x));
    const removed = b.filter((x) => !tSet.has(x));
    totalAdded += added.length;
    totalRemoved += removed.length;
    if (added.length === 0 && removed.length === 0) {
      console.log(`\n--- ${seed.id} [${seed.bucket}] 无变化（${b.length} 行）`);
      continue;
    }
    console.log(`\n--- ${seed.id} [${seed.bucket}] "${seed.task}"  (${b.length} → ${t.length} 行)`);
    for (const line of added) console.log(`  + ${line.slice(0, 200)}`);
    for (const line of removed) console.log(`  - ${line.slice(0, 200)}`);
  }
  console.log(`\n合计：新增 ${totalAdded} 行 / 掉出 ${totalRemoved} 行`);
  console.log("（掉出不为零是预期的：top-k 容量固定。判据是每条掉出都能说明性质。）");
}

if (DIFF_MODE) {
  printDiff();
} else {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const payload: Record<string, unknown> = { arm: ARM, limitPerSection: LIMIT_PER_SECTION, seeds: SEEDS };

  if (PASS.includes("A")) {
    console.log(`[${ARM}] Pass A 扫库中…`);
    const passA = await runPassA();
    payload.passA = passA;
    console.log(`[${ARM}] Pass A: 扫 ${passA.scanned} 条，命中预筛 ${passA.candidates} 条，判定 ${passA.rows.length} 组`);
  }
  if (PASS.includes("B")) {
    console.log(`[${ARM}] Pass B 跑 resume_context（${SEEDS.length} 条 query，会发嵌入请求）…`);
    payload.passB = await runPassB();
    console.log(`[${ARM}] Pass B 完成`);
  }

  writeFileSync(armPath(ARM), JSON.stringify(payload, null, 2));
  console.log(`[${ARM}] 写入 ${armPath(ARM)}`);
}
