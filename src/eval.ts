#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { metaDir } from "./compat.js";
import { buildSessionCheckpointRecord, normalizeCheckpointScope } from "./session-engine.js";
import type { ResumeContextResponse, SessionCheckpointRecord } from "./session-schema.js";
import { composeResumeContext } from "./context-composer.js";
import { cleanText } from "./context-composer-text.js";
import { createComponents, loadConfig, loadDotEnv, type LocalMemoryConfig } from "./runtime-config.js";
import { logInfo } from "./stderr-log.js";
import { buildWorkflowObservationRecord } from "./workflow-observation-engine.js";
import type { WorkflowObservationInput } from "./workflow-observation-schema.js";
import { WorkflowObservationStore } from "./workflow-observation-store.js";

export type ProfileName = "default" | "writing" | "debug" | "fact-check";
export type EvalMode = "retrieval" | "continuity" | "canary";

export interface RetrievalEvalCase {
  name: string;
  query: string;
  profile?: ProfileName;
  scope?: string;
  limit?: number;
  expectAny?: string[];
  expectAll?: string[];
  expectScopePrefixes?: string[];
  forbid?: string[];
  notes?: string;
}

export interface ContinuityEvalCase {
  name: string;
  task?: string;
  profile?: ProfileName;
  scope?: string;
  sessionId?: string;
  limitPerSection?: number;
  includeLatestCheckpoint?: boolean;
  checkpoint?: {
    sessionId?: string;
    scope?: string;
    summary: string;
    task?: string;
    decisions?: string[];
    openLoops?: string[];
    nextActions?: string[];
    entities?: string[];
    files?: string[];
    updatedAt?: string;
  };
  expectStableAny?: string[];
  expectStableAll?: string[];
  expectPatternsAny?: string[];
  expectCasesAny?: string[];
  expectCheckpointAny?: string[];
  forbid?: string[];
  notes?: string;
}

export interface CanaryEvalCase {
  name: string;
  query: string;
  profile?: ProfileName;
  scope?: string;
  limit?: number;
  /** A 类：该召回的 memory id（按 target id 算 rank） */
  targets?: string[];
  /** C 类：不该进 TopK 的干扰项 memory id */
  hardNegatives?: string[];
  /** 目标应进前几（默认 3） */
  expectTopK?: number;
  /** B 类新旧序：按此顺序排列，newer 在前，前者 rank 应小于后者 */
  expectOrder?: string[];
  /** D 类稳定偏好：召回文本命中任一要点即算对（不钉 id） */
  expectContentAny?: string[];
  /** 文本层禁词（沿用 retrieval 语义） */
  forbid?: string[];
  notes?: string;
}

export interface CanaryCaseReport {
  mode: "canary";
  name: string;
  query: string;
  profile: ProfileName;
  score: number;
  passed: boolean;
  hitCount: number;
  targetRanks: Array<{ id: string; rank: number | null }>;
  top1Hit: boolean;
  top3Hit: boolean;
  forbiddenIdMatches: string[];
  orderOk: boolean | null;
  matchedContentAny: string[];
  forbiddenMatches: string[];
  topIds: string[];
  topSnippet: string;
  notes?: string;
}

export interface RetrievalCaseReport {
  mode: "retrieval";
  name: string;
  query: string;
  profile: ProfileName;
  score: number;
  passed: boolean;
  hitCount: number;
  matchedAny: string[];
  matchedAll: string[];
  matchedScopes: string[];
  forbiddenMatches: string[];
  topScopes: string[];
  topSnippet: string;
  notes?: string;
}

export interface ContinuityCaseReport {
  mode: "continuity";
  name: string;
  task: string;
  profile: ProfileName;
  score: number;
  passed: boolean;
  stableCount: number;
  patternCount: number;
  caseCount: number;
  hasCheckpoint: boolean;
  matchedStableAny: string[];
  matchedStableAll: string[];
  matchedPatternsAny: string[];
  matchedCasesAny: string[];
  matchedCheckpointAny: string[];
  forbiddenMatches: string[];
  stablePreview: string[];
  patternPreview: string[];
  casePreview: string[];
  checkpointSummary: string;
  notes?: string;
}

type EvalReport = RetrievalCaseReport | ContinuityCaseReport | CanaryCaseReport;

interface EvalArgs {
  mode: EvalMode;
  casesPath?: string;
  outputPath?: string;
  jsonMode: boolean;
  recordObservations: boolean;
  observationScope?: string;
  observationSource?: string;
}

interface EvalCheckpointLookup {
  getLatest(query?: { sessionId?: string; scope?: string }): Promise<SessionCheckpointRecord | null>;
}

