import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { SessionCheckpointRecord } from "./session-schema.js";
import { SessionCheckpointRecordSchema } from "./session-schema.js";

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

export class SessionCheckpointStore {
  constructor(private readonly dir = resolve(import.meta.dir, "../data/session-checkpoints")) {}

  get dataDir(): string {
    return ensureDir(this.dir);
  }

  async save(record: SessionCheckpointRecord): Promise<SessionCheckpointRecord> {
    const parsed = SessionCheckpointRecordSchema.parse(record);
    const timestampToken = parsed.updatedAt.replace(/[:.]/g, "-");
    const path = join(this.dataDir, `${timestampToken}-${parsed.checkpointId}.json`);
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
    return parsed;
  }

  async listRecent(query: SessionCheckpointQuery = {}): Promise<SessionCheckpointRecord[]> {
    const { sessionId, scope, limit = 20 } = query;
    const files = readdirSync(this.dataDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(this.dataDir, name));

    const items: SessionCheckpointRecord[] = [];
    for (const path of files) {
      try {
        const parsed = SessionCheckpointRecordSchema.parse(
          JSON.parse(readFileSync(path, "utf-8")),
        );
        if (sessionId && parsed.sessionId !== sessionId) continue;
        if (scope && parsed.resolvedScope !== scope) continue;
        items.push(parsed);
      } catch {
        // Skip corrupt checkpoint files.
      }
    }

    return sortNewestFirst(items).slice(0, limit);
  }

  async getLatest(query: SessionCheckpointQuery = {}): Promise<SessionCheckpointRecord | null> {
    const [latest] = await this.listRecent({ ...query, limit: 1 });
    return latest || null;
  }
}
