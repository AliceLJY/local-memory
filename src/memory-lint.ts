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
 * 5. Weak lessons — workflow patterns lacking any action verbs (inspired by
 *    KarryViber/Orb memory-lint heuristic — a "lesson" should prescribe an
 *    action, not describe a phenomenon)
 *
 * Produces a health score (0-100) and a human-readable report.
 */

import type { MemoryEntry, MemoryStore } from "./store.js";
import { cosineSimilarity } from "./multi-vector.js";
import { parseEvolution, isActiveMemory } from "./memory-evolution.js";
import { deriveUsageStatus } from "./usage-tracker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LintSeverity = "info" | "warning" | "error";

export interface LintFinding {
  check: string;     // e.g., "contradiction", "duplicate", "stale", "orphan", "weakLesson"
  severity: LintSeverity;
  detail: string;
  memoryIds: string[];
}

export interface MemoryLintReport {
  findings: LintFinding[];
  healthScore: number;  // 0-100
  totalScanned: number;
  /** True if the scan hit the 10000-entry cap (older entries were not analyzed). */
  scanLimited: boolean;
  timestamp: string;
  summary: {
    contradictions: number;
    duplicates: number;
    staleMemories: number;
    orphans: number;
    weakLessons: number;
    /** P0 B-1: cold 记忆数(被反复 surface 却从未被引用)。 */
    coldMemories: number;
  };
}

