/**
 * Result Synthesizer — Tier 3.5
 *
 * Converts multiple retrieval fragments into a single coherent narrative
 * using LLM. Falls back to original fragments when LLM is unavailable.
 *
 * Integration point: context-composer calls synthesize() on section outputs
 * (stableContext, relevantPatterns, recentCases) when enabled.
 *
 * Enable: RECALLNEST_SYNTHESIZE=true environment variable.
 */

import type { LLMClient } from "./llm-client.js";
import { logWarn } from "./stderr-log.js";

// ============================================================================
// Configuration
// ============================================================================

export interface SynthesizerConfig {
  /** Minimum fragments required to trigger synthesis (default: 3).
   *  Below this count, fragments are returned as-is. */
  minFragments: number;
  /** Maximum output length in chars (default: 500). */
  maxOutputChars: number;
}

export const DEFAULT_SYNTHESIZER_CONFIG: SynthesizerConfig = {
  minFragments: 3,
  maxOutputChars: 500,
};

// ============================================================================
// Core
// ============================================================================

/**
 * Check if synthesis is enabled via environment variable.
 */
export function isSynthesisEnabled(): boolean {
  return process.env.RECALLNEST_SYNTHESIZE === "true";
}

/**
 * Synthesize an array of text fragments into a coherent narrative.
 *
 * @param fragments  Array of text snippets (e.g. from retrieval results)
 * @param query      The original query/task that produced these fragments
 * @param llm        LLM client instance (null = fallback to pass-through)
 * @param config     Optional configuration overrides
 * @returns Object with synthesized text (or original fragments on fallback)
 */
export async function synthesize(
  fragments: string[],
  query: string,
  llm: LLMClient | null,
  config: SynthesizerConfig = DEFAULT_SYNTHESIZER_CONFIG,
): Promise<SynthesisResult> {
  // Not enough fragments to justify synthesis
  if (fragments.length < config.minFragments) {
    return { text: null, fragments, synthesized: false, reason: "below-threshold" };
  }

  // No LLM available
  if (!llm) {
    return { text: null, fragments, synthesized: false, reason: "no-llm" };
  }

  try {
    const result = await llm.synthesizeFragments(fragments, query, config.maxOutputChars);
    if (result && result.length > 0) {
      return { text: result, fragments, synthesized: true, reason: "ok" };
    }
    return { text: null, fragments, synthesized: false, reason: "empty-response" };
  } catch (err) {
    logWarn("Result synthesis failed, using raw fragments:", err);
    return { text: null, fragments, synthesized: false, reason: "error" };
  }
}

/**
 * Synthesize a section of context-composer output.
 * If synthesis succeeds, returns a single-element array with the narrative.
 * Otherwise returns the original array unchanged.
 */
export async function synthesizeSection(
  sectionItems: string[],
  query: string,
  llm: LLMClient | null,
  config: SynthesizerConfig = DEFAULT_SYNTHESIZER_CONFIG,
): Promise<string[]> {
  if (!isSynthesisEnabled()) return sectionItems;

  const result = await synthesize(sectionItems, query, llm, config);
  if (result.synthesized && result.text) {
    return [result.text];
  }
  return sectionItems;
}

// ============================================================================
// Types
// ============================================================================

export interface SynthesisResult {
  /** Synthesized narrative text, or null if synthesis was skipped/failed */
  text: string | null;
  /** Original fragments (preserved for fallback) */
  fragments: string[];
  /** Whether synthesis was actually performed */
  synthesized: boolean;
  /** Reason for the outcome */
  reason: "ok" | "below-threshold" | "no-llm" | "empty-response" | "error";
}
