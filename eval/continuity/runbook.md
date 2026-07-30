# Continuity Eval Runbook

## Goal

Measure whether a fresh window can recover stable background through `resume_context`, instead of depending on manual reminders.

## Command

```bash
bun run eval:continuity
```

If you also want the continuity eval run to emit workflow observations into the dedicated observation store, use:

```bash
bun run eval:continuity --record-observations --observation-scope eval:continuity
```

Generate a dated markdown report:

```bash
bun run src/eval.ts --mode continuity \
  --cases eval/continuity/cases.json \
  --output eval/continuity/results-YYYY-MM-DD.md
```

Generate JSON for tooling:

```bash
bun run src/eval.ts --mode continuity \
  --cases eval/continuity/cases.json \
  --json \
  --output /tmp/recallnest-continuity.json
```

## What To Check

- Pass rate
- Average score
- Which cases only recover `stableContext`
- Which cases still fail on `relevantPatterns` or `recentCases`
- Whether a checkpoint is present when `scope` or `sessionId` is provided

## Before Running

1. Confirm your normal memory index is available.
2. Seed the canonical workflow patterns if you want continuity eval to use durable `patterns` memory instead of only fallback logic:

```bash
bun run seed:patterns
```

3. Seed the continuity cases and stable project memories if you want project continuity cases to use durable `cases` / `entities` instead of only task fallback:

```bash
bun run seed:continuity
```

4. If you want to test checkpoint-aware continuity, write a checkpoint first with `checkpoint_session` or `POST /v1/checkpoint`.
5. Keep the cases file small and high-signal. Four to eight cases is enough.

## Claude Code Smoke Test

Use this when you want a real Claude Code acceptance check instead of only local eval fixtures:

```bash
bun run smoke:claude-continuity
```

This headless smoke test:

- runs `claude -p` with a fresh-window `继续 RecallNest` prompt
- verifies `resume_context` appears before any visible repo exploration tools
- runs a second prompt that requires `checkpoint_session`
- stores raw `stream-json` artifacts under `/tmp/recallnest-claude-smoke-*`
- writes success / missed / failure workflow observations into `data/workflow-observations` by default

Notes:

- the script pre-allows RecallNest MCP tools because non-interactive `dontAsk` mode otherwise denies them
- the script prints `[smoke] Running continue case...` and `[smoke] Running checkpoint case...` so the slower checkpoint path is visible while it runs
- use the saved JSONL artifacts as the source of truth for tool order
- if Claude's prose mentions repo state without matching `Read` / `Bash` / `Grep` / `Glob` events, treat that as an inference, not a verified observation
- if the warning points at `resume_context`, the inherited source is usually an older checkpoint summary; overwrite it with a clean checkpoint after you actually inspect the repo
- the smoke script now fails if `checkpoint_session` itself writes repo-state claims without visible repo tools, because that contaminates later continuity handoffs
- qualified copies still count: `git status ... but not verified in this window` is still a failure if no repo tool ran in that window
- RecallNest now strips repo-state text from saved checkpoint content, so a raw `checkpoint_session` request with repo-state text is a warning, but the saved checkpoint output must stay clean
- set `RECALLNEST_RECORD_WORKFLOW_OBSERVATIONS=0` if you only want JSONL artifacts without writing workflow observations
- the checkpoint case can take materially longer than the continue case because it waits for both `resume_context` and `checkpoint_session`; that slower path is expected and is not the same thing as a lingering zombie process

## After Running

1. Save the markdown report into `eval/continuity/results-YYYY-MM-DD.md`.
2. Compare it with the previous run instead of eyeballing one score in isolation.
3. If a case fails, decide which layer is missing:
   - capture gap
   - checkpoint gap
   - composition gap
   - retrieval gap

## Reading Failures

- Stable context missing:
  durable memories are not strong enough yet
- Patterns missing:
  reusable workflow knowledge has not been promoted enough
- Cases missing:
  solved problems are still trapped in raw transcripts
- Checkpoint missing:
  active work state was not written for the tested `scope` or `sessionId`
