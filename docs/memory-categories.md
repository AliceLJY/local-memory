# Memory Categories

> 6 类分类体系：RecallNest 自动将每条记忆归入 6 个类别之一，便于过滤和差异化管理。

## The Six Categories

RecallNest classifies every memory into one of six categories. Classification happens automatically during ingestion using keyword heuristics and (optionally) LLM-based analysis.

| Category | What It Stores | Examples | Consolidation |
|----------|---------------|----------|---------------|
| **profile** | Who the user is — role, background, identity | "Data scientist with 5 years experience", "Works at Acme Corp" | Merge (latest wins) |
| **preferences** | How the user likes things done | "Prefers TDD", "Uses Bun over Node", "Commit after every change" | Merge (latest wins) |
| **entities** | Named things — projects, tools, people, repos | "Project X uses LanceDB", "Bob handles DevOps" | Merge (accumulate) |
| **events** | Things that happened — incidents, decisions, milestones | "Migrated to AWS on 2026-01-15", "Bot crashed due to OOM" | Append (dedup only) |
| **cases** | Debugging stories, troubleshooting workflows | "Fixed Docker crash by increasing memory limit", "API timeout was caused by DNS" | Append (dedup only) |
| **patterns** | Recurring techniques, best practices, anti-patterns | "Always grep callers after API change", "Use mv to Trash, never rm" | Merge (refine) |

---

## Why Categories Matter

### 1. Smarter Search

Filter by category to reduce noise:

```bash
# MCP: search only debugging cases
search_memory("Docker crash", category="cases")

# HTTP API: same thing
curl -X POST localhost:4318/v1/search \
  -d '{"query": "Docker crash", "category": "cases"}'
```

> 按类别过滤能显著减少噪音：搜 debug 问题时只看 cases，搜用户偏好时只看 preferences。

### 2. Different Lifecycle Rules

Not all memories age the same way:

- **profile** and **preferences**: Slow decay — identity and habits change slowly
- **events**: Medium decay — historical facts stay relevant for months
- **cases**: Medium decay — debugging patterns remain useful
- **patterns**: Slow decay — best practices persist
- **entities**: Fast update — project details change frequently

### 3. Consolidation Strategy

Merge-type categories (profile, preferences, entities, patterns) benefit from periodic consolidation — combining 5 similar entries into 1 refined one.

Append-type categories (events, cases) keep distinct entries but remove exact duplicates.

---

## Classification Rules

### Automatic (Keyword Heuristics)

During ingestion, RecallNest scans for signal words:

| Signal | Category |
|--------|----------|
| "I am", "my role", "background", "experience" | `profile` |
| "prefer", "always", "never", "like to", "style" | `preferences` |
| Names, URLs, project names, tool names | `entities` |
| Dates, "happened", "decided", "migrated", "shipped" | `events` |
| "fixed", "debugged", "root cause", "workaround", "error" | `cases` |
| "pattern", "best practice", "rule", "always do", "anti-pattern" | `patterns` |

### Manual Override

When storing via API, you can specify the category explicitly:

```json
POST /v1/store
{
  "text": "Always run tests before pushing",
  "category": "patterns"
}
```

If omitted, defaults to `"events"`.

---

## Category Distribution

A healthy memory index typically looks like:

```
events     ████████████████████████  45%
cases      ████████████             20%
entities   ████████                 15%
patterns   ██████                   10%
preferences ███                      5%
profile    ██                        5%
```

Check yours with:

```bash
curl http://localhost:4318/v1/stats
# or via MCP: memory_stats
```

> 如果某个类别占比异常（比如 events 占了 90%），说明分类规则可能需要调优。
