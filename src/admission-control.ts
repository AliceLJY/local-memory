/**
 * LME-8: Admission Control — 写入准入控制
 *
 * 在 capture-engine.ts 的 persistMemory 入口处执行写前门控，
 * 拦截低质量记忆，避免垃圾进库再过滤。
 *
 * 4 层准入检查：
 *   1. 最短文本长度 — 过短文本拒绝
 *   2. Noise filter — 噪声模式前置过滤
 *   3. Importance 下限 — 低 importance 拒绝
 *   4. Scope 写入频率限制 — 防 flood
 */

import { isNoise } from "./noise-filter.js";
import { logInfo } from "./stderr-log.js";

// ============================================================================
// Configuration
// ============================================================================

export interface AdmissionConfig {
  /** Minimum text length to accept (default: 10) */
  minTextLength: number;
  /** Enable noise-filter pre-check (default: true) */
  noiseFilterEnabled: boolean;
  /** Minimum importance to accept (default: 0.2) */
  minImportance: number;
  /** Max writes per scope within the rate window (default: 50) */
  maxWritesPerScope: number;
  /** Rate limit window in milliseconds (default: 60_000 = 1 minute) */
  rateLimitWindowMs: number;
}

const DEFAULT_CONFIG: AdmissionConfig = {
  minTextLength: 10,
  noiseFilterEnabled: true,
  minImportance: 0.2,
  maxWritesPerScope: 50,
  rateLimitWindowMs: 60_000,
};

export function resolveAdmissionConfig(
  overrides?: Partial<AdmissionConfig>,
): AdmissionConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// ============================================================================
// Admission Result
// ============================================================================

export type AdmissionVerdict = "accepted" | "rejected";
export type RejectionReason =
  | "text_too_short"
  | "noise_detected"
  | "importance_too_low"
  | "rate_limited";

export interface AdmissionResult {
  verdict: AdmissionVerdict;
  reason?: RejectionReason;
}

const ACCEPTED: AdmissionResult = { verdict: "accepted" };

// ============================================================================
// Rate Limiter — per-scope write frequency tracking
// ============================================================================

export class ScopeRateLimiter {
  private readonly windows = new Map<string, number[]>();

  /**
   * Record a write for a scope and check if rate limit is exceeded.
   * Returns true if the write should be allowed.
   */
  check(scope: string, config: AdmissionConfig): boolean {
    const now = Date.now();
    const cutoff = now - config.rateLimitWindowMs;

    let timestamps = this.windows.get(scope);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(scope, timestamps);
    }

    // Prune expired timestamps
    const firstValid = timestamps.findIndex((t) => t >= cutoff);
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    } else if (firstValid === -1) {
      timestamps.length = 0;
    }

    if (timestamps.length >= config.maxWritesPerScope) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  /** Number of scopes currently tracked. */
  get size(): number {
    return this.windows.size;
  }

  /** Clear all tracking state. */
  clear(): void {
    this.windows.clear();
  }
}

// ============================================================================
// Public API — admission gate
// ============================================================================

/**
 * Check whether a memory write should be admitted.
 * Call this at the top of persistMemory, before embedding.
 *
 * @param text       - Memory text to evaluate
 * @param importance - Importance score (0–1)
 * @param scope      - Target scope
 * @param rateLimiter - Optional shared rate limiter instance
 * @param config     - Optional config overrides
 */
export function checkAdmission(
  text: string,
  importance: number,
  scope: string,
  rateLimiter?: ScopeRateLimiter,
  config?: Partial<AdmissionConfig>,
): AdmissionResult {
  const cfg = resolveAdmissionConfig(config);

  // Layer 1: minimum text length
  const trimmed = text.trim();
  if (trimmed.length < cfg.minTextLength) {
    logInfo(`[admission-control] rejected: text too short (${trimmed.length} < ${cfg.minTextLength})`);
    return { verdict: "rejected", reason: "text_too_short" };
  }

  // Layer 2: noise filter pre-check
  if (cfg.noiseFilterEnabled && isNoise(trimmed)) {
    logInfo(`[admission-control] rejected: noise detected`);
    return { verdict: "rejected", reason: "noise_detected" };
  }

  // Layer 3: importance floor
  if (importance < cfg.minImportance) {
    logInfo(`[admission-control] rejected: importance too low (${importance} < ${cfg.minImportance})`);
    return { verdict: "rejected", reason: "importance_too_low" };
  }

  // Layer 4: scope rate limiting
  if (rateLimiter && !rateLimiter.check(scope, cfg)) {
    logInfo(`[admission-control] rejected: rate limited for scope "${scope}"`);
    return { verdict: "rejected", reason: "rate_limited" };
  }

  return ACCEPTED;
}