type EvalCaseComponents = Pick<ReturnType<typeof createComponents>, "retriever" | "accessTracker">;
type EvalComponentFactory = (profileName?: string) => EvalCaseComponents;

function createFreshEvalComponentsFactory(config: LocalMemoryConfig): EvalComponentFactory {
  return function createEvalComponentsForCase(profileName?: string) {
    const { retriever, accessTracker } = createComponents(config, profileName);
    return { retriever, accessTracker };
  };
}

export function buildContinuityEvalRequest(evalCase: ContinuityEvalCase) {
  return {
    task: evalCase.task,
    scope: evalCase.scope,
    sessionId: evalCase.sessionId || evalCase.checkpoint?.sessionId,
    profile: evalCase.profile,
    limitPerSection: evalCase.limitPerSection,
    includeLatestCheckpoint: evalCase.includeLatestCheckpoint,
  };
}

function parseArgs(args: string[]): EvalArgs {
  const outputIdx = args.indexOf("--output");
  const casesIdx = args.indexOf("--cases");
  const modeIdx = args.indexOf("--mode");
  const observationScopeIdx = args.indexOf("--observation-scope");
  const observationSourceIdx = args.indexOf("--observation-source");
  const modeRaw = modeIdx >= 0 ? args[modeIdx + 1] : "retrieval";
  const mode: EvalMode = modeRaw === "continuity" ? "continuity" : modeRaw === "canary" ? "canary" : "retrieval";

  return {
    mode,
    casesPath: casesIdx >= 0 ? args[casesIdx + 1] : undefined,
    outputPath: outputIdx >= 0 ? resolve(args[outputIdx + 1]) : undefined,
    jsonMode: args.includes("--json"),
    recordObservations: args.includes("--record-observations"),
    observationScope: observationScopeIdx >= 0 ? args[observationScopeIdx + 1] : undefined,
    observationSource: observationSourceIdx >= 0 ? args[observationSourceIdx + 1] : undefined,
  };
}

function defaultCasesPath(mode: EvalMode): string {
  if (mode === "continuity") return resolve(metaDir(import.meta), "../eval/continuity/cases.json");
  if (mode === "canary") return resolve(metaDir(import.meta), "../eval/cases-canary.json");
  return resolve(metaDir(import.meta), "../eval/cases.json");
}

function loadCases<T>(mode: EvalMode, pathArg?: string): T[] {
  const casesPath = pathArg ? resolve(pathArg) : defaultCasesPath(mode);
  return JSON.parse(readFileSync(casesPath, "utf-8")) as T[];
}

function clip(text: string, maxLen = 140): string {
  return cleanText(text, maxLen);
}

function matchedTerms(terms: string[] | undefined, haystack: string): string[] {
  return (terms || []).filter((term) => haystack.includes(term.toLowerCase()));
}

/**
 * 命中比例 × 权重。
 *
 * 调用方必须先滤掉 case 没声明的期望、再对剩下的权重重新归一化——下面三个
 * 评分器都是这么做的。空期望这里返回 0 而不是 weight：万一将来有第四个调用
 * 点忘了滤，代价是少给分而不是白送分。三个现有调用点都已滤过，所以这个分支
 * 当前走不到，纯属兜底。
 */
function scoreExpectation(expected: string[] | undefined, matched: string[], weight: number): number {
  if (!expected || expected.length === 0) return 0;
  return (matched.length / expected.length) * weight;
}

