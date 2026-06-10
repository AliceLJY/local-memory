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
  /** DB 层真分页(where/limit/offset 下推),全库维护扫描用;list() 是全量拉取再切片。 */
  listPage(opts?: {
    scopeFilter?: string[];
    category?: string;
    limit?: number;
    offset?: number;
    includeVector?: boolean;
  }): Promise<MemoryEntry[]>;
  get(id: string, scopeFilter?: string[]): Promise<MemoryEntry | null>;
  getById(id: string): Promise<MemoryEntry | null>;
  store(entry: Omit<MemoryEntry, "id" | "timestamp"> & { id?: string }): Promise<MemoryEntry>;
  update(id: string, updates: MemoryStoreUpdate, scopeFilter?: string[]): Promise<MemoryEntry | null>;
  vectorSearch(vector: number[], limit?: number, minScore?: number, scopeFilter?: string[]): Promise<MemorySearchResult[]>;
}
