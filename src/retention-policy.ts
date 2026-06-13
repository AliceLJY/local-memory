/**
 * F-2: Per-scope retention policy.
 * Users can configure auto-archive rules per scope.
 * Default: infinite retention (archive-first, delete-never).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as envConfig from "./env-config.js";

export interface RetentionPolicy {
  /** Auto-archive memories older than this many days (0 = disabled) */
  autoArchiveAfterDays: number;
  /** Maximum active memories per scope (0 = unlimited) */
  maxMemories: number;
  /** Whether to allow hard delete (default: false — archive-first) */
  allowHardDelete: boolean;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  autoArchiveAfterDays: 0,
  maxMemories: 0,
  allowHardDelete: false,
};

function scopeHash(scope: string): string {
  return createHash("sha256").update(scope).digest("hex").slice(0, 16);
}

function retentionDir(configDir?: string): string {
  return join(
    configDir ?? envConfig.dataDir(),
    "retention",
  );
}

/** Load policy for a scope. Falls back to default if not configured. */
export function loadRetentionPolicy(
  scope: string,
  configDir?: string,
): RetentionPolicy {
  const filePath = join(retentionDir(configDir), `${scopeHash(scope)}.json`);
  try {
    if (!existsSync(filePath)) return { ...DEFAULT_RETENTION_POLICY };
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RetentionPolicy>;
    return { ...DEFAULT_RETENTION_POLICY, ...parsed };
  } catch {
    return { ...DEFAULT_RETENTION_POLICY };
  }
}

/** Save policy for a scope. */
export function saveRetentionPolicy(
  scope: string,
  policy: Partial<RetentionPolicy>,
  configDir?: string,
): void {
  const dir = retentionDir(configDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, `${scopeHash(scope)}.json`);
  const merged: RetentionPolicy = { ...DEFAULT_RETENTION_POLICY, ...policy };
  writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

/** Check if a memory should be archived based on policy. */
export function shouldArchiveByPolicy(
  policy: RetentionPolicy,
  memoryAgeDays: number,
  activeCountInScope: number,
): { archive: boolean; reason?: string } {
  if (
    policy.autoArchiveAfterDays > 0 &&
    memoryAgeDays > policy.autoArchiveAfterDays
  ) {
    return {
      archive: true,
      reason: `Memory age (${memoryAgeDays}d) exceeds autoArchiveAfterDays (${policy.autoArchiveAfterDays}d)`,
    };
  }
  if (policy.maxMemories > 0 && activeCountInScope > policy.maxMemories) {
    return {
      archive: true,
      reason: `Active count (${activeCountInScope}) exceeds maxMemories (${policy.maxMemories})`,
    };
  }
  return { archive: false };
}