export interface LintDeps {
  store: Pick<MemoryStore, "list" | "getVectors">;
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

/**
 * Categories where the action-verb lesson-quality heuristic applies.
 *
 * Workflow `patterns` are meant to be reusable "do it this way next time"
 * prescriptions. A pattern whose text contains no imperative/action verb is
 * usually too abstract for the agent to reuse and is flagged as a weak lesson.
 *
 * We intentionally do NOT apply this to `cases` (problem/solution pairs whose
 * text may be descriptive), `events` (append-only log), `profile`/`preferences`
 * (static facts), or `entities` (noun-centric).
 *
 * Inspired by KarryViber/Orb `lib/holographic/memory-lint.py`.
 */
const LESSON_CATEGORIES = new Set(["patterns"]);

/**
 * Regex matching action/imperative verbs used to judge whether a workflow
 * pattern is actionable. Bilingual: English word-bounded; Chinese substring
 * (CJK has no word boundaries).
 *
 * Intentionally wide — false-negatives here are benign (a weak-lesson flag is
 * an `info` hint, not an error). We only want to catch patterns that are pure
 * observations/descriptions with no prescriptive action at all.
 */
const ACTION_VERBS = /\b(check|verify|validate|ensure|use|avoid|implement|run|call|set|add|remove|update|refactor|test|document|commit|push|rollback|escalate|stop|retry|install|configure|create|delete|write|read|spawn|enable|disable|init|start|restart|launch|store|fetch|query|log|match|replace|generate|prefer|require|invoke|route|build|deploy|review|fix|parse|apply|assert|include|exclude|skip|catch|throw|wrap|mock|mount|import|export|inject|extract|prepend|append|return|raise|cache|clear|reset|refresh|merge|split|rename|move|copy|scan|patrol|trigger|schedule|observe|record|emit|publish|subscribe|notify|confirm|choose|select|filter|sort|group|reduce|map|forward|resolve|reject)\b|使用|避免|检查|验证|确认|添加|删除|修改|改为|回滚|停止|重试|安装|配置|运行|调用|启用|禁用|生成|初始化|启动|重启|存储|获取|查询|记录|匹配|替换|创建|写入|读取|强制|禁止|必须|应当|保留|抛出|捕获|重构|部署|审查|修复|解析|应用|断言|包含|排除|跳过|合并|拆分|重命名|移动|复制|刷新|重置|清理|缓存|注入|提取|追加|遍历|订阅|发布|通知|选择|筛选|排序|触发|观察/iu;

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
// Check 5: Weak Lessons (action-verb heuristic)
// ---------------------------------------------------------------------------

/**
 * Identify "weak lessons" — workflow `patterns` whose text contains no
 * imperative/action verb. Such entries are usually descriptive rather than
 * prescriptive, so the agent cannot act on them next time.
 *
 * Severity is `info` (not warning/error): this is a quality hint, not a bug.
 * Low penalty (see computeHealthScore) reflects that.
 *
 * Inspired by KarryViber/Orb `lib/holographic/memory-lint.py`.
 */
function findWeakLessons(entries: MemoryEntry[]): LintFinding[] {
  const findings: LintFinding[] = [];

  for (const entry of entries) {
    if (!LESSON_CATEGORIES.has(entry.category)) continue;

    // Empty/whitespace text is caught elsewhere; skip to avoid double-flagging.
    if (!entry.text || entry.text.trim() === "") continue;

    if (ACTION_VERBS.test(entry.text)) continue;

    findings.push({
      check: "weakLesson",
      severity: "info",
      detail: `Pattern without action verbs (too abstract to reuse): "${truncate(entry.text, 60)}"`,
      memoryIds: [entry.id],
    });
  }

  return findings;
}

/**
 * Check 6 (P0 B-1 观察): cold memories — 被反复 surface(accessCount ≥ 6)却
 * 从未被 reconstruction [src:ID] 引用的记忆,召回位污染信号。
 *
 * 聚合为单条 finding(cold 可能有几千条,逐条 finding 会淹没报告);
 * memoryIds 取 injection 最高的前 20 条供抽查。severity 永远是 info:
 * B-1 是纯观察阶段,降权/归档要等观察数据校准后的 B-2。
 */
function findColdMemories(entries: MemoryEntry[]): { findings: LintFinding[]; coldCount: number } {
  const cold: Array<{ id: string; injection: number }> = [];

  for (const entry of entries) {
    if (deriveUsageStatus(entry) !== "cold") continue;
    let injection = 0;
    try {
      const meta = JSON.parse(entry.metadata || "{}") as Record<string, unknown>;
      injection = typeof meta.accessCount === "number" ? meta.accessCount : 0;
    } catch { /* keep 0 */ }
    cold.push({ id: entry.id, injection });
  }

  if (cold.length === 0) return { findings: [], coldCount: 0 };

  const pct = entries.length > 0 ? ((cold.length / entries.length) * 100).toFixed(1) : "0";
  const topIds = cold
    .sort((a, b) => b.injection - a.injection)
    .slice(0, 20)
    .map(c => c.id);

  return {
    coldCount: cold.length,
    findings: [{
      check: "coldMemory",
      severity: "info",
      detail: `${cold.length} cold memories (${pct}% of scanned): repeatedly surfaced (accessCount >= 6) but never cited by reconstruction. Top-20 by injection in memoryIds. Observation only (B-1) — no action taken.`,
      memoryIds: topIds,
    }],
  };
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
 * - Weak lessons: -2 each (pattern lacks action verbs, reuse-unfriendly)
 * - Cold memories (P0 B-1): 按占比而非条数 — 超过 10% 的部分每个百分点 -1,
 *   封顶 -10。cold 是反复 surface 零引用的召回污染信号,量大但单条危害小,
 *   按条扣会瞬间扣穿。纯观察反馈,不触发任何动作。
 *
 * `weakLessons`/`coldMemories` are optional on the input type for backward
 * compatibility — callers constructing `summary` without them still get a
 * correct score.
 */
export function computeHealthScore(
  summary: {
    contradictions: number;
    duplicates: number;
    staleMemories: number;
    orphans: number;
    weakLessons?: number;
    coldMemories?: number;
  },
  total: number,
): number {
  const coldPct = total > 0 ? ((summary.coldMemories ?? 0) / total) * 100 : 0;
  const coldPenalty = Math.min(10, Math.max(0, Math.floor(coldPct - 10)));

  const penalty =
    summary.contradictions * 10 +
    summary.duplicates * 5 +
    Math.floor(summary.staleMemories * 0.5) +
    summary.orphans * 3 +
    (summary.weakLessons ?? 0) * 2 +
    coldPenalty;

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
  const SCAN_LIMIT = 10000;
  const allEntries = await deps.store.list(scopeFilter, undefined, SCAN_LIMIT, 0);
  const scanLimited = allEntries.length >= SCAN_LIMIT;

  // Filter to active entries only
  const activeEntries = allEntries.filter(e => isActiveMemory(e.metadata));

  // list() 为性能不返回向量(vector: []);矛盾/去重检查靠向量算相似度,否则恒为 0、
  // 静默失效并给出虚假 all-clear。补回真实向量再检查(stale/orphan/weakLesson 不依赖向量)。
  const vectorMap = await deps.store.getVectors(activeEntries.map(e => e.id));
  const entries = activeEntries.map(e => ({ ...e, vector: vectorMap.get(e.id) ?? [] }));

  // Run all checks
  const contradictions = findContradictions(entries);
  const duplicates = findDuplicates(entries);
  const stale = findStaleMemories(entries);
  const orphans = findOrphans(entries);
  const weakLessons = findWeakLessons(entries);
  const coldResult = findColdMemories(entries);

  const findings = [...contradictions, ...duplicates, ...stale, ...orphans, ...weakLessons, ...coldResult.findings];

  const summary = {
    contradictions: contradictions.length,
    duplicates: duplicates.length,
    staleMemories: stale.length,
    orphans: orphans.length,
    weakLessons: weakLessons.length,
    coldMemories: coldResult.coldCount,
  };

  return {
    findings,
    healthScore: computeHealthScore(summary, entries.length),
    totalScanned: entries.length,
    scanLimited,
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
    lines.push(`Scanned: ${report.totalScanned} active memories${report.scanLimited ? " (达扫描上限 10000，更早记忆未分析)" : ""}`);
    lines.push(`Health Score: ${report.healthScore}/100`);
    return lines.join("\n");
  }

  // Header
  lines.push(`Memory Lint Report (${report.timestamp})`);
  lines.push("=".repeat(44));
  lines.push(`Scanned: ${report.totalScanned} active memories${report.scanLimited ? " (达扫描上限 10000，更早记忆未分析)" : ""}`);
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

  // Weak Lessons
  if (report.summary.weakLessons > 0) {
    const items = report.findings.filter(f => f.check === "weakLesson");
    lines.push(`Weak Lessons (${items.length}):`);
    if (items.length <= 5) {
      for (const f of items) {
        lines.push(`  - ${f.detail} [${f.memoryIds.map(id => id.slice(0, 8)).join(", ")}]`);
      }
    } else {
      lines.push(`  - ${items.length} patterns without action verbs (consider rewriting or promoting)`);
    }
    lines.push("");
  }

  // Cold Memories (P0 B-1 observation)
  if (report.summary.coldMemories > 0) {
    const item = report.findings.find(f => f.check === "coldMemory");
    lines.push(`Cold Memories (${report.summary.coldMemories}):`);
    if (item) {
      lines.push(`  - ${item.detail}`);
      lines.push(`  - top by injection: ${item.memoryIds.map(id => id.slice(0, 8)).join(", ")}`);
    }
    lines.push("");
  }

  // Health score
  lines.push(`Health Score: ${report.healthScore}/100`);

  return lines.join("\n");
}
