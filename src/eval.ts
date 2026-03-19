#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { buildSessionCheckpointRecord } from "./session-engine.js";
import type { ResumeContextResponse, SessionCheckpointRecord } from "./session-schema.js";
import { composeResumeContext } from "./context-composer.js";
import { cleanText } from "./context-composer-text.js";
import { createComponentResolver, loadConfig, loadDotEnv } from "./runtime-config.js";
import { logInfo } from "./stderr-log.js";
import { buildWorkflowObservationRecord } from "./workflow-observation-engine.js";
import type { WorkflowObservationInput } from "./workflow-observation-schema.js";
import { WorkflowObservationStore } from "./workflow-observation-store.js";

export type ProfileName = "default" | "writing" | "debug" | "fact-check";
export type EvalMode = "retrieval" | "continuity";

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

type EvalReport = RetrievalCaseReport | ContinuityCaseReport;

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
  const mode = modeRaw === "continuity" ? "continuity" : "retrieval";

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
  return mode === "continuity"
    ? resolve(import.meta.dir, "../eval/continuity/cases.json")
    : resolve(import.meta.dir, "../eval/cases.json");
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

function scoreExpectation(expected: string[] | undefined, matched: string[], weight: number): number {
  if (!expected || expected.length === 0) return weight;
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

  let score = 0;
  score += scoreExpectation(evalCase.expectAny, matchedAny, 0.4);
  score += scoreExpectation(evalCase.expectAll, matchedAll, 0.3);
  score += scoreExpectation(evalCase.expectScopePrefixes, matchedScopes, 0.2);
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
      const filtered = records.filter((record) => {
        if (query.sessionId && record.sessionId !== query.sessionId) return false;
        if (query.scope && record.resolvedScope !== query.scope) return false;
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

async function runRetrievalEval(
  cases: RetrievalEvalCase[],
): Promise<RetrievalCaseReport[]> {
  const config = loadConfig();
  const getComponents = createComponentResolver(config);
  const reports: RetrievalCaseReport[] = [];

  for (const [index, evalCase] of cases.entries()) {
    if (cases.length > 1) {
      logInfo(`[INFO] retrieval-eval ${index + 1}/${cases.length}: ${evalCase.name}`);
    }
    const profileName = evalCase.profile || "default";
    const { retriever } = getComponents(profileName);
    const results = await retriever.retrieve({
      query: evalCase.query,
      limit: evalCase.limit || 5,
      scopeFilter: evalCase.scope ? [evalCase.scope] : undefined,
    });
    const report = scoreRetrievalCase(evalCase, results);
    reports.push(report);
    if (cases.length > 1) {
      logInfo(
        `[INFO] retrieval-eval ${index + 1}/${cases.length} done: ${evalCase.name} ${formatPercent(report.score)} ${report.passed ? "pass" : "fail"}`,
      );
    }
  }

  return reports;
}

async function runContinuityEval(
  cases: ContinuityEvalCase[],
  options: { recordObservations?: boolean; observationScope?: string; observationSource?: string } = {},
): Promise<ContinuityCaseReport[]> {
  const config = loadConfig();
  const getComponents = createComponentResolver(config);
  const checkpointStore = createContinuityEvalCheckpointStore(cases);
  const observationStore = options.recordObservations ? new WorkflowObservationStore() : null;
  const reports: ContinuityCaseReport[] = [];

  for (const [index, evalCase] of cases.entries()) {
    if (cases.length > 1) {
      logInfo(`[INFO] continuity-eval ${index + 1}/${cases.length}: ${evalCase.name}`);
    }
    const profileName = evalCase.profile || "default";
    const { retriever } = getComponents(profileName);
    const response = await composeResumeContext({
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
