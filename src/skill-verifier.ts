/**
 * A2 · Skill promotion verifier — zero-LLM consistency gate.
 *
 * 借鉴 MemOS local-plugin `core/skill/verifier.ts`（repo-insight 借鉴审计 2026-06-13）。
 * 用在 `scan_skill_promotions` 的 pattern_to_skill 候选生成处：pattern 当 draft，
 * supporting cases 当 evidence。两个确定性检查，**无 LLM 调用**：
 *
 * 1. **tool coverage**：draft 声称的 tools 必须 ⊆ evidence 里真实出现过的 tools
 *    （覆盖率 ≥ COVERAGE_THRESHOLD）。专治 LLM 蒸馏 skill 时编造证据里没有的命令/工具名。
 * 2. **evidence resonance**：≥ minResonance 比例的 evidence 与 draft 的 summary/steps
 *    共享 ≥2 个 token。专治"叙述跟例子对不上"。
 *
 * `tokensOf` 对中文做 2-gram bigram（RecallNest case/skill 大量中文，不能只认 ASCII token）。
 * verdict 只描述、不决策——调用方（skill-promotion）据此附 `verification` 字段披露，
 * 失败候选保留排后、不静默丢弃（no-silent-caps）。
 */

export interface VerifyDraft {
  /** draft 声称用到的工具/命令名 */
  tools: string[];
  /** draft 摘要文本（如 pattern 的 title + trigger / 正文） */
  summary: string;
  /** draft 步骤文本 */
  steps: string[];
}

export interface VerifyEvidence {
  /** 证据条目正文（如 supporting case 的 text） */
  text: string;
  /** 证据条目里真实出现过的工具/命令名 */
  tools: string[];
}

export interface VerifyResult {
  ok: boolean;
  /** draft.tools ∩ evidenceTools / draft.tools（无声称工具时为 1） */
  coverage: number;
  /** 与 draft 共享 ≥2 token 的 evidence 比例 */
  resonance: number;
  /** draft 声称但任何 evidence 都没出现过的工具（疑似幻觉） */
  unmappedTools: string[];
  /** 失败原因；ok=true 时省略 */
  reason?: string;
}

export const DEFAULT_MIN_RESONANCE = 0.5;
export const COVERAGE_THRESHOLD = 0.5;

/**
 * 对一份 draft + 其证据做零 LLM 一致性校验。确定性、可单测、读写无副作用。
 */
export function verifyDraft(
  draft: VerifyDraft,
  evidence: VerifyEvidence[],
  options: { minResonance?: number } = {},
): VerifyResult {
  const minResonance = options.minResonance ?? DEFAULT_MIN_RESONANCE;

  if (evidence.length === 0) {
    return { ok: false, coverage: 0, resonance: 0, unmappedTools: [], reason: "no-evidence" };
  }

  // --- tool coverage（集合包含检查）---
  const evidenceTools = new Set<string>();
  for (const ev of evidence) {
    for (const t of ev.tools) {
      const norm = t.trim().toLowerCase();
      if (norm) evidenceTools.add(norm);
    }
  }
  const draftTools = draft.tools.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const matched: string[] = [];
  const unmapped: string[] = [];
  for (const tok of draftTools) {
    if (evidenceTools.has(tok)) matched.push(tok);
    else unmapped.push(tok);
  }
  // 无声称工具 → 无可证伪，coverage 视为满分（只看 resonance）。
  const coverage = draftTools.length === 0 ? 1 : matched.length / draftTools.length;

  // --- evidence resonance ---
  const resonance = computeResonance(draft, evidence);

  if (coverage < COVERAGE_THRESHOLD && draftTools.length > 0) {
    return {
      ok: false,
      coverage,
      resonance,
      unmappedTools: unmapped,
      reason: `coverage=${coverage.toFixed(2)}<${COVERAGE_THRESHOLD}`,
    };
  }
  if (resonance < minResonance) {
    return {
      ok: false,
      coverage,
      resonance,
      unmappedTools: unmapped,
      reason: `resonance=${resonance.toFixed(2)}<${minResonance}`,
    };
  }
  return { ok: true, coverage, resonance, unmappedTools: unmapped };
}

function computeResonance(draft: VerifyDraft, evidence: VerifyEvidence[]): number {
  const needle = [draft.summary, ...draft.steps].join(" ").toLowerCase();
  const draftTokens = tokensOf(needle);
  if (draftTokens.size === 0) return 0;
  let hit = 0;
  for (const ev of evidence) {
    const toks = tokensOf(ev.text.toLowerCase());
    let overlap = 0;
    for (const tok of draftTokens) {
      if (toks.has(tok)) {
        overlap += 1;
        if (overlap >= 2) break; // 只需判定 ≥2，命中即可停
      }
    }
    if (overlap >= 2) hit += 1;
  }
  return hit / evidence.length;
}

/**
 * 分词：ASCII 标识符（≥4 字符、去停用词）+ CJK 2-gram bigram。
 * CJK 部分不走停用词（2-gram 本身已足够稀疏）。
 */
export function tokensOf(s: string): Set<string> {
  const out = new Set<string>();
  const asciiMatches = s.match(/[a-z0-9_][a-z0-9_./-]{3,}/g) ?? [];
  for (const m of asciiMatches) {
    const tok = m.toLowerCase();
    if (RESONANCE_STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  const cjkRuns = s.match(/[一-鿿぀-ヿ㐀-䶿]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i++) {
      out.add(run.slice(i, i + 2));
    }
  }
  return out;
}

const RESONANCE_STOPWORDS = new Set<string>([
  "the", "and", "for", "with", "that", "this", "from", "will", "then",
  "into", "when", "what", "where", "your", "user", "agent", "null", "true",
  "false", "none", "let", "new", "old", "use", "used", "have", "has", "its",
  "not", "any", "can", "does", "only", "just", "like", "please", "step",
  "steps", "body", "title", "summary", "task", "tasks", "run", "see", "end",
  "our", "their", "them", "being", "make", "made", "thing", "things",
]);
