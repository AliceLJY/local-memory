# GB-1 + GB-2 实施计划

> GBrain 借鉴项 1（Obsidian Vault 接入）+ 项 2（Connector 标准规范）
> 目标仓库：`~/Projects/memory-lancedb-pro/recallnest/`
> 基线：1428 tests / 0 fail

---

## 现状摘要

| 组件 | 位置 | 现状 |
|------|------|------|
| `conversation-importer.ts` | `src/` | 5 种格式检测 (claude-code/claude-ai/chatgpt/slack/plaintext)，`NormalizedMessage` 类型 |
| `ingest.ts` | `src/` | `parseMarkdown()` 按 heading 切分，无 Obsidian 感知；`buildIngestedEntry()` 构建入库条目 |
| `tracker.ts` | `src/` | 增量追踪器，`isProcessed(path, size, mtime)` |
| `mcp-server.ts` | `src/` | `import_conversations` tool 走 conversation-importer |
| `cli.ts` | `src/` | `ingest` 命令调 ingestCCTranscripts / ingestMarkdownFiles 等 |

---

## GB-2: Connector 标准规范（先做，因为 GB-1 会复用）

### 设计

定义一个 ConnectorOutput 标准 JSON 格式（connector-v1），所有外部数据源（Obsidian、Email、RSS、自定义脚本）统一产出这个格式，ingest.ts 只需消费一种格式。

```typescript
// src/connector-types.ts（新文件）

/** connector-v1 标准格式 */
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
```

### 改动文件清单

| # | 文件 | 改动 | 说明 |
|---|------|------|------|
| 2.1 | `src/connector-types.ts` | 新建 | ConnectorOutputV1 + ConnectorRecord 类型定义 |
| 2.2 | `src/conversation-importer.ts` | 改 | ConversationFormat 加 "connector-v1"；detectFormat() 识别；新增 normalizeConnectorV1() |
| 2.3 | `src/ingest.ts` | 改 | 新增 ingestConnectorFile() 函数 |
| 2.4 | `src/mcp-server.ts` | 改 | import_conversations tool 的 format enum 加 "connector-v1" |
| 2.5 | `src/__tests__/connector-v1.test.ts` | 新建 | connector-v1 格式检测 + normalize + ingest 测试 |
| 2.6 | `docs/connector-spec.md` | 新建 | 规范文档（给外部 connector 作者看） |

### 代码片段

2.2 conversation-importer.ts — detectFormat 扩展：

```typescript
// ConversationFormat 加一个值
export type ConversationFormat =
  | "claude-code"
  | "claude-ai"
  | "chatgpt"
  | "slack"
  | "plaintext"
  | "connector-v1";  // 新增

// detectFormat() 里 JSON 对象分支内，最前面加：
if (parsed.version === "connector-v1" && Array.isArray(parsed.records)) {
  return "connector-v1";
}
```

2.2 conversation-importer.ts — normalizeConnectorV1：

```typescript
import type { ConnectorOutputV1 } from "./connector-types.js";

export function normalizeConnectorV1(content: string): NormalizedMessage[] {
  const parsed: ConnectorOutputV1 = JSON.parse(content);
  return parsed.records.map((r) => ({
    role: "user" as const,
    content: r.title ? `[${r.title}] ${r.text}` : r.text,
    timestamp: r.timestamp,
  }));
}
```

2.3 ingest.ts — ingestConnectorFile：

