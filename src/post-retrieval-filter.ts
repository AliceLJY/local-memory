/**
 * E-2: Post-retrieval relevance filter.
 * After retrieval returns top-K candidates, use LLM to judge relevance.
 * Only fires for resume_context (batch recall), not search_memory (too slow for interactive).
 */

import type { LLMClient } from "./llm-client.js";
import type { RetrievalResult } from "./retriever.js";

export interface FilterConfig {
  /** Max items to filter per batch (default: 10) */
  maxItems: number;
  /** Minimum score to even consider filtering — below this, just drop (default: 0.40) */
  minScoreForFilter: number;
}

const DEFAULT_FILTER_CONFIG: FilterConfig = {
  maxItems: 10,
  minScoreForFilter: 0.40,
};

const RELEVANCE_SYSTEM_PROMPT =
  "你是记忆相关性过滤器。判断以下记忆是否与当前查询相关。\n" +
  "只输出 JSON 数组：[true, false, true, ...]（与输入顺序对应）";

/**
 * Filter retrieval results by LLM relevance judgment.
 * Returns only results judged as relevant.
 * Falls back to returning all results on LLM failure.
 */
export async function filterByRelevance(
  results: RetrievalResult[],
  query: string,
  llm: LLMClient,
  config?: Partial<FilterConfig>,
): Promise<RetrievalResult[]> {
  if (results.length === 0 || !query) return results;

  const cfg: FilterConfig = { ...DEFAULT_FILTER_CONFIG, ...config };

  // Split: items above threshold go to LLM filter, below threshold get dropped
  const candidates = results.slice(0, cfg.maxItems).filter((r) => r.score >= cfg.minScoreForFilter);
  if (candidates.length === 0) return [];

  // Build user prompt: query + numbered memory excerpts (first 200 chars)
  const excerpts = candidates
    .map((r, i) => `[${i + 1}] ${extractExcerpt(r)}`)
    .join("\n");
  const userPrompt = `查询：${query}\n\n记忆列表：\n${excerpts}`;

  try {
    const verdicts = await llm.chatJson<boolean[]>(RELEVANCE_SYSTEM_PROMPT, userPrompt);
    if (!Array.isArray(verdicts)) return candidates;

    return candidates.filter((_, i) => i < verdicts.length && verdicts[i] === true);
  } catch {
    // Graceful fallback: return all candidates rather than losing data
    return candidates;
  }
}

/** Extract a short excerpt from a result for the LLM prompt. */
function extractExcerpt(result: RetrievalResult): string {
  // Prefer l0_abstract from metadata if available, otherwise use raw text
  if (result.entry.metadata) {
    try {
      const meta = JSON.parse(result.entry.metadata) as Record<string, unknown>;
      if (typeof meta.l0_abstract === "string" && meta.l0_abstract.length > 0) {
        return meta.l0_abstract.slice(0, 200);
      }
    } catch {
      // Fall through to raw text
    }
  }
  return result.entry.text.slice(0, 200);
}
