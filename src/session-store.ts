import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { SessionCheckpointRecord } from "./session-schema.js";
import { SessionCheckpointRecordSchema } from "./session-schema.js";
import { normalizeCheckpointScope, type CheckpointQuality } from "./session-engine.js";

const FALLBACK_SUMMARY = "Checkpoint captured current task state without repo-state details.";

export function classifyCheckpointQuality(record: SessionCheckpointRecord): CheckpointQuality {
  const isFallback = record.summary === FALLBACK_SUMMARY;
  const hasContent = record.decisions.length > 0 || record.openLoops.length > 0 || record.nextActions.length > 0;
  return isFallback && !hasContent ? "minimal" : "rich";
}

export interface SessionCheckpointQuery {
  sessionId?: string;
  scope?: string;
  limit?: number;
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function sortNewestFirst(records: SessionCheckpointRecord[]): SessionCheckpointRecord[] {
  return [...records].sort((a, b) => {
    const timeDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (timeDiff !== 0) return timeDiff;
    return b.checkpointId.localeCompare(a.checkpointId);
  });
}

export interface CheckpointGcOptions {
  dryRun?: boolean;
  now?: Date;
  /** Keep N newest rich checkpoints per resolvedScope (default: 5) */
  keepPerScope?: number;
  /** Keep 1 checkpoint per sessionId if younger than this many hours (default: 48) */
  sessionTtlHours?: number;
  /** Delete minimal checkpoints older than this many days (default: 7) */
  minimalTtlDays?: number;
  /** Archive rich checkpoints older than this many days (default: 30) */
  archiveAfterDays?: number;
  /** Hard-delete archived files older than this many days (default: 90) */
  archiveTtlDays?: number;
}

export interface CheckpointGcFileAction {
  file: string;
  checkpointId: string;
  resolvedScope: string;
  quality: CheckpointQuality;
  updatedAt: string;
  action: "keep" | "archive" | "delete";
  reason: string;
}

export interface CheckpointGcResult {
  kept: number;
  archived: number;
  deleted: number;
  errors: string[];
  actions: CheckpointGcFileAction[];
}

export class SessionCheckpointStore {
  constructor(private readonly dir = resolve(import.meta.dir, "../data/session-checkpoints")) {}

  get dataDir(): string {
    return ensureDir(this.dir);
  }

  async save(record: SessionCheckpointRecord): Promise<SessionCheckpointRecord> {
    const parsed = SessionCheckpointRecordSchema.parse(record);
    const timestampToken = parsed.updatedAt.replace(/[:.]/g, "-");
    const path = join(this.dataDir, `${timestampToken}-${parsed.checkpointId}.json`);
    try {
      writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
    } catch (err) {
      console.error("[recallnest] Failed to save session checkpoint:", err instanceof Error ? err.message : String(err));
    }
    return parsed;
  }

  async listRecent(query: SessionCheckpointQuery = {}): Promise<SessionCheckpointRecord[]> {
    const { sessionId, scope, limit = 20 } = query;
    const files = readdirSync(this.dataDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(this.dataDir, name));

    const normalizedQueryScope = scope ? normalizeCheckpointScope(scope) : undefined;
    const items: SessionCheckpointRecord[] = [];
    for (const path of files) {
      try {
        const parsed = SessionCheckpointRecordSchema.parse(
          JSON.parse(readFileSync(path, "utf-8")),
        );
        if (sessionId && parsed.sessionId !== sessionId) continue;
        if (normalizedQueryScope) {
          const normalizedRecordScope = normalizeCheckpointScope(parsed.resolvedScope ?? parsed.scope ?? "");
          if (normalizedRecordScope !== normalizedQueryScope) continue;
        }
        items.push(parsed);
      } catch {
        // Skip corrupt checkpoint files.
      }
    }

    return sortNewestFirst(items).slice(0, limit);
  }

  async getLatest(query: SessionCheckpointQuery = {}): Promise<SessionCheckpointRecord | null> {
    // Look at recent checkpoints and prefer rich ones over minimal/fallback ones
    const recent = await this.listRecent({ ...query, limit: 5 });
    if (recent.length === 0) return null;
    const rich = recent.find((r) => classifyCheckpointQuality(r) === "rich");
    return rich || recent[0];
  }

  private get archiveDir(): string {
    return ensureDir(resolve(this.dir, "../archive/session-checkpoints"));
  }

  gc(options: CheckpointGcOptions = {}): CheckpointGcResult {
    const {
      dryRun = false,
      now = new Date(),
      keepPerScope = 5,
      sessionTtlHours = 48,
      minimalTtlDays = 7,
      archiveAfterDays = 30,
      archiveTtlDays = 90,
    } = options;

    const nowMs = now.getTime();
    const DAY_MS = 86_400_000;
    const HOUR_MS = 3_600_000;

    const errors: string[] = [];
    const actions: CheckpointGcFileAction[] = [];

    // --- Phase 1: Load and classify all checkpoint files ---
    const dir = this.dataDir;
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));

    interface ParsedEntry {
      path: string;
      record: SessionCheckpointRecord;
      quality: CheckpointQuality;
      ageMs: number;
      scope: string;
    }

