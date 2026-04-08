/**
 * Memory Lint Engine — Content Quality Checker
 *
 * A read-only quality checker for memory content. Separate from data-checkup.ts
 * which checks infrastructure integrity (vector dims, tier distribution, etc.),
 * Memory Lint checks *content* quality:
 *
 * 1. Contradictions — memories that say opposite things about the same topic
 * 2. Duplicates — near-identical memories by vector cosine similarity
 * 3. Stale — memories never or rarely accessed and old enough to review
 * 4. Orphans — memories with missing scope or broken consolidation links
 *
 * Produces a health score (0-100) and a human-readable report.
 */

import type { MemoryEntry, MemoryStore } from "./store.js";
import { cosineSimilarity } from "./multi-vector.js";
import { parseEvolution, isActiveMemory } from "./memory-evolution.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LintSeverity = "info" | "warning" | "error";

export interface LintFinding {
  check: string;     // e.g., "contradiction", "duplicate", "stale", "orphan"
  severity: LintSeverity;
  detail: string;
  memoryIds: string[];
}

export interface MemoryLintReport {
  findings: LintFinding[];
  healthScore: number;  // 0-100
  totalScanned: number;
  timestamp: string;
  summary: {
    contradictions: number;
    duplicates: number;
    staleMemories: number;
    orphans: number;
  };
}