export function scoreRetrievalCase(
  evalCase: RetrievalEvalCase,
  results: Array<{ entry: { text: string; scope: string; metadata?: string } }>,
): RetrievalCaseReport {
  const profile = evalCase.profile || "default";
  const joined = results.map((r) => `${r.entry.scope}\n${r.entry.text}\n${r.entry.metadata || ""}`).join("\n").toLowerCase();
  const scopes = results.map((r) => r.entry.scope);
  const topSnippet = results[0] ? clip(results[0].entry.text) : "-";

  const matchedAny = matchedTerms(evalCase.expectAny, joined);
  const matchedAll = matchedTerms(evalCase.expectAll, joined);
  const matchedScopes = (evalCase.expectScopePrefixes || []).filter((scope) => scopes.some((item) => item.startsWith(scope)));
  const forbiddenMatches = matchedTerms(evalCase.forbid, joined);

  // 动态加权：只计 case 实际声明的维度，权重在这些维度间重新归一化——
  // 和下面 canary、continuity 两个评分器已有的写法一致。
  // 改之前未声明的维度按满权重计入，而 eval/cases.json 里 20 个 case 一个都没写
  // expectAll，于是每个 case 白拿 0.3：expectAny 四个词命中一个再加 scope 前缀命中，
  // 正好落在 0.7 及格线上。
  const expectationScores = [
    { expected: evalCase.expectAny, matched: matchedAny, weight: 0.4 },
    { expected: evalCase.expectAll, matched: matchedAll, weight: 0.3 },
    { expected: evalCase.expectScopePrefixes, matched: matchedScopes, weight: 0.2 },
  ].filter((item) => (item.expected || []).length > 0);

  const totalExpectedWeight = expectationScores.reduce((sum, item) => sum + item.weight, 0);
  const normalizedExpectationScore = totalExpectedWeight > 0
    ? expectationScores.reduce((sum, item) => sum + scoreExpectation(item.expected, item.matched, item.weight), 0) / totalExpectedWeight
    : 0;

  let score = normalizedExpectationScore * 0.9;
  if (results.length > 0) score += 0.1;
  if (forbiddenMatches.length > 0) score -= 0.3;
  score = Math.max(0, Math.min(1, score));

  return {
    mode: "retrieval",
    name: evalCase.name,
    query: evalCase.query,
    profile,
    score,
    passed: score >= 0.7 && forbiddenMatches.length === 0,
    hitCount: results.length,
    matchedAny,
    matchedAll,
    matchedScopes,
    forbiddenMatches,
    topScopes: scopes.slice(0, 5),
    topSnippet,
    notes: evalCase.notes,
  };
}

export function scoreCanaryCase(
  evalCase: CanaryEvalCase,
  results: Array<{ entry: { id: string; text: string; scope: string; metadata?: string } }>,
): CanaryCaseReport {
  const profile = evalCase.profile || "default";
  const ids = results.map((r) => r.entry.id);
  const topK = evalCase.expectTopK ?? 3;
  const limit = evalCase.limit ?? results.length;
  const joined = results
    .map((r) => `${r.entry.scope}\n${r.entry.text}\n${r.entry.metadata || ""}`)
    .join("\n")
    .toLowerCase();

  // memory id 用前缀匹配：targets/expectOrder/hardNegatives 常写 8 位短前缀，
  // 而召回结果的 entry.id 是完整 UUID（recallnest 惯例：≥8 hex 前缀即可定位）。
  const idMatches = (fullId: string, target: string): boolean =>
    fullId === target || fullId.startsWith(target);
  const rankOf = (target: string): number | null => {
    const idx = ids.findIndex((fullId) => idMatches(fullId, target));
    return idx === -1 ? null : idx + 1;
  };

  // A 类：单目标命中
  const targets = evalCase.targets || [];
  const targetRanks = targets.map((id) => ({ id, rank: rankOf(id) }));
  const top1Hit = targetRanks.some((t) => t.rank === 1);
  const top3Hit = targetRanks.some((t) => t.rank !== null && t.rank <= Math.min(3, topK));

  // C 类：干扰项进 TopK（limit 内）即违规（同样前缀匹配）
  const forbiddenIdMatches = (evalCase.hardNegatives || []).filter((neg) => {
    const rank = rankOf(neg);
    return rank !== null && rank <= limit;
  });

  // B 类：新旧序，前者须召回且 rank 小于后者
  let orderOk: boolean | null = null;
  const order = evalCase.expectOrder || [];
  if (order.length >= 2) {
    orderOk = true;
    for (let i = 0; i < order.length - 1; i += 1) {
      const a = rankOf(order[i]);
      const b = rankOf(order[i + 1]);
      if (a === null) {
        orderOk = false;
        break;
      }
      if (b !== null && a >= b) {
        orderOk = false;
        break;
      }
    }
  }

  // D 类：内容要点命中
  const matchedContentAny = matchedTerms(evalCase.expectContentAny, joined);

  // 文本禁词
  const forbiddenMatches = matchedTerms(evalCase.forbid, joined);

  // 动态加权：只计 case 实际声明的维度
  const parts: Array<{ weight: number; value: number }> = [];
  if (targets.length > 0) {
    const ranks = targetRanks.map((t) => t.rank).filter((r): r is number => r !== null);
    const bestRank = ranks.length > 0 ? Math.min(...ranks) : null;
    const targetScore = bestRank === null ? 0 : bestRank === 1 ? 1 : bestRank <= 3 ? 0.7 : 0.4;
    parts.push({ weight: 0.5, value: targetScore });
  }
  if (orderOk !== null) {
    parts.push({ weight: 0.2, value: orderOk ? 1 : 0 });
  }
  const contentAny = evalCase.expectContentAny || [];
  if (contentAny.length > 0) {
    parts.push({ weight: 0.3, value: matchedContentAny.length / contentAny.length });
  }
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  let score = totalWeight > 0
    ? parts.reduce((sum, p) => sum + p.weight * p.value, 0) / totalWeight
    : (results.length > 0 ? 0.5 : 0);
  if (forbiddenIdMatches.length > 0) score -= 0.3;
  if (forbiddenMatches.length > 0) score -= 0.3;
  score = Math.max(0, Math.min(1, score));

  return {
    mode: "canary",
    name: evalCase.name,
    query: evalCase.query,
    profile,
    score,
    passed: score >= 0.7 && forbiddenIdMatches.length === 0 && forbiddenMatches.length === 0,
    hitCount: results.length,
    targetRanks,
    top1Hit,
    top3Hit,
    forbiddenIdMatches,
    orderOk,
    matchedContentAny,
    forbiddenMatches,
    topIds: ids.slice(0, 5),
    topSnippet: results[0] ? clip(results[0].entry.text) : "-",
    notes: evalCase.notes,
  };
}

