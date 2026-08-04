#!/usr/bin/env bun
/**
 * pivot-apply Stage 1 机械预筛（plan v2）：对 8,971 候选打标记，不删除。
 *
 * 规则（全部纯规则零 LLM）：
 *   R1  任务信封 anchor：结构化模式清单命中 → mark "R1-envelope"；anchor >200 字符 → mark "R1-long"
 *       模式清单必须先过 200 条 holdout 校准（--extract-holdout / --calibrate），误杀 >2% 收紧后重测
 *   R2  项目局部性：session.path/project 命中创作项目清单（确定性元数据优先）→ mark "project-scoped"
 *       文本特征仅兜底（字数/章节/题材类硬指标词）
 *   R3  canonicalKey 碰撞组：组内「规范化文本完全相同」→ 机械折叠（保留 1 条，其余 mark "fold-dropped"）；
 *       其余组整组 mark "collision-deferred"（本轮不写，二轮合并审——不选主版本）
 *   R4  弱候选：text <30，或 evidence 仅 1 条且 <15 字，或 evidence 为空 → mark "R4-weak"
 *   R5  现库撞 key：与全库 durable+active canonicalKey 全集（精确 + 规范化双通道）相撞 → mark "key-collision"
 *       （比对基线文件由全库扫描生成，写批前 Stage 3 窗口内还会再校验一次）
 *   AD  自动任务来源：session.path 含 session-digest 临时目录 → mark "auto-digest"（二手转述，
 *       src 指针断裂；处置呈 Alice，预筛只标不删）
 *
 * 用法：
 *   bun scripts/pivot-apply-prescreen.ts --extract-holdout <out.json>
 *   bun scripts/pivot-apply-prescreen.ts --calibrate <labeled.json>
 *   bun scripts/pivot-apply-prescreen.ts --run <out-dir> --live-keys <live-durable-keys.json>
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const RESULTS_DIR = resolve(
  process.env.HOME ?? "",
  "pivot-distill-runs/20260803/full/results",
);
const EXPECTED_REPORT_ID = "00b609834309b7b44d1e36fc7c93169e083abb66487073bfd64d8c5bafc337fa";
const EXPECTED_CANDIDATES = 8971;

// ---------------------------------------------------------------------------
// R1 任务信封模式清单 v1（结构化模式，不用散词——摸底时「交付」散词误伤过
// 写字楼租赁对话）。校准判据：holdout 误杀 >2% 收紧重测。
// ---------------------------------------------------------------------------
const R1_ENVELOPE_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "heading-or-goal", re: /^\s*(#{1,4}\s|Goal\s*[:：]|Scope\s*[:：]|Constraints\s*[:：]|Done\s+when\s*[:：])/im },
  { id: "task-label", re: /^#?\s*任务\s*[:：]/m },
  { id: "bracket-directive", re: /【要做的改动】|【任务】|【要求】|【交接】/ },
  { id: "contract-words", re: /Out of Scope|Current materials|验收标准|Done Criteria|Deliverables\s*[:：]/i },
  { id: "numbered-steps", re: /^\s*\d+[.、]\s.{6,}[\r\n]+\s*\d+[.、]\s/m },
  { id: "bullet-list", re: /^\s*[-*]\s.+[\r\n]+\s*[-*]\s/m },
  { id: "handoff-path", re: /\/(?:private\/tmp|tmp)\/[^\s'"]+|scratchpad\/[^\s'"]+/ },
  { id: "read-brief-directive", re: /^请?(?:完整|先)?读\s|^Review the material/im },
  // v2 校准补（FN 修复）：指令式派活开场 / 输出规格指令 / 系统标记 / 英文祈使文书开场
  { id: "output-spec", re: /^只?输出\s*[:：]|不要别的文本|直接传给|不要改写、|^给下面|^Then report|report findings with/im },
  { id: "system-marker", re: /^<turn_aborted>|^<system|^\[system/i },
  { id: "en-imperative-open", re: /^(Need|Answer|State|Verify|Summarize|Implement|Fix|Draft)\s+(a|an|the|two|three|\d|quick|all)\b/ },
  { id: "cn-answer-directive", re: /^回答下面|逐条回答[:：]?|要具体、可执行/m },
];
// v2 校准：口语开场豁免——numbered-steps/bullet-list 命中但 anchor 以第一人称
// 口语开场的，是 Alice 说话带编号的习惯（「我想问你两件事：1…2…」），不是任务文书。
const R1_COLLOQUIAL_EXEMPT = /^(好[，,、的]|嗯|哦|唉|我想|我们不|你先|你帮我|请你|帮我|告诉我|继续|其实|就是说)/;
const R1_EXEMPTABLE = new Set(["numbered-steps", "bullet-list"]);
// v2 校准：纯长度规则删除（holdout 实测 40 条长 anchor 里 13 条是 Alice 长口语，
// 误杀 33%；宁漏勿杀——漏放的还有抽验哨兵和三选一兜底，误杀无救济）。
const R1_LONG_THRESHOLD = Number.POSITIVE_INFINITY;

// R2 创作项目清单 v1（确定性 session 元数据；清单本身随首批抽验呈 Alice）
const R2_PROJECT_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "novel", re: /惊鸿照影|jhzy|贞观|墨香旧信|小说/i },
  { id: "gongwen", re: /工作专用中转站|公文/ },
  { id: "article-pipeline", re: /article-archive|content-alchemy|content-publisher|bot-articles/i },
];
// R2 文本特征兜底：项目局部硬指标（字数/章节/题材约束）
const R2_TEXT_FALLBACK: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "wordcount-constraint", re: /每[章回节][不少超]?于?\s*\d+\s*字|字数[不少超]?于?\s*\d{3,}|控制在\s*\d{3,}\s*字/ },
  { id: "chapter-structure", re: /第[一二三四五六七八九十百\d]+[章回]的?(结构|走向|大纲|情节)/ },
];

const AUTO_DIGEST_RE = /session-digest/;

interface RawCandidate {
  kind: string;
  text: string;
  anchor: string;
  canonicalKey: string;
  evidence: string[];
  proposedScope: string;
  proposedCategory: string;
  tags: string[];
}

interface LoadedCandidate extends RawCandidate {
  sessionFingerprint: string;
  sessionId: string;
  sessionPath: string;
  sessionProject: string;
  harness: string;
  candidateHash: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function candidateHashOf(sessionFingerprint: string, c: RawCandidate): string {
  const payload = canonicalJson({
    sessionFingerprint,
    kind: c.kind,
    text: c.text,
    anchor: c.anchor,
    canonicalKey: c.canonicalKey,
    evidence: c.evidence,
    proposedScope: c.proposedScope,
    proposedCategory: c.proposedCategory,
    tags: c.tags,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function normalizeText(t: string): string {
  return t.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeKeyLoose(k: string): string {
  return k.normalize("NFKC").replace(/[:：\s]+/g, "-").trim().toLowerCase();
}

function loadAllCandidates(): LoadedCandidate[] {
  const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json")).sort();
  const out: LoadedCandidate[] = [];
  for (const f of files) {
    const d = JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf8")) as Record<string, unknown>;
    if (d.status !== "ok" || !d.hasPivot) continue;
    const session = d.session as Record<string, unknown>;
    const fingerprint = f.replace(/\.json$/, "");
    for (const c of (d.candidates as RawCandidate[]) ?? []) {
      out.push({
        ...c,
        sessionFingerprint: fingerprint,
        sessionId: String(session.sessionId ?? ""),
        sessionPath: String(session.path ?? ""),
        sessionProject: String(session.project ?? ""),
        harness: String(session.harness ?? ""),
        candidateHash: candidateHashOf(fingerprint, c),
      });
    }
  }
  if (out.length !== EXPECTED_CANDIDATES) {
    throw new Error(`conservation check failed: loaded ${out.length} candidates, expected ${EXPECTED_CANDIDATES}`);
  }
  return out;
}

function r1EnvelopeHits(anchor: string): string[] {
  const hits = R1_ENVELOPE_PATTERNS.filter((p) => p.re.test(anchor)).map((p) => p.id);
  if (hits.length > 0 && hits.every((h) => R1_EXEMPTABLE.has(h)) && R1_COLLOQUIAL_EXEMPT.test(anchor.trim())) {
    return [];
  }
  return hits;
}

function marksFor(
  c: LoadedCandidate,
  liveKeys: { exact: Set<string>; loose: Set<string> } | null,
): { marks: string[]; detail: Record<string, unknown> } {
  const marks: string[] = [];
  const detail: Record<string, unknown> = {};

  const envelope = r1EnvelopeHits(c.anchor);
  if (envelope.length > 0) {
    marks.push("R1-envelope");
    detail.r1Patterns = envelope;
  }
  if (c.anchor.length > R1_LONG_THRESHOLD) marks.push("R1-long");

  const projHay = `${c.sessionPath} ${c.sessionProject}`;
  const projHit = R2_PROJECT_PATTERNS.find((p) => p.re.test(projHay));
  if (projHit) {
    marks.push("project-scoped");
    detail.r2Source = `metadata:${projHit.id}`;
  } else {
    const textHit = R2_TEXT_FALLBACK.find((p) => p.re.test(c.text));
    if (textHit) {
      marks.push("project-scoped");
      detail.r2Source = `text:${textHit.id}`;
    }
  }

  if (c.text.length < 30 || c.evidence.length === 0 || (c.evidence.length === 1 && c.evidence[0].length < 15)) {
    marks.push("R4-weak");
  }

  if (liveKeys) {
    if (liveKeys.exact.has(c.canonicalKey)) marks.push("key-collision");
    else if (liveKeys.loose.has(normalizeKeyLoose(c.canonicalKey))) marks.push("key-collision-loose");
  }

  if (AUTO_DIGEST_RE.test(c.sessionPath)) marks.push("auto-digest");

  return { marks, detail };
}

// ---------------------------------------------------------------------------
// modes
// ---------------------------------------------------------------------------

function extractHoldout(outPath: string): void {
  const all = loadAllCandidates();
  // 分层抽样：模式命中 80 / 长 anchor 40 / 无命中随机 80 —— 用固定步长伪随机（可复现，无 Math.random）
  const hit = all.filter((c) => r1EnvelopeHits(c.anchor).length > 0 && c.anchor.length <= R1_LONG_THRESHOLD);
  const long = all.filter((c) => c.anchor.length > R1_LONG_THRESHOLD);
  const rest = all.filter((c) => r1EnvelopeHits(c.anchor).length === 0 && c.anchor.length <= R1_LONG_THRESHOLD);
  const stride = <T>(arr: T[], n: number): T[] => {
    if (arr.length <= n) return [...arr];
    const step = arr.length / n;
    return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
  };
  const sample = [...stride(hit, 80), ...stride(long, 40), ...stride(rest, 80)];
  const rows = sample.map((c) => ({
    candidateHash: c.candidateHash,
    harness: c.harness,
    anchorLength: c.anchor.length,
    patternHits: r1EnvelopeHits(c.anchor),
    anchor: c.anchor,
    // 标注字段：执行者逐条填 true（是任务信封/派活文本）或 false（真人对话）
    isEnvelope: null as boolean | null,
  }));
  writeFileSync(outPath, JSON.stringify(rows, null, 1));
  console.log(`holdout written: ${outPath} (${rows.length} rows: ${stride(hit, 80).length} pattern-hit + ${stride(long, 40).length} long + ${stride(rest, 80).length} rest)`);
}

function calibrate(labeledPath: string): void {
  const rows = JSON.parse(readFileSync(labeledPath, "utf8")) as Array<{
    anchor: string;
    anchorLength: number;
    isEnvelope: boolean | null;
  }>;
  const unlabeled = rows.filter((r) => r.isEnvelope === null).length;
  if (unlabeled > 0) throw new Error(`${unlabeled} rows still unlabeled (isEnvelope: null)`);

  let tp = 0, fp = 0, fn = 0, tn = 0;
  const falsePositives: string[] = [];
  const falseNegatives: string[] = [];
  for (const r of rows) {
    const predicted = r1EnvelopeHits(r.anchor).length > 0 || r.anchorLength > R1_LONG_THRESHOLD;
    if (predicted && r.isEnvelope) tp++;
    else if (predicted && !r.isEnvelope) { fp++; falsePositives.push(r.anchor.slice(0, 100)); }
    else if (!predicted && r.isEnvelope) { fn++; falseNegatives.push(r.anchor.slice(0, 100)); }
    else tn++;
  }
  const negatives = fp + tn;
  const positives = tp + fn;
  const falseKillRate = negatives > 0 ? fp / negatives : 0;
  const recall = positives > 0 ? tp / positives : 1;
  console.log(`holdout: ${rows.length} rows | positives ${positives} negatives ${negatives}`);
  console.log(`recall: ${(recall * 100).toFixed(1)}% (${tp}/${positives})`);
  console.log(`false-kill (误杀率): ${(falseKillRate * 100).toFixed(2)}% (${fp}/${negatives}) — threshold 2%`);
  for (const s of falsePositives) console.log(`  FP: ${s.replace(/\n/g, "⏎")}`);
  for (const s of falseNegatives) console.log(`  FN: ${s.replace(/\n/g, "⏎")}`);
  console.log(falseKillRate <= 0.02 ? "CALIBRATION PASS" : "CALIBRATION FAIL — tighten the pattern list and retest");
  process.exit(falseKillRate <= 0.02 ? 0 : 1);
}

function runFull(outDir: string, liveKeysPath: string): void {
  const all = loadAllCandidates();
  const liveRaw = JSON.parse(readFileSync(liveKeysPath, "utf8")) as Record<string, unknown>;
  const liveKeys = {
    exact: new Set(Object.keys(liveRaw)),
    loose: new Set(Object.keys(liveRaw).map(normalizeKeyLoose)),
  };

  // R3：碰撞组
  const byKey = new Map<string, LoadedCandidate[]>();
  for (const c of all) {
    const list = byKey.get(c.canonicalKey) ?? [];
    list.push(c);
    byKey.set(c.canonicalKey, list);
  }
  const foldDropped = new Set<string>(); // candidateHash
  const collisionDeferred = new Set<string>();
  let foldGroups = 0, deferGroups = 0;
  for (const [, group] of byKey) {
    if (group.length <= 1) continue;
    const norms = new Set(group.map((c) => normalizeText(c.text)));
    if (norms.size === 1) {
      foldGroups++;
      // 折叠：保留 sessionFingerprint 最小的一条（稳定确定），其余打 fold-dropped
      const sorted = [...group].sort((a, b) => (a.sessionFingerprint < b.sessionFingerprint ? -1 : 1));
      for (const c of sorted.slice(1)) foldDropped.add(c.candidateHash);
    } else {
      deferGroups++;
      for (const c of group) collisionDeferred.add(c.candidateHash);
    }
  }

  mkdirSync(outDir, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    reportId: EXPECTED_REPORT_ID,
    total: all.length,
    ruleCounts: {} as Record<string, number>,
    r3: { foldGroups, foldDropped: foldDropped.size, deferGroups, collisionDeferred: collisionDeferred.size },
    cleanPool: 0,
    cleanByKind: {} as Record<string, number>,
  };

  const lines: string[] = [];
  for (const c of all) {
    const { marks, detail } = marksFor(c, liveKeys);
    if (foldDropped.has(c.candidateHash)) marks.push("fold-dropped");
    if (collisionDeferred.has(c.candidateHash)) marks.push("collision-deferred");
    for (const m of marks) summary.ruleCounts[m] = (summary.ruleCounts[m] ?? 0) + 1;
    const clean = marks.length === 0;
    if (clean) {
      summary.cleanPool++;
      summary.cleanByKind[c.kind] = (summary.cleanByKind[c.kind] ?? 0) + 1;
    }
    lines.push(JSON.stringify({
      candidateHash: c.candidateHash,
      sessionId: c.sessionId,
      sessionFingerprint: c.sessionFingerprint,
      reportId: EXPECTED_REPORT_ID,
      kind: c.kind,
      proposedCategory: c.proposedCategory,
      canonicalKey: c.canonicalKey,
      harness: c.harness,
      anchorLength: c.anchor.length,
      textLength: c.text.length,
      marks,
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    }));
  }
  writeFileSync(join(outDir, "allowlist-draft.jsonl"), lines.join("\n") + "\n");
  writeFileSync(join(outDir, "prescreen-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`written: ${join(outDir, "allowlist-draft.jsonl")} (${lines.length} rows)`);
}

const args = process.argv.slice(2);
if (args[0] === "--extract-holdout" && args[1]) extractHoldout(args[1]);
else if (args[0] === "--calibrate" && args[1]) calibrate(args[1]);
else if (args[0] === "--run" && args[1] && args[2] === "--live-keys" && args[3]) runFull(args[1], args[3]);
else {
  console.error("usage: --extract-holdout <out.json> | --calibrate <labeled.json> | --run <out-dir> --live-keys <keys.json>");
  process.exit(1);
}
