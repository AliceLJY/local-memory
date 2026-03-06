import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";

import type { MemoryEntry } from "./store.js";
import type { RetrievalResult } from "./retriever.js";
import type { RetrievalProfileName } from "./retrieval-profiles.js";
import type { DistilledSummary } from "./memory-output.js";

export interface PinAsset {
  id: string;
  type: "pinned-memory";
  createdAt: string;
  updatedAt: string;
  title: string;
  summary: string;
  tags: string[];
  source: {
    memoryId: string;
    scope: string;
    timestamp: number;
    metadata: Record<string, unknown>;
  };
  retrieval?: {
    query?: string;
    profile?: RetrievalProfileName;
    score?: number;
    path?: string;
  };
  snippet: string;
}

export interface BriefAsset {
  id: string;
  type: "memory-brief";
  createdAt: string;
  updatedAt: string;
  title: string;
  summary: string;
  tags: string[];
  query: string;
  profile: RetrievalProfileName;
  hits: number;
  sources: DistilledSummary["sources"];
  takeaways: string[];
  evidence: DistilledSummary["evidence"];
  reusableCandidates: string[];
}

export type MemoryAsset = PinAsset | BriefAsset;
export type MemoryAssetRecord = MemoryAsset & { path: string };

export interface ExportArtifact {
  id: string;
  type: "memory-export";
  query: string;
  profile: RetrievalProfileName;
  createdAt: string;
  format: "md" | "json";
  outputPath: string;
}

export interface ExportArtifactRecord extends ExportArtifact {
  summary?: string;
  path: string;
}

export interface DirtyBriefAssetRecord extends BriefAsset {
  path: string;
  reasons: string[];
  scope: string;
}

