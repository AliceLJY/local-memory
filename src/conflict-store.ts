import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ConflictCandidateRecord, ConflictStatus } from "./conflict-schema.js";
import { ConflictCandidateRecordSchema } from "./conflict-schema.js";

export interface ConflictCandidateQuery {
  status?: ConflictStatus;
  canonicalKey?: string;
  limit?: number;
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function sortNewestFirst(records: ConflictCandidateRecord[]): ConflictCandidateRecord[] {
  return [...records].sort((a, b) => {
    const timeDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (timeDiff !== 0) return timeDiff;
    return b.conflictId.localeCompare(a.conflictId);
  });
}

export class ConflictCandidateStore {
  constructor(private readonly dir = resolve(import.meta.dir, "../data/conflict-candidates")) {}

  get dataDir(): string {
    return ensureDir(this.dir);
  }

  async save(record: ConflictCandidateRecord): Promise<ConflictCandidateRecord> {
    const parsed = ConflictCandidateRecordSchema.parse(record);
    const timestampToken = parsed.createdAt.replace(/[:.]/g, "-");
    const path = join(this.dataDir, `${timestampToken}-${parsed.conflictId}.json`);
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
    return parsed;
  }

  async replace(record: ConflictCandidateRecord): Promise<ConflictCandidateRecord> {
    const parsed = ConflictCandidateRecordSchema.parse(record);
    const existingPath = this.findPathById(parsed.conflictId);
    const timestampToken = parsed.createdAt.replace(/[:.]/g, "-");
    const path = existingPath || join(this.dataDir, `${timestampToken}-${parsed.conflictId}.json`);
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
    return parsed;
  }

  async listRecent(query: ConflictCandidateQuery = {}): Promise<ConflictCandidateRecord[]> {
    const { status, canonicalKey, limit = 20 } = query;
    const files = readdirSync(this.dataDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(this.dataDir, name));

    const items: ConflictCandidateRecord[] = [];
    for (const path of files) {
      try {
        const parsed = ConflictCandidateRecordSchema.parse(
          JSON.parse(readFileSync(path, "utf-8")),
        );
        if (status && parsed.status !== status) continue;
        if (canonicalKey && parsed.canonicalKey !== canonicalKey) continue;
        items.push(parsed);
      } catch {
        // Skip corrupt conflict files.
      }
    }

    return sortNewestFirst(items).slice(0, limit);
  }

  async getById(conflictId: string): Promise<ConflictCandidateRecord | null> {
    const path = this.findPathById(conflictId);
    if (!path) return null;
    try {
      return ConflictCandidateRecordSchema.parse(
        JSON.parse(readFileSync(path, "utf-8")),
      );
    } catch {
      return null;
    }
  }

  async getOpenByFingerprint(fingerprint: string): Promise<ConflictCandidateRecord | null> {
    const items = await this.listRecent({ status: "open", limit: 200 });
    return items.find((item) => item.fingerprint === fingerprint) || null;
  }

  async getLatestByFingerprint(fingerprint: string): Promise<ConflictCandidateRecord | null> {
    const items = await this.listRecent({ limit: 200 });
    return items.find((item) => item.fingerprint === fingerprint) || null;
  }

  private findPathById(conflictId: string): string | null {
    const exact = readdirSync(this.dataDir)
      .filter((name) => name.endsWith(`-${conflictId}.json`))
      .map((name) => join(this.dataDir, name));
    if (exact.length > 0) {
      return exact[0] || null;
    }

    const files = readdirSync(this.dataDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(this.dataDir, name));

    const matches: string[] = [];
    for (const path of files) {
      try {
        const parsed = ConflictCandidateRecordSchema.parse(
          JSON.parse(readFileSync(path, "utf-8")),
        );
        if (parsed.conflictId.startsWith(conflictId)) {
          matches.push(path);
        }
      } catch {
        // Skip corrupt conflict files.
      }
    }

    if (matches.length > 1) {
      throw new Error(`Ambiguous conflict prefix "${conflictId}" matches ${matches.length} conflicts. Use a longer prefix or full ID.`);
    }

    return matches[0] || null;
  }
}
