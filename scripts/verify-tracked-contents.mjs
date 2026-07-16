#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const listing = spawnSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (listing.status !== 0) {
  process.stderr.write(listing.stderr || "git ls-files failed\n");
  process.exit(listing.status || 1);
}

const detectors = [
  ["private-key-block", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g],
  ["xai-key", /xai-[A-Za-z0-9_-]{40,}/g],
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{30,}/g],
  ["openai-or-qwen-key", /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ["jina-key", /jina_[A-Za-z0-9_-]{20,}/g],
  ["aws-access-key", /AKIA[0-9A-Z]{16}/g],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{36,}/g],
  ["slack-token", /xox[baprs]-[A-Za-z0-9-]{20,}/g],
  ["telegram-bot-token", /\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b/g],
  ["google-api-key", /AIza[0-9A-Za-z_-]{35}/g],
  ["npm-token", /npm_[A-Za-z0-9]{30,}/g],
  ["huggingface-token", /hf_[A-Za-z0-9]{30,}/g],
];

const fixtureAllowlist = new Set([
  "src/__tests__/pii-redact.test.ts:private-key-block",
  "src/__tests__/pii-redact.test.ts:slack-token",
]);
const skipExtensions = /\.(?:7z|a|avi|bin|bmp|class|dylib|gif|gz|ico|jpeg|jpg|mov|mp3|mp4|o|pdf|png|so|tar|tgz|ttf|wav|webp|woff2?|zip)$/i;
const findings = [];

function lineNumber(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

for (const path of listing.stdout.split("\0").filter(Boolean)) {
  if (skipExtensions.test(path)) continue;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;

  for (const [name, pattern] of detectors) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const normalized = match[0].toLowerCase();
      if (/(?:example|dummy|replace|sample|test|xxxx|yyyy|your[_ -]?)/.test(normalized)) {
        continue;
      }
      if (fixtureAllowlist.has(path + ":" + name)) continue;
      findings.push({
        path,
        line: lineNumber(text, match.index),
        detector: name,
        matchLength: match[0].length,
      });
    }
  }
}

if (findings.length) {
  process.stderr.write(
    "Provider-shaped credentials found (values omitted):\n" +
      findings
        .map((item) =>
          item.path + ":" + item.line + " " + item.detector + " length=" + item.matchLength,
        )
        .join("\n") +
      "\n",
  );
  process.exit(1);
}

process.stdout.write("Tracked provider credential scan passed\n");