export interface LintDeps {
  store: Pick<MemoryStore, "list">;
  scope?: string;
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum entries to compare per scope+category group (performance guard). */
const MAX_ENTRIES_PER_GROUP = 100;

/** Cosine similarity threshold for duplicate detection. */
const DUPLICATE_THRESHOLD = 0.92;

/**
 * Minimum vector similarity to even consider two entries as potential contradictions.
 * Real contradictions are about the SAME topic but say opposite things,
 * so they should have moderate semantic similarity.
 */
const CONTRADICTION_SIMILARITY_FLOOR = 0.45;

/**
 * Categories where contradictions are meaningful.
 * Append-only categories (events, cases) naturally contain "opposite" entries
 * from different points in time — those are not contradictions.
 */
const CONTRADICTION_CATEGORIES = new Set(["profile", "preferences", "entities", "patterns"]);

/** Entries not accessed in this many days are candidates for staleness. */
const STALE_DAYS = 90;

const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Contradiction Detection (inline copy from consolidation-engine.ts)
// ---------------------------------------------------------------------------

/**
 * Heuristic contradiction detection between two memory texts.
 * Checks for negation patterns and requires at least one shared significant
 * term to reduce false positives.
 */
function detectContradiction(textA: string, textB: string): boolean {
  const a = textA.toLowerCase();
  const b = textB.toLowerCase();

  const negationPairs: [RegExp, RegExp][] = [
    [/\bnot\b/, /\b(?:always|must|should|is|are|was|were)\b/],
    [/\bnever\b/, /\b(?:always|every|each)\b/],
    [/\bdisable/, /\benable/],
    [/不要|不用|别/, /必须|一定|总是/],
    [/从不/, /每次|总是|一直/],
  ];

  for (const [negRe, posRe] of negationPairs) {
    if ((negRe.test(a) && posRe.test(b)) || (negRe.test(b) && posRe.test(a))) {
      // Require at least one shared significant term to reduce false positives
      const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 3));
      const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 3));
      for (const w of wordsA) {
        if (wordsB.has(w)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate text for display in findings. */
function truncate(text: string, maxLen = 60): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Group entries by scope + category key.
 * Within each group, sort by importance descending and cap at MAX_ENTRIES_PER_GROUP.
 */
function groupEntries(entries: MemoryEntry[]): Map<string, MemoryEntry[]> {
  const groups = new Map<string, MemoryEntry[]>();

  for (const entry of entries) {
    const key = `${entry.scope ?? ""}::${entry.category}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  // Sort each group by importance descending, cap at limit
  for (const [key, group] of groups) {
    group.sort((a, b) => b.importance - a.importance);
    if (group.length > MAX_ENTRIES_PER_GROUP) {
      groups.set(key, group.slice(0, MAX_ENTRIES_PER_GROUP));
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Check 1: Contradictions
// ---------------------------------------------------------------------------

function findContradictions(entries: MemoryEntry[]): LintFinding[] {
  const findings: LintFinding[] = [];

  // Only check merge-type categories where contradictions are meaningful
  const eligible = entries.filter(e => CONTRADICTION_CATEGORIES.has(e.category));
  const groups = groupEntries(eligible);

  for (const [, group] of groups) {
    if (group.length < 2) continue;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        // Pre-filter: entries must be about the same topic (moderate vector similarity)
        const sim = cosineSimilarity(group[i].vector, group[j].vector);
        if (sim < CONTRADICTION_SIMILARITY_FLOOR) continue;

        if (detectContradiction(group[i].text, group[j].text)) {
          findings.push({
            check: "contradiction",
            severity: "warning",
            detail: `"${truncate(group[i].text)}" vs "${truncate(group[j].text)}"`,
            memoryIds: [group[i].id, group[j].id],
          });
        }
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Check 2: Duplicates
// ---------------------------------------------------------------------------

function findDuplicates(entries: MemoryEntry[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const groups = groupEntries(entries);

  for (const [, group] of groups) {
    if (group.length < 2) continue;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const sim = cosineSimilarity(group[i].vector, group[j].vector);
        if (sim >= DUPLICATE_THRESHOLD) {
          findings.push({
            check: "duplicate",
            severity: "warning",
            detail: `"${truncate(group[i].text)}" -- ${(sim * 100).toFixed(1)}% similar [${truncate(group[j].text)}]`,
            memoryIds: [group[i].id, group[j].id],
          });
        }
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Check 3: Stale Memories
// ---------------------------------------------------------------------------

function findStaleMemories(entries: MemoryEntry[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const now = Date.now();

  for (const entry of entries) {
    const evo = parseEvolution(entry.metadata, entry.timestamp);

    // Stale = entry itself is old enough AND (lastAccessedAt is null or > 90 days ago) AND accessCount <= 1
    const entryAge = now - entry.timestamp;
    if (entryAge < STALE_MS) continue; // too new to be considered stale

    const lastAccess = evo.lastAccessedAt;
    const isOldAccess = lastAccess === null || (now - lastAccess > STALE_MS);

    if (isOldAccess && evo.accessCount <= 1) {
      const ageDays = Math.floor((now - entry.timestamp) / (24 * 60 * 60 * 1000));
      findings.push({
        check: "stale",
        severity: "info",
        detail: `${ageDays}d old, ${evo.accessCount} access(es): "${truncate(entry.text, 50)}"`,
        memoryIds: [entry.id],
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Check 4: Orphans
// ---------------------------------------------------------------------------

function findOrphans(entries: MemoryEntry[]): LintFinding[] {
  const findings: LintFinding[] = [];

  // Build set of all loaded IDs for consolidation link checking
  const allIds = new Set(entries.map(e => e.id));

  for (const entry of entries) {
    // Missing or schema scope
    if (!entry.scope || entry.scope.trim() === "" || entry.scope === "__schema__") {
      findings.push({
        check: "orphan",
        severity: "info",
        detail: `Missing/empty scope: "${truncate(entry.text, 50)}"`,
        memoryIds: [entry.id],
      });
      continue;
    }

    // Broken consolidation link
    const evo = parseEvolution(entry.metadata, entry.timestamp);
    if (evo.consolidatedInto && !allIds.has(evo.consolidatedInto)) {
      findings.push({
        check: "orphan",
        severity: "warning",
        detail: `Broken consolidation link -> ${evo.consolidatedInto.slice(0, 12)}...: "${truncate(entry.text, 40)}"`,
        memoryIds: [entry.id],
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Health Score
// ---------------------------------------------------------------------------

/**
 * Compute a 0-100 health score from finding counts.
 *
 * Weights:
 * - Contradictions: -10 each (most dangerous, conflicting guidance)
 * - Duplicates: -5 each (waste and confusion risk)
 * - Stale: -0.5 each (minor, many are expected)
 * - Orphans: -3 each (moderate, broken references)
 */
export function computeHealthScore(
  summary: MemoryLintReport["summary"],
  _total: number,
): number {
  const penalty =
    summary.contradictions * 10 +
    summary.duplicates * 5 +
    Math.floor(summary.staleMemories * 0.5) +
    summary.orphans * 3;

  return Math.max(0, Math.min(100, 100 - penalty));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run all memory lint checks and produce a report.
 *
 * @param deps.store - Memory store (only `list` is needed)
 * @param deps.scope - Optional scope filter; undefined = all scopes
 * @param deps.verbose - Reserved for future use
 */
export async function runMemoryLint(deps: LintDeps): Promise<MemoryLintReport> {
  const scopeFilter = deps.scope ? [deps.scope] : undefined;
  const allEntries = await deps.store.list(scopeFilter, undefined, 10000, 0);

  // Filter to active entries only
  const entries = allEntries.filter(e => isActiveMemory(e.metadata));

  // Run all checks
  const contradictions = findContradictions(entries);
  const duplicates = findDuplicates(entries);
  const stale = findStaleMemories(entries);
  const orphans = findOrphans(entries);

  const findings = [...contradictions, ...duplicates, ...stale, ...orphans];

  const summary = {
    contradictions: contradictions.length,
    duplicates: duplicates.length,
    staleMemories: stale.length,
    orphans: orphans.length,
  };

  return {
    findings,
    healthScore: computeHealthScore(summary, entries.length),
    totalScanned: entries.length,
    timestamp: new Date().toISOString(),
    summary,
  };
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/** Format a lint report as human-readable text. */
export function formatMemoryLintReport(report: MemoryLintReport): string {
  const lines: string[] = [];

  // All clear case
  if (report.findings.length === 0) {
    lines.push("Memory Lint: All Clear!");
    lines.push(`Scanned: ${report.totalScanned} active memories`);
    lines.push(`Health Score: ${report.healthScore}/100`);
    return lines.join("\n");
  }

  // Header
  lines.push(`Memory Lint Report (${report.timestamp})`);
  lines.push("=".repeat(44));
  lines.push(`Scanned: ${report.totalScanned} active memories`);
  lines.push("");

  // Contradictions
  if (report.summary.contradictions > 0) {
    const items = report.findings.filter(f => f.check === "contradiction");
    lines.push(`Contradictions (${items.length}):`);
    for (const f of items) {
      lines.push(`  - ${f.detail} [${f.memoryIds.map(id => id.slice(0, 8)).join(", ")}]`);
    }
    lines.push("");
  }

  // Duplicates
  if (report.summary.duplicates > 0) {
    const items = report.findings.filter(f => f.check === "duplicate");
    lines.push(`Duplicates (${items.length}):`);
    for (const f of items) {
      lines.push(`  - ${f.detail} [${f.memoryIds.map(id => id.slice(0, 8)).join(", ")}]`);
    }
    lines.push("");
  }

  // Stale
  if (report.summary.staleMemories > 0) {
    const items = report.findings.filter(f => f.check === "stale");
    lines.push(`Stale (${items.length}):`);
    if (items.length <= 5) {
      for (const f of items) {
        lines.push(`  - ${f.detail}`);
      }
    } else {
      // Summarize when many
      lines.push(`  - ${items.length} memories not accessed in ${STALE_DAYS}+ days`);
    }
    lines.push("");
  }

  // Orphans
  if (report.summary.orphans > 0) {
    const items = report.findings.filter(f => f.check === "orphan");
    const missingScope = items.filter(f => f.severity === "info");
    const brokenLinks = items.filter(f => f.severity === "warning");

    lines.push(`Orphans (${items.length}):`);
    if (missingScope.length > 0) {
      lines.push(`  - ${missingScope.length} memor${missingScope.length === 1 ? "y" : "ies"} with missing scope`);
    }
    if (brokenLinks.length > 0) {
      for (const f of brokenLinks) {
        lines.push(`  - ${f.detail} [${f.memoryIds.map(id => id.slice(0, 8)).join(", ")}]`);
      }
    }
    lines.push("");
  }

  // Health score
  lines.push(`Health Score: ${report.healthScore}/100`);

  return lines.join("\n");
}
