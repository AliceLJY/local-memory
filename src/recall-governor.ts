/**
 * LME-7: Recall Governor — auto-recall 治理层
 *
 * 在 HybridRetriever 返回结果后、auto-recall 返回给调用方之前，
 * 对检索结果施加 4 层治理：
 *   1. Query 截断 — 超长 query 截到 maxQueryChars（省 embedding 成本）
 *   2. 状态过滤 — 排除 archived/superseded 记忆（evolution 兜底）
 *   3. 预算控制 — 总字符上限 + 条目数上限
 *   4. 会话去重 — 同一 session 内不重复注入同一条记忆
 */

import { isActiveMemory } from "./memory-evolution.js";
import type { RetrievalResult } from "./retriever.js";
import { logInfo } from "./stderr-log.js";

// ============================================================================
// Configuration
// ============================================================================

export interface GovernorConfig {
  /** Max query length before truncation (default: 1000) */
  maxQueryChars: number;
  /** Max total characters across all injected memories (default: 8000) */
  charBudget: number;
  /** Max number of memories to inject (default: 10) */
  maxItems: number;
}

const DEFAULT_CONFIG: GovernorConfig = {
  maxQueryChars: 1000,
  charBudget: 8000,
  maxItems: 10,
};

export function resolveGovernorConfig(
  overrides?: Partial<GovernorConfig>,
): GovernorConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// ============================================================================
// Governor Session — tracks per-session dedup state
// ============================================================================

export class GovernorSession {
  private readonly injectedIds = new Set<string>();

  /** Mark a memory ID as already injected in this session. */
  markInjected(id: string): void {
    this.injectedIds.add(id);
  }

  /** Check whether a memory ID was already injected. */
  wasInjected(id: string): boolean {
    return this.injectedIds.has(id);
  }

  /** Bulk-mark results after governing. */
  markAll(results: RetrievalResult[]): void {
    for (const r of results) {
      this.injectedIds.add(r.entry.id);
    }
  }

  /** Number of unique IDs tracked so far. */
  get size(): number {
    return this.injectedIds.size;
  }
}

// ============================================================================
// Layer 1: Query Truncation
// ============================================================================

export function truncateQuery(
  query: string,
  maxChars: number,
): string {
  if (query.length <= maxChars) return query;
  logInfo(`[recall-governor] query truncated: ${query.length} → ${maxChars} chars`);
  return query.slice(0, maxChars);
}

// ============================================================================
// Layer 2: Evolution State Filter
// ============================================================================

function filterByEvolutionState(results: RetrievalResult[]): RetrievalResult[] {
  const before = results.length;
  const filtered = results.filter((r) => isActiveMemory(r.entry.metadata));
  const dropped = before - filtered.length;
  if (dropped > 0) {
    logInfo(`[recall-governor] evolution filter dropped ${dropped}/${before} inactive memories`);
  }
  return filtered;
}

// ============================================================================
// Layer 3: Budget Control
// ============================================================================

function applyBudget(
  results: RetrievalResult[],
  config: GovernorConfig,
): RetrievalResult[] {
  const kept: RetrievalResult[] = [];
  let totalChars = 0;

  for (const r of results) {
    if (kept.length >= config.maxItems) break;
    const textLen = r.entry.text.length;
    if (totalChars + textLen > config.charBudget && kept.length > 0) break;
    // Always allow at least one result even if it exceeds budget
    kept.push(r);
    totalChars += textLen;
  }

  if (kept.length < results.length) {
    logInfo(
      `[recall-governor] budget control: ${kept.length}/${results.length} kept ` +
      `(${totalChars} chars, limit ${config.charBudget})`,
    );
  }
  return kept;
}

// ============================================================================
// Layer 4: Session Dedup
// ============================================================================

function deduplicateBySession(
  results: RetrievalResult[],
  session: GovernorSession | undefined,
): RetrievalResult[] {
  if (!session) return results;

  const before = results.length;
  const deduped = results.filter((r) => !session.wasInjected(r.entry.id));
  const dropped = before - deduped.length;
  if (dropped > 0) {
    logInfo(`[recall-governor] session dedup dropped ${dropped}/${before} already-injected memories`);
  }
  return deduped;
}

// ============================================================================
// Public API — compose all layers
// ============================================================================

/**
 * Run the full governance pipeline on retrieval results.
 * Call this after tier-aware filtering in auto-recall, before returning.
 *
 * @param results - Pre-sorted retrieval results (score descending)
 * @param session - Optional GovernorSession for cross-call dedup
 * @param config  - Optional config overrides
 * @returns Governed results, ready for injection
 */
export function governResults(
  results: RetrievalResult[],
  session?: GovernorSession,
  config?: Partial<GovernorConfig>,
): RetrievalResult[] {
  if (results.length === 0) return results;

  const cfg = resolveGovernorConfig(config);

  // Layer 2: evolution state filter
  let governed = filterByEvolutionState(results);

  // Layer 3: session dedup (before budget so deduped items don't waste budget slots)
  governed = deduplicateBySession(governed, session);

  // Layer 4: budget control
  governed = applyBudget(governed, cfg);

  // Mark newly injected IDs for future dedup
  if (session) {
    session.markAll(governed);
  }

  return governed;
}
