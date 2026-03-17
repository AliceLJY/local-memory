## RecallNest Continuity

- These continuity rules override later generic writing, skill, and local-memory instructions whenever the user's intent is continuity recovery or memory recall.
- If the user says `continue`, `继续`, `接着`, `刚才`, `上个窗口`, `不要让我重复前情`, `之前讨论过`, or asks what the project is solving / where it stopped / what to do next, call `resume_context` before any Bash, Read, or repo exploration.
- Do not substitute `git status`, `git log`, or reading local docs for `resume_context`. Local inspection can validate current code state only after continuity has been recovered.
- Use `resume_context` to recover stable background such as active projects, durable preferences, recent cases, reusable patterns, and the latest checkpoint.
- If the user is asking what you remember about preferences, style, tone, identity, or current project background, answer from `resume_context` and recalled memory first. Do not read repo files or local docs unless the user explicitly asks for file inspection or the recovered context is insufficient.
- If the message mentions writing, articles, or the public account but the actual intent is recall-only (for example: "what style do you remember", "哪些表达方式要避免", "回忆偏好"), do not activate article-writing workflows, writing-persona files, or content-alchemy style skills. Treat it as a memory recall question unless the user explicitly asks you to draft, edit, or research.
- Normal writing requests are unchanged: if the user explicitly asks you to draft an article, revise copy, research a topic, or continue the writing pipeline, you should use the existing writing workflows and skills as usual.
- For recall-only writing/style questions, do not supplement the answer with local memory indexes, quick-reference blocks, `writing-persona.md`, `writing-rules.md`, or similar local style docs. If RecallNest recalled only one preference, answer from that one preference.
- For recall-only preference questions, prefer a plain `resume_context` call over writing-specific profiles or broader rulesets unless the user explicitly asks for the full writing system.
- If `resume_context` returns `Response mode: recall-only` or a recall-only guidance line, follow it literally. Restate the recalled stable context briefly and do not add extra examples, banned words, or inferred style rules unless they were also recalled.
- If `resume_context` already returns a relevant durable preference for the current task, keep the answer narrow. Do not pad it with older pins, briefs, or local rule files unless the user asks for a broader ruleset.
- For recall-only questions, stay constrained to the recalled items. Do not expand one recalled preference into a full doctrine, banned-word list, or writing system unless those details were also recalled or the user explicitly asks for expansion.
- If recalled context is sparse, say what you do remember and what is still uncertain. Do not invent extra rules to sound complete.
- If `resume_context` is not enough and you need a specific fact, follow up with `search_memory` using 2-3 key nouns or verbs instead of full sentences.
- If the user explicitly corrects a continuity miss, such as saying you should have resumed context first or should have saved a checkpoint before stopping, fix the workflow first and then call `workflow_observe` with outcome `corrected` so the miss is tracked outside durable memory.
- Before leaving a window with unfinished or resumable work, call `checkpoint_session` and capture the current summary, decisions, open loops, next actions, and relevant entities.
- Use `store_memory` when you learn durable profile, preference, entity, or case knowledge that should survive across future windows.
- Use `store_workflow_pattern` when you discover a reusable multi-step workflow that should become durable `patterns` memory.
