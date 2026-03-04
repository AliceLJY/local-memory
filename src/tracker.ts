/**
 * 增量更新追踪器 — 记录已处理的文件，避免重复 ingest
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const TRACKER_PATH = resolve(import.meta.dir, "../data/ingested-files.json");

interface TrackerData {
  files: Record<string, { ingestedAt: string; size: number; chunks: number; mtimeMs?: number }>;
}

function load(): TrackerData {
  if (!existsSync(TRACKER_PATH)) {
    return { files: {} };
  }
  try {
    return JSON.parse(readFileSync(TRACKER_PATH, "utf-8"));
  } catch {
    return { files: {} };
  }
}

function save(data: TrackerData): void {
  writeFileSync(TRACKER_PATH, JSON.stringify(data, null, 2));
}

export function isProcessed(filePath: string, fileSize: number, mtimeMs?: number): boolean {
  const data = load();
  const entry = data.files[filePath];
  if (!entry) return false;
  // Re-process if file size or mtime changed
  if (entry.size !== fileSize) return false;
  if (mtimeMs !== undefined && entry.mtimeMs !== undefined && entry.mtimeMs !== mtimeMs) return false;
  return true;
}

export function markProcessed(filePath: string, fileSize: number, chunks: number, mtimeMs?: number): void {
  const data = load();
  data.files[filePath] = {
    ingestedAt: new Date().toISOString(),
    size: fileSize,
    chunks,
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
  };
  save(data);
}

export function getStats(): { totalFiles: number; totalChunks: number } {
  const data = load();
  let totalChunks = 0;
  for (const entry of Object.values(data.files)) {
    totalChunks += entry.chunks;
  }
  return { totalFiles: Object.keys(data.files).length, totalChunks };
}
