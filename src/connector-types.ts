/**
 * Connector Standard Types (connector-v1)
 *
 * 定义外部数据源（Obsidian、Email、RSS、自定义脚本）统一产出的 JSON 格式。
 * ingest.ts 的 ingestConnectorFile 消费这个格式，走已有的 dedup/extract/入库管线。
 *
 * 协议版本管理：version 字段用于未来兼容性。当前固定 "connector-v1"。
 */

export interface ConnectorOutputV1 {
  /** 格式版本，固定 "connector-v1" */
  version: "connector-v1";
  /** 数据源标识，如 "obsidian", "email", "rss", "x-bookmarks" */
  source: string;
  /** 目标 scope，如 "vault:my-notes", "project:research" */
  scope: string;
  /** 批次 ID（可选，用于幂等重试） */
  batchId?: string;
  /** 产出时间 ISO 8601 */
  producedAt: string;
  /** 记录列表 */
  records: ConnectorRecord[];
}

export interface ConnectorRecord {
  /** 记录唯一 ID（source 内唯一，用于增量去重） */
  id: string;
  /** 正文 */
  text: string;
  /** 标题/heading（可选） */
  title?: string;
  /** 分类提示：preferences / events / knowledge / facts / decisions */
  categoryHint?: string;
  /** 重要性提示 0-1（可选，默认 0.7） */
  importanceHint?: number;
  /** 标签 */
  tags?: string[];
  /** 原始时间戳 ISO 8601 */
  timestamp?: string;
  /** 内容哈希（用于增量同步，调用方计算） */
  contentHash?: string;
  /** 来源元数据（自由字段） */
  sourceMetadata?: Record<string, unknown>;
}

/** 运行时格式验证：判定一个 parsed JSON 是否是合法 connector-v1 */
export function isConnectorOutputV1(value: unknown): value is ConnectorOutputV1 {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.version === "connector-v1"
    && typeof obj.source === "string"
    && typeof obj.scope === "string"
    && typeof obj.producedAt === "string"
    && Array.isArray(obj.records)
  );
}
