# Architecture

> 架构总览：RecallNest 的分层设计，从接入层到存储层。

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Client Layer                           │
├──────────┬──────────┬──────────┬──────────┬─────────────────┤
│ Claude   │ Gemini   │ Codex    │ Custom   │ curl / any      │
│ Code     │ CLI      │          │ Agents   │ HTTP client     │
└────┬─────┴────┬─────┴────┬─────┴────┬─────┴────┬────────────┘
     │          │          │          │          │
     └──── MCP (stdio) ───┘          └── HTTP ──┘
                │                        │
                ▼                        ▼
┌─────────────────────────────────────────────────────────────┐
│                     Integration Layer                        │
├────────────────────────┬────────────────────────────────────┤
│    MCP Server          │       HTTP API Server               │
│    (mcp-server.ts)     │       (api-server.ts)               │
│                        │       port 4318                     │
│  Tools:                │                                     │
│  - search_memory       │  Endpoints:                         │
│  - memory_stats        │  - POST /v1/recall                  │
│  - brief_memory        │  - POST /v1/store                   │
│  - distill_memory      │  - POST /v1/search                  │
│  - pin_memory          │  - GET  /v1/stats                   │
│  - explain_memory      │  - GET  /v1/health                  │
│  - export_memory       │  - POST /v1/consolidate             │
│                        │  - GET  /v1/gaps                    │
└────────────┬───────────┴──────────────┬─────────────────────┘
             │                          │
             ▼                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      Core Engine                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Retriever   │  │  Classifier  │  │  Query Expander    │  │
│  │ (hybrid:     │  │ (6 categories│  │  (synonym +        │  │
│  │  vector +    │  │  auto-assign)│  │   semantic expand) │  │
│  │  BM25 + RRF) │  │              │  │                    │  │
│  └──────┬───────┘  └──────────────┘  └────────────────────┘  │
│         │                                                    │
│  ┌──────┴───────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Decay       │  │  Access      │  │  Noise Filter      │  │
│  │  Engine      │  │  Tracker     │  │  (relevance        │  │
│  │  (Weibull)   │  │  (use it or  │  │   threshold)       │  │
│  │              │  │   lose it)   │  │                    │  │
│  └──────────────┘  └──────────────┘  └────────────────────┘  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐                          │
│  │ Consolidator │  │ Gap Detector │   ← Self-Evolution       │
│  │ (merge/dedup)│  │ (find blind  │                          │
│  │              │  │  spots)      │                          │
│  └──────────────┘  └──────────────┘                          │
│                                                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     Storage Layer                            │
├─────────────────────────┬───────────────────────────────────┤
│  LanceDB               │  Jina Embeddings                   │
│  (vector + columnar)    │  (v5, 1024-dim)                    │
│                         │                                    │
│  Tables:                │  Task-aware:                       │
│  - memories (main)      │  - retrieval.query (for searches)  │
│  - access_log           │  - retrieval.passage (for docs)    │
│  - search_log           │                                    │
└─────────────────────────┴───────────────────────────────────┘
```

## Data Flow

### Ingestion Pipeline

```
Source Files                    Processing                  Storage
─────────────                  ──────────                  ───────

CC transcripts ─┐
                │   ┌──────────────────┐   ┌───────────┐
Codex sessions ─┼──►│  Chunker         │──►│ Embedder  │──► LanceDB
                │   │  (split by turn, │   │ (Jina v5) │
Gemini chats ───┤   │   noise filter)  │   └───────────┘
                │   └──────────────────┘
Memory .md ─────┘         │
                          ▼
                   ┌──────────────┐
                   │ Classifier   │
                   │ (6 categories│
                   │  + tier)     │
                   └──────────────┘
```

> 入库流程：多源文件 → 分块 → 过滤噪音 → 分类 → 嵌入向量 → 存入 LanceDB

### Search Pipeline

```
Query                                               Results
─────                                               ───────

"Docker debugging"
    │
    ▼
┌──────────────┐    ┌──────────────┐    ┌───────────────┐
│ Query        │───►│ Hybrid       │───►│ Post-process  │──► Top-K
│ Expander     │    │ Retrieval    │    │               │   Results
│ (synonyms)   │    │              │    │ - Decay       │
└──────────────┘    │ Vector: 0.7  │    │ - Access boost│
                    │ BM25:   0.3  │    │ - Score floor │
                    │ RRF merge    │    │ - Dedup       │
                    └──────────────┘    └───────────────┘
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **LanceDB** (not SQLite/Postgres) | Native vector search, columnar storage, zero-config, single-file DB |
| **Jina v5** (not OpenAI embeddings) | Task-aware embeddings (query vs passage), better multilingual, 1024-dim sweet spot |
| **Hybrid retrieval** (vector + BM25) | Vector alone misses keyword matches; BM25 alone misses semantic similarity |
| **RRF fusion** | Reciprocal Rank Fusion is parameter-free and robust across score distributions |
| **Weibull decay** (not exponential) | Better models human forgetting: slow start, accelerating fade |
| **6 categories** (not free-form tags) | Structured enough for filtering and lifecycle rules, simple enough to auto-classify |
| **HTTP API + MCP** (not just MCP) | MCP is great for CLI tools, but HTTP API works with any language/framework |
| **Bun runtime** | Fast startup, native TypeScript, good for CLI tools and local servers |

## File Map

```
src/
├── api-server.ts          # HTTP API server (port 4318)
├── mcp-server.ts          # MCP server (stdio transport)
├── cli.ts                 # CLI entry point (lm command)
├── store.ts               # LanceDB storage layer
├── retriever.ts           # Hybrid retrieval (vector + BM25 + RRF)
├── embedder.ts            # Jina embedding client
├── ingest.ts              # Multi-source ingestion pipeline
├── chunker.ts             # Text chunking with noise filtering
├── decay-engine.ts        # Weibull time decay
├── access-tracker.ts      # "Use it or lose it" tracking
├── noise-filter.ts        # Low-quality content filter
├── query-expander.ts      # Query expansion (synonyms)
├── retrieval-profiles.ts  # 4 search profiles (precision/balanced/exploratory/recent)
├── memory-output.ts       # Output formatting
├── memory-assets.ts       # Brief/pin/export asset management
├── asset-sync.ts          # Asset indexing
├── runtime-config.ts      # Config loading
├── llm-client.ts          # LLM client for smart extraction
├── doctor.ts              # Health check diagnostics
├── adaptive-retrieval.ts  # Adaptive retrieval strategies
├── stderr-log.ts          # Logging
├── tracker.ts             # Ingestion tracker (incremental)
└── __tests__/             # Test suite
```