```typescript
import type { ConnectorOutputV1 } from "./connector-types.js";

export async function ingestConnectorFile(
  store: MemoryStore,
  embedder: Embedder,
  content: string,  // raw JSON string
  options: { verbose?: boolean; noDedup?: boolean; llm?: LLMClient | null } = {},
): Promise<IngestResult> {
  const parsed: ConnectorOutputV1 = JSON.parse(content);
  const { source, scope, records } = parsed;

  const result: IngestResult = {
    source,
    filesProcessed: 1,
    chunksIngested: 0,
    chunksSkipped: 0,
    chunksDeduped: 0,
    dedupReasonCounts: createDedupReasonCounts(),
    errors: [],
  };

  const batchSize = 32;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const texts = batch.map((r) => r.title ? `[${r.title}] ${r.text}` : r.text);

    try {
      const vectors = await embedder.embedBatchPassage(texts);

      for (let j = 0; j < batch.length; j++) {
        const record = batch[j];
        const vector = vectors[j];
        if (!vector || vector.length === 0) {
          result.chunksSkipped++;
          continue;
        }

        // dedup
        if (!options.noDedup) {
          const decision = await dedupCheck(store, vector, texts[j], options.llm);
          recordDedupDecision(result, decision);
          if (decision.secondaryDeletes?.length) {
            await executeSecondaryDeletes(store, decision.secondaryDeletes);
          }
          if (decision.action === "skip") continue;
        }

        // smart extract + build entry
        const [extraction] = await smartExtractBatch([texts[j]], options.llm);
        const [coreSummary] = await generateCoreSummaries([texts[j]], options.llm);

        const entry = buildIngestedEntry({
          source: `connector:${source}`,
          scope,
          text: texts[j],
          vector,
          extraction,
          file: record.id,
          heading: record.title,
          coreSummary,
        });

        // 把 connector 元数据合入 metadata
        const meta = JSON.parse(entry.metadata);
        if (record.tags?.length) meta.connectorTags = record.tags;
        if (record.contentHash) meta.contentHash = record.contentHash;
        if (record.sourceMetadata) meta.sourceMetadata = record.sourceMetadata;
        entry.metadata = JSON.stringify(meta);

        // 尊重 categoryHint
        if (record.categoryHint) {
          entry.category = record.categoryHint;
        }
        // 尊重 importanceHint
        if (record.importanceHint !== undefined) {
          entry.importance = record.importanceHint;
        }

        await store.store(entry);
        result.chunksIngested++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Connector batch error: ${msg}`);
    }
  }

  return result;
}
```

---

## GB-1: Obsidian Vault 接入

### 设计

Obsidian vault 是本地 markdown 文件夹，特征：
1. `.obsidian/` 目录存在
2. `[[wikilink]]` 双向链接
3. YAML frontmatter（`---` 包裹的元数据）
4. 目录结构有语义（文件夹 = 主题域）

方案：写 `obsidian-connector.ts`，读取 vault 产出 ConnectorOutputV1，交给 ingestConnectorFile() 消费。Obsidian 是 connector 规范的第一个消费者。

### 改动文件清单

| # | 文件 | 改动 | 说明 |
|---|------|------|------|
| 1.1 | `src/obsidian-connector.ts` | 新建 | vault 扫描：检测 vault、递归读 .md、解析 frontmatter + wikilink、产出 ConnectorOutputV1 |
| 1.2 | `src/ingest.ts` | 改 | 新增 ingestObsidianVault() 包装函数 |
| 1.3 | `src/cli.ts` | 改 | ingest 命令加 --obsidian vault-path 子命令 |
| 1.4 | `src/__tests__/obsidian-connector.test.ts` | 新建 | vault 检测 + frontmatter + wikilink + scope 映射 + hash 测试 |

### 核心函数设计

1.1 obsidian-connector.ts：

```typescript
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import type { ConnectorOutputV1, ConnectorRecord } from "./connector-types.js";

// --- Vault 检测 ---
export function isObsidianVault(dirPath: string): boolean {
  return existsSync(join(dirPath, ".obsidian"));
}

// --- YAML Frontmatter 解析 ---
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

export interface ObsidianFrontmatter {
  tags?: string[];
  aliases?: string[];
  [key: string]: unknown;
}

export function parseFrontmatter(content: string): {
  frontmatter: ObsidianFrontmatter | null;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: content };

  const yamlBlock = match[1];
  const body = content.slice(match[0].length).trimStart();

  // 简易 YAML 解析：key: value 和 list（- item）
  const fm: ObsidianFrontmatter = {};
  let currentKey: string | null = null;
  let listAccum: string[] = [];

  function flushList() {
    if (currentKey && listAccum.length > 0) {
      fm[currentKey] = listAccum;
      listAccum = [];
    }
    currentKey = null;
  }

  for (const line of yamlBlock.split("\n")) {
    const listItem = line.match(/^\s+-\s+(.+)/);
    if (listItem && currentKey) {
      listAccum.push(listItem[1].trim());
      continue;
    }

    const kv = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (kv) {
      flushList();
      const [, key, val] = kv;
      const trimVal = val.trim();
      if (trimVal === "" || trimVal === "[]") {
        currentKey = key;
        listAccum = [];
      } else if (trimVal.startsWith("[") && trimVal.endsWith("]")) {
        // inline list: [a, b, c]
        fm[key] = trimVal.slice(1, -1).split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
      } else {
        fm[key] = trimVal;
      }
    }
  }
  flushList();

  return {
    frontmatter: Object.keys(fm).length > 0 ? fm : null,
    body,
  };
}

// --- Wikilink 提取 ---
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface WikiLink {
  target: string;
  displayText?: string;
}

export function extractWikiLinks(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    links.push({
      target: match[1].trim(),
      ...(match[2] ? { displayText: match[2].trim() } : {}),
    });
  }
  return links;
}

