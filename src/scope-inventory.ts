import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { suppressesLegacyScopeIssue } from "./legacy-scope-review.js";
import { classifyLegacyScope, type LegacyScopeAudit, type LegacyScopeIssueKind, type MemoryStore } from "./store.js";

export type ScopeInventoryLayer =
  | "memories"
  | "pins"
  | "session-checkpoints"
  | "workflow-observations";

export interface ScopeInventorySample {
  layer: ScopeInventoryLayer;
  id: string;
  kind: LegacyScopeIssueKind;
  scope: string | null;
  context: string;
  preview: string;
  recordedAt?: string;
  sourcePath?: string;
}

export interface ScopeInventoryLayerReport {
  layer: ScopeInventoryLayer;
  scannedCount: number;
  anomalyCount: number;
  invalidCount: number;
  reviewedCount: number;
  counts: Record<LegacyScopeIssueKind, number>;
  samples: ScopeInventorySample[];
  recommendation: string;
}

export interface ScopeInventoryReport {
  generatedAt: string;
  sampleLimit: number;
  totalScannedCount: number;
  totalAnomalyCount: number;
  totalInvalidCount: number;
  totalReviewedCount: number;
  layers: ScopeInventoryLayerReport[];
}

export interface ScopeInventoryOptions {
  store: MemoryStore;
  sampleLimit?: number;
  pinsDir?: string;
  checkpointsDir?: string;
  workflowObservationsDir?: string;
}

interface FileLayerScanOptions {
  dir: string;
  layer: ScopeInventoryLayer;
  sampleLimit: number;
  readScope: (record: Record<string, unknown>) => unknown;
  readId: (record: Record<string, unknown>, path: string) => string;
  readContext: (record: Record<string, unknown>) => string;
  readPreview: (record: Record<string, unknown>) => string;
  readRecordedAt?: (record: Record<string, unknown>) => string | undefined;
  recommendation: string;
}

function emptyCounts(): Record<LegacyScopeIssueKind, number> {
  return {
    missing: 0,
    empty: 0,
    global: 0,
  };
}

function clampLimit(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function clip(text: string, maxLen = 72): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "-";
  return compact.length <= maxLen ? compact : `${compact.slice(0, maxLen - 3)}...`;
}

function formatLayerLabel(layer: ScopeInventoryLayer): string {
  switch (layer) {
    case "memories":
      return "memories";
    case "pins":
      return "pins";
    case "session-checkpoints":
      return "session-checkpoints";
    case "workflow-observations":
      return "workflow-observations";
  }
}

function normalizeRecordedAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function timestampToIso(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

function mapMemoryAudit(audit: LegacyScopeAudit): ScopeInventorySample[] {
  return audit.samples.map((sample) => ({
    layer: "memories",
    id: sample.id,
    kind: sample.kind,
    scope: sample.scope,
    context: sample.category,
    preview: clip(sample.text, 80),
    recordedAt: timestampToIso(sample.timestamp),
  }));
}

function scanJsonLayer(options: FileLayerScanOptions): ScopeInventoryLayerReport {
  const counts = emptyCounts();
  if (!existsSync(options.dir)) {
    return {
      layer: options.layer,
      scannedCount: 0,
      anomalyCount: 0,
      invalidCount: 0,
      reviewedCount: 0,
      counts,
      samples: [],
      recommendation: options.recommendation,
    };
  }

  const files = readdirSync(options.dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(options.dir, name));

  const anomalies: ScopeInventorySample[] = [];
  let invalidCount = 0;
  let reviewedCount = 0;

  for (const path of files) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      invalidCount += 1;
      continue;
    }

    const rawScope = options.readScope(parsed);
    const kind = classifyLegacyScope(rawScope);
    if (!kind) continue;
    if (suppressesLegacyScopeIssue(parsed.legacyScopeReview, kind)) {
      reviewedCount += 1;
      continue;
    }

    counts[kind] += 1;
    anomalies.push({
      layer: options.layer,
      id: options.readId(parsed, path),
      kind,
      scope: typeof rawScope === "string" ? rawScope : rawScope == null ? null : String(rawScope),
      context: options.readContext(parsed),
      preview: clip(options.readPreview(parsed), 80),
      recordedAt: options.readRecordedAt?.(parsed),
      sourcePath: path,
    });
  }

  anomalies.sort((a, b) => {
    const timeDiff = Date.parse(b.recordedAt || "") - Date.parse(a.recordedAt || "");
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });

  return {
    layer: options.layer,
    scannedCount: files.length,
    anomalyCount: counts.missing + counts.empty + counts.global,
    invalidCount,
    reviewedCount,
    counts,
    samples: anomalies.slice(0, options.sampleLimit),
    recommendation: options.recommendation,
  };
}

