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
  /** 按 id 批量取真实向量。list()/listPage() 为性能恒返回 vector:[]（假空数组），
   *  任何要做相似度/聚类的消费者必须用这个回填——promote_scan 与 dream 3b 都栽过同一坑。 */
  getVectors(ids: string[]): Promise<Map<string, number[]>>;
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
  /** metadata 读改写的单写通道(per-id 串行队列)。新代码改 metadata 一律走这里,
   *  不要 getById+update 裸 RMW(并发覆盖)。 */
  patchMetadata(
    id: string,
    patchFn: (meta: Record<string, unknown>, entry: MemoryEntry) => Record<string, unknown>,
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null>;
  vectorSearch(vector: number[], limit?: number, minScore?: number, scopeFilter?: string[]): Promise<MemorySearchResult[]>;
}
