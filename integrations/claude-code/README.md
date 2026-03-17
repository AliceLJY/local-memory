# Claude Code Integration

> Claude Code 接入指南：配 MCP + 安装 continuity 规则，让 CC 在新窗口里主动恢复稳定上下文。

## Quick Start

```bash
# One-click setup (idempotent, safe to re-run)
bash integrations/claude-code/setup.sh

# Seed the canonical continuity baseline into your local memory store
bun run seed:continuity
```

This does two things:

1. **Adds RecallNest MCP server** to `~/.claude.json`
2. **Installs a managed RecallNest block** in `~/.claude/CLAUDE.md`

## What You Get

After setup, Claude Code gains access to these MCP tools:

| Tool | Description |
|------|-------------|
| `search_memory` | Search past conversations by semantic similarity |
| `memory_stats` | Show memory index statistics |
| `brief_memory` | Generate a brief summary of a topic |
| `distill_memory` | Distill and consolidate related memories |
| `pin_memory` | Pin important memories for permanent retention |
| `explain_memory` | Explain what RecallNest knows about a topic |
| `export_memory` | Export memories to markdown |
| `checkpoint_session` | Save the current active work state before switching windows |
| `latest_checkpoint` | Inspect the latest saved checkpoint by session or scope |
| `resume_context` | Compose startup context for a fresh window |
| `store_memory` | Store durable cross-window knowledge |
| `store_workflow_pattern` | Store reusable workflows as durable patterns |

## Continuity Rules

The setup script installs [claude-md-snippet.md](claude-md-snippet.md) into your global `~/.claude/CLAUDE.md` inside a managed block.

Re-run `setup.sh` after upgrading RecallNest if you want the managed block refreshed.

The installed rules tell Claude Code to:

- call `resume_context` at the start of fresh windows or continuity-sensitive tasks
- use `search_memory` only as a follow-up when a specific detail is needed
- treat repo-state text recalled through `resume_context` as unverified handoff context until current-window repo tools confirm it
- save `checkpoint_session` before leaving resumable work
- avoid writing `git status` / modified-file claims into `checkpoint_session` unless the repo was inspected in the current window
- never copy unverified repo-state text into `checkpoint_session`, even if it is labeled as recalled or unverified
- promote durable facts with `store_memory` and reusable workflows with `store_workflow_pattern`

## Manual Setup

If you prefer to configure manually:

### 1. Add MCP Server

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "recallnest": {
      "command": "bun",
      "args": ["run", "RECALLNEST_PATH/src/mcp-server.ts"],
      "env": {}
    }
  }
}
```

Replace `RECALLNEST_PATH` with your actual RecallNest directory (e.g., `/Users/you/recallnest`).

### 2. Add Rules

Copy [claude-md-snippet.md](claude-md-snippet.md) into `~/.claude/CLAUDE.md` or your project `CLAUDE.md`.

### 3. Verify

Restart Claude Code, then ask: "resume my context for RecallNest continuity work"

If `resume_context` or `search_memory` is called and returns results, you're set.

## Headless Smoke Test

If you want a non-interactive acceptance check, run:

```bash
bun run smoke:claude-continuity
```

What it does:

- runs `claude -p` in fresh-window style prompts
- pre-allows `resume_context` / `checkpoint_session` so `dontAsk` mode can still use RecallNest MCP tools
- prints `[smoke]` phase markers so the slower checkpoint case is visible while it runs
- saves raw `stream-json` artifacts under `/tmp/recallnest-claude-smoke-*`
- fails if `Read` / `Bash` / `Grep` / `Glob` show up before `resume_context`
- records `workflow_observe` success / missed / failure signals into the dedicated observation store by default

Outside smoke, normal managed continuity usage now records workflow observations too:

- MCP / HTTP `resume_context` calls append a `managed` success observation automatically
- MCP / HTTP `checkpoint_session` calls append a `managed` success observation automatically
- if `checkpoint_session` had to sanitize repo-state text, the automatic observation is `corrected` with signal `repo-state-sanitized`
- if the user explicitly corrects a continuity miss, the managed snippet now tells the agent to call `workflow_observe` after fixing the flow

Requirements:

- `claude` CLI is installed and already authenticated
- RecallNest MCP is installed via `setup.sh`
- your local memory store has baseline continuity data, usually via `bun run seed:continuity`

This smoke test validates tool order and checkpoint writes. Treat any free-text repo-state claims in Claude's reply as unverified unless the saved JSONL also shows matching repo tools.
If the warning points at `resume_context`, the likely source is an older checkpoint that already contained speculative repo-state text; write a fresh checkpoint after verifying the repo if you want to flush that inherited handoff.
RecallNest now sanitizes repo-state text out of saved `checkpoint_session` output, so a raw checkpoint request that still mentions `git status` stays a warning, while a saved checkpoint that still contains repo-state text remains a failure.
The checkpoint case is usually slower than the continue case because Claude needs to finish both `resume_context` and `checkpoint_session`; the phase markers make that visible so a 30-90s run does not look like a hung process.
Set `RECALLNEST_RECORD_WORKFLOW_OBSERVATIONS=0` if you want to skip writing smoke observations, or override the default scope with `RECALLNEST_CC_SMOKE_SCOPE=project:your-scope`.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `search_memory` or `resume_context` not found | Restart CC after editing `~/.claude.json` |
| Empty results | Run `bun run ingest --source all`, then `bun run seed:continuity` to load the canonical continuity baseline |
| Fresh windows still feel stateless | Check that `~/.claude/CLAUDE.md` contains the `recallnest-continuity` managed block |
| `lm doctor` warns that continuity baseline is missing | Run `bun run seed:continuity` from the RecallNest repo root |
| MCP connection error | Check that `bun` is in your PATH and RecallNest path is correct |