function joinResumeSections(response: ResumeContextResponse): string {
  return [
    response.summary,
    ...response.stableContext,
    ...response.relevantPatterns,
    ...response.recentCases,
    response.latestCheckpoint?.summary || "",
  ].join("\n").toLowerCase();
}

export function scoreContinuityCase(
  evalCase: ContinuityEvalCase,
  response: ResumeContextResponse,
): ContinuityCaseReport {
  const profile = evalCase.profile || "default";
  const stableJoined = response.stableContext.join("\n").toLowerCase();
  const patternJoined = response.relevantPatterns.join("\n").toLowerCase();
  const caseJoined = response.recentCases.join("\n").toLowerCase();
  const checkpointJoined = `${response.latestCheckpoint?.summary || ""}\n${response.summary}`.toLowerCase();
  const joined = joinResumeSections(response);

  const matchedStableAny = matchedTerms(evalCase.expectStableAny, stableJoined);
  const matchedStableAll = matchedTerms(evalCase.expectStableAll, stableJoined);
  const matchedPatternsAny = matchedTerms(evalCase.expectPatternsAny, patternJoined);
  const matchedCasesAny = matchedTerms(evalCase.expectCasesAny, caseJoined);
  const matchedCheckpointAny = matchedTerms(evalCase.expectCheckpointAny, checkpointJoined);
  const forbiddenMatches = matchedTerms(evalCase.forbid, joined);

  const expectationScores = [
    { expected: evalCase.expectStableAny, matched: matchedStableAny, weight: 0.35 },
    { expected: evalCase.expectStableAll, matched: matchedStableAll, weight: 0.25 },
    { expected: evalCase.expectPatternsAny, matched: matchedPatternsAny, weight: 0.15 },
    { expected: evalCase.expectCasesAny, matched: matchedCasesAny, weight: 0.15 },
    { expected: evalCase.expectCheckpointAny, matched: matchedCheckpointAny, weight: 0.1 },
  ].filter((item) => (item.expected || []).length > 0);

  const totalExpectedWeight = expectationScores.reduce((sum, item) => sum + item.weight, 0);
  const normalizedExpectationScore = totalExpectedWeight > 0
    ? expectationScores.reduce((sum, item) => sum + scoreExpectation(item.expected, item.matched, item.weight), 0) / totalExpectedWeight
    : 0.5;

  let score = normalizedExpectationScore * 0.9;
  if (response.stableContext.length > 0) score += 0.1;
  if (forbiddenMatches.length > 0) score -= 0.3;
  score = Math.max(0, Math.min(1, score));

  return {
    mode: "continuity",
    name: evalCase.name,
    task: evalCase.task || "",
    profile,
    score,
    passed: score >= 0.7 && forbiddenMatches.length === 0,
    stableCount: response.stableContext.length,
    patternCount: response.relevantPatterns.length,
    caseCount: response.recentCases.length,
    hasCheckpoint: Boolean(response.latestCheckpoint),
    matchedStableAny,
    matchedStableAll,
    matchedPatternsAny,
    matchedCasesAny,
    matchedCheckpointAny,
    forbiddenMatches,
    stablePreview: response.stableContext.slice(0, 3).map((item) => clip(item, 120)),
    patternPreview: response.relevantPatterns.slice(0, 3).map((item) => clip(item, 120)),
    casePreview: response.recentCases.slice(0, 3).map((item) => clip(item, 120)),
    checkpointSummary: response.latestCheckpoint ? clip(response.latestCheckpoint.summary, 160) : "-",
    notes: evalCase.notes,
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function missingExpectationLabels(evalCase: ContinuityEvalCase, report: ContinuityCaseReport): string[] {
  const missing: string[] = [];
  if ((evalCase.expectStableAny || []).length > report.matchedStableAny.length) missing.push("stable");
  if ((evalCase.expectStableAll || []).length > report.matchedStableAll.length) missing.push("stable-all");
  if ((evalCase.expectPatternsAny || []).length > report.matchedPatternsAny.length) missing.push("patterns");
  if ((evalCase.expectCasesAny || []).length > report.matchedCasesAny.length) missing.push("cases");
  if ((evalCase.expectCheckpointAny || []).length > report.matchedCheckpointAny.length) missing.push("checkpoint");
  return missing;
}

export function buildContinuityEvalObservationInput(
  evalCase: ContinuityEvalCase,
  report: ContinuityCaseReport,
  options: { scope?: string; source?: string } = {},
): WorkflowObservationInput {
  const missingLabels = missingExpectationLabels(evalCase, report);
  const signal = report.passed
    ? "eval-pass"
    : report.forbiddenMatches.length > 0
      ? "forbidden-match"
      : missingLabels[0]
        ? `missing-${missingLabels[0]}`
        : "low-continuity-score";

  const summary = report.passed
    ? `Continuity eval case ${evalCase.name} passed at ${formatPercent(report.score)}.`
    : `Continuity eval case ${evalCase.name} failed at ${formatPercent(report.score)}${missingLabels.length > 0 ? ` (${missingLabels.join(", ")})` : ""}.`;

  return {
    workflowId: "resume_context",
    outcome: report.passed ? "success" : "failure",
    summary,
    scope: options.scope || evalCase.scope || "eval:continuity",
    source: options.source || "eval",
    signal,
    task: `continuity eval: ${evalCase.name}`,
    tags: [
      "continuity-eval",
      evalCase.profile || "default",
      report.passed ? "pass" : "fail",
    ],
    tools: ["resume_context"],
  };
}

function summarizeReports(reports: EvalReport[]): { passed: number; average: number } {
  const passed = reports.filter((item) => item.passed).length;
  const average = reports.reduce((sum, item) => sum + item.score, 0) / Math.max(reports.length, 1);
  return { passed, average };
}

function sortNewestFirst(records: SessionCheckpointRecord[]): SessionCheckpointRecord[] {
  return [...records].sort((a, b) => {
    const timeDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (timeDiff !== 0) return timeDiff;
    return b.checkpointId.localeCompare(a.checkpointId);
  });
}

function buildEvalCheckpointRecord(
  evalCase: ContinuityEvalCase,
  index: number,
): SessionCheckpointRecord | null {
  if (!evalCase.checkpoint) return null;

  const fallbackSessionId = evalCase.sessionId || `eval-${evalCase.name}-${index + 1}`;
  const record = buildSessionCheckpointRecord({
    sessionId: evalCase.checkpoint.sessionId || fallbackSessionId,
    scope: evalCase.checkpoint.scope || evalCase.scope,
    summary: evalCase.checkpoint.summary,
    task: evalCase.checkpoint.task,
    decisions: evalCase.checkpoint.decisions || [],
    openLoops: evalCase.checkpoint.openLoops || [],
    nextActions: evalCase.checkpoint.nextActions || [],
    entities: evalCase.checkpoint.entities || [],
    files: evalCase.checkpoint.files || [],
    updatedAt: evalCase.checkpoint.updatedAt || "2026-03-16T00:00:00.000Z",
  });
  return record;
}

export function createContinuityEvalCheckpointStore(
  cases: ContinuityEvalCase[],
): EvalCheckpointLookup {
  const records = cases
    .map((evalCase, index) => buildEvalCheckpointRecord(evalCase, index))
    .filter((record): record is SessionCheckpointRecord => Boolean(record));

  return {
    async getLatest(query = {}) {
      const normalizedQueryScope = query.scope ? normalizeCheckpointScope(query.scope) : undefined;
      const filtered = records.filter((record) => {
        if (query.sessionId && record.sessionId !== query.sessionId) return false;
        if (normalizedQueryScope && normalizeCheckpointScope(record.resolvedScope ?? "") !== normalizedQueryScope) return false;
        return true;
      });
      const [latest] = sortNewestFirst(filtered);
      return latest || null;
    },
  };
}

function markdownRetrievalReport(reports: RetrievalCaseReport[]): string {
  const { passed, average } = summarizeReports(reports);

  const lines = [
    "# RecallNest Retrieval Eval",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Cases: ${reports.length}`,
    `- Passed: ${passed}/${reports.length}`,
    `- Average score: ${formatPercent(average)}`,
    "",
    "| Case | Profile | Score | Pass | Hits | Top scopes |",
    "|------|---------|-------|------|------|------------|",
    ...reports.map((item) =>
      `| ${item.name} | ${item.profile} | ${(item.score * 100).toFixed(0)}% | ${item.passed ? "yes" : "no"} | ${item.hitCount} | ${item.topScopes.join(", ") || "-"} |`,
    ),
    "",
    "## Case Notes",
    "",
  ];

  for (const item of reports) {
    lines.push(`### ${item.name}`);
    lines.push(`- Query: ${item.query}`);
    lines.push(`- Score: ${(item.score * 100).toFixed(0)}%`);
    lines.push(`- Pass: ${item.passed ? "yes" : "no"}`);
    lines.push(`- Hits: ${item.hitCount}`);
    lines.push(`- Top scopes: ${item.topScopes.join(", ") || "-"}`);
    lines.push(`- Top snippet: ${item.topSnippet}`);
    lines.push(`- Matched any: ${item.matchedAny.join(", ") || "-"}`);
    lines.push(`- Matched all: ${item.matchedAll.join(", ") || "-"}`);
    lines.push(`- Matched scopes: ${item.matchedScopes.join(", ") || "-"}`);
    lines.push(`- Forbidden matches: ${item.forbiddenMatches.join(", ") || "-"}`);
    if (item.notes) lines.push(`- Notes: ${item.notes}`);
    lines.push("");
  }

  return lines.join("\n");
}

function markdownCanaryReport(reports: CanaryCaseReport[]): string {
  const { passed, average } = summarizeReports(reports);
  const top1 = reports.filter((r) => r.top1Hit).length;
  const top3 = reports.filter((r) => r.top3Hit).length;

  const lines = [
    "# RecallNest Canary Eval",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Cases: ${reports.length}`,
    `- Passed: ${passed}/${reports.length}`,
    `- Average score: ${formatPercent(average)}`,
    `- Top1 hit: ${top1}/${reports.length}`,
    `- Top3 hit: ${top3}/${reports.length}`,
    "",
    "| Case | Profile | Score | Pass | Top1 | Top3 | Order | Forbid |",
    "|------|---------|-------|------|------|------|-------|--------|",
    ...reports.map((item) =>
      `| ${item.name} | ${item.profile} | ${(item.score * 100).toFixed(0)}% | ${item.passed ? "yes" : "no"} | ${item.top1Hit ? "yes" : "-"} | ${item.top3Hit ? "yes" : "-"} | ${item.orderOk === null ? "-" : item.orderOk ? "ok" : "bad"} | ${item.forbiddenIdMatches.length + item.forbiddenMatches.length || "-"} |`,
    ),
    "",
    "## Case Notes",
    "",
  ];

  for (const item of reports) {
    lines.push(`### ${item.name}`);
    lines.push(`- Query: ${item.query}`);
    lines.push(`- Score: ${(item.score * 100).toFixed(0)}% (${item.passed ? "pass" : "fail"})`);
    lines.push(`- Target ranks: ${item.targetRanks.map((t) => `${t.id}=${t.rank ?? "miss"}`).join(", ") || "-"}`);
    lines.push(`- Top1 / Top3: ${item.top1Hit ? "yes" : "no"} / ${item.top3Hit ? "yes" : "no"}`);
    lines.push(`- Order ok: ${item.orderOk === null ? "n/a" : item.orderOk}`);
    lines.push(`- Matched content: ${item.matchedContentAny.join(", ") || "-"}`);
    lines.push(`- Forbidden id matches: ${item.forbiddenIdMatches.join(", ") || "-"}`);
    lines.push(`- Forbidden term matches: ${item.forbiddenMatches.join(", ") || "-"}`);
    lines.push(`- Top ids: ${item.topIds.join(", ") || "-"}`);
    lines.push(`- Top snippet: ${item.topSnippet}`);
    if (item.notes) lines.push(`- Notes: ${item.notes}`);
    lines.push("");
  }

  return lines.join("\n");
}

function markdownContinuityReport(reports: ContinuityCaseReport[]): string {
  const { passed, average } = summarizeReports(reports);

  const lines = [
    "# RecallNest Continuity Eval",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Cases: ${reports.length}`,
    `- Passed: ${passed}/${reports.length}`,
    `- Average score: ${formatPercent(average)}`,
    "",
    "| Case | Profile | Score | Pass | Stable | Patterns | Cases | Checkpoint |",
    "|------|---------|-------|------|--------|----------|-------|------------|",
    ...reports.map((item) =>
      `| ${item.name} | ${item.profile} | ${(item.score * 100).toFixed(0)}% | ${item.passed ? "yes" : "no"} | ${item.stableCount} | ${item.patternCount} | ${item.caseCount} | ${item.hasCheckpoint ? "yes" : "no"} |`,
    ),
    "",
    "## Case Notes",
    "",
  ];

  for (const item of reports) {
    lines.push(`### ${item.name}`);
    lines.push(`- Task: ${item.task || "-"}`);
    lines.push(`- Score: ${(item.score * 100).toFixed(0)}%`);
    lines.push(`- Pass: ${item.passed ? "yes" : "no"}`);
    lines.push(`- Stable items: ${item.stableCount}`);
    lines.push(`- Pattern items: ${item.patternCount}`);
    lines.push(`- Case items: ${item.caseCount}`);
    lines.push(`- Checkpoint present: ${item.hasCheckpoint ? "yes" : "no"}`);
    lines.push(`- Stable preview: ${item.stablePreview.join(" | ") || "-"}`);
    lines.push(`- Pattern preview: ${item.patternPreview.join(" | ") || "-"}`);
    lines.push(`- Case preview: ${item.casePreview.join(" | ") || "-"}`);
    lines.push(`- Checkpoint summary: ${item.checkpointSummary}`);
    lines.push(`- Matched stable any: ${item.matchedStableAny.join(", ") || "-"}`);
    lines.push(`- Matched stable all: ${item.matchedStableAll.join(", ") || "-"}`);
    lines.push(`- Matched patterns any: ${item.matchedPatternsAny.join(", ") || "-"}`);
    lines.push(`- Matched cases any: ${item.matchedCasesAny.join(", ") || "-"}`);
    lines.push(`- Matched checkpoint any: ${item.matchedCheckpointAny.join(", ") || "-"}`);
    lines.push(`- Forbidden matches: ${item.forbiddenMatches.join(", ") || "-"}`);
    if (item.notes) lines.push(`- Notes: ${item.notes}`);
    lines.push("");
  }

  return lines.join("\n");
}

export async function runRetrievalEval(
  cases: RetrievalEvalCase[],
  deps: {
    createEvalComponents?: EvalComponentFactory;
  } = {},
): Promise<RetrievalCaseReport[]> {
  const config = deps.createEvalComponents ? null : loadConfig();
  const createEvalComponentsForCase = deps.createEvalComponents || createFreshEvalComponentsFactory(config!);
  const reports: RetrievalCaseReport[] = [];

  for (const [index, evalCase] of cases.entries()) {
    if (cases.length > 1) {
      logInfo(`[INFO] retrieval-eval ${index + 1}/${cases.length}: ${evalCase.name}`);
    }
    const profileName = evalCase.profile || "default";
    const { retriever, accessTracker } = createEvalComponentsForCase(profileName);
    try {
      const results = await retriever.retrieve({
        query: evalCase.query,
        limit: evalCase.limit || 5,
        scopeFilter: evalCase.scope ? [evalCase.scope] : undefined,
        source: "auto-recall",
      });
      const report = scoreRetrievalCase(evalCase, results);
      reports.push(report);
      if (cases.length > 1) {
        logInfo(
          `[INFO] retrieval-eval ${index + 1}/${cases.length} done: ${evalCase.name} ${formatPercent(report.score)} ${report.passed ? "pass" : "fail"}`,
        );
      }
    } finally {
      accessTracker.destroy();
    }
  }

  return reports;
}

export async function runCanaryEval(
  cases: CanaryEvalCase[],
  deps: {
    createEvalComponents?: EvalComponentFactory;
  } = {},
): Promise<CanaryCaseReport[]> {
  const config = deps.createEvalComponents ? null : loadConfig();
  const createEvalComponentsForCase = deps.createEvalComponents || createFreshEvalComponentsFactory(config!);
  const reports: CanaryCaseReport[] = [];

  for (const [index, evalCase] of cases.entries()) {
    if (cases.length > 1) {
      logInfo(`[INFO] canary-eval ${index + 1}/${cases.length}: ${evalCase.name}`);
    }
    const profileName = evalCase.profile || "default";
    const { retriever, accessTracker } = createEvalComponentsForCase(profileName);
    try {
      const results = await retriever.retrieve({
        query: evalCase.query,
        limit: evalCase.limit || 8,
        scopeFilter: evalCase.scope ? [evalCase.scope] : undefined,
        source: "auto-recall",
      });
      const report = scoreCanaryCase(evalCase, results);
      reports.push(report);
      if (cases.length > 1) {
        logInfo(
          `[INFO] canary-eval ${index + 1}/${cases.length} done: ${evalCase.name} ${formatPercent(report.score)} ${report.passed ? "pass" : "fail"}`,
        );
      }
    } finally {
      accessTracker.destroy();
    }
  }

  return reports;
}

export async function runContinuityEval(
  cases: ContinuityEvalCase[],
  options: { recordObservations?: boolean; observationScope?: string; observationSource?: string } = {},
  deps: {
    createEvalComponents?: EvalComponentFactory;
    checkpointStore?: EvalCheckpointLookup;
    observationStore?: WorkflowObservationStore | null;
    composeResumeContextFn?: typeof composeResumeContext;
  } = {},
): Promise<ContinuityCaseReport[]> {
  const config = deps.createEvalComponents ? null : loadConfig();
  const createEvalComponentsForCase = deps.createEvalComponents || createFreshEvalComponentsFactory(config!);
  const checkpointStore = deps.checkpointStore || createContinuityEvalCheckpointStore(cases);
  const observationStore = deps.observationStore === undefined
    ? (options.recordObservations ? new WorkflowObservationStore() : null)
    : deps.observationStore;
  const composeResumeContextFn = deps.composeResumeContextFn || composeResumeContext;
  const reports: ContinuityCaseReport[] = [];

  for (const [index, evalCase] of cases.entries()) {
    if (cases.length > 1) {
      logInfo(`[INFO] continuity-eval ${index + 1}/${cases.length}: ${evalCase.name}`);
    }
    const profileName = evalCase.profile || "default";
    const { retriever, accessTracker } = createEvalComponentsForCase(profileName);
    try {
      const response = await composeResumeContextFn({
        retriever,
        checkpointStore,
      }, buildContinuityEvalRequest(evalCase));
      const report = scoreContinuityCase(evalCase, response);
      reports.push(report);
      if (cases.length > 1) {
        logInfo(
          `[INFO] continuity-eval ${index + 1}/${cases.length} done: ${evalCase.name} ${formatPercent(report.score)} ${report.passed ? "pass" : "fail"}`,
        );
      }
      if (observationStore) {
        await observationStore.save(buildWorkflowObservationRecord(
          buildContinuityEvalObservationInput(evalCase, report, {
            scope: options.observationScope,
            source: options.observationSource,
          }),
        ));
      }
    } finally {
      accessTracker.destroy();
    }
  }

  return reports;
}

function writeOutput(outputPath: string | undefined, text: string): void {
  if (!outputPath) return;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, text + "\n");
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "continuity") {
    const cases = loadCases<ContinuityEvalCase>("continuity", args.casesPath);
    const reports = await runContinuityEval(cases, {
      recordObservations: args.recordObservations,
      observationScope: args.observationScope,
      observationSource: args.observationSource,
    });
    if (args.jsonMode) {
      const payload = JSON.stringify({
        mode: "continuity",
        generatedAt: new Date().toISOString(),
        reports,
      }, null, 2);
      writeOutput(args.outputPath, payload);
      console.log(payload);
      return;
    }

    const output = markdownContinuityReport(reports);
    writeOutput(args.outputPath, output);
    console.log(output);
    return;
  }

  if (args.mode === "canary") {
    const cases = loadCases<CanaryEvalCase>("canary", args.casesPath);
    const reports = await runCanaryEval(cases);
    if (args.jsonMode) {
      const payload = JSON.stringify({
        mode: "canary",
        generatedAt: new Date().toISOString(),
        reports,
      }, null, 2);
      writeOutput(args.outputPath, payload);
      console.log(payload);
      return;
    }
    const output = markdownCanaryReport(reports);
    writeOutput(args.outputPath, output);
    console.log(output);
    return;
  }

  const cases = loadCases<RetrievalEvalCase>("retrieval", args.casesPath);
  const reports = await runRetrievalEval(cases);
  if (args.jsonMode) {
    const payload = JSON.stringify({
      mode: "retrieval",
      generatedAt: new Date().toISOString(),
      reports,
    }, null, 2);
    writeOutput(args.outputPath, payload);
    console.log(payload);
    return;
  }

  const output = markdownRetrievalReport(reports);
  writeOutput(args.outputPath, output);
  console.log(output);
}

if (import.meta.main) {
  await main();
}
