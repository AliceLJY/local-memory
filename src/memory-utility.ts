/**
 * Memory Utility — 价值回溯（MemOS Reflect2Evolve 的零 LLM 变体）。
 *
 * 借鉴来源：MemOS 自进化记忆系统借鉴评估（2026-06-13 审计，C1「价值回溯算术内核」）。
 * MemOS 原式两处烧 LLM（任务级 R_human 三轴 rubric + 步级反思权重 α_t），
 * 这里两处都换成库里现成的确定性信号：
 *   R_human → workflow observation 的四档 outcome 查表（OUTCOME_REWARD）
 *   α_t     → join 强度（任务级精确命中 vs 会话级弱关联），见 JOIN_WEIGHT
 * 回溯本体在 MemOS 里就是纯算术，这里同样零 LLM、零网络。
 *
 * ⚠️ **这一列不写进 `importance`**，理由是硬的：
 *   1. importance 是**阈值语义**——`resolveTier` 拿 ≥0.95 判 core、`isDecayExempt`
 *      拿 core+≥0.95 判**永不衰减**（decay-engine.ts:180-186）。一条效用高的记忆
 *      被顶过 0.95 就顺手拿到永久免衰减，这是串扰不是特性。
 *   2. 那一列已经有写手：STC 的 retroactive-boost 在改它，传播的是**语义相关性**；
 *      价值回溯传播的是**因果贡献**。两件事不该共用一列，否则互相盖。
 *   3. importance 不能为负，而负值那半最值钱——「上次这么干失败了」在 importance 里没有容器装。
 * utility 落在 metadata（与 tier/accessCount/readerIds 同族），只喂检索排序：
 * `resolveTier` 与 `isDecayExempt` 都不读这个字段，tier 与豁免行为天然零变化。
 */

import type { MemoryEntry } from "./store.js";
import type {
  WorkflowObservationOutcome,
  WorkflowObservationRecord,
} from "./workflow-observation-schema.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * outcome → 回报值。取代 MemOS 的 LLM 三轴打分（目标 0.45／过程 0.30／满意 0.25）。
 * 数值可调，关键是它**确定性、零成本**——LLM 打的分没法在 7 万条库上重放。
 */
export const OUTCOME_REWARD: Record<WorkflowObservationOutcome, number> = {
  success: 0.8,
  corrected: 0.2,
  missed: -0.3,
  failure: -0.8,
};

/**
 * join 强度权重，充当 MemOS α_t（反思权重）的位置。
 * exact = observation 自己列出了这条 memory；
 * session = 只知道「同一个会话读过这条、且那个会话报了这个结果」，弱得多——
 * 一个会话会跑很多任务，readerIds 又是累积的，不加权就会把无关任务的成败摊到这条头上。
 */
export const JOIN_WEIGHT = { exact: 1.0, session: 0.25 } as const;

/** 半衰期（天）。旧结果该让位给新结果，与 MemOS priority 式的 0.5^(Δdays/30) 同形。 */
export const UTILITY_HALF_LIFE_DAYS = 30;

/** 低于这个有效样本量时不下结论（utility=null）。 */
export const MIN_EFFECTIVE_SAMPLES = 0.5;

export type JoinKind = keyof typeof JOIN_WEIGHT;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface MemoryOutcomeLink {
  observationId: string;
  workflowId: string;
  outcome: WorkflowObservationOutcome;
  recordedAt: string;
  join: JoinKind;
  summary: string;
}

export interface MemoryOutcomeSummary {
  memoryId: string;
  /** 参与过的任务总数（exact + session）。 */
  total: number;
  exactCount: number;
  sessionCount: number;
  counts: Record<WorkflowObservationOutcome, number>;
  /** success / total。没有样本时为 null——0% 和「没数据」不是一回事。 */
  successRate: number | null;
  /** 只看精确 join 的成功率，null 表示没有精确样本。 */
  exactSuccessRate: number | null;
  /**
   * 效用值 ∈ [-0.8, 0.8]，可为负。样本不足时为 null。
   * null 与 0 语义不同：null = 没数据，0 = 有数据但正负相抵。
   */
  utility: number | null;
  /** 时间折扣后的有效样本量，用于判断这个 utility 有多可信。 */
  effectiveSamples: number;
  /**
   * utility 是拿哪部分样本算的。
   * `exact` = 有精确 join 样本，会话级样本被排除在计算之外（默认策略，见 summarizeMemoryOutcomes）；
   * `session` = 只有会话级样本，聊胜于无；`none` = 没样本。
   */
  utilityBasis: "exact" | "session" | "none";
  links: MemoryOutcomeLink[];
}

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

