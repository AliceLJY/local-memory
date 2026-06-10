/**
 * Usage Tracker — injection-vs-use 双计数影子统计（shadow usage stats）
 *
 * 借鉴 Orb (MIT © 2026 Kailiang Zhang) 的 injection/usage 双计数 + cold 判定，
 * TS 逻辑重写（Orb 原为 Python）。回答的痛点："纠正写进记忆后，是否真的不再复发？"
 *
 * 两类信号分离：
 *   - injection = 记忆被检索 surface / 注入上下文的次数。已有计数 = metadata.accessCount
 *     （由 access-tracker 维护）。本模块只读它做对比，不修改。
 *   - use = 记忆在 reconstruction 输出里被 [src:ID] 真正引用的次数。新增 = metadata.usage.useCount。
 *
 * 设计同 confidence-tracker：纯函数返回 metadata patch，caller 用 store.update() 应用，
 * 模块本身 store-agnostic、易测。命名空间 metadata.usage 独立于两套已有 accessCount
 * （top-level metadata.accessCount + metadata.evolution.accessCount），避免语义打架。
 *
 * 【第一阶段定位：纯影子统计 · 只采原始信号】
 *   写入路径（buildUsagePatch / recordMemoryUsage）只记 useCount / firstUsedAt / lastUsedAt
 *   这种"被引用了"的客观事实，**不写 usageStatus**。原因：reconstruction 只在"被引用"时触发，
 *   写入时 useCount 必 > 0，永远写不出 cold（被反复 surface 却从未被引用）——而 cold 恰是核心观察目标。
 *   所以状态判定降级为离线/按需：deriveUsageStatus(entry) 用真实 accessCount(injection) + useCount
 *   现算，cold 由此可达。第一阶段不参与 ranking、不接 forget-engine、不动 tier/confidence——
 *   computeUsageStatus 不接任何决策回路，纯供离线观察 / 第二阶段使用。
 *
 *   注：accessCount 作 injection 代理是近似（受 access-tracker 的 novelty/cooldown gate 影响）；
 *   并发：usage 写入与 access/confidence 共用 metadata RMW（读整段→改→写回），并发下后写覆盖先写，
 *   单用户场景几乎不触发，根治（store 级 patchMetadata 单写通道）留第二阶段。
 */

import type { MemoryEntry } from "./store.js";

// ---------------------------------------------------------------------------
// Constants（复刻 Orb decay_tick 判定阈值，供 deriveUsageStatus / computeUsageStatus 使用）
// ---------------------------------------------------------------------------

/** injection ≥ 此值 且 use == 0 → cold（被反复 surface 却从未被真正引用）。 */
export const USAGE_COLD_INJECTION_THRESHOLD = 6;
/** use / injection ≥ 此比例 → hot。 */
export const USAGE_HOT_RATIO = 0.3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UsageStatus = "unused" | "cold" | "warm" | "hot";

export interface UsageMetadata {
  /** 被 reconstruction [src:ID] 引用的累计次数。 */
  useCount: number;
  /** 首次被引用时间（ms）。 */
  firstUsedAt?: number;
  /** 最近被引用时间（ms）。 */
  lastUsedAt?: number;
  /**
   * 衍生观察状态。第一阶段写入路径**不写**此字段（见文件头注释）；保留 optional
   * 是为了向后兼容 + 第二阶段可能持久化。读取（readUsage）仍兼容已存在的旧值。
   */
  usageStatus?: UsageStatus;
}

export interface UsageUpdate {
  entryId: string;
  oldUseCount: number;
  newUseCount: number;
}

export interface UsagePatch {
  /** 完整 metadata object（含原有所有字段 + 更新后的 usage）— caller 整体 JSON.stringify 写回。 */
  metadata: Record<string, unknown>;
  update: UsageUpdate;
}

/** 有 store 的 caller 用的最小端口（结构化类型，便于测试 mock）。
 *  第二阶段起走 store.patchMetadata 单写通道：读改写在 per-id 队列内完成，
 *  不再各自 getById+update（那是并发覆盖的根源）。 */
