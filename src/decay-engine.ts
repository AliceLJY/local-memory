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
// Tier Resolution
// ============================================================================

/**
 * Determine a memory's current tier from its metadata.
 * Falls back to heuristic based on importance if no tier is stored.
 */
export function resolveTier(metadata?: string): MemoryTier {
  if (!metadata) return "peripheral";

  try {
    const meta = JSON.parse(metadata) as Record<string, unknown>;

    // Explicit tier stored in metadata
    if (meta.tier === "core" || meta.tier === "working" || meta.tier === "peripheral") {
      return meta.tier;
    }

    // Heuristic for entries without explicit tier:
    // - Pinned assets (importance ≥ 0.95) → core
    // - High importance (≥ 0.8) → working
    // - Everything else → peripheral
    const importance = typeof meta.importance === "number" ? meta.importance : 0;
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
