#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createComponentResolver, loadConfig, loadDotEnv } from "./runtime-config.js";

type ProfileName = "default" | "writing" | "debug" | "fact-check";

interface EvalCase {
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

interface CaseReport {
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

function loadCases(pathArg?: string): EvalCase[] {
  const casesPath = pathArg
    ? resolve(pathArg)
    : resolve(import.meta.dir, "../eval/cases.json");
  return JSON.parse(readFileSync(casesPath, "utf-8")) as EvalCase[];
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, maxLen = 140): string {
  const compact = cleanText(text);
  return compact.length <= maxLen ? compact : `${compact.slice(0, maxLen - 3)}...`;
}

function scoreCase(evalCase: EvalCase, results: Array<{ entry: { text: string; scope: string; metadata?: string } }>): CaseReport {
  const profile = evalCase.profile || "default";
  const joined = results.map((r) => `${r.entry.scope}\n${r.entry.text}\n${r.entry.metadata || ""}`).join("\n").toLowerCase();
  const scopes = results.map((r) => r.entry.scope);
  const topSnippet = results[0] ? clip(results[0].entry.text) : "-";

  const expectAny = evalCase.expectAny || [];
  const expectAll = evalCase.expectAll || [];
  const expectScopes = evalCase.expectScopePrefixes || [];
  const forbid = evalCase.forbid || [];

  const matchedAny = expectAny.filter((term) => joined.includes(term.toLowerCase()));
  const matchedAll = expectAll.filter((term) => joined.includes(term.toLowerCase()));
  const matchedScopes = expectScopes.filter((scope) => scopes.some((item) => item.startsWith(scope)));
  const forbiddenMatches = forbid.filter((term) => joined.includes(term.toLowerCase()));

  let score = 0;
  if (expectAny.length > 0) {
    score += (matchedAny.length / expectAny.length) * 0.4;
  } else {
    score += 0.4;
  }
  if (expectAll.length > 0) {
    score += (matchedAll.length / expectAll.length) * 0.3;
  } else {
    score += 0.3;
  }
  if (expectScopes.length > 0) {
    score += (matchedScopes.length / expectScopes.length) * 0.2;
  } else {
    score += 0.2;
  }
  if (results.length > 0) {
    score += 0.1;
  }
  if (forbiddenMatches.length > 0) {
    score -= 0.3;
  }

  score = Math.max(0, Math.min(1, score));

  return {
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

function markdownReport(reports: CaseReport[]): string {
  const passed = reports.filter((item) => item.passed).length;
  const average = reports.reduce((sum, item) => sum + item.score, 0) / Math.max(reports.length, 1);

  const lines = [
    "# RecallNest Eval Baseline",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Cases: ${reports.length}`,
    `- Passed: ${passed}/${reports.length}`,
    `- Average score: ${(average * 100).toFixed(1)}%`,
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

async function main() {
  loadDotEnv();
  const args = process.argv.slice(2);
  const outputIdx = args.indexOf("--output");
  const casesIdx = args.indexOf("--cases");
  const jsonMode = args.includes("--json");
  const outputPath = outputIdx >= 0 ? resolve(args[outputIdx + 1]) : "";
  const casesPath = casesIdx >= 0 ? args[casesIdx + 1] : undefined;

  const config = loadConfig();
  const getComponents = createComponentResolver(config);
  const cases = loadCases(casesPath);

  const reports: CaseReport[] = [];
  for (const evalCase of cases) {
    const profileName = evalCase.profile || "default";
    const { retriever } = getComponents(profileName);
    const results = await retriever.retrieve({
      query: evalCase.query,
      limit: evalCase.limit || 5,
      scopeFilter: evalCase.scope ? [evalCase.scope] : undefined,
    });
    reports.push(scoreCase(evalCase, results));
  }

  if (jsonMode) {
    const payload = {
      generatedAt: new Date().toISOString(),
      reports,
    };
    const text = JSON.stringify(payload, null, 2);
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, text + "\n");
    }
    console.log(text);
    return;
  }

  const output = markdownReport(reports);
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, output + "\n");
  }
  console.log(output);
}

function dirname(path: string): string {
  return path.replace(/\/[^/]+$/, "") || ".";
}

await main();
