#!/usr/bin/env bun
/**
 * Log File Connector Adapter (skeleton)
 *
 * Demonstrates how to produce a ConnectorOutputV1 JSON file from application
 * log files for RecallNest ingestion. Useful for tracking deploy events,
 * error patterns, and operational decisions.
 *
 * Usage:
 *   bun run connectors/examples/logs-adapter.ts /var/log/myapp/*.log > logs-output.json
 *   lm ingest --connector logs-output.json
 *
 * Customize:
 *   1. Replace parseLogLine() with your log format parser
 *   2. Adjust the importance/category logic for your use case
 *   3. Set scope to match your project
 */

import type { ConnectorOutputV1 } from "../../src/connector-types.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// TODO: Replace with your log format parser
// ---------------------------------------------------------------------------

interface ParsedLogEntry {
  timestamp: string;  // ISO 8601
  level: "info" | "warn" | "error" | "debug";
  message: string;
  source?: string;    // e.g. module name, service
}

function parseLogLine(line: string): ParsedLogEntry | null {
  // Example: "2026-04-14T10:00:00Z [ERROR] auth: login failed for user@example.com"
  const match = line.match(
    /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+\[(\w+)]\s+(?:(\w+):\s+)?(.+)$/,
  );
  if (!match) return null;
  return {
    timestamp: match[1],
    level: match[2].toLowerCase() as ParsedLogEntry["level"],
    source: match[3],
    message: match[4],
  };
}

function levelToImportance(level: string): number {
  switch (level) {
    case "error": return 0.9;
    case "warn":  return 0.7;
    case "info":  return 0.5;
    default:      return 0.3;
  }
}

// ---------------------------------------------------------------------------
// Transform → ConnectorOutputV1
// ---------------------------------------------------------------------------

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("Usage: logs-adapter.ts <logfile> [logfile...]");
    process.exit(1);
  }

  const records: ConnectorOutputV1["records"] = [];

  for (const file of files) {
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      const entry = parseLogLine(line);
      if (!entry) continue;

      // Skip debug-level by default — too noisy for memory storage
      if (entry.level === "debug") continue;

      records.push({
        id: `log:${createHash("md5").update(line).digest("hex")}`,
        text: entry.message,
        title: entry.source ? `[${entry.level.toUpperCase()}] ${entry.source}` : undefined,
        categoryHint: entry.level === "error" ? "cases" : "events",
        importanceHint: levelToImportance(entry.level),
        tags: ["log", entry.level, ...(entry.source ? [`module:${entry.source}`] : [])],
        timestamp: entry.timestamp,
        contentHash: createHash("sha256").update(line).digest("hex"),
      });
    }
  }

  const output: ConnectorOutputV1 = {
    version: "connector-v1",
    source: "logs",
    scope: "ops:myapp",               // Customize: "project:xyz", "ops:production"
    producedAt: new Date().toISOString(),
    records,
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
