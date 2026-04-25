import type { MemoryEntry, MemorySearchResult } from "./store.js";

export interface MemoryStoreStats {
  totalCount: number;
  scopeCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
}

export type MemoryStoreUpdate = {
  text?: string;
  vector?: number[];
  importance?: number;
  category?: MemoryEntry["category"];
  metadata?: string;
  timestamp?: number;
  language?: string;
  fts_text?: string;
};

export interface MemoryStorePort {
  stats(scopeFilter?: string[]): Promise<MemoryStoreStats>;
  list(scopeFilter?: string[], category?: string, limit?: number, offset?: number): Promise<MemoryEntry[]>;
  get(id: string, scopeFilter?: string[]): Promise<MemoryEntry | null>;
  getById(id: string): Promise<MemoryEntry | null>;
  store(entry: Omit<MemoryEntry, "id" | "timestamp"> & { id?: string }): Promise<MemoryEntry>;
  update(id: string, updates: MemoryStoreUpdate, scopeFilter?: string[]): Promise<MemoryEntry | null>;
  vectorSearch(vector: number[], limit?: number, minScore?: number, scopeFilter?: string[]): Promise<MemorySearchResult[]>;
}