const DATA_DIR = resolve(import.meta.dir, "../data");
const PINS_DIR = join(DATA_DIR, "pins");
const ASSETS_DIR = join(DATA_DIR, "assets");
const ARCHIVE_DIR = join(DATA_DIR, "archive", "dirty-briefs");
const EXPORTS_DIR = join(DATA_DIR, "exports");

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function parseMetadata(entry: MemoryEntry): Record<string, unknown> {
  try {
    return JSON.parse(entry.metadata || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function cleanSnippet(text: string, maxLen = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 3)}...`;
}

function titleFromText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.slice(0, 72) || "Pinned Memory";
}

function tagify(text: string): string[] {
  const matches = text.match(/[\p{Script=Han}]{2,}|[a-z0-9._/-]{4,}/giu) || [];
  return Array.from(new Set(matches.map(item => item.toLowerCase()))).slice(0, 6);
}

function retrievalPath(result: RetrievalResult): string {
  const parts: string[] = [];
  if (result.sources.vector) parts.push("vector");
  if (result.sources.bm25) parts.push("bm25");
  if (result.sources.reranked) parts.push("reranked");
  return parts.join("+") || "direct";
}

export function getPinsDir(): string {
  return ensureDir(PINS_DIR);
}

export function getAssetsDir(): string {
  return ensureDir(ASSETS_DIR);
}

export function getDirtyBriefArchiveDir(): string {
  return ensureDir(ARCHIVE_DIR);
}

export function getExportsDir(): string {
  return ensureDir(EXPORTS_DIR);
}

export function buildPinAsset(result: RetrievalResult, options: {
  title?: string;
  summary?: string;
  query?: string;
  profile?: RetrievalProfileName;
} = {}): PinAsset {
  const metadata = parseMetadata(result.entry);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    type: "pinned-memory",
    createdAt: now,
    updatedAt: now,
    title: options.title || titleFromText(result.entry.text),
    summary: options.summary || cleanSnippet(result.entry.text, 240),
    tags: tagify(`${options.query || ""} ${result.entry.scope} ${result.entry.text}`),
    source: {
      memoryId: result.entry.id,
      scope: result.entry.scope,
      timestamp: result.entry.timestamp,
      metadata,
    },
    retrieval: {
      query: options.query,
      profile: options.profile,
      score: result.score,
      path: retrievalPath(result),
    },
    snippet: cleanSnippet(result.entry.text, 320),
  };
}

export function savePinAsset(asset: PinAsset): string {
  const dir = getPinsDir();
  const path = join(dir, `${asset.id}.json`);
  writeFileSync(path, JSON.stringify(asset, null, 2) + "\n");
  return path;
}

export function buildBriefAsset(
  summary: DistilledSummary,
  options: { title?: string } = {},
): BriefAsset {
  const now = new Date().toISOString();
  const takeaways = summary.takeaways.slice(0, 4);
  const fallbackSummary = takeaways.map((item) => item.replace(/^[^:]+:\s*/, "")).join(" ").trim();

  return {
    id: randomUUID(),
    type: "memory-brief",
    createdAt: now,
    updatedAt: now,
    title: options.title || `${summary.query} brief`,
    summary: cleanSnippet(fallbackSummary || `Brief for ${summary.query}`, 260),
    tags: tagify(`${summary.query} ${takeaways.join(" ")} ${summary.sources.map((item) => item.source).join(" ")}`),
    query: summary.query,
    profile: summary.profile,
    hits: summary.hits,
    sources: summary.sources,
    takeaways,
    evidence: summary.evidence.slice(0, 6),
    reusableCandidates: summary.reusableCandidates.slice(0, 4),
  };
}

export function saveBriefAsset(asset: BriefAsset): string {
  const dir = getAssetsDir();
  const path = join(dir, `${asset.id}.json`);
  writeFileSync(path, JSON.stringify(asset, null, 2) + "\n");
  return path;
}

export function listPinAssets(limit = 20): Array<PinAsset & { path: string }> {
  const dir = getPinsDir();
  const files = readdirSync(dir)
    .filter(name => name.endsWith(".json"))
    .map(name => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit);

  const items: Array<PinAsset & { path: string }> = [];
  for (const path of files) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as PinAsset;
      items.push({ ...parsed, path });
    } catch {
      // Skip corrupt asset files.
    }
  }
  return items;
}

function listJsonRecords<T extends MemoryAsset>(dir: string, limit = 20): Array<T & { path: string }> {
  ensureDir(dir);
  const files = readdirSync(dir)
    .filter(name => name.endsWith(".json"))
    .map(name => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit);

  const items: Array<T & { path: string }> = [];
  for (const path of files) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as T;
      items.push({ ...parsed, path });
    } catch {
      // Skip corrupt records.
    }
  }
  return items;
}

export function listBriefAssets(limit = 20): Array<BriefAsset & { path: string }> {
  return listJsonRecords<BriefAsset>(getAssetsDir(), limit);
}

function detectDirtyBriefReasons(asset: BriefAsset): string[] {
  const reasons: string[] = [];
  if (asset.sources.some((item) => item.source === "asset")) {
    reasons.push("source includes asset");
  }
  if (asset.takeaways.some((item) => item.startsWith("asset:"))) {
    reasons.push("takeaways include asset");
  }
  if (asset.evidence.some((item) => item.source === "asset")) {
    reasons.push("evidence includes asset");
  }
  if (/\[(Pinned Asset|Memory Brief)\]/i.test(asset.summary)) {
    reasons.push("summary contains asset marker");
  }
  if (asset.reusableCandidates.some((item) => /\[(Pinned Asset|Memory Brief)\]/i.test(item))) {
    reasons.push("reusable candidate contains asset marker");
  }
  return reasons;
}

export function listDirtyBriefAssets(limit = 200): DirtyBriefAssetRecord[] {
  return listBriefAssets(limit)
    .map((asset) => {
      const reasons = detectDirtyBriefReasons(asset);
      return {
        ...asset,
        reasons,
        scope: `asset:brief:${asset.id.slice(0, 8)}`,
      };
    })
    .filter((asset) => asset.reasons.length > 0);
}

export function archiveDirtyBriefAsset(asset: DirtyBriefAssetRecord): string {
  const dir = getDirtyBriefArchiveDir();
  const targetPath = join(dir, basename(asset.path));
  renameSync(asset.path, targetPath);
  return targetPath;
}

export function listMemoryAssets(limit = 20): MemoryAssetRecord[] {
  const pins = listPinAssets(limit);
  const briefs = listBriefAssets(limit);
  return [...pins, ...briefs]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

export function writeExportArtifact(params: {
  query: string;
  profile: RetrievalProfileName;
  results: RetrievalResult[];
  summary: string;
  format: "md" | "json";
}): ExportArtifact {
  const dir = getExportsDir();
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const dateSlug = timestamp.replace(/[:]/g, "-").replace(/\..+/, "");
  const safeStem = params.query
    .toLowerCase()
    .replace(/[^a-z0-9\p{Script=Han}]+/giu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "memory-export";
  const filename = `${dateSlug}-${safeStem}.${params.format}`;
  const outputPath = join(dir, filename);

  const payload = {
    id,
    type: "memory-export",
    query: params.query,
    profile: params.profile,
    createdAt: timestamp,
    summary: params.summary,
    results: params.results.map(result => ({
      id: result.entry.id,
      scope: result.entry.scope,
      score: result.score,
      timestamp: result.entry.timestamp,
      text: result.entry.text,
      metadata: parseMetadata(result.entry),
      retrievalPath: retrievalPath(result),
    })),
  };

  if (params.format === "json") {
    writeFileSync(outputPath, JSON.stringify(payload, null, 2) + "\n");
  } else {
    const lines = [
      `# Memory Export`,
      "",
      `- Query: ${params.query}`,
      `- Profile: ${params.profile}`,
      `- Created: ${timestamp}`,
      `- Hits: ${params.results.length}`,
      "",
      `## Distilled Brief`,
      "",
      params.summary,
      "",
      `## Evidence`,
      "",
    ];

    params.results.forEach((result, index) => {
      const metadata = parseMetadata(result.entry);
      lines.push(`### ${index + 1}. ${titleFromText(result.entry.text)}`);
      lines.push("");
      lines.push(`- Memory ID: ${result.entry.id}`);
      lines.push(`- Scope: ${result.entry.scope}`);
      lines.push(`- Score: ${(result.score * 100).toFixed(0)}%`);
      lines.push(`- File: ${String(metadata.file || metadata.heading || "-")}`);
      lines.push(`- Date: ${new Date(result.entry.timestamp).toISOString()}`);
      lines.push(`- Retrieval: ${retrievalPath(result)}`);
      lines.push("");
      lines.push(result.entry.text);
      lines.push("");
    });

    writeFileSync(outputPath, lines.join("\n"));
  }

  return {
    id,
    type: "memory-export",
    query: params.query,
    profile: params.profile,
    createdAt: timestamp,
    format: params.format,
    outputPath,
  };
}

