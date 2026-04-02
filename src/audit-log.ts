/**
 * F-1: Audit log — record every store/update/delete/retrieve operation.
 * Logs are written to a separate file (not mixed into memory data).
 *
 * Each log entry: { timestamp, operation, scope, memoryId, actor, details }
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AuditOperation =
  | "store"
  | "update"
  | "delete"
  | "retrieve"
  | "archive"
  | "supersede"
  | "consolidate";

export interface AuditEntry {
  timestamp: string; // ISO 8601
  operation: AuditOperation;
  scope?: string;
  memoryId?: string;
  actor: string; // "manual" | "agent" | "api" | "system"
  details?: string; // brief context (<=200 chars)
}

export interface AuditLogger {
  log(entry: Omit<AuditEntry, "timestamp">): void;
  /** Read recent entries (newest first) */
  getRecent(limit?: number): AuditEntry[];
  /** Export all entries as JSON array */
  exportAll(): AuditEntry[];
  /** Count total entries */
  count(): number;
}

function parseLines(raw: string): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as AuditEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/**
 * File-based audit logger. Appends JSON lines to a log file.
 * Non-blocking: write failures are silently ignored (audit must never block operations).
 */
export function createAuditLogger(logPath?: string): AuditLogger {
  const resolvedPath =
    logPath ??
    join(process.env.RECALLNEST_DATA_DIR || "data", "audit.jsonl");

  // Ensure directory exists (silent on failure)
  try {
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {
    // silent — audit must never block
  }

  return {
    log(entry: Omit<AuditEntry, "timestamp">): void {
      try {
        const full: AuditEntry = {
          timestamp: new Date().toISOString(),
          ...entry,
        };
        // Truncate details to 200 chars
        if (full.details && full.details.length > 200) {
          full.details = full.details.slice(0, 200);
        }
        appendFileSync(resolvedPath, JSON.stringify(full) + "\n", "utf-8");
      } catch {
        // silent — audit must never block operations
      }
    },

    getRecent(limit = 20): AuditEntry[] {
      try {
        if (!existsSync(resolvedPath)) return [];
        const raw = readFileSync(resolvedPath, "utf-8");
        const all = parseLines(raw);
        return all.slice(-limit).reverse();
      } catch {
        return [];
      }
    },

    exportAll(): AuditEntry[] {
      try {
        if (!existsSync(resolvedPath)) return [];
        const raw = readFileSync(resolvedPath, "utf-8");
        return parseLines(raw);
      } catch {
        return [];
      }
    },

    count(): number {
      try {
        if (!existsSync(resolvedPath)) return 0;
        const raw = readFileSync(resolvedPath, "utf-8");
        return parseLines(raw).length;
      } catch {
        return 0;
      }
    },
  };
}
