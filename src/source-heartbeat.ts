/**
 * GB-3: Source Heartbeat Tracking
 *
 * Every connector ingest writes a heartbeat record to data/source-heartbeat.json.
 * data_checkup and doctor --ci read heartbeats to detect stale data sources.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { metaDir } from "./compat.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceHeartbeat {
  source: string;
  lastIngest: string;       // ISO 8601
  recordsIngested: number;
  errors: string[];
}

export type HeartbeatFile = Record<string, SourceHeartbeat>;

export interface StaleSource {
  source: string;
  lastIngest: string;
  daysSince: number;
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

const HEARTBEAT_PATH = resolve(metaDir(import.meta), "../data/source-heartbeat.json");

/** Visible for testing — override the default path. */
export function heartbeatPath(): string {
  return HEARTBEAT_PATH;
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export function readHeartbeats(path?: string): HeartbeatFile {
  const p = path ?? HEARTBEAT_PATH;
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as HeartbeatFile;
  } catch {
    return {};
  }
}

export function writeHeartbeat(
  source: string,
  recordsIngested: number,
  errors: string[],
  path?: string,
): void {
  const p = path ?? HEARTBEAT_PATH;
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = readHeartbeats(p);
  existing[source] = {
    source,
    lastIngest: new Date().toISOString(),
    recordsIngested,
    errors: errors.slice(0, 10), // cap stored errors
  };
  writeFileSync(p, JSON.stringify(existing, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Staleness check
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

export function checkSourceStaleness(maxDays = 7, path?: string): StaleSource[] {
  const heartbeats = readHeartbeats(path);
  const now = Date.now();
  const stale: StaleSource[] = [];

  for (const hb of Object.values(heartbeats)) {
    const lastMs = Date.parse(hb.lastIngest);
    if (Number.isNaN(lastMs)) continue;
    const daysSince = Math.floor((now - lastMs) / MS_PER_DAY);
    if (daysSince > maxDays) {
      stale.push({ source: hb.source, lastIngest: hb.lastIngest, daysSince });
    }
  }

  return stale.sort((a, b) => b.daysSince - a.daysSince);
}

/** Human-readable age string, e.g. "2h ago", "3d ago". */
export function formatAge(isoDate: string): string {
  const ms = Date.now() - Date.parse(isoDate);
  if (ms < 0) return "just now";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