export function readPinAsset(pinIdOrFile: string): (PinAsset & { path: string }) | null {
  const dir = getPinsDir();
  const directPath = pinIdOrFile.endsWith(".json") ? pinIdOrFile : join(dir, `${pinIdOrFile}.json`);
  const candidates = existsSync(directPath)
    ? [directPath]
    : readdirSync(dir)
        .filter(name => name.endsWith(".json") && basename(name, ".json").startsWith(pinIdOrFile))
        .map(name => join(dir, name));

  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(`Ambiguous pin id prefix: ${pinIdOrFile}`);
  }

  const path = candidates[0];
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as PinAsset;
  return { ...parsed, path };
}

export function assetSummaryLine(asset: MemoryAsset): string {
  const scope = asset.type === "pinned-memory"
    ? asset.source.scope
    : asset.sources.map((item) => item.source).join(", ").slice(0, 24) || "brief";
  const kind = asset.type === "pinned-memory" ? "pin" : "brief";
  return `${asset.id.slice(0, 8)}  ${kind.padEnd(5)}  ${asset.title}  [${scope}]  ${asset.createdAt.slice(0, 10)}`;
}

export function pinSummaryLine(asset: PinAsset): string {
  return assetSummaryLine(asset);
}

function parseMarkdownExport(path: string): ExportArtifactRecord | null {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  const query = lines.find(line => line.startsWith("- Query: "))?.replace("- Query: ", "").trim() || "";
  const profile = (lines.find(line => line.startsWith("- Profile: "))?.replace("- Profile: ", "").trim() || "default") as RetrievalProfileName;
  const createdAt = lines.find(line => line.startsWith("- Created: "))?.replace("- Created: ", "").trim() || new Date(statSync(path).mtimeMs).toISOString();
  const briefIndex = lines.findIndex(line => line.trim() === "## Distilled Brief");
  let summary = "";
  if (briefIndex >= 0) {
    summary = lines.slice(briefIndex + 2, briefIndex + 12).join("\n").trim();
  }

  return {
    id: basename(path, extname(path)),
    type: "memory-export",
    query,
    profile,
    createdAt,
    format: "md",
    outputPath: path,
    summary,
    path,
  };
}

function parseJsonExport(path: string): ExportArtifactRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return {
      id: String(parsed.id || basename(path, extname(path))),
      type: "memory-export",
      query: String(parsed.query || ""),
      profile: String(parsed.profile || "default") as RetrievalProfileName,
      createdAt: String(parsed.createdAt || new Date(statSync(path).mtimeMs).toISOString()),
      format: "json",
      outputPath: path,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      path,
    };
  } catch {
    return null;
  }
}

export function listExportArtifacts(limit = 20): ExportArtifactRecord[] {
  const dir = getExportsDir();
  const files = readdirSync(dir)
    .filter(name => name.endsWith(".md") || name.endsWith(".json"))
    .map(name => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit);

  const items: ExportArtifactRecord[] = [];
  for (const path of files) {
    const parsed = path.endsWith(".json")
      ? parseJsonExport(path)
      : parseMarkdownExport(path);
    if (parsed) {
      items.push(parsed);
    }
  }
  return items;
}
