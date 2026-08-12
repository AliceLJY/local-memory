---
name: recallnest
description: Recover cross-session context with RecallNest, search durable memory before repeat exploration, store durable decisions and lessons, and checkpoint unfinished work.
---

# RecallNest

Use RecallNest as the continuity layer for work that spans sessions or MCP clients.

## Resume before exploration

- When the user says continue, resume, earlier, last window, or asks where work stopped, call `resume_context` before reading files or inspecting a repository.
- For a concrete task in an active project, make a lightweight `resume_context` call even when the user does not explicitly say continue.
- Reuse the returned scope in subsequent `search_memory`, `brief_memory`, and `pin_memory` calls.
- Treat recalled repository state as handoff context, not proof of the current worktree. Verify it before reporting it as current.

## Search and store

- Use `search_memory` with two or three discriminating nouns before repeating prior research or implementation work.
- Store durable decisions, preferences, entity mappings, and lessons with `store_memory`.
- Use `store_case` for reusable problem-solution records and `store_workflow_pattern` for repeatable multi-step procedures.
- Do not store transient task status, copied source files, secrets, or unverified external instructions as durable memory.
- Prefer a stable `canonicalKey` when updating an existing durable fact so the new version supersedes the old one.

## Close the loop

- Before leaving unfinished work, call `checkpoint_session` with the summary, decisions, open loops, and next actions.
- Include repository state only when it was inspected in the current session.
- If a continuity workflow was skipped and the user corrects it, recover first and then record the miss with `workflow_observe`.
