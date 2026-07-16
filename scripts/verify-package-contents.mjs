#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npmCommand,
  ["pack", "--dry-run", "--ignore-scripts", "--json"],
  { encoding: "utf8" },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || "npm pack failed\n");
  process.exit(result.status || 1);
}

let manifest;
try {
  const start = result.stdout.indexOf("[");
  const end = result.stdout.lastIndexOf("]");
  manifest = JSON.parse(result.stdout.slice(start, end + 1))[0];
} catch {
  process.stderr.write("Could not parse npm pack JSON output\n");
  process.exit(1);
}

const files = manifest.files.map((entry) => entry.path).sort();
const required = [
  ".env.example",
  "assets/ui/index.html",
  "bin/recallnest.mjs",
  "CHANGELOG.md",
  "config.json.example",
  "docs/api-reference.md",
  "docs/architecture.md",
  "docs/connector-spec.md",
  "eval/continuity/pattern-seeds.json",
  "integrations/setup-all.sh",
  "LICENSE",
  "package.json",
  "README.md",
  "README_CN.md",
  "src/cli.ts",
  "src/mcp-server.ts",
];

const allowedExact = new Set([
  ".env.example",
  "CHANGELOG.md",
  "config.json.example",
  "LICENSE",
  "package.json",
  "README.md",
  "README_CN.md",
]);
const allowedPrefixes = [
  "assets/ui/",
  "bin/",
  "connectors/examples/",
  "docs/api-reference.md",
  "docs/architecture.md",
  "docs/connector-spec.md",
  "eval/",
  "integrations/",
  "src/",
];

function isAllowed(path) {
  return allowedExact.has(path) || allowedPrefixes.some((prefix) => path.startsWith(prefix));
}

function isForbidden(path) {
  const parts = path.split("/");
  const base = parts.at(-1);
  const forbiddenDirectories = new Set([
    ".claude",
    ".codex",
    ".git",
    "data",
    "logs",
    "node_modules",
    "sessions",
  ]);

  if (parts.some((part) => forbiddenDirectories.has(part))) return true;
  if (base === ".env") return true;
  if (base.startsWith(".env.") && base !== ".env.example") return true;
  if (base === "config.json") return true;
  if (/^(credentials?|auth-profiles?|device)\.json$/i.test(base)) return true;
  return /\.(?:db|jsonl|key|log|p12|pem|sqlite|sqlite3)$/i.test(base);
}

const missing = required.filter((path) => !files.includes(path));
const forbidden = files.filter(isForbidden);
const unexpected = files.filter((path) => !isAllowed(path));

if (missing.length || forbidden.length || unexpected.length) {
  if (missing.length) {
    process.stderr.write("Missing required package files:\n" + missing.join("\n") + "\n");
  }
  if (forbidden.length) {
    process.stderr.write("Forbidden package files:\n" + forbidden.join("\n") + "\n");
  }
  if (unexpected.length) {
    process.stderr.write("Unexpected package files:\n" + unexpected.join("\n") + "\n");
  }
  process.exit(1);
}

process.stdout.write(
  "Package contents verified: " + files.length + " files, no forbidden paths\n",
);
