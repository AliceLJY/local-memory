# RecallNest HTTP API Reference

> HTTP API 文档：所有端点的请求/响应格式。服务默认监听 `127.0.0.1:4318`。

Base URL: `http://localhost:4318`

All endpoints accept and return JSON. Set `Content-Type: application/json` for POST requests.

---

## Health Check

```
GET /v1/health
```

Returns server status.

**Response:**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "totalMemories": 1247,
  "timestamp": "2026-03-15T10:00:00.000Z"
}
```

---

## Recall (Quick Search)

```
POST /v1/recall
```

Semantic search across all memories. Best for quick, conversational lookups.

> 主动回忆：用关键词搜索相关记忆，返回按相关度排序的结果。

**Request:**

```json
{
  "query": "Docker bot debugging",
  "limit": 5,
  "minScore": 0.5
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query (2-3 key nouns work best) |
| `limit` | number | no | 5 | Max results (1-20) |
| `minScore` | number | no | 0 | Minimum relevance score (0-1). 0 = no filter |
| `category` | string | no | — | Filter: `profile`, `preferences`, `entities`, `events`, `cases`, `patterns` |
| `profile` | string | no | `"default"` | Retrieval profile: `default`, `writing`, `debug`, `fact-check` |

**Response:**

```json
{
  "results": [
    {
      "id": "a1b2c3d4",
      "text": "Docker bot crash troubleshooting: check logs first with docker logs...",
      "category": "cases",
      "tier": "core",
      "source": "cc",
      "scope": "cc:a1b2c3d4",
      "score": 0.87,
      "date": "2026-03-04"
    }
  ],
  "query": "Docker bot debugging",
  "profile": "default",
  "totalMemories": 1247
}
```

---

## Store

```
POST /v1/store
```

Store a new memory entry.

> 存入新记忆：agent 在对话中发现重要信息时调用。

**Request:**

```json
{
  "text": "User prefers code changes to be committed and pushed immediately",
  "category": "preferences",
  "source": "my-agent",
  "importance": 0.85
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | yes | — | Memory content |
| `category` | string | no | `"events"` | One of: `profile`, `preferences`, `entities`, `events`, `cases`, `patterns`. Invalid values fall back to `events`. |
| `source` | string | no | `"api"` | Identifier for the source agent/system. Stored as scope `api:{source}`. |
| `importance` | number | no | 0.7 | Importance score (0-1), affects decay and ranking |

**Response:**

```json
{
  "id": "e5f6g7h8-...",
  "stored": true
}
```

---

## Search (Advanced)

```
POST /v1/search
```

Advanced search with full metadata, retrieval path details, and scope filtering.

> 高级搜索：返回完整元数据、检索路径、重要度等详情。

**Request:**

```json
{
  "query": "API authentication patterns",
  "limit": 5,
  "category": "patterns",
  "profile": "fact-check"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query |
| `limit` | number | no | 5 | Max results (1-20) |
| `category` | string | no | — | Filter: `profile`, `preferences`, `entities`, `events`, `cases`, `patterns` |
| `profile` | string | no | `"default"` | Retrieval profile: `default`, `writing`, `debug`, `fact-check` |
| `scope` | string | no | — | Filter by source scope (e.g. `cc`, `codex`, `api:my-agent`) |
| `minScore` | number | no | 0 | Minimum relevance score (0-1) |

**Response:**

```json
{
  "results": [
    {
      "id": "a1b2c3d4-...",
      "text": "Authentication pattern: use JWT with...",
      "category": "patterns",
      "scope": "cc:abc12345",
      "score": 0.82,
      "importance": 0.8,
      "timestamp": 1741219200000,
      "date": "2026-03-06",
      "metadata": { "source": "cc", "tier": "working", "file": "..." },
      "sources": { "vector": { "score": 0.85, "rank": 1 }, "bm25": { "score": 0.7, "rank": 3 } }
    }
  ],
  "query": "API authentication patterns",
  "profile": "fact-check",
  "count": 1
}
```

---

## Stats

```
GET /v1/stats
```

Memory index statistics.

**Response:**

```json
{
  "totalMemories": 35176,
  "byScope": {
    "cc:abc12345": 773,
    "memory": 974,
    "codex:019ccbe4": 277
  },
  "byCategory": {
    "fact": 31582,
    "events": 1546,
    "cases": 1337,
    "entities": 455,
    "patterns": 156,
    "preferences": 65,
    "profile": 26
  }
}
```

> Note: `byScope` shows raw scope keys. Use `byCategory` for the 6-category distribution.

---

## Consolidate (Phase 3 — not yet implemented)

```
POST /v1/consolidate
```

> This endpoint is planned for Phase 3 (self-evolution). See [docs/self-evolution.md](self-evolution.md) for the design.

---

## Gaps (Phase 3 — not yet implemented)

```
GET /v1/gaps
```

> This endpoint is planned for Phase 3 (self-evolution). See [docs/self-evolution.md](self-evolution.md) for the design.

---

## Error Responses

All endpoints return errors in this format:

```json
{
  "error": "Description of what went wrong"
}
```

| HTTP Status | Meaning |
|-------------|---------|
| 400 | Bad request (missing required fields, invalid values) |
| 404 | Endpoint not found |
| 500 | Internal server error |
| 503 | Service unavailable (health check failed) |

---

## Quick Test

```bash
# Health check
curl http://localhost:4318/v1/health

# Recall
curl -X POST http://localhost:4318/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "Docker debugging", "limit": 3}'

# Store
curl -X POST http://localhost:4318/v1/store \
  -H "Content-Type: application/json" \
  -d '{"text": "Test memory entry", "category": "events"}'

# Advanced search with category filter
curl -X POST http://localhost:4318/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query": "debugging", "category": "cases", "profile": "debug"}'

# Stats
curl http://localhost:4318/v1/stats
```
