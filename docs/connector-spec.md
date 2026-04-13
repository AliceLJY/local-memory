# RecallNest Connector Specification (connector-v1)

## Overview

The connector-v1 format is the standard interface for feeding external data into RecallNest. Any external script, service, or integration can produce a JSON file in this format, and RecallNest will consume it through its existing ingest pipeline (dedup, embedding, smart extraction, tiered storage).

**Design philosophy**: RecallNest's core engine stays lean. External connectors handle data fetching and normalization; RecallNest handles memory quality (dedup, decay, governance, retrieval).

## JSON Schema

```json
{
  "version": "connector-v1",
  "source": "obsidian",
  "scope": "vault:my-notes",
  "batchId": "batch-2026-04-13-001",
  "producedAt": "2026-04-13T12:00:00Z",
  "records": [
    {
      "id": "obsidian:notes/meeting-2026-04-13.md",
      "text": "Meeting with team about Q2 goals...",
      "title": "Q2 Planning Meeting",
      "categoryHint": "events",
      "importanceHint": 0.8,
      "tags": ["meeting", "q2", "link:Team-Goals"],
      "timestamp": "2026-04-13T10:00:00Z",
      "contentHash": "a1b2c3d4e5f67890",
      "sourceMetadata": {
        "filePath": "notes/meeting-2026-04-13.md",
        "frontmatter": { "tags": ["meeting"] }
      }
    }
  ]
}
```

## Field Reference

### Top-level

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | `"connector-v1"` | Yes | Fixed version string for format detection |
| `source` | string | Yes | Data source identifier (e.g. `"obsidian"`, `"email"`, `"rss"`) |
| `scope` | string | Yes | Target scope for all records (e.g. `"vault:my-notes"`, `"project:research"`) |
| `batchId` | string | No | Batch identifier for idempotent retry |
| `producedAt` | string (ISO 8601) | Yes | When this payload was generated |
| `records` | ConnectorRecord[] | Yes | Array of records to ingest |

### ConnectorRecord

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique ID within the source (used for incremental tracking) |
| `text` | string | Yes | Main content to be stored and embedded |
| `title` | string | No | Title or heading (prepended as `[title]` in stored text) |
| `categoryHint` | string | No | Suggested category: `preferences`, `events`, `knowledge`, `facts`, `decisions` |
| `importanceHint` | number (0-1) | No | Suggested importance score (default: extracted by LLM or 0.7) |
| `tags` | string[] | No | Tags stored in metadata as `connectorTags` |
| `timestamp` | string (ISO 8601) | No | Original creation/modification time |
| `contentHash` | string | No | Content hash for incremental sync (skip if unchanged) |
| `sourceMetadata` | object | No | Arbitrary metadata from the source (stored as-is in entry metadata) |

## Ingest Behavior

1. **Format detection**: `detectFormat()` identifies connector-v1 by checking `version === "connector-v1"` and `Array.isArray(records)`. Takes highest priority among object-type formats.

2. **Incremental sync**: If `contentHash` is present, RecallNest stores it in entry metadata. Future versions may use this for pre-embedding dedup.

3. **Dedup**: Each record goes through the standard two-stage dedup pipeline (vector pre-filter + optional LLM semantic decision).

4. **Category/importance**: If `categoryHint` or `importanceHint` are provided, they override the LLM-extracted values. Otherwise, smart extraction determines them.

5. **Tags**: `tags` are stored in `metadata.connectorTags` (separate from RecallNest's internal tags to avoid namespace collision).

6. **Scope**: All records share the top-level `scope`. To ingest records into different scopes, produce separate connector-v1 payloads.

## Writing a Connector

A connector is any script that produces a connector-v1 JSON file. Minimal example in TypeScript:

```typescript
import { writeFileSync } from "node:fs";

const output = {
  version: "connector-v1",
  source: "my-app",
  scope: "project:my-app",
  producedAt: new Date().toISOString(),
  records: [
    {
      id: "note-001",
      text: "User prefers dark mode and compact layout",
      title: "UI Preferences",
      categoryHint: "preferences",
      importanceHint: 0.9,
      tags: ["ui", "preferences"],
    },
  ],
};

writeFileSync("my-connector-output.json", JSON.stringify(output, null, 2));
```

Then feed it to RecallNest:

```bash
# Via CLI
recallnest ingest --connector my-connector-output.json

# Via MCP tool
# Use import_conversations with format="connector-v1" and content=<file contents>
```

## Built-in Connectors

| Connector | Source | Description |
|-----------|--------|-------------|
| `obsidian-connector` | `obsidian` | Scans an Obsidian vault, extracts frontmatter + wikilinks, maps folder structure to tags |

## Versioning

The `version` field enables future format evolution. RecallNest will:
- Accept `"connector-v1"` indefinitely (no breaking changes within v1)
- Future v2 will be a separate format, not a replacement
- Unknown versions are rejected with a clear error message
