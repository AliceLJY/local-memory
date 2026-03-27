# RecallNest Ingest Pipeline Upgrade: Conversation Fragments → Knowledge Extraction

**Date**: 2026-03-19
**Status**: Approved
**Scope**: Route B (bulk distillation) + Route A (pipeline default change)

## Problem

29,984 total records; 23,453 (78.2%) are `fact` category — raw conversation slices (`[助手]`/`[用户]` prefixed) with no knowledge extraction. This is the root cause of 96.7% dead memory rate.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Disposition | New + Archive (B) | Preserve originals for traceability; ~5K new records is not bloat |
| Extraction model | Reuse `smartExtractBatch()` (C) | Already has 6-category prompt + scoring; no new wheel |
| Batch strategy | Dry-run then batch+checkpoint (C→B) | Verify quality first, then fault-tolerant batch |

## Route B: Bulk Distillation

### New file: `scripts/distill-facts.ts`

**Modes**:
- `--dry-run`: Process 1 session (~30-50 facts), print results for human review
- Default: Process all sessions with checkpoint

**Pipeline per batch (20 texts)**:
1. `smartExtractBatch(texts)` → `SmartExtraction[]` (category, importance, l0, l1)
2. `embedBatchPassage(extractedTexts)` → vectors
3. Dedup against existing non-fact records (cosine > 0.80 → skip)
4. Store new records: `boundary.layer = "durable"`, `boundary.authority = "distillation"`
5. Archive originals: metadata += `{ archived: true, archivedAt, distilledTo: [ids] }`
6. Write checkpoint: `data/distill-progress.json` (scope → done/skip)

**Expected output**: 23K facts → ~3K-5K structured knowledge (5:1 to 8:1 compression)

### Archive marking

```json
{
  "archived": true,
  "archivedAt": "2026-03-19T10:00:00Z",
  "distilledTo": ["uuid-1", "uuid-2"],
  "originalCategory": "fact"
}
```

## Route A: Pipeline Default Change

### Changes to `src/ingest.ts`

1. `smartExtractBatch()` becomes **default** (was opt-in via `--llm`)
2. New `--no-llm` flag for fallback mode
3. LLM failure → don't store raw slice; queue to `data/pending-extraction.json`
4. Next `lm ingest` auto-retries pending queue

**Core principle**: Better to skip than to store garbage.

### Changes to `src/retriever.ts`

- Default filter: exclude `archived = true` from search results
- New `includeArchived` parameter for traceability queries

## Cost Estimate

~1,173 LLM calls (20 texts/batch), ~4.1M input + ~1.2M output tokens.
GPT-4o-mini: ~$1.3 | Gemini Flash: ~$0.7 | Claude Haiku: ~$8

## Files to create/modify

| File | Action |
|------|--------|
| `scripts/distill-facts.ts` | Create — bulk distillation script |
| `src/ingest.ts` | Modify — flip smartExtract default |
| `src/retriever.ts` | Modify — archived filter |
| `data/distill-progress.json` | Auto-created at runtime |
| `data/pending-extraction.json` | Auto-created at runtime |
