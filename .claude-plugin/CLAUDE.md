# RecallNest Memory Plugin

RecallNest is a local-first shared memory layer backed by LanceDB. It stores and recalls context across sessions, terminals, and agents (Claude Code, Codex, Gemini CLI).

**Prerequisite**: Requires [Bun](https://bun.sh) runtime. On first start, dependencies install automatically.

## Tool Quick Reference

| When | Tool | Purpose |
|------|------|---------|
| Session opens, user says continue/接着/上个窗口 | `resume_context` | Load stable context, latest checkpoint, recent cases |
| Before answering about prior work / known facts | `search_memory` | Targeted fact/pattern recall (2-3 key nouns) |
| After solving something significant | `store_memory` or `store_case` | Persist durable knowledge |
| Before closing a window with unfinished work | `checkpoint_session` | Save current state for next session |
| After discovering a reusable workflow | `store_workflow_pattern` | Persist as durable pattern |
| Memory feels stale or conflicted | `consolidate_memories` | Merge near-duplicates (dry-run by default) |

## Continuity Rules

- If the user says `continue`, `继续`, `接着`, `刚才`, `上个窗口`, `不要让我重复前情`, or asks where you stopped / what to do next — call `resume_context` before any Bash, Read, or repo exploration.
- If the user starts a concrete task in an active project or asks for prior implementation detail — do lightweight RecallNest recovery before repo exploration even without an explicit `continue`.
- Do not substitute `git status`, `git log`, or reading local docs for `resume_context`. Local inspection can validate current code state only **after** continuity has been recovered.
- When `scope` or `sessionId` is known, pass it into recall tools instead of relying on global recall.
- If `resume_context` returns a resolved scope or checkpoint scope, reuse that same scope in follow-up `search_memory`, `brief_memory`, `pin_memory` calls.
- If recalled context mentions repo state (modified files, pending push), treat it as **handoff context only** — do not restate as current state without verifying in this window.
- Before leaving a window with resumable work, call `checkpoint_session`. Do not include repo state claims unless you actually inspected the repo this window.
- Use `store_memory` for durable profile, preference, entity, or case knowledge.
- Use `store_workflow_pattern` for reusable multi-step workflows.
- If the user explicitly corrects a continuity miss, fix the workflow and call `workflow_observe` with `outcome: corrected`.
