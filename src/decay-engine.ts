/**
 * Weibull Decay Engine + Tier Manager
 *
 * Borrowed from memory-lancedb-pro v1.1.0 smart-memory architecture.
 * Implements Weibull stretched-exponential decay and three-tier memory lifecycle.
 *
 * Three tiers simulate human memory consolidation:
 *   Peripheral (fast decay) ⟷ Working (standard) ⟷ Core (slow decay)
 *
 * No LLM required — pure math + access statistics.
 */

import type { EmotionMetadata } from "./memory-schema.js";

// ============================================================================
// Tier Definitions
// ============================================================================

export type MemoryTier = "core" | "working" | "peripheral";

interface TierParams {
  /** Weibull shape parameter: <1 = slow start, >1 = fast start */
  beta: number;
  /** Minimum score multiplier (decay floor) */
  floor: number;
}

/** Tier-specific decay parameters */
export const TIER_PARAMS: Record<MemoryTier, TierParams> = {
  core:       { beta: 0.8, floor: 0.85 },   // Sub-exponential: slow forgetting
  working:    { beta: 1.0, floor: 0.65 },   // Standard exponential
  peripheral: { beta: 1.3, floor: 0.45 },   // Super-exponential: fast forgetting
};

// ============================================================================
// Promotion / Demotion Thresholds
// ============================================================================

export interface TierThresholds {
  /** Peripheral → Working: minimum access count */
  workingAccessMin: number;
  /** Peripheral → Working: minimum importance */
  workingImportanceMin: number;
  /** Working → Core: minimum access count */
  coreAccessMin: number;
  /** Working → Core: minimum importance */
  coreImportanceMin: number;
  /** Demotion: days without access before downgrade */
  demotionStaleDays: number;
  /** Demotion: minimum access count to resist demotion */
  demotionAccessMin: number;
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  workingAccessMin: 3,
  workingImportanceMin: 0.5,
  coreAccessMin: 10,
  coreImportanceMin: 0.8,
  demotionStaleDays: 60,
  demotionAccessMin: 3,
};

// ============================================================================
// Weibull Decay
// ============================================================================

/**
 * Compute Weibull decay factor for a memory entry.
 *
 * Formula: floor + (1 - floor) * exp(-λ * t^β)
 *   where λ = ln(2) / halfLife^β
 *
 * At t = halfLife: factor = floor + (1 - floor) * 0.5
 * At t = 0:       factor = 1.0
 * At t → ∞:       factor = floor
 */
export function weibullDecay(
  ageDays: number,
  halfLifeDays: number,
  tier: MemoryTier = "peripheral",
): number {
  if (halfLifeDays <= 0 || ageDays <= 0) return 1.0;

  const { beta, floor } = TIER_PARAMS[tier];
  const lambda = Math.LN2 / Math.pow(halfLifeDays, beta);
  const decay = Math.exp(-lambda * Math.pow(ageDays, beta));

  return floor + (1 - floor) * decay;
}

// ============================================================================
// Emotion-Adjusted Decay
// ============================================================================

/**
 * Adjust half-life based on emotional intensity.
 * Strong emotion extends half-life by up to 30%.
 */
export function adjustHalfLifeForEmotion(
  baseHalfLife: number,
  emotion: EmotionMetadata | null | undefined,
): number {
  if (!emotion) return baseHalfLife;
  const raw = Math.abs(emotion.valence);
  // Dead-zone: ignore negligible emotional signal below threshold
  const intensity = raw < 0.1 ? 0 : raw;
  return baseHalfLife * (1 + 0.3 * intensity);
}

/**
 * Compute initial strength boost from arousal (flashbulb memory effect).
 * Returns multiplier in [1.0, 1.1].
 */
export function computeArousalBoost(
  emotion: EmotionMetadata | null | undefined,
): number {
  if (!emotion) return 1.0;
  return 1 + 0.1 * emotion.arousal;
}

// ============================================================================
// HP-7: Decay Exemptions
// ============================================================================

/**
 * Check if a memory should be exempt from time decay.
 * Exempt entries keep their original score without time-based penalties.
 *
 * Exemption rules:
 * 1. Core tier + high importance (≥ 0.95) → identity/correction, must not fade
 * 2. Recently accessed (within 7 days) → actively used, not stale
 * 3. Pinned → user explicitly marked as persistent
 */
