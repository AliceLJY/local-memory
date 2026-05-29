/**
 * LC-P4: Data Checkup Engine
 *
 * Health checks for the memory database, inspired by lossless-claw's
 * IntegrityChecker. Pure read-only diagnostics — never modifies data.
 *
 * Checks:
 * 1. Vector dimension consistency
 * 2. Orphan memories (scope missing or empty)
 * 3. Tier distribution health
 * 4. Conflict backlog
 * 5. Version group integrity
 */

import type { MemoryEntry, MemoryStore } from "./store.js";
import { resolveTier, type MemoryTier } from "./decay-engine.js";
import { measureInterferenceDensity } from "./interference-detector.js";
import { readHeartbeats, checkSourceStaleness, formatAge } from "./source-heartbeat.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  status: "ok" | "warning" | "error";
  detail: string;
}

export interface CheckupReport {
  checks: CheckResult[];
  totalEntries: number;
  /** Total entries in store; when > totalEntries, only the most recent were scanned. */
  totalAvailable: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** Check 1: All vectors should have the same dimension. */
function checkVectorDimensions(entries: MemoryEntry[]): CheckResult {
  // 只对真正取到向量的条目判维度一致性;取不到向量的(dim=0)单独计数后跳过——
  // 否则会把"未补到向量"误报成"维度不一致",或把"全 0 维空向量"假报成健康。
  const dims = new Map<number, number>(); // dim → count
  let missingVectors = 0;
  for (const e of entries) {
    const d = e.vector?.length ?? 0;
    if (d === 0) { missingVectors++; continue; }
    dims.set(d, (dims.get(d) ?? 0) + 1);
  }

  const withVectors = entries.length - missingVectors;
  if (entries.length === 0) {
    return { name: "vector_dimensions", status: "ok", detail: "No entries to check" };
  }
  if (withVectors === 0) {
    return {
      name: "vector_dimensions",
      status: "warning",
      detail: `No retrievable vectors among ${entries.length} entries — dimension consistency not verified`,
    };
  }

  const suffix = missingVectors > 0 ? ` (${missingVectors} without retrievable vector, skipped)` : "";

  if (dims.size === 1) {
    const dim = dims.keys().next().value ?? 0;
    return { name: "vector_dimensions", status: "ok", detail: `All ${withVectors} vectors have dimension ${dim}${suffix}` };
  }

  const sorted = [...dims.entries()].sort((a, b) => b[1] - a[1]);
  const expected = sorted[0][0];
  const mismatched = sorted.slice(1).reduce((sum, [, c]) => sum + c, 0);
  return {
    name: "vector_dimensions",
    status: "error",
    detail: `${mismatched} entries have wrong dimension (expected ${expected}): ${sorted.map(([d, c]) => `dim=${d}: ${c}`).join(", ")}${suffix}`,
  };
}

/** Check 2: Memories with missing/empty scope. */
function checkOrphanMemories(entries: MemoryEntry[]): CheckResult {
  const orphans = entries.filter(e => !e.scope || e.scope.trim() === "" || e.scope === "__schema__");
  if (orphans.length === 0) {
    return { name: "orphan_memories", status: "ok", detail: "No orphan memories found" };
  }
  return {
    name: "orphan_memories",
    status: orphans.length > 10 ? "error" : "warning",
    detail: `${orphans.length} memories with missing/empty/schema scope (IDs: ${orphans.slice(0, 5).map(e => e.id.slice(0, 8)).join(", ")}${orphans.length > 5 ? "..." : ""})`,
  };
}

/** Check 3: Tier distribution — core should not exceed 500, peripheral should not exceed 70%. */
function checkTierDistribution(entries: MemoryEntry[]): CheckResult {
  const tierCounts: Record<MemoryTier, number> = { core: 0, working: 0, peripheral: 0 };
  for (const e of entries) {
    const tier = resolveTier(e.metadata);
    tierCounts[tier]++;
  }

  const total = entries.length;
  const issues: string[] = [];

  if (tierCounts.core > 500) {
    issues.push(`core tier has ${tierCounts.core} entries (max recommended: 500)`);
  }
  if (total >= 20 && tierCounts.peripheral / total > 0.7) {
    const pct = Math.round(tierCounts.peripheral / total * 100);
    issues.push(`peripheral tier is ${pct}% of total (recommended: ≤70%)`);
  }

  const dist = `core=${tierCounts.core}, working=${tierCounts.working}, peripheral=${tierCounts.peripheral}`;
  if (issues.length === 0) {
    return { name: "tier_distribution", status: "ok", detail: `Healthy distribution: ${dist}` };
  }
  return { name: "tier_distribution", status: "warning", detail: `${dist} — ${issues.join("; ")}` };
}

/** Check 4: Open conflict backlog. */
function checkConflictBacklog(openConflictCount: number): CheckResult {
  if (openConflictCount === 0) {
    return { name: "conflict_backlog", status: "ok", detail: "No open conflicts" };
  }
  const status = openConflictCount > 20 ? "error" : openConflictCount > 5 ? "warning" : "ok";
  return { name: "conflict_backlog", status, detail: `${openConflictCount} open conflicts` };
}

/** Check 5: Version group integrity — members should reference the same group ID. */
function checkVersionGroups(entries: MemoryEntry[]): CheckResult {
  const groups = new Map<string, { ids: string[]; ranks: number[] }>();

  for (const e of entries) {
    if (!e.metadata) continue;
    try {
      const meta = JSON.parse(e.metadata);
      const group = meta.version_group;
      if (typeof group !== "string") continue;
      if (!groups.has(group)) groups.set(group, { ids: [], ranks: [] });
      const g = groups.get(group)!;
      g.ids.push(e.id);
      g.ranks.push(typeof meta.version_rank === "number" ? meta.version_rank : -1);
    } catch { /* skip */ }
  }

  if (groups.size === 0) {
    return { name: "version_groups", status: "ok", detail: "No version groups found" };
  }

  const issues: string[] = [];
  for (const [groupId, { ids, ranks }] of groups) {
    // Single-member group is suspicious
    if (ids.length < 2) {
      issues.push(`group ${groupId.slice(0, 8)} has only ${ids.length} member`);
    }
    // Check for missing ranks
    const missingRanks = ranks.filter(r => r < 0).length;
    if (missingRanks > 0) {
      issues.push(`group ${groupId.slice(0, 8)} has ${missingRanks} members with missing rank`);
    }
  }

  if (issues.length === 0) {
    return { name: "version_groups", status: "ok", detail: `${groups.size} version groups, all healthy` };
  }
  return {
    name: "version_groups",
    status: issues.length > 3 ? "error" : "warning",
    detail: `${groups.size} groups, ${issues.length} issue(s): ${issues.slice(0, 3).join("; ")}${issues.length > 3 ? "..." : ""}`,
  };
}

/** Check 6 (GB-3): Source health — detect stale connector data sources. */
function checkSourceHealth(heartbeatPath?: string): CheckResult {
  const heartbeats = readHeartbeats(heartbeatPath);
  const sources = Object.values(heartbeats);
  if (sources.length === 0) {
    return { name: "source_health", status: "ok", detail: "No connector sources tracked yet" };
  }

  const stale30 = checkSourceStaleness(30, heartbeatPath);
  const stale7 = checkSourceStaleness(7, heartbeatPath);

  const summary = sources
    .map((s) => `${s.source}: ${formatAge(s.lastIngest)}`)
    .join(", ");

  if (stale30.length > 0) {
    const names = stale30.map((s) => `${s.source} (${s.daysSince}d)`).join(", ");
    return { name: "source_health", status: "error", detail: `${summary} — critically stale: ${names}` };
  }
  if (stale7.length > 0) {
    const names = stale7.map((s) => `${s.source} (${s.daysSince}d)`).join(", ");
    return { name: "source_health", status: "warning", detail: `${summary} — stale: ${names}` };
  }
  return { name: "source_health", status: "ok", detail: `All sources fresh: ${summary}` };
}

/** Check 7 (F2): Interference density — detect semantic clustering pressure. */
function checkInterferenceDensity(entries: MemoryEntry[]): CheckResult {
  // Only check entries with vectors (skip schema/empty entries)
  const withVectors = entries.filter(e => e.vector && e.vector.length > 0);
  if (withVectors.length < 10) {
    return { name: "interference_density", status: "ok", detail: "Too few entries for interference analysis" };
  }

  // Sample up to 200 entries for performance (interference detection is O(n²))
  const sample = withVectors.length > 200
    ? withVectors.sort(() => Math.random() - 0.5).slice(0, 200)
    : withVectors;

  const density = measureInterferenceDensity(sample);
  const issues: string[] = [];

  if (density.highRiskCount > sample.length * 0.2) {
    issues.push(`${density.highRiskCount} high-risk entries (>${Math.round(sample.length * 0.2)} threshold)`);
  }
  if (density.avgClusterSize > 5) {
    issues.push(`avg cluster size ${density.avgClusterSize.toFixed(1)} (recommended: ≤5)`);
  }

  const detail = `${density.clusterCount} clusters, avg size ${density.avgClusterSize.toFixed(1)}, ${density.highRiskCount} high-risk`;
  if (issues.length === 0) {
    return { name: "interference_density", status: "ok", detail: `Healthy: ${detail}` };
  }
  return {
    name: "interference_density",
    status: issues.length > 1 ? "error" : "warning",
    detail: `${detail} — ${issues.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface CheckupDeps {
  store: Pick<MemoryStore, "list" | "stats" | "getVectors">;
  openConflictCount: number;
  /** Optional override path for source-heartbeat.json (used in tests). */
  heartbeatPath?: string;
}

export async function runDataCheckup(deps: CheckupDeps): Promise<CheckupReport> {
  const SCAN_LIMIT = 10000;
  const listed = await deps.store.list(undefined, undefined, SCAN_LIMIT, 0);

  // list() 为性能不返回向量(vector: []);维度/干扰检查靠向量,否则把"全 0 维"
  // 误判成健康、干扰分析永远"样本不足"。补回真实向量再检查。
  const vectorMap = await deps.store.getVectors(listed.map(e => e.id));
  const entries = listed.map(e => ({ ...e, vector: vectorMap.get(e.id) ?? [] }));

  // 截断披露:库总量 > 已扫,说明只体检了最近 SCAN_LIMIT 条。
  const totalAvailable = (await deps.store.stats()).totalCount;

  return {
    checks: [
      checkVectorDimensions(entries),
      checkOrphanMemories(entries),
      checkTierDistribution(entries),
      checkConflictBacklog(deps.openConflictCount),
      checkVersionGroups(entries),
      checkSourceHealth(deps.heartbeatPath),
      checkInterferenceDensity(entries),
    ],
    totalEntries: entries.length,
    totalAvailable,
    timestamp: new Date().toISOString(),
  };
}

export function formatCheckupReport(report: CheckupReport): string {
  const truncationNote = report.totalAvailable > report.totalEntries
    ? ` (of ${report.totalAvailable} total — only the most recent ${report.totalEntries} analyzed)`
    : "";
  const lines = [
    `Data Checkup Report (${report.timestamp})`,
    `Total entries scanned: ${report.totalEntries}${truncationNote}`,
    "",
  ];

  for (const check of report.checks) {
    const icon = check.status === "ok" ? "[OK]" : check.status === "warning" ? "[WARN]" : "[ERR]";
    lines.push(`${icon} ${check.name}: ${check.detail}`);
  }

  const errorCount = report.checks.filter(c => c.status === "error").length;
  const warnCount = report.checks.filter(c => c.status === "warning").length;
  lines.push("");
  lines.push(`Summary: ${errorCount} error(s), ${warnCount} warning(s), ${report.checks.length - errorCount - warnCount} ok`);

  return lines.join("\n");
}
