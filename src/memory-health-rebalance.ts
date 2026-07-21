import type { MemoryTier } from "./decay-engine.js";

export type StoredMemoryTier = MemoryTier | "unknown";

export interface MemoryHealthSnapshot {
  id: string;
  importance: number;
  timestamp: number;
  metadata?: string;
}

export interface MemoryHealthRebalancePlan {
  id: string;
  accessCount: number;
  currentImportance: number;
  nextImportance: number;
  currentTier: StoredMemoryTier;
  targetTier: MemoryTier;
  currentMetadata: Record<string, unknown>;
  nextMetadata: Record<string, unknown>;
  tierChanged: boolean;
  tierBackfilled: boolean;
  deadMemoryRow: boolean;
  deadMemoryDemoted: boolean;
  importanceChanged: boolean;
  changed: boolean;
}

export interface MemoryHealthRebalanceSummary {
  totalRows: number;
  changedRows: number;
  deadMemoryRows: number;
  deadMemoryDemotions: number;
  tierBackfills: number;
  tierChanges: number;
  importanceChanges: number;
}

export interface MemoryHealthDatasetStats {
  maxAccessCount: number;
  minTimestamp: number;
  maxTimestamp: number;
}

interface ImportanceBand {
  min: number;
  max: number;
}

const IMPORTANCE_BANDS: Record<MemoryTier, ImportanceBand> = {
  core: { min: 0.85, max: 0.95 },
  working: { min: 0.6, max: 0.8 },
  peripheral: { min: 0.3, max: 0.5 },
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function roundImportance(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function parseMemoryHealthMetadata(metadata?: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadata || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function getMemoryHealthAccessCount(metadata: Record<string, unknown>): number {
  const camel = metadata.accessCount;
  if (typeof camel === "number" && Number.isFinite(camel) && camel >= 0) {
    return Math.floor(camel);
  }

  const snake = metadata.access_count;
  if (typeof snake === "number" && Number.isFinite(snake) && snake >= 0) {
    return Math.floor(snake);
  }

  return 0;
}

export function getStoredMemoryTier(metadata: Record<string, unknown>): StoredMemoryTier {
  const tier = metadata.tier;
  return tier === "core" || tier === "working" || tier === "peripheral"
    ? tier
    : "unknown";
}

export function resolveRebalancedTier(currentTier: StoredMemoryTier, accessCount: number): MemoryTier {
  if (accessCount <= 0) return "peripheral";
  if (currentTier !== "unknown") return currentTier;
  if (accessCount > 5) return "core";
  return "working";
}

function computeTierAccessSignal(
  tier: MemoryTier,
  accessCount: number,
  maxAccessCount: number,
): number {
  if (accessCount <= 0) return 0;

  switch (tier) {
    case "peripheral": {
      const ceiling = Math.max(1, Math.min(5, maxAccessCount));
      return clamp(accessCount / ceiling, 0, 1);
    }
    case "working": {
      if (accessCount <= 1) return 0;
      return clamp((Math.min(accessCount, 5) - 1) / 4, 0, 1);
    }
    case "core": {
      const ceiling = Math.max(6, maxAccessCount);
      if (ceiling <= 6) return 1;
      return clamp((Math.min(accessCount, ceiling) - 6) / (ceiling - 6), 0, 1);
    }
  }
}

// ⚠️ 约束（2026-07-21 通用Wiki上下文记忆Agent方案借鉴审计 P1-4）：本函数用 accessCount 参与
// importance 计算（importance←accessSignal，越常访问 importance 越高的马太逻辑）。当前为孤儿代码——
// 全树仅测试引用、生产侧零 import。接线前须评估与「usage 只进检索先验、绝不抬 importance/事实置信」
// 立场的冲突：频次抬 importance 会自增强（越常召回越权威），违反该立场。接线须 Alice 明确批准。
export function computeRebalancedImportance(
  currentImportance: number,
  tier: MemoryTier,
  accessCount: number,
  maxAccessCount: number,
  recencySignal: number,
): number {
  const band = IMPORTANCE_BANDS[tier];
  const span = band.max - band.min;
  const currentSignal = clamp(currentImportance, 0, 1);
  const accessSignal = computeTierAccessSignal(tier, accessCount, maxAccessCount);
  const blendedSignal = tier === "peripheral" && accessCount === 0
    ? clamp(currentSignal * 0.15 + recencySignal * 0.85, 0, 1)
    : clamp(currentSignal * 0.25 + accessSignal * 0.65 + recencySignal * 0.1, 0, 1);
  return roundImportance(clamp(band.min + span * blendedSignal, band.min, band.max));
}

export function buildMemoryHealthRebalancePlan(
  snapshot: MemoryHealthSnapshot,
  stats: MemoryHealthDatasetStats,
): MemoryHealthRebalancePlan {
  const currentMetadata = parseMemoryHealthMetadata(snapshot.metadata);
  const accessCount = getMemoryHealthAccessCount(currentMetadata);
  const currentTier = getStoredMemoryTier(currentMetadata);
  const targetTier = resolveRebalancedTier(currentTier, accessCount);
  const currentImportance = clamp(snapshot.importance, 0, 1);
  const recencySignal = stats.maxTimestamp <= stats.minTimestamp
    ? 0.5
    : clamp(
        (snapshot.timestamp - stats.minTimestamp) / (stats.maxTimestamp - stats.minTimestamp),
        0,
        1,
      );
  const nextImportance = computeRebalancedImportance(
    currentImportance,
    targetTier,
    accessCount,
    stats.maxAccessCount,
    recencySignal,
  );

  const nextMetadata: Record<string, unknown> = {
    ...currentMetadata,
    tier: targetTier,
    importance: nextImportance,
  };

  const tierChanged = currentTier !== targetTier;
  const tierBackfilled = currentTier === "unknown";
  const deadMemoryRow = accessCount === 0;
  const deadMemoryDemoted = deadMemoryRow && currentTier !== "peripheral";
  const importanceChanged = roundImportance(currentImportance) !== nextImportance;

  return {
    id: snapshot.id,
    accessCount,
    currentImportance,
    nextImportance,
    currentTier,
    targetTier,
    currentMetadata,
    nextMetadata,
    tierChanged,
    tierBackfilled,
    deadMemoryRow,
    deadMemoryDemoted,
    importanceChanged,
    changed: tierChanged || importanceChanged || !("importance" in currentMetadata),
  };
}

export function summarizeMemoryHealthPlans(
  plans: MemoryHealthRebalancePlan[],
): MemoryHealthRebalanceSummary {
  return plans.reduce<MemoryHealthRebalanceSummary>((summary, plan) => {
    summary.totalRows += 1;
    if (plan.changed) summary.changedRows += 1;
    if (plan.deadMemoryRow) summary.deadMemoryRows += 1;
    if (plan.deadMemoryDemoted) summary.deadMemoryDemotions += 1;
    if (plan.tierBackfilled) summary.tierBackfills += 1;
    if (plan.tierChanged) summary.tierChanges += 1;
    if (plan.importanceChanged) summary.importanceChanges += 1;
    return summary;
  }, {
    totalRows: 0,
    changedRows: 0,
    deadMemoryRows: 0,
    deadMemoryDemotions: 0,
    tierBackfills: 0,
    tierChanges: 0,
    importanceChanges: 0,
  });
}