export async function collectScopeInventory(options: ScopeInventoryOptions): Promise<ScopeInventoryReport> {
  const sampleLimit = clampLimit(options.sampleLimit, 1, 200, 20);
  const [stats, audit] = await Promise.all([
    options.store.stats(),
    options.store.auditLegacyScopes(sampleLimit),
  ]);

  const memoryLayer: ScopeInventoryLayerReport = {
    layer: "memories",
    scannedCount: stats.totalCount,
    anomalyCount: audit.totalCount,
    invalidCount: 0,
    reviewedCount: 0,
    counts: audit.counts,
    samples: mapMemoryAudit(audit),
    recommendation: "Migrate or delete historical unscoped memory rows before removing compatibility shims.",
  };

  const pinsDir = options.pinsDir || resolve(import.meta.dir, "../data/pins");
  const checkpointsDir = options.checkpointsDir || resolve(import.meta.dir, "../data/session-checkpoints");
  const workflowObservationsDir = options.workflowObservationsDir || resolve(import.meta.dir, "../data/workflow-observations");

  const pinLayer = scanJsonLayer({
    dir: pinsDir,
    layer: "pins",
    sampleLimit,
    readScope: (record) => (record.source as Record<string, unknown> | undefined)?.scope,
    readId: (record, path) => typeof record.id === "string" ? record.id : basename(path, ".json"),
    readContext: (record) => typeof record.type === "string" ? record.type : "pin",
    readPreview: (record) => {
      if (typeof record.title === "string" && record.title.trim()) return record.title;
      if (typeof record.summary === "string" && record.summary.trim()) return record.summary;
      return "Pinned asset with legacy source scope";
    },
    readRecordedAt: (record) =>
      normalizeRecordedAt(record.updatedAt) || normalizeRecordedAt(record.createdAt),
    recommendation: "Review pinned assets that still point at global/unscoped sources; re-pin them from a scoped memory if needed.",
  });

  const checkpointLayer = scanJsonLayer({
    dir: checkpointsDir,
    layer: "session-checkpoints",
    sampleLimit,
    readScope: (record) => record.resolvedScope,
    readId: (record, path) => typeof record.checkpointId === "string" ? record.checkpointId : basename(path, ".json"),
    readContext: (record) => typeof record.sessionId === "string" ? record.sessionId : "checkpoint",
    readPreview: (record) => typeof record.summary === "string" ? record.summary : "Checkpoint with legacy scope state",
    readRecordedAt: (record) => normalizeRecordedAt(record.updatedAt),
    recommendation: "Review or delete legacy checkpoint files with missing/empty/global resolvedScope before relying on them for handoff context.",
  });

  const workflowLayer = scanJsonLayer({
    dir: workflowObservationsDir,
    layer: "workflow-observations",
    sampleLimit,
    readScope: (record) => record.resolvedScope,
    readId: (record, path) => typeof record.observationId === "string" ? record.observationId : basename(path, ".json"),
    readContext: (record) => typeof record.workflowId === "string" ? record.workflowId : "workflow",
    readPreview: (record) => typeof record.summary === "string" ? record.summary : "Workflow observation with legacy scope state",
    readRecordedAt: (record) => normalizeRecordedAt(record.recordedAt),
    recommendation: "Review or delete legacy workflow observation files with missing/empty/global resolvedScope; they should stay outside normal continuity recall.",
  });

  const layers = [memoryLayer, pinLayer, checkpointLayer, workflowLayer];
  return {
    generatedAt: new Date().toISOString(),
    sampleLimit,
    totalScannedCount: layers.reduce((sum, layer) => sum + layer.scannedCount, 0),
    totalAnomalyCount: layers.reduce((sum, layer) => sum + layer.anomalyCount, 0),
    totalInvalidCount: layers.reduce((sum, layer) => sum + layer.invalidCount, 0),
    totalReviewedCount: layers.reduce((sum, layer) => sum + layer.reviewedCount, 0),
    layers,
  };
}

function formatScope(value: string | null): string {
  if (value == null) return "<missing>";
  return value.trim() ? value.trim() : "<empty>";
}

export function formatScopeInventoryReport(report: ScopeInventoryReport): string {
  const lines = [
    "Scope inventory",
    "",
    `  Generated at   : ${report.generatedAt}`,
    `  Records scanned: ${report.totalScannedCount}`,
    `  Anomalies      : ${report.totalAnomalyCount}`,
    `  Invalid files  : ${report.totalInvalidCount}`,
    `  Reviewed keeps : ${report.totalReviewedCount}`,
    "",
    "  By layer:",
  ];

  for (const layer of report.layers) {
    lines.push(
      `    ${formatLayerLabel(layer.layer).padEnd(22)} scanned ${String(layer.scannedCount).padStart(4)}  anomalies ${String(layer.anomalyCount).padStart(3)}  invalid ${String(layer.invalidCount).padStart(3)}  reviewed ${String(layer.reviewedCount).padStart(3)}  missing ${String(layer.counts.missing).padStart(3)}  empty ${String(layer.counts.empty).padStart(3)}  global ${String(layer.counts.global).padStart(3)}`
    );
  }

  const anomalyLayers = report.layers.filter((layer) => layer.samples.length > 0);
  if (anomalyLayers.length === 0) {
    if (report.totalInvalidCount === 0) {
      lines.push("", "No unresolved legacy scope anomalies found across memories, pins, checkpoints, or workflow observations.");
    }
    return lines.join("\n");
  }

  for (const layer of anomalyLayers) {
    lines.push("", `  [${formatLayerLabel(layer.layer)}]`);
    lines.push("    ID        Kind     Scope        Context             Date        Preview");
    lines.push("    --------  -------  -----------  ------------------  ----------  -------");
    for (const sample of layer.samples) {
      lines.push(
        `    ${sample.id.slice(0, 8).padEnd(8)}  ${sample.kind.padEnd(7)}  ${formatScope(sample.scope).padEnd(11)}  ${clip(sample.context, 18).padEnd(18)}  ${(sample.recordedAt || "-").slice(0, 10).padEnd(10)}  ${clip(sample.preview, 56)}`
      );
    }
    lines.push(`    Next: ${layer.recommendation}`);
  }

  return lines.join("\n");
}