// --- 内容哈希 ---
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// --- Vault 扫描 → ConnectorOutputV1 ---
export function scanVault(vaultPath: string, options?: {
  scopePrefix?: string;
  excludeDirs?: string[];
}): ConnectorOutputV1 {
  const vaultName = basename(vaultPath);
  const scopePrefix = options?.scopePrefix ?? `vault:${vaultName}`;
  const defaultExclude = [".obsidian", ".trash", ".git", "node_modules"];
  const excludeDirs = new Set(options?.excludeDirs ?? defaultExclude);

  const records: ConnectorRecord[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (excludeDirs.has(entry.name)) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        const raw = readFileSync(full, "utf-8");
        if (raw.trim().length < 30) continue; // skip near-empty

        const { frontmatter, body } = parseFrontmatter(raw);
        const wikiLinks = extractWikiLinks(body);
        const relPath = relative(vaultPath, full);
        const folder = dirname(relPath);

        const tags: string[] = [];
        if (frontmatter?.tags) {
          const fmTags = Array.isArray(frontmatter.tags)
            ? frontmatter.tags
            : [String(frontmatter.tags)];
          tags.push(...fmTags.map((t) => String(t)));
        }
        for (const link of wikiLinks) {
          tags.push(`link:${link.target}`);
        }
        if (folder !== ".") {
          tags.push(`folder:${folder}`);
        }

        records.push({
          id: `obsidian:${relPath}`,
          text: body,
          title: basename(entry.name, ".md"),
          tags,
          contentHash: contentHash(raw),
          timestamp: new Date(statSync(full).mtimeMs).toISOString(),
          sourceMetadata: {
            vaultPath,
            relativePath: relPath,
            ...(frontmatter ? { frontmatter } : {}),
            ...(wikiLinks.length > 0 ? { wikiLinks } : {}),
          },
        });
      }
    }
  }

  walk(vaultPath);

  return {
    version: "connector-v1",
    source: "obsidian",
    scope: scopePrefix,
    producedAt: new Date().toISOString(),
    records,
  };
}
```

1.2 ingest.ts — ingestObsidianVault 包装：

```typescript
import { isObsidianVault, scanVault } from "./obsidian-connector.js";

export async function ingestObsidianVault(
  store: MemoryStore,
  embedder: Embedder,
  vaultPath: string,
  options: { verbose?: boolean; noDedup?: boolean; llm?: LLMClient | null; scopePrefix?: string } = {},
): Promise<IngestResult> {
  const resolved = expandHome(vaultPath);

  if (!isObsidianVault(resolved)) {
    return {
      source: "obsidian",
      filesProcessed: 0,
      chunksIngested: 0,
      chunksSkipped: 0,
      chunksDeduped: 0,
      dedupReasonCounts: createDedupReasonCounts(),
      errors: [`Not an Obsidian vault (missing .obsidian/ directory): ${resolved}`],
    };
  }

  const output = scanVault(resolved, { scopePrefix: options.scopePrefix });
  const content = JSON.stringify(output);

  if (options.verbose) {
    console.log(`  obsidian: scanned ${output.records.length} notes from ${resolved}`);
  }

  return ingestConnectorFile(store, embedder, content, options);
}
```

Wikilink 实体关联：wikilinks 作为 link:target 标签存入 metadata.connectorTags，检索时可用 tag filter 找互相链接的笔记。KG 模式开启时 link: 标签可转为三元组。

Scope 映射：vault 整体用 vault:vault-name 作为 scope，子文件夹通过 folder:path 标签区分。

增量同步：每个文件算 SHA-256 前 16 位作为 contentHash，ingestConnectorFile 层通过 contentHash 跳过相同内容。

---

## 实施顺序

```
GB-2.1  新建 src/connector-types.ts（纯类型）
GB-2.2  改 src/conversation-importer.ts（加 connector-v1 格式）
GB-2.3  改 src/ingest.ts（加 ingestConnectorFile）
GB-2.4  改 src/mcp-server.ts（format enum 加 connector-v1）
GB-2.5  新建 src/__tests__/connector-v1.test.ts
GB-2.6  新建 docs/connector-spec.md
  |
GB-1.1  新建 src/obsidian-connector.ts
GB-1.2  改 src/ingest.ts（加 ingestObsidianVault 包装）
GB-1.3  改 src/cli.ts（加 --obsidian 子命令）
GB-1.4  新建 src/__tests__/obsidian-connector.test.ts
  |
bun test（确认 >= 1428 pass / 0 fail）
```

## 不做的事

- 不引入 yaml 库 — frontmatter 用简易解析，解析失败兜底返回 null 不阻塞
- 不做实时 watch — 首版只做一次性扫描 + contentHash 增量
- 不改现有 ingestMarkdownFiles — 它处理 RecallNest 自己的 memory .md 文件，和 Obsidian vault 是不同入口
- 不做 Obsidian 插件 — connector 是 CLI 端的
- 不处理 Obsidian embed 语法 (![[embed]]) 和块引用 — 只处理 [[target]] 和 [[target|display]]

## 风险

| 风险 | 缓解 |
|------|------|
| YAML frontmatter 格式多样 | 简易解析 + 兜底（失败返回 null） |
| 大 vault（10K+ 文件）性能 | 顺序处理 + contentHash 保证重跑不重入 |
| wikilink 复杂语法 | 只处理两种基本形式 |
| ingestConnectorFile 内 contentHash 去重需要查库 | 首版走 metadata grep，后续可加 hash 索引列 |
