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
      "date": "2026-03-04",
      "boundary": {
        "layer": "evidence",
        "authority": "transcript-ingest",
        "conflictPolicy": "append-only",
        "originalCategory": "cases"
      },
      "canonicalKey": null,
      "promotedFrom": null
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

Store a new durable memory entry.

> 存入长期记忆：适合 profile、preferences、entities、cases、patterns 这类跨窗口仍然有价值的信息。

**Request:**

```json
{
  "text": "User prefers code changes to be committed and pushed immediately",
  "category": "preferences",
  "source": "agent",
  "tags": ["workflow", "git"],
  "importance": 0.85
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | yes | — | Memory content |
| `category` | string | no | `"events"` | One of: `profile`, `preferences`, `entities`, `events`, `cases`, `patterns` |
| `source` | string | no | `"manual"` | One of: `manual`, `agent`, `api` |
| `scope` | string | no | `memory:{source}` | Optional scope override |
| `importance` | number | no | 0.7 | Importance score (0-1), affects decay and ranking |
| `tags` | string[] | no | `[]` | Optional tags, max 8 items |
| `canonicalKey` | string | no | derived from content | Optional stable key for dedupe/update semantics |

**Response:**

```json
{
  "id": "e5f6g7h8-...",
  "stored": true,
  "disposition": "stored",
  "storedAt": "2026-03-16T02:10:00.000Z",
  "category": "preferences",
  "scope": "memory:agent",
  "canonicalKey": "preferences:user-prefers-code-changes-to-be-committed-and-pushed-immediately"
}
```

If the same `canonicalKey` is already occupied by a different durable category, RecallNest returns `disposition = "conflict"` plus a `conflictId` instead of silently creating a second durable owner.

For atomic brand-item preferences such as `我喜欢吃麦当劳的麦辣鸡翅`, RecallNest now derives a slot-aware key like `preferences:brand-item:麦当劳:麦辣鸡翅` instead of collapsing everything into a broader same-topic key.

---

## Capture (Structured Batch Write)

```
POST /v1/capture
```

Store multiple structured memories in one request.

> 批量结构化写入：适合上层 agent 一次性提炼多条 durable memory 后统一写入。

**Request:**

```json
{
  "scope": "agent:codex",
  "source": "agent",
  "defaultImportance": 0.7,
  "memories": [
    {
      "text": "RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI",
      "category": "entities"
    },
    {
      "text": "Use search_memory at task start",
      "category": "patterns",
      "importance": 0.9,
      "tags": ["workflow", "memory"]
    }
  ]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `scope` | string | no | — | Default scope applied to items that do not specify one |
| `source` | string | no | `"agent"` | Default source for items that do not specify one |
| `defaultImportance` | number | no | 0.7 | Default importance for items that do not specify one |
| `memories` | array | yes | — | 1-20 structured memory items |

Each memory item supports:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | yes | — | Memory content |
| `category` | string | no | `"events"` | Durable memory category |
| `importance` | number | no | envelope default | Optional per-item override |
| `scope` | string | no | envelope scope or `memory:{source}` | Optional per-item override |
| `source` | string | no | envelope source | Optional per-item override |
| `tags` | string[] | no | `[]` | Optional tags |
| `canonicalKey` | string | no | derived from content | Optional stable key for dedupe/update semantics |

**Response:**

```json
{
  "stored": 2,
  "memories": [
    {
      "id": "a1b2c3d4-...",
      "text": "RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI",
      "category": "entities",
      "scope": "agent:codex",
      "source": "agent",
      "storedAt": "2026-03-16T02:11:00.000Z",
      "disposition": "stored",
      "canonicalKey": "entities:recallnest-is-the-shared-memory-layer-for-claude-code-codex-and-gemini-cli"
    }
  ]
}
```

Each item may also carry `disposition = "conflict"` and a `conflictId` when batch input reuses an existing `canonicalKey` under a different durable category.

---

## Pattern (Structured Workflow Capture)

```
POST /v1/pattern
```

Store a reusable workflow as durable `patterns` memory.

> 专门写 workflow pattern：适合把“什么时候用、怎么做、做完得到什么”这种可复用流程沉淀成高质量 `patterns` 记忆。

**Request:**

```json
{
  "title": "Cross-window continuity handoff",
  "trigger": "When opening a fresh terminal window for the same project",
  "steps": [
    "Call resume_context before coding",
    "Review stable context and latest checkpoint",
    "Save checkpoint_session before leaving the window"
  ],
  "outcome": "The next window recovers decisions and next actions faster",
  "tools": ["resume_context", "checkpoint_session"],
  "importance": 0.9,
  "source": "agent",
  "tags": ["continuity", "handoff"]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `title` | string | yes | — | Short workflow title |
| `trigger` | string | yes | — | When this workflow should be used |
| `steps` | string[] | yes | — | Ordered workflow steps, 1-8 items |
| `outcome` | string | no | — | Optional expected outcome |
| `tools` | string[] | no | `[]` | Optional tools, commands, or interfaces involved |
| `importance` | number | no | 0.82 | Importance score (0-1) |
| `scope` | string | no | `memory:{source}` | Optional scope override |
| `source` | string | no | `"agent"` | One of: `manual`, `agent`, `api` |
| `tags` | string[] | no | `[]` | Optional tags; `workflow` and `pattern` are auto-added |
| `canonicalKey` | string | no | derived from title | Optional stable key for dedupe/update semantics |

**Response:**

```json
{
  "id": "f0e1d2c3-...",
  "stored": true,
  "category": "patterns",
  "title": "Cross-window continuity handoff",
  "scope": "memory:agent",
  "tags": ["continuity", "handoff", "workflow", "pattern"],
  "storedAt": "2026-03-16T08:10:00.000Z"
}
```

---

## Case (Structured Problem-Solution Capture)

```
POST /v1/case
```

Store a reusable problem-solution case as durable `cases` memory.

> 专门写 problem-solution case：适合把“遇到什么问题、怎么解决、最后效果怎样”这种可复用经验沉淀成高质量 `cases` 记忆。

**Request:**

```json
{
  "title": "RecallNest sparse startup context cleanup",
  "problem": "resume_context was returning noisy transcript fragments instead of a clean project handoff",
  "context": "This happened in a fresh RecallNest window after continuity setup was already in place",
  "solutionSteps": [
    "Filter low-signal transcript fragments from stable recall",
    "Backfill stable context from checkpoint focus, summary, and decisions",
    "Use a lightweight task focus fallback only when no checkpoint-backed context is available"
  ],
  "outcome": "Fresh windows now recover cleaner RecallNest continuity context",
  "tools": ["resume_context", "checkpoint_session"],
  "importance": 0.9,
  "source": "agent",
  "tags": ["continuity", "startup-context"]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `title` | string | yes | — | Short case title |
| `problem` | string | yes | — | What problem happened |
| `context` | string | no | — | Optional context or preconditions |
| `solutionSteps` | string[] | yes | — | Ordered solution steps, 1-8 items |
| `outcome` | string | no | — | Optional result or resolution |
| `tools` | string[] | no | `[]` | Optional tools, commands, or interfaces involved |
| `importance` | number | no | 0.84 | Importance score (0-1) |
| `scope` | string | no | `memory:{source}` | Optional scope override |
| `source` | string | no | `"agent"` | One of: `manual`, `agent`, `api` |
| `tags` | string[] | no | `[]` | Optional tags; `case` and `solution` are auto-added |
| `canonicalKey` | string | no | derived from title | Optional stable key for dedupe/update semantics |

---

## Promote (Evidence -> Durable)

```
POST /v1/promote
```

Promote an evidence memory into durable memory.

> 显式升级：把 transcript / import evidence 中的高价值片段升级成 durable memory，而不是让 raw ingest 直接冒充长期事实。

**Request:**

```json
{
  "memoryId": "12345678-1234-1234-1234-123456789abc",
  "text": "User prefers concise, direct replies.",
  "category": "preferences",
  "canonicalKey": "user-reply-style",
  "tags": ["writing"]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `memoryId` | string | yes | — | Evidence memory ID or unique prefix |
| `text` | string | no | source text | Optional cleaned durable text |
| `category` | string | no | inferred from source | Target durable category |
| `importance` | number | no | 0.78 | Importance score (0-1) |
| `scope` | string | no | `memory:{source}` | Optional scope override |
| `source` | string | no | `"agent"` | Promotion source label |
| `tags` | string[] | no | `[]` | Optional tags |
| `canonicalKey` | string | no | derived from text | Optional stable key for dedupe/update semantics |

**Response:**

```json
{
  "id": "c0ffee00-...",
  "stored": true,
  "disposition": "promoted",
  "category": "preferences",
  "scope": "memory:agent",
  "sourceMemoryId": "12345678-1234-1234-1234-123456789abc",
  "sourceCategory": "events",
  "storedAt": "2026-03-16T02:20:00.000Z",
  "canonicalKey": "user-reply-style"
}
```

When a promotion would overwrite an existing durable memory with the same `canonicalKey`, RecallNest now creates an open conflict candidate instead of silently applying `latest-wins`.

The same slot-aware key inference also applies during promotion when `category = "preferences"` and the text is an atomic brand-item preference.

If the promotion resolves to the same atomic preference slot as the existing durable owner, RecallNest now collapses it onto that owner instead of opening a conflict. This currently applies to slot-aware brand-item preference keys such as `preferences:brand-item:麦当劳:麦辣鸡翅`.

```json
{
  "id": "baddcafe-...",
  "stored": false,
  "disposition": "conflict",
  "category": "preferences",
  "scope": "memory:agent",
  "sourceMemoryId": "12345678-1234-1234-1234-123456789abc",
  "sourceCategory": "events",
  "storedAt": "2026-03-16T02:20:00.000Z",
  "canonicalKey": "user-reply-style",
  "conflictId": "4f71a1f1-..."
}
```

Notes:

- `disposition = "promoted"` means a new durable memory was written
- `disposition = "deduped"` means the durable text already existed under the same `canonicalKey`
- `disposition = "conflict"` means RecallNest kept the existing durable memory and opened a review item

---

## Conflicts

### List / Inspect Conflicts

```
GET /v1/conflicts
GET /v1/conflicts?status=open&canonicalKey=user-reply-style&limit=10
GET /v1/conflicts?attention=stale&limit=10
GET /v1/conflicts?groupBy=cluster&attention=resolved&limit=10
GET /v1/conflicts?conflictId=4f71a1f1-...
```

List recent conflict candidates or fetch a single conflict record.

**List response:**

```json
{
  "groupBy": "record",
  "conflicts": [
    {
      "conflictId": "4f71a1f1-...",
      "status": "open",
      "reason": "promotion_conflicts_with_existing_durable",
      "canonicalKey": "user-reply-style",
      "category": "preferences",
      "reopenCount": 1,
      "lastReopenedAt": "2026-03-16T05:20:00.000Z",
      "lifecycle": {
        "attention": "aging",
        "openAgeDays": 1,
        "reopenCount": 1,
        "isOpen": true,
        "needsAttention": false
      },
      "advice": {
        "suggestedResolution": "keep_existing",
        "confidence": "medium",
        "similarity": 0.84,
        "clusterKey": "user-reply-style::promotion_conflicts_with_existing_durable::preferences",
        "clusterLabel": "preferences / user-reply-style",
        "reasons": [
          "Existing durable text already looks like the tighter rewrite."
        ]
      },
      "existing": {
        "memoryId": "baddcafe-...",
        "text": "User prefers concise, direct replies."
      },
      "incoming": {
        "sourceMemoryId": "12345678-1234-1234-1234-123456789abc",
        "text": "User prefers colloquial writing that stays grounded and non-salesy."
      }
    }
  ],
  "count": 1
}
```

**Cluster response:**

```json
{
  "groupBy": "cluster",
  "clusters": [
    {
      "clusterKey": "user-reply-style::promotion_conflicts_with_existing_durable::preferences",
      "clusterLabel": "preferences / user-reply-style",
      "canonicalKey": "user-reply-style",
      "category": "preferences",
      "reason": "promotion_conflicts_with_existing_durable",
      "totalCount": 3,
      "openCount": 1,
      "latestUpdatedAt": "2026-03-16T05:20:00.000Z",
      "latestConflictId": "4f71a1f1-...",
      "attentionCounts": {
        "fresh": 0,
        "aging": 1,
        "stale": 0,
        "escalated": 0,
        "resolved": 2
      },
      "suggestedResolution": "keep_existing",
      "confidence": "medium"
    }
  ],
  "count": 1
}
```

Query parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Optional raw status filter: `open`, `accepted-incoming`, `kept-existing` |
| `attention` | string | Optional lifecycle filter: `fresh`, `aging`, `stale`, `escalated`, `resolved` |
| `groupBy` | string | Optional output mode: `record` (default) or `cluster` |
| `canonicalKey` | string | Optional canonical key filter |
| `limit` | number | Max results, default `20` |
| `conflictId` | string | Fetch a single conflict by full ID or unique prefix |

`advice.mergeSuggestion` is optional. It appears only when RecallNest can derive a conservative merged wording suggestion for `manual_review` conflicts.

**Single conflict response:**

```json
{
  "conflict": {
    "conflictId": "4f71a1f1-...",
    "status": "open",
    "canonicalKey": "user-reply-style",
    "category": "preferences",
    "lifecycle": {
      "attention": "aging",
      "openAgeDays": 1,
      "reopenCount": 1,
      "isOpen": true,
      "needsAttention": false
    },
    "advice": {
      "suggestedResolution": "keep_existing",
      "confidence": "medium",
      "similarity": 0.84,
      "clusterKey": "user-reply-style::promotion_conflicts_with_existing_durable::preferences",
      "clusterLabel": "preferences / user-reply-style",
      "reasons": [
        "Existing durable text already looks like the tighter rewrite."
      ]
    }
  }
}
```

### Resolve Conflict

```
POST /v1/conflicts/resolve
```

Resolve an open conflict candidate by keeping the existing durable memory, accepting the incoming promoted text, or merging the two into a conservative durable rewrite.

**Request:**

```json
{
  "conflictId": "4f71a1f1-...",
  "resolution": "accept_incoming",
  "notes": "Incoming wording is cleaner."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `conflictId` | string | yes | Conflict candidate ID |
| `resolution` | string | yes | `accept_incoming`, `keep_existing`, or `merge` |
| `mergedText` | string | no | Optional merged durable wording when `resolution=merge`; otherwise RecallNest uses `advice.mergeSuggestion` when available |
| `notes` | string | no | Optional operator notes |

**Response:**

```json
{
  "conflictId": "4f71a1f1-...",
  "status": "accepted-incoming",
  "updatedAt": "2026-03-16T05:00:00.000Z",
  "resolvedAt": "2026-03-16T05:00:00.000Z",
  "updatedMemoryId": "baddcafe-..."
}
```

If you keep the existing durable memory, `updatedMemoryId` is omitted and the conflict status becomes `kept-existing`.
If you resolve with `merge`, the conflict status becomes `merged` and `updatedMemoryId` points to the rewritten durable memory that kept the same canonical owner.

### Conflict Audit

```
GET /v1/conflicts/audit
GET /v1/conflicts/audit?limit=100&top=5
GET /v1/conflicts/audit?canonicalKey=user-reply-style
```

Generate a terminal-friendly audit summary so stale or escalated clusters can be reviewed first.

**Response:**

```json
{
  "totalConflicts": 7,
  "totalClusters": 3,
  "openConflicts": 4,
  "openClusters": 2,
  "attentionCounts": {
    "fresh": 1,
    "aging": 1,
    "stale": 1,
    "escalated": 1,
    "resolved": 3
  },
  "priorityClusters": [
    {
      "clusterKey": "user-reply-style::promotion_conflicts_with_existing_durable::preferences",
      "clusterLabel": "preferences / user-reply-style",
      "canonicalKey": "user-reply-style",
      "category": "preferences",
      "reason": "promotion_conflicts_with_existing_durable",
      "totalCount": 4,
      "openCount": 2,
      "latestUpdatedAt": "2026-03-16T05:20:00.000Z",
      "latestConflictId": "4f71a1f1-...",
      "attention": "escalated",
      "suggestedResolution": "keep_existing",
      "confidence": "medium"
    }
  ],
  "suggestedActions": [
    "Resolve 1 escalated cluster(s) first."
  ]
}
```

Query parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Optional raw status filter: `open`, `accepted-incoming`, `kept-existing` |
| `canonicalKey` | string | Optional canonical key filter |
| `limit` | number | Max records to scan, default `100` |
| `top` | number | Max priority clusters to return, default `5` |

### Escalate Conflicts

```
POST /v1/conflicts/escalate
```

Preview or apply escalation metadata for `stale` / `escalated` open conflicts.

**Request:**

```json
{
  "attention": "stale",
  "limit": 100,
  "top": 10,
  "apply": false,
  "notes": "nightly escalation audit"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `attention` | string | no | `stale` or `escalated`, default `stale` |
| `canonicalKey` | string | no | Optional canonical key filter |
| `limit` | number | no | Max open conflicts to scan, default `100` |
| `top` | number | no | Max eligible conflicts to include, default `10` |
| `apply` | boolean | no | When `false`, preview only. When `true`, writes escalation metadata |
| `notes` | string | no | Optional operator note stored on escalated conflicts |

**Response:**

```json
{
  "apply": false,
  "scanned": 12,
  "eligible": 2,
  "escalated": 0,
  "skipped": 0,
  "items": [
    {
      "conflictId": "4f71a1f1-...",
      "canonicalKey": "user-reply-style",
      "attention": "stale",
      "openAgeDays": 4,
      "reopenCount": 1,
      "escalationCount": 0,
      "suggestedResolution": "manual_review",
      "confidence": "high",
      "action": "pending",
      "clusterKey": "user-reply-style::promotion_conflicts_with_existing_durable::preferences"
    }
  ]
}
```

---

## Checkpoint (Save Current Work State)

```
POST /v1/checkpoint
```

Store a session checkpoint outside the durable memory index.

> 保存当前工作状态：适合跨窗口延续任务，但不应该混入长期 durable memory。

**Request:**

```json
{
  "sessionId": "codex-2026-03-16-001",
  "scope": "agent:codex",
  "summary": "Implement session checkpoint storage",
  "decisions": ["Keep checkpoints out of LanceDB"],
  "openLoops": ["Need resume_context next"],
  "nextActions": ["Add checkpoint MCP tool"],
  "entities": ["RecallNest", "Codex"],
  "files": ["src/session-store.ts"]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `sessionId` | string | yes | — | Current session identifier |
| `scope` | string | no | `session:{sessionId}` | Optional shared scope |
| `summary` | string | yes | — | Compact summary of the current work state |
| `task` | string | no | — | Optional task label |
| `decisions` | string[] | no | `[]` | Key decisions already made |
| `openLoops` | string[] | no | `[]` | Unresolved questions or pending items |
| `nextActions` | string[] | no | `[]` | Next actions to take |
| `entities` | string[] | no | `[]` | Relevant projects, tools, or people |
| `files` | string[] | no | `[]` | Relevant files or paths |
| `updatedAt` | string | no | `now()` | Optional ISO timestamp override |

**Response:**

```json
{
  "sessionId": "codex-2026-03-16-001",
  "scope": "agent:codex",
  "summary": "Implement session checkpoint storage",
  "decisions": ["Keep checkpoints out of LanceDB"],
  "openLoops": ["Need resume_context next"],
  "nextActions": ["Add checkpoint MCP tool"],
  "entities": ["RecallNest", "Codex"],
  "files": ["src/session-store.ts"],
  "updatedAt": "2026-03-16T09:30:00.000Z"
}
```

---

## Resume (Compose Startup Context)

```
POST /v1/resume
```

Compose startup context for a fresh window by combining stable durable memory, relevant patterns and cases, plus the latest checkpoint for a session or scope.

> 为新窗口编排上下文：返回的是组合后的连续性上下文，不是原始检索结果堆积。

**Request:**

```json
{
  "task": "Implement startup continuity for fresh windows",
  "scope": "agent:codex",
  "sessionId": "codex-2026-03-16-001",
  "limitPerSection": 3,
  "includeLatestCheckpoint": true,
  "profile": "default"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `task` | string | no | — | Optional current task or question to bias recall |
| `scope` | string | no | — | Optional shared scope for project or terminal continuity |
| `sessionId` | string | no | — | Optional session identifier used to recover the latest checkpoint |
| `limitPerSection` | number | no | 3 | Max items returned per section (1-6) |
| `includeLatestCheckpoint` | boolean | no | `true` | Whether to include the latest checkpoint summary |
| `profile` | string | no | `"default"` | Retrieval profile: `default`, `writing`, `debug`, `fact-check` |

**Response:**

```json
{
  "summary": "Loaded 3 stable context item(s), 2 pattern(s), and 1 case(s). Latest checkpoint from codex-2026-03-16-001 on 2026-03-16: Implement startup continuity for fresh windows.",
  "stableContext": [
    "Profile: User builds local-first memory systems.",
    "Preference: User prefers concise technical replies.",
    "Entity: RecallNest is shared across Claude Code, Codex, and Gemini CLI."
  ],
  "relevantPatterns": [
    "At task start, run search_memory before coding."
  ],
  "recentCases": [
    "Keep session state in a checkpoint store instead of the durable index."
  ],
  "latestCheckpoint": {
    "sessionId": "codex-2026-03-16-001",
    "summary": "Implement startup continuity for fresh windows",
    "updatedAt": "2026-03-16T05:00:00.000Z"
  },
  "generatedAt": "2026-03-16T05:10:00.000Z",
  "profile": "default"
}
```

---

## Latest Checkpoint

```
GET /v1/checkpoint/latest
```

Fetch the latest checkpoint for a given `sessionId` or `scope`.

> 获取最新 checkpoint：适合调试当前工作状态是否已写入，也可以和 `POST /v1/resume` 配合使用。

Query params:

| Param | Required | Description |
|-------|----------|-------------|
| `sessionId` | no | Filter by session ID |
| `scope` | no | Filter by shared scope |

**Response:**

```json
{
  "checkpoint": {
    "sessionId": "codex-2026-03-16-001",
    "summary": "Implement session checkpoint storage",
    "updatedAt": "2026-03-16T03:20:00.000Z",
    "checkpointId": "b1c2d3e4-...",
    "resolvedScope": "agent:codex"
  }
}
```

If nothing matches:

```json
{
  "checkpoint": null
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
      "boundary": {
        "layer": "durable",
        "authority": "structured-memory",
        "conflictPolicy": "latest-wins",
        "originalCategory": "patterns"
      },
      "canonicalKey": "patterns:cross-window-continuity-handoff",
      "promotedFrom": null,
      "sources": { "vector": { "score": 0.85, "rank": 1 }, "bm25": { "score": 0.7, "rank": 3 } }
    }
  ],
  "query": "API authentication patterns",
  "profile": "fact-check",
  "count": 1
}
```

Derived provenance fields:

| Field | Type | Description |
|-------|------|-------------|
| `boundary` | object \| null | Parsed boundary metadata: `layer`, `authority`, `conflictPolicy`, and optional `originalCategory` / `downgradedFrom` |
| `canonicalKey` | string \| null | Stable dedupe/update key if the memory has one |
| `promotedFrom` | object \| null | Present when a durable memory was explicitly promoted from evidence; includes source `memoryId`, `scope`, `category`, `source`, and source `boundary` |

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
