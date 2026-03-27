# Pull Claude Desktop Conversations into RecallNest

Date: 2026-03-23

## Goal

One script to pull all historical Claude Desktop / claude.ai conversations and convert them into RecallNest's ingest format, so `lm ingest` can process them through the existing pipeline (noise filter, dedup, LLM extraction, 6-category classification).

## Script

`~/recallnest/scripts/pull-claude-desktop.ts` (Bun runtime)

## Authentication

- `CLAUDE_SESSION_KEY` env var (from browser DevTools → Application → Cookies → claude.ai → `sessionKey`)
- Also accept `--session-key` CLI flag

## Data Flow

```
sessionKey → GET /api/organizations → orgId
           → GET /api/organizations/{orgId}/chat_conversations (paginated, 50/page)
           → for each conversation:
               GET .../chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true
               → parse branches → extract latest branch message chain
               → convert to CC transcript .jsonl
               → write to data/desktop-import/{conversationId}.jsonl
```

## Output Format

Each conversation becomes one `.jsonl` file with entries matching CC transcript schema:

```jsonl
{"type":"user","message":{"role":"user","content":"text"},"sessionId":"conv-uuid","timestamp":"2025-01-15T10:00:00Z"}
{"type":"assistant","message":{"role":"assistant","content":"reply"},"sessionId":"conv-uuid","timestamp":"2025-01-15T10:00:01Z"}
```

## Output Directory

```
data/desktop-import/
  .sync-state.json
  {conversation-id}.jsonl
  ...
```

## Sync State (Resumable)

`.sync-state.json` tracks:

```json
{
  "lastSyncedAt": "ISO8601",
  "conversations": {
    "conv-id": {
      "messageCount": 42,
      "updatedAt": "ISO8601",
      "pulledAt": "ISO8601"
    }
  }
}
```

Re-run skips conversations whose `updatedAt` hasn't changed since last pull.

## Branch Handling

Claude web conversations support branching (edit/retry). The script extracts only the latest branch by walking `parent_message_uuid` chain from the most recent message backward.

## Rate Limiting

- 200ms delay between conversation detail requests
- On 429 or 5xx: exponential backoff starting at 1s, max 3 retries
- On auth failure (401/403): abort immediately with clear message

## Error Handling

- Single conversation failure does not abort the batch
- Failed conversations logged and reported in final summary
- Summary output: total conversations, pulled, skipped (already synced), failed

## Ingest Integration

After pulling, user runs:

```bash
lm ingest --source cc
```

Need to verify that ingest scans `data/desktop-import/` or that the path is configurable. If not, the script will symlink or copy files to the CC transcript directory.

## Dependencies

- Only Bun built-ins (fetch, fs, path) — no new npm packages
