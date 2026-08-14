/**
 * Version Manager — Tier 3.3
 *
 * Replaces the "archive loser" SUPERSEDE model with version coexistence:
 * - Entries that would have been merged are instead grouped by version_group
 * - Each version has a rank (confidence × log1p(accessCount + 1))
 * - During retrieval, only the top-ranked version per group is returned
 * - All versions remain in DB for history/audit
 *
 * Brain science inspiration: Imprint Competition — competing memory traces
 * can coexist; the stronger one dominates recall but the weaker remains
 * available for re-evaluation.
 */

import type { MemoryEntry } from "./store.js";
import type { MemoryStorePort } from "./memory-store-port.js";
import { logInfo } from "./stderr-log.js";

// ============================================================================
// Types
// ============================================================================

export interface VersionGroupMetadata {
  /** Shared UUID for all versions in this group */
  version_group: string;
  /** Rank within group (higher = preferred for retrieval) */
  version_rank: number;
  /** When this version was created/grouped */
  version_created: string;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * 纯计算版：给一条 entry 的（已解析）metadata 打 version-group 三键，不写库。
 * 就地修改并返回传入的 meta 对象。
 *
 * 供 consolidation-engine 3a 在 patchMetadataBatch 的 patchFn 里使用 —— patchFn 在
 * 锁内拿到库中最新 meta，这里只负责"该设哪些键"；groupId 的决策（沿用已有组 or
 * 新生成）由调用方在 cluster 级做一次、全 cluster 共享，修掉了旧路径"每个 member
 * 重新从旧内存串判组 → 各造一个新 groupId"的 Bug-1 半边。
 *
 * @param preserveCreated canonical 语义：已有 version_created 则保留；member 语义传 false（总是刷新）
 */
export function computeVersionGroupPatch(
  meta: Record<string, unknown>,
  entry: MemoryEntry,
  groupId: string,
  preserveCreated: boolean,
  nowIso: string,
): Record<string, unknown> {
  meta.version_group = groupId;
  meta.version_rank = computeVersionRank(entry);
  if (!preserveCreated || !meta.version_created) meta.version_created = nowIso;
  return meta;
}

/**
 * Create a version group from two entries that would otherwise be merged.
 * Instead of archiving the weaker one, both get tagged with the same group.
 *
 * ⚠️ 2026-08-14 起 consolidation-engine 3a 不再走本函数（改走 computeVersionGroupPatch
 * + patchMetadataBatch，每 cluster 一次 commit）。本函数保留原签名原行为（逐条 update，
 * 每次调用 2 个 commit），唯一剩余调用方是 llm-consolidation.ts:executeMergeDecisions ——
 * 该路径的调用链（auto-consolidation.ts）生产零 import 且被 RECALLNEST_LLM_CONSOLIDATION
 * flag 关闭，是不可达死代码；其调用循环里还留着与 Bug-1 同族的 stale-canonical 问题
 * （多 member 时每次从旧内存串判组）。**有意不修不批量化**：给不可达路径补测试无收益。
 * 若 auto-consolidation 被接回生产路径，先修那个循环再上线（见 2026-08-14 dream 根治
 * 方案 plan.md D 节否决项）。
 *
 * @param store      Memory store
 * @param canonical  The stronger entry (higher canonicalScore)
 * @param member     The weaker entry
 * @param scope      Scope filter for updates
 * @returns The version_group ID
 */
export async function createVersionGroup(
  store: Pick<MemoryStorePort, "update">,
  canonical: MemoryEntry,
  member: MemoryEntry,
  scope: string,
): Promise<string> {
  // Check if canonical already has a version_group
  const canonMeta = parseMetadata(canonical.metadata);
  const existingGroup = typeof canonMeta.version_group === "string" ? canonMeta.version_group : null;
  const groupId = existingGroup ?? generateGroupId();
  const now = new Date().toISOString();

  // Update canonical
  const canonRank = computeVersionRank(canonical);
  canonMeta.version_group = groupId;
  canonMeta.version_rank = canonRank;
  if (!canonMeta.version_created) canonMeta.version_created = now;
  await store.update(canonical.id, { metadata: JSON.stringify(canonMeta) }, [scope]);

  // Update member
  const memberMeta = parseMetadata(member.metadata);
  const memberRank = computeVersionRank(member);
  memberMeta.version_group = groupId;
  memberMeta.version_rank = memberRank;
  memberMeta.version_created = now;
  await store.update(member.id, { metadata: JSON.stringify(memberMeta) }, [scope]);

  logInfo(
    `[INFO] Version group ${groupId.slice(0, 8)}: ` +
    `${canonical.id.slice(0, 8)} (rank=${canonRank.toFixed(2)}) + ` +
    `${member.id.slice(0, 8)} (rank=${memberRank.toFixed(2)})`,
  );

  return groupId;
}

/** 3a 批量路径的 groupId 决策：canonical 已有组沿用，否则新生成（cluster 级一次）。 */
export function resolveGroupId(canonical: MemoryEntry): string {
  const canonMeta = parseMetadata(canonical.metadata);
  const existing = typeof canonMeta.version_group === "string" ? canonMeta.version_group : null;
  return existing ?? generateGroupId();
}

/**
 * Compute version rank for an entry.
 * Formula: (0.5 * importance + 0.5 * confidence) × (1 + log1p(accessCount))
 * Combines both importance (from extraction) and confidence (from user feedback)
 * with access frequency to determine which version wins.
 * Higher = preferred for retrieval.
 */
export function computeVersionRank(entry: MemoryEntry): number {
  const meta = parseMetadata(entry.metadata);
  const confidence = typeof meta.confidence === "number" ? meta.confidence : 0.7;
  const accessCount = typeof meta.accessCount === "number" ? meta.accessCount : 0;
  const importance = typeof entry.importance === "number" ? entry.importance : 0.5;
  const quality = 0.5 * importance + 0.5 * confidence;
  return quality * (1 + Math.log1p(accessCount));
}

/**
 * Deduplicate retrieval results by version group.
 * For each version_group, keep only the entry with the highest version_rank.
 * Entries without a version_group pass through unchanged.
 *
 * @param results  Array of retrieval results (must have entry.metadata)
 * @returns Filtered array with at most one entry per version group
 */
export function deduplicateByVersionGroup<T extends { entry: MemoryEntry; score: number }>(
  results: T[],
): T[] {
  // First pass: find the best entry per version group
  const groupBest = new Map<string, T>();

  for (const r of results) {
    const meta = parseMetadata(r.entry.metadata);
    const group = typeof meta.version_group === "string" ? meta.version_group : null;
    if (!group) continue;

    const existing = groupBest.get(group);
    if (!existing) {
      groupBest.set(group, r);
    } else {
      const existingRank = getVersionRank(existing.entry);
      const newRank = getVersionRank(r.entry);
      if (newRank > existingRank) {
        groupBest.set(group, r);
      }
    }
  }

  // Second pass: emit results preserving order, replacing groups with their winner
  const groupWinnerIds = new Set([...groupBest.values()].map(r => r.entry.id));
  const seenGroups = new Set<string>();
  const output: T[] = [];

  for (const r of results) {
    const meta = parseMetadata(r.entry.metadata);
    const group = typeof meta.version_group === "string" ? meta.version_group : null;

    if (!group) {
      // No version group → pass through
      output.push(r);
    } else if (!seenGroups.has(group) && groupWinnerIds.has(r.entry.id)) {
      // First appearance of this group's winner
      output.push(r);
      seenGroups.add(group);
    }
    // Skip non-winners and duplicate group appearances
  }

  return output;
}

// ============================================================================
// Helpers
// ============================================================================

function getVersionRank(entry: MemoryEntry): number {
  const meta = parseMetadata(entry.metadata);
  return typeof meta.version_rank === "number" ? meta.version_rank : computeVersionRank(entry);
}

function parseMetadata(raw?: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function generateGroupId(): string {
  // Simple UUID v4-like (no crypto needed for grouping)
  const hex = () => Math.random().toString(16).slice(2, 6);
  return `vg-${hex()}${hex()}`;
}