/** 从 memory metadata 里取 readerIds（会话级 join 的另一半 key）。 */
export function readReaderIds(metadata?: string): string[] {
  try {
    const meta = JSON.parse(metadata || "{}") as Record<string, unknown>;
    return Array.isArray(meta.readerIds)
      ? meta.readerIds.filter((r): r is string => typeof r === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * 把一条 memory 和 workflow observations 配对起来——本方案要补的那个 join key。
 *
 * 两条路，精确的优先：
 *   exact   —— observation.recalledIds 直接点名了这条 memory
 *   session —— observation.readerId 在这条 memory 的 readerIds 里（同一会话读过它）
 * 同一条 observation 只算一次，exact 覆盖 session。
 */
export function linkMemoryToObservations(
  memoryId: string,
  memoryMetadata: string | undefined,
  observations: readonly WorkflowObservationRecord[],
): MemoryOutcomeLink[] {
  const readerIds = new Set(readReaderIds(memoryMetadata));
  const links: MemoryOutcomeLink[] = [];

  for (const obs of observations) {
    const exact = Array.isArray(obs.recalledIds) && obs.recalledIds.includes(memoryId);
    const session = !exact && !!obs.readerId && readerIds.has(obs.readerId);
    if (!exact && !session) continue;
    links.push({
      observationId: obs.observationId,
      workflowId: obs.workflowId,
      outcome: obs.outcome,
      recordedAt: obs.recordedAt,
      join: exact ? "exact" : "session",
      summary: obs.summary,
    });
  }

  return links.sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
}

// ---------------------------------------------------------------------------
// 汇总 + 效用
// ---------------------------------------------------------------------------

function emptyCounts(): Record<WorkflowObservationOutcome, number> {
  return { success: 0, failure: 0, corrected: 0, missed: 0 };
}

/**
 * 汇总一条 memory 的参与记录，算出成功率与 utility。
 *
 * utility = Σ(w_join · decay · R) / Σ(w_join · decay)
 * 加权平均而不是求和：一条被读一百次的记忆不该仅凭次数就压过一条被读三次但每次都救场的。
 */
export function summarizeMemoryOutcomes(
  memoryId: string,
  links: readonly MemoryOutcomeLink[],
  now = Date.now(),
  options: { preferExact?: boolean } = {},
): MemoryOutcomeSummary {
  const preferExact = options.preferExact ?? true;
  const counts = emptyCounts();
  let exactCount = 0;
  let sessionCount = 0;
  let exactSuccess = 0;
  const acc = {
    exact: { reward: 0, weight: 0 },
    session: { reward: 0, weight: 0 },
  };

  for (const link of links) {
    counts[link.outcome]++;
    if (link.join === "exact") {
      exactCount++;
      if (link.outcome === "success") exactSuccess++;
    } else {
      sessionCount++;
    }

    const ageDays = Math.max(0, (now - Date.parse(link.recordedAt)) / 86_400_000);
    const decay = Math.pow(0.5, ageDays / UTILITY_HALF_LIFE_DAYS);
    const weight = JOIN_WEIGHT[link.join] * decay;
    acc[link.join].reward += weight * OUTCOME_REWARD[link.outcome];
    acc[link.join].weight += weight;
  }

  // 有精确样本时不掺会话级样本 —— 这不是洁癖，是 2026-08-23 落地当天的实测结论：
  // 同一个会话跑多个任务时，readerId join 会把无关任务的成败摊到每条被读过的记忆头上。
  // 实测那次 5 条记忆的会话级成功率全是 44%（同一批 observation），
  // 而精确成功率是 100% / 33% / 0% —— 后者才带信息，前者是会话噪声的常数。
  // 一条从没被精确点名过的记忆（历史 observation / CLI 上报）仍退回会话级，聊胜于无。
  const useExact = preferExact && acc.exact.weight >= MIN_EFFECTIVE_SAMPLES;
  const basisAcc = useExact
    ? acc.exact
    : { reward: acc.exact.reward + acc.session.reward, weight: acc.exact.weight + acc.session.weight };

  const total = links.length;
  const hasUtility = basisAcc.weight >= MIN_EFFECTIVE_SAMPLES;
  return {
    memoryId,
    total,
    exactCount,
    sessionCount,
    counts,
    successRate: total > 0 ? counts.success / total : null,
    exactSuccessRate: exactCount > 0 ? exactSuccess / exactCount : null,
    utility: hasUtility ? basisAcc.reward / basisAcc.weight : null,
    effectiveSamples: basisAcc.weight,
    utilityBasis: !hasUtility ? "none" : useExact ? "exact" : "session",
    links: [...links],
  };
}

/** 一步到位：memory + observations → 汇总。 */
export function computeMemoryUtility(
  entry: Pick<MemoryEntry, "id" | "metadata">,
  observations: readonly WorkflowObservationRecord[],
  now = Date.now(),
  options: { preferExact?: boolean } = {},
): MemoryOutcomeSummary {
  return summarizeMemoryOutcomes(
    entry.id,
    linkMemoryToObservations(entry.id, entry.metadata, observations),
    now,
    options,
  );
}

// ---------------------------------------------------------------------------
// 写回 metadata
// ---------------------------------------------------------------------------

/** metadata 里 utility 三件套的字段名。改名要同步 retriever 的 applyUtilityWeight。 */
export const UTILITY_FIELD = "utility";
export const UTILITY_SAMPLES_FIELD = "utilitySamples";
export const UTILITY_UPDATED_FIELD = "utilityUpdatedAt";
export const UTILITY_BASIS_FIELD = "utilityBasis";

/** 从 metadata 读 utility；没有/坏了都返回 null（不是 0——见上文语义说明）。 */
export function readUtility(metadata?: string): number | null {
  try {
    const meta = JSON.parse(metadata || "{}") as Record<string, unknown>;
    const value = meta[UTILITY_FIELD];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 把 utility 写进 metadata 对象（纯函数，调用方负责落库）。
 * utility=null 时**清除**旧值，而不是写 0：证据没了就该退回「没数据」，不是退回「中性」。
 */
export function applyUtilityToMeta(
  meta: Record<string, unknown>,
  summary: MemoryOutcomeSummary,
  now = Date.now(),
): Record<string, unknown> {
  const next = { ...meta };
  if (summary.utility === null) {
    delete next[UTILITY_FIELD];
    delete next[UTILITY_SAMPLES_FIELD];
    delete next[UTILITY_BASIS_FIELD];
    delete next[UTILITY_UPDATED_FIELD];
    return next;
  }
  next[UTILITY_FIELD] = Number(summary.utility.toFixed(4));
  next[UTILITY_SAMPLES_FIELD] = Number(summary.effectiveSamples.toFixed(4));
  next[UTILITY_BASIS_FIELD] = summary.utilityBasis;
  next[UTILITY_UPDATED_FIELD] = now;
  return next;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

export function formatMemoryUtility(summary: MemoryOutcomeSummary, options: { showLinks?: number } = {}): string {
  const lines: string[] = [];
  lines.push(`Memory ${summary.memoryId}`);
  lines.push(`  参与任务: ${summary.total} 条 (精确 ${summary.exactCount} / 会话级 ${summary.sessionCount})`);
  lines.push(
    `  outcome:  success=${summary.counts.success} corrected=${summary.counts.corrected}`
    + ` missed=${summary.counts.missed} failure=${summary.counts.failure}`,
  );
  lines.push(`  成功率:   ${pct(summary.successRate)}  (仅精确 join: ${pct(summary.exactSuccessRate)})`);
  lines.push(
    `  utility:  ${summary.utility === null ? "null（样本不足，不下结论）" : summary.utility.toFixed(4)}`
    + `  [基于 ${summary.utilityBasis} join，有效样本 ${summary.effectiveSamples.toFixed(2)}]`,
  );

  const limit = options.showLinks ?? 0;
  if (limit > 0 && summary.links.length > 0) {
    lines.push("  最近参与:");
    for (const link of summary.links.slice(0, limit)) {
      lines.push(
        `    ${link.recordedAt.slice(0, 10)} [${link.join}] ${link.workflowId} → ${link.outcome}`
        + `  ${link.summary.slice(0, 60)}`,
      );
    }
  }
  return lines.join("\n");
}