export interface UsageStorePort {
  patchMetadata(
    id: string,
    patchFn: (meta: Record<string, unknown>, entry: MemoryEntry) => Record<string, unknown>,
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 解析 metadata JSON，仅接受非空对象（防 "null" / 数组 / 标量等让后续 meta.usage 访问崩）。 */
function parseMeta(entry: MemoryEntry): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(entry.metadata || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asUsageStatus(v: unknown): UsageStatus | undefined {
  return v === "unused" || v === "cold" || v === "warm" || v === "hot" ? v : undefined;
}

function readUsage(meta: Record<string, unknown>): UsageMetadata {
  const raw = meta.usage;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      useCount: typeof obj.useCount === "number" ? obj.useCount : 0,
      firstUsedAt: typeof obj.firstUsedAt === "number" ? obj.firstUsedAt : undefined,
      lastUsedAt: typeof obj.lastUsedAt === "number" ? obj.lastUsedAt : undefined,
      usageStatus: asUsageStatus(obj.usageStatus),
    };
  }
  return { useCount: 0 };
}

/** injection 代理 = top-level metadata.accessCount（access-tracker 维护）。只读不写。 */
function readInjectionCount(meta: Record<string, unknown>): number {
  return typeof meta.accessCount === "number" ? meta.accessCount : 0;
}

/**
 * use 信号采集是否在生产路径上活跃。
 * useCount 唯一的写入路径是 reconstruction 的 [src:ID] 引用,而 reconstruction
 * 由 RECALLNEST_CONSTRUCTIVE_RETRIEVAL 控制——flag 关闭时 useCount 恒零,
 * "cold"(access 高 + use 零)退化为"access 高",不可解释。
 * 观察口(data_checkup / memory_lint / dream 快照)必须先查本开关:信号未采集时
 * 如实标注并跳过判定,否则输出的是统计学完美、临床无意义的假 cold。
 * (2026-06-11 临床重审:Alice 曾开过此 flag,因合成"召回缺失"主动关闭——
 * 病史见 memory canonicalKey=constructive-retrieval-flag-clinical-history)
 */
export function isUsageSignalActive(): boolean {
  return process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL === "true";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** 读取 metadata.usage（缺失字段当 0/undefined）。 */
export function getUsageMetadata(entry: MemoryEntry): UsageMetadata {
  return readUsage(parseMeta(entry));
}

/**
 * 影子状态判定（纯函数，不裁决）。复刻 Orb decay_tick：
 *   use > 0 且 use/injection ≥ HOT_RATIO → hot
 *   use > 0                              → warm
 *   use == 0 且 injection ≥ COLD_THRESH  → cold
 *   否则                                  → unused
 */
export function computeUsageStatus(injectionCount: number, useCount: number): UsageStatus {
  if (useCount > 0) {
    if (injectionCount > 0 && useCount / injectionCount >= USAGE_HOT_RATIO) return "hot";
    return "warm";
  }
  if (injectionCount >= USAGE_COLD_INJECTION_THRESHOLD) return "cold";
  return "unused";
}

/**
 * 离线/按需派生 usage 状态（不持久化）。
 * 第一阶段写入路径不写 usageStatus，cold 等状态通过本函数用真实 accessCount(injection) + useCount
 * 现算 —— 这是 cold 可观察的唯一入口。纯读，不改 store、不接决策。
 */
export function deriveUsageStatus(entry: MemoryEntry): UsageStatus {
  const meta = parseMeta(entry);
  return computeUsageStatus(readInjectionCount(meta), readUsage(meta).useCount);
}

/**
 * 构造一次"使用"的 metadata patch（纯函数，不写 store）。
 * useCount +1、更新 lastUsedAt/firstUsedAt。**只记原始信号，不写 usageStatus**（见文件头）。
 * 只动 metadata.usage，原有字段（accessCount/confidence/evolution/tier/...）原样保留。
 * entry 为 null（未找到）→ 返回 null。
 */
export function buildUsagePatch(entry: MemoryEntry | null, now: number): UsagePatch | null {
  if (!entry) return null;

  const meta = parseMeta(entry);
  const usage = readUsage(meta);

  const oldUseCount = usage.useCount;
  const newUseCount = oldUseCount + 1;

  const nextUsage: UsageMetadata = {
    useCount: newUseCount,
    firstUsedAt: usage.firstUsedAt ?? now,
    lastUsedAt: now,
  };

  meta.usage = nextUsage;

  return {
    metadata: meta,
    update: { entryId: entry.id, oldUseCount, newUseCount },
  };
}

/**
 * Convenience wrapper：经 store.patchMetadata 队列做读改写（防并发覆盖）。
 * 影子写入；entry 未找到 → 返回 null（no-op）。
 * 失败由 caller 决定是否 try/catch（影子统计不应阻断主流程）。
 */
export async function recordMemoryUsage(
  store: UsageStorePort,
  entryId: string,
  now: number = Date.now(),
  scope?: string,
): Promise<UsageUpdate | null> {
  let update: UsageUpdate | null = null;
  const result = await store.patchMetadata(
    entryId,
    (_meta, entry) => {
      // buildUsagePatch 读的是队列内最新一次读出的 entry，与 _meta 同源。
      const patch = buildUsagePatch(entry, now);
      // entry 在队列内非 null，patch 必非 null；防御性兜底保持类型干净。
      if (!patch) return _meta;
      update = patch.update;
      return patch.metadata;
    },
    scope ? [scope] : undefined,
  );
  return result === null ? null : update;
}

/**
 * 批量影子记录一次 reconstruction 引用到的所有记忆（best-effort）。
 * citedIds = reconstruction 输出里 valid 的 [src:ID]（caller 已用 extractCitedIds 提取并 scope 校验过）。
 * 用 allSettled：单条写失败不连累其它，也绝不向上抛——影子统计不阻断主检索/resume 流程。
 */
export async function recordReconstructionUsage(
  store: UsageStorePort,
  citedIds: string[],
  now: number = Date.now(),
  scope?: string,
): Promise<void> {
  if (citedIds.length === 0) return;
  const unique = [...new Set(citedIds)];
  await Promise.allSettled(unique.map(id => recordMemoryUsage(store, id, now, scope)));
}
