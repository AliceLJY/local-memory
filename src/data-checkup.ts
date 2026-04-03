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
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** Check 1: All vectors should have the same dimension. */
function checkVectorDimensions(entries: MemoryEntry[]): CheckResult {
  const dims = new Map<number, number>(); // dim → count
  for (const e of entries) {
    const d = e.vector?.length ?? 0;
    dims.set(d, (dims.get(d) ?? 0) + 1);
  }

  if (dims.size <= 1) {
    const dim = dims.keys().next().value ?? 0;
    return { name: "vector_dimensions", status: "ok", detail: `All ${entries.length} entries have dimension ${dim}` };
  }

  const sorted = [...dims.entries()].sort((a, b) => b[1] - a[1]);
  const expected = sorted[0][0];
  const mismatched = sorted.slice(1).reduce((sum, [, c]) => sum + c, 0);
  return {
    name: "vector_dimensions",
    status: "error",
    detail: `${mismatched} entries have wrong dimension (expected ${expected}): ${sorted.map(([d, c]) => `dim=${d}: ${c}`).join(", ")}`,
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface CheckupDeps {
  store: Pick<MemoryStore, "list" | "stats">;
  openConflictCount: number;
}

export async function runDataCheckup(deps: CheckupDeps): Promise<CheckupReport> {
  const entries = await deps.store.list(undefined, undefined, 10000, 0);

  return {
    checks: [
      checkVectorDimensions(entries),
      checkOrphanMemories(entries),
      checkTierDistribution(entries),
      checkConflictBacklog(deps.openConflictCount),
      checkVersionGroups(entries),
    ],
    totalEntries: entries.length,
    timestamp: new Date().toISOString(),
  };
}

export function formatCheckupReport(report: CheckupReport): string {
  const lines = [
    `Data Checkup Report (${report.timestamp})`,
    `Total entries scanned: ${report.totalEntries}`,
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
