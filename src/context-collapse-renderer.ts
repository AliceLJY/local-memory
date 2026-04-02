/**
 * CC-7: Context Collapse — dynamic granularity rendering layer.
 *
 * Given retrieval results + scores, renders each item at L0/L1/L2 granularity
 * based on relevance score. High-relevance items get full content (L2),
 * medium gets overview (L1), low gets one-liner (L0).
 *
 * Also includes CC-2 staleness hints: items older than 7 days get an age warning
 * so the model can judge whether to trust the information.
 *
 * Reuses existing L0/L1/L2 text stored in metadata by the multi-vector pipeline.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RenderLevel = "L0" | "L1" | "L2";

export interface CollapseInput {
  entryId: string;
  text: string;
  metadata?: string;
  score: number;
  timestamp: number;
}

export interface CollapseOutput {
  entryId: string;
  text: string;
  renderLevel: RenderLevel;
  stalenessHint?: string;
}

export interface CollapseConfig {
  /** Total token budget for all rendered items (default: 8000) */
  tokenBudget: number;
  /** Score thresholds for each level */
  thresholds: { l2: number; l1: number; l0: number };
  /** Days before staleness hint is added (default: 7) */
  stalenessThresholdDays: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_COLLAPSE_CONFIG: CollapseConfig = {
  tokenBudget: 8000,
  thresholds: { l2: 0.85, l1: 0.65, l0: 0.50 },
  stalenessThresholdDays: 7,
};

// ---------------------------------------------------------------------------
// Text extraction at each level
// ---------------------------------------------------------------------------

function parseMetaJson(metadata?: string): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    return JSON.parse(metadata);
  } catch {
    return null;
  }
}

/** Extract L0 text (one-liner, ≤80 chars). Falls back to first sentence of full text. */
function extractL0(text: string, metadata?: string): string {
  const meta = parseMetaJson(metadata);
  if (meta) {
    if (typeof meta.l0_abstract === "string" && meta.l0_abstract.length > 5) return meta.l0_abstract;
    if (typeof meta.anchor === "string" && meta.anchor.length > 5) return meta.anchor;
  }
  // Fallback: first sentence or first 80 chars
  const firstSentence = text.match(/^[^.!?。！？\n]+[.!?。！？]?/)?.[0];
  if (firstSentence && firstSentence.length <= 120) return firstSentence;
  return text.slice(0, 80) + (text.length > 80 ? "…" : "");
}

/** Extract L1 text (structured overview, 2-5 lines). Falls back to L0. */
function extractL1(text: string, metadata?: string): string {
  const meta = parseMetaJson(metadata);
  if (meta) {
    if (typeof meta.core_summary === "string" && meta.core_summary.length > 5) return meta.core_summary;
    if (typeof meta.l1_overview === "string" && meta.l1_overview.length > 5) return meta.l1_overview;
  }
  // Fallback: truncated full text
  if (text.length <= 300) return text;
  return text.slice(0, 300) + "…";
}

/** Extract L2 text (full content). */
function extractL2(text: string): string {
  return text;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token estimate: CJK chars ≈ 1.5 tokens each, others ≈ 0.25 per char. */
function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    tokens += /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(char) ? 1.5 : 0.25;
  }
  return Math.ceil(tokens);
}

// ---------------------------------------------------------------------------
// Staleness hint (CC-2)
// ---------------------------------------------------------------------------

function buildStalenessHint(timestamp: number, thresholdDays: number, now?: number): string | undefined {
  const ts = now ?? Date.now();
  const daysSinceUpdate = Math.floor((ts - timestamp) / 86_400_000);
  if (daysSinceUpdate <= thresholdDays) return undefined;
  return `[Updated ${daysSinceUpdate} days ago — verify before acting on this]`;
}

// ---------------------------------------------------------------------------
// Core: collapse renderer
// ---------------------------------------------------------------------------

/**
 * Render retrieval results at adaptive granularity based on relevance score.
 *
 * - score >= l2 threshold → full content (L2)
 * - score >= l1 threshold → overview (L1)
 * - score >= l0 threshold → one-liner (L0)
 * - below l0 threshold → excluded
 *
 * Token budget is enforced: once budget is exhausted, remaining items
 * are downgraded to L0 or excluded.
 */
export function collapseResults(
  items: CollapseInput[],
  config?: Partial<CollapseConfig>,
): CollapseOutput[] {
  const cfg: CollapseConfig = { ...DEFAULT_COLLAPSE_CONFIG, ...config };
  const { thresholds, tokenBudget, stalenessThresholdDays } = cfg;

  // Sort by score descending (highest relevance first)
  const sorted = [...items].sort((a, b) => b.score - a.score);

  const output: CollapseOutput[] = [];
  let tokensUsed = 0;

  for (const item of sorted) {
    // Below minimum threshold → skip
    if (item.score < thresholds.l0) continue;

    // Determine target level based on score
    let targetLevel: RenderLevel;
    if (item.score >= thresholds.l2) {
      targetLevel = "L2";
    } else if (item.score >= thresholds.l1) {
      targetLevel = "L1";
    } else {
      targetLevel = "L0";
    }

    // Extract text at target level
    let text: string;
    let actualLevel: RenderLevel = targetLevel;

    if (targetLevel === "L2") {
      text = extractL2(item.text);
    } else if (targetLevel === "L1") {
      text = extractL1(item.text, item.metadata);
    } else {
      text = extractL0(item.text, item.metadata);
    }

    // Check token budget — downgrade if needed
    const tokens = estimateTokens(text);
    if (tokensUsed + tokens > tokenBudget) {
      // Try downgrading to L1
      if (actualLevel === "L2") {
        text = extractL1(item.text, item.metadata);
        actualLevel = "L1";
        const l1Tokens = estimateTokens(text);
        if (tokensUsed + l1Tokens > tokenBudget) {
          // Further downgrade to L0
          text = extractL0(item.text, item.metadata);
          actualLevel = "L0";
          const l0Tokens = estimateTokens(text);
          if (tokensUsed + l0Tokens > tokenBudget) continue; // Skip entirely
          tokensUsed += l0Tokens;
        } else {
          tokensUsed += l1Tokens;
        }
      } else if (actualLevel === "L1") {
        text = extractL0(item.text, item.metadata);
        actualLevel = "L0";
        const l0Tokens = estimateTokens(text);
        if (tokensUsed + l0Tokens > tokenBudget) continue;
        tokensUsed += l0Tokens;
      } else {
        // Already L0 and still over budget → skip
        continue;
      }
    } else {
      tokensUsed += tokens;
    }

    // CC-2: Staleness hint
    const stalenessHint = buildStalenessHint(item.timestamp, stalenessThresholdDays);

    output.push({
      entryId: item.entryId,
      text,
      renderLevel: actualLevel,
      ...(stalenessHint ? { stalenessHint } : {}),
    });
  }

  return output;
}

// Re-export helpers for testing
export { extractL0, extractL1, extractL2, estimateTokens, buildStalenessHint };
