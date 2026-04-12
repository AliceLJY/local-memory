import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { metaDir } from "./compat.js";
import type { WorkflowObservationOutcome, WorkflowObservationRecord } from "./workflow-observation-schema.js";
import { WorkflowObservationRecordSchema } from "./workflow-observation-schema.js";

export interface WorkflowObservationQuery {
  workflowId?: string;
  scope?: string;
  outcome?: WorkflowObservationOutcome;
  limit?: number;
  since?: string;
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function sortNewestFirst(records: WorkflowObservationRecord[]): WorkflowObservationRecord[] {
  return [...records].sort((a, b) => {
    const timeDiff = Date.parse(b.recordedAt) - Date.parse(a.recordedAt);
    if (timeDiff !== 0) return timeDiff;
    return b.observationId.localeCompare(a.observationId);
  });
}

export class WorkflowObservationStore {
  constructor(private readonly dir = resolve(metaDir(import.meta), "../data/workflow-observations")) {}

  get dataDir(): string {
    return ensureDir(this.dir);
  }

  async save(record: WorkflowObservationRecord): Promise<WorkflowObservationRecord> {
    const parsed = WorkflowObservationRecordSchema.parse(record);
    const timestampToken = parsed.recordedAt.replace(/[:.]/g, "-");
    const path = join(this.dataDir, `${timestampToken}-${parsed.observationId}.json`);
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
    return parsed;
  }

  async listRecent(query: WorkflowObservationQuery = {}): Promise<WorkflowObservationRecord[]> {
    const { workflowId, scope, outcome, limit = 200, since } = query;
    const sinceTime = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
    const files = readdirSync(this.dataDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(this.dataDir, name));

    const items: WorkflowObservationRecord[] = [];
    for (const path of files) {
      try {
        const parsed = WorkflowObservationRecordSchema.parse(
          JSON.parse(readFileSync(path, "utf-8")),
        );
        if (workflowId && parsed.workflowId !== workflowId) continue;
        if (scope && parsed.resolvedScope !== scope) continue;
        if (outcome && parsed.outcome !== outcome) continue;
        if (Date.parse(parsed.recordedAt) < sinceTime) continue;
        items.push(parsed);
      } catch {
        // Skip corrupt observation files.
      }
    }

    return sortNewestFirst(items).slice(0, limit);
  }
}