    const entries: ParsedEntry[] = [];
    for (const name of files) {
      const path = join(dir, name);
      try {
        const record = SessionCheckpointRecordSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
        const quality = classifyCheckpointQuality(record);
        const scope = normalizeCheckpointScope(record.resolvedScope ?? record.scope ?? `session:${record.sessionId}`);
        const ageMs = nowMs - Date.parse(record.updatedAt);
        entries.push({ path, record, quality, ageMs, scope });
      } catch (err) {
        errors.push(`parse error: ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- Phase 2: Build protected set ---
    const protectedPaths = new Set<string>();
    const protectedReasons = new Map<string, string>();

    // Rule 1: Latest N rich per scope
    const byScope = new Map<string, ParsedEntry[]>();
    for (const entry of entries) {
      const list = byScope.get(entry.scope) ?? [];
      list.push(entry);
      byScope.set(entry.scope, list);
    }
    for (const [scope, list] of byScope) {
      const richSorted = list
        .filter((e) => e.quality === "rich")
        .sort((a, b) => a.ageMs - b.ageMs); // newest first (smallest age)
      for (const entry of richSorted.slice(0, keepPerScope)) {
        protectedPaths.add(entry.path);
        protectedReasons.set(entry.path, `latest ${keepPerScope} rich for scope ${scope}`);
      }
    }

    // Rule 2: Latest 1 per session within sessionTtlHours
    const bySession = new Map<string, ParsedEntry[]>();
    for (const entry of entries) {
      const list = bySession.get(entry.record.sessionId) ?? [];
      list.push(entry);
      bySession.set(entry.record.sessionId, list);
    }
    for (const [, list] of bySession) {
      const newest = list.sort((a, b) => a.ageMs - b.ageMs)[0];
      if (newest && newest.ageMs < sessionTtlHours * HOUR_MS) {
        if (!protectedPaths.has(newest.path)) {
          protectedPaths.add(newest.path);
          protectedReasons.set(newest.path, `latest checkpoint for session within ${sessionTtlHours}h`);
        }
      }
    }

    // --- Phase 3: Decide action for each entry ---
    for (const entry of entries) {
      const ageDays = entry.ageMs / DAY_MS;
      let action: "keep" | "archive" | "delete";
      let reason: string;

      if (protectedPaths.has(entry.path)) {
        action = "keep";
        reason = protectedReasons.get(entry.path) ?? "protected";
      } else if (entry.quality === "minimal" && ageDays > minimalTtlDays) {
        action = "delete";
        reason = `minimal checkpoint older than ${minimalTtlDays} days (${Math.floor(ageDays)}d)`;
      } else if (entry.quality === "rich" && ageDays > archiveAfterDays) {
        action = "archive";
        reason = `rich checkpoint older than ${archiveAfterDays} days (${Math.floor(ageDays)}d), not in latest ${keepPerScope} per scope`;
      } else {
        action = "keep";
        reason = `${entry.quality} checkpoint within retention window (${Math.floor(ageDays)}d)`;
      }

      actions.push({
        file: basename(entry.path),
        checkpointId: entry.record.checkpointId,
        resolvedScope: entry.scope,
        quality: entry.quality,
        updatedAt: entry.record.updatedAt,
        action,
        reason,
      });
    }

    // --- Phase 4: Execute actions (unless dry-run) ---
    let kept = 0;
    let archived = 0;
    let deleted = 0;

    for (const item of actions) {
      if (item.action === "keep") {
        kept++;
        continue;
      }
      if (dryRun) {
        if (item.action === "archive") archived++;
        else deleted++;
        continue;
      }
      const srcPath = join(dir, item.file);
      try {
        if (item.action === "archive") {
          renameSync(srcPath, join(this.archiveDir, item.file));
          archived++;
        } else {
          unlinkSync(srcPath);
          deleted++;
        }
      } catch (err) {
        errors.push(`${item.action} failed: ${item.file}: ${err instanceof Error ? err.message : String(err)}`);
        kept++; // count as kept since we couldn't move/delete it
      }
    }

    // --- Phase 5: Sweep archived directory for expired files ---
    const archDir = this.archiveDir;
    const archivedFiles = readdirSync(archDir).filter((name) => name.endsWith(".json"));
    for (const name of archivedFiles) {
      const path = join(archDir, name);
      try {
        const mtime = statSync(path).mtimeMs;
        const ageDays = (nowMs - mtime) / DAY_MS;
        if (ageDays > archiveTtlDays) {
          if (!dryRun) unlinkSync(path);
          deleted++;
          actions.push({
            file: `archive/${name}`,
            checkpointId: name.replace(/.*-([0-9a-f-]{36})\.json$/, "$1"),
            resolvedScope: "archived",
            quality: "rich",
            updatedAt: new Date(mtime).toISOString(),
            action: "delete",
            reason: `archived file older than ${archiveTtlDays} days (${Math.floor(ageDays)}d)`,
          });
        }
      } catch (err) {
        errors.push(`archive sweep: ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { kept, archived, deleted, errors, actions };
  }
}