export function isDecayExempt(
  metadata: string | undefined,
  importance: number,
): boolean {
  if (!metadata) return false;

  try {
    const meta = JSON.parse(metadata) as Record<string, unknown>;

    // Rule 1: Core + very high importance
    // importance 是本函数的入参（来自 entry 列），一并传下去——否则 heuristic 读不到它。
    const tier = meta.tier ?? resolveTierFromMeta(meta, importance);
    if (tier === "core" && importance >= 0.95) return true;

    // Rule 2: Accessed within last 7 days
    const lastAccess = typeof meta.lastAccessedAt === "number" ? meta.lastAccessedAt : 0;
    if (lastAccess > 0 && (Date.now() - lastAccess) < 7 * 86_400_000) return true;

    // Rule 3: Pinned
    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    if (tags.includes("pinned")) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Internal helper: resolve tier from parsed metadata (avoids re-parsing).
 *
 * `entryImportance` 是 MemoryEntry 的列字段。必须由调用方传进来：importance 不存在
 * 于 metadata（accessCount / lastAccessedAt / tier 才是 access-tracker 写在顶层的），
 * 所以只读 meta.importance 会恒等于 0，让所有还没有显式 tier 的条目一律落到
 * peripheral——2026-07 实测全库 3214 条走这个分支，顶层有 importance 的是 0 条。
 */
function resolveTierFromMeta(meta: Record<string, unknown>, entryImportance?: number): MemoryTier {
  if (meta.tier === "core" || meta.tier === "working" || meta.tier === "peripheral") {
    return meta.tier;
  }
  const imp = typeof meta.importance === "number"
    ? meta.importance
    : (typeof entryImportance === "number" ? entryImportance : 0);
  const ac = typeof meta.accessCount === "number" ? meta.accessCount : 0;
  if (imp >= 0.95 || ac >= 10) return "core";
  if (imp >= 0.8 || ac >= 3) return "working";
  return "peripheral";
}

// ============================================================================
// Tier Resolution
// ============================================================================

/**
 * Determine a memory's current tier from its metadata.
 * Falls back to heuristic based on importance if no tier is stored.
 */
export function resolveTier(metadata?: string, entryImportance?: number): MemoryTier {
  if (!metadata) return "peripheral";

  try {
    const meta = JSON.parse(metadata) as Record<string, unknown>;

    // Explicit tier stored in metadata（access-tracker 算过一次就会写在这里）
    if (meta.tier === "core" || meta.tier === "working" || meta.tier === "peripheral") {
      return meta.tier;
    }

    // Heuristic for entries without explicit tier:
    // - Pinned assets (importance ≥ 0.95) → core
    // - High importance (≥ 0.8) → working
    // - Everything else → peripheral
    //
    // importance 优先取调用方传入的 entry 列值。metadata 里没有这个字段——顶层住着的是
    // accessCount / lastAccessedAt / tier（access-tracker 写的），importance 从来不在。
    // 不传就只能退回 0，那会把所有还没被访问过的条目一律压成 peripheral。
    const importance = typeof meta.importance === "number"
      ? meta.importance
      : (typeof entryImportance === "number" ? entryImportance : 0);
    const accessCount = typeof meta.accessCount === "number" ? meta.accessCount : 0;

    if (importance >= 0.95 || accessCount >= 10) return "core";
    if (importance >= 0.8 || accessCount >= 3) return "working";
    return "peripheral";
  } catch {
    return "peripheral";
  }
}

// ============================================================================
// Tier Promotion / Demotion
// ============================================================================

/**
 * Evaluate whether a memory should be promoted or demoted.
 * Returns the new tier (may be the same as current).
 */
/**
 * Synaptic homeostasis: when core tier exceeds capacity, raise promotion thresholds.
 * Prevents "everything is important = nothing is important" problem.
 */
export function homeostasisAdjustedThresholds(
  coreCount: number,
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS,
  coreCap = 500,
): TierThresholds {
  if (coreCount <= coreCap) return thresholds;
  // Scale factor: 1.0 at cap, up to 2.0 at 3x cap
  const overflow = Math.min(coreCount / coreCap, 3.0);
  return {
    ...thresholds,
    coreAccessMin: Math.ceil(thresholds.coreAccessMin * overflow),
    coreImportanceMin: Math.min(thresholds.coreImportanceMin * (0.5 + 0.5 * overflow), 0.98),
  };
}

export function evaluateTierChange(
  currentTier: MemoryTier,
  accessCount: number,
  importance: number,
  lastAccessedAt: number,
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS,
): MemoryTier {
  const now = Date.now();
  const daysSinceAccess = lastAccessedAt > 0
    ? (now - lastAccessedAt) / 86_400_000
    : Infinity;

  // --- Promotion ---
  if (currentTier === "peripheral") {
    if (accessCount >= thresholds.workingAccessMin && importance >= thresholds.workingImportanceMin) {
      return "working";
    }
  }

  if (currentTier === "working" || currentTier === "peripheral") {
    if (accessCount >= thresholds.coreAccessMin && importance >= thresholds.coreImportanceMin) {
      return "core";
    }
  }

  // --- Demotion ---
  if (currentTier === "core") {
    if (daysSinceAccess > thresholds.demotionStaleDays && accessCount < thresholds.demotionAccessMin) {
      return "working";
    }
  }

  if (currentTier === "working") {
    if (daysSinceAccess > thresholds.demotionStaleDays && accessCount < thresholds.demotionAccessMin) {
      return "peripheral";
    }
  }

  return currentTier;
}
