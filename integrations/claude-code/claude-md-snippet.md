# RecallNest Memory Rules for CLAUDE.md

> 把下面这段复制粘贴到你的 CLAUDE.md 里，CC 就会自动搜索记忆。

Copy everything below the `---` line into your `CLAUDE.md`:

---

## Memory Retrieval (RecallNest)

- **Proactive search**: At the start of every task, use `search_memory` with key nouns from the user's message. Do NOT wait for the user to ask.
- **When to search**: Starting new tasks, debugging, writing, making decisions, referencing past work, or when context from prior conversations would help.
- **Query strategy**: Use 2-3 key nouns/verbs, not full sentences. For broad topics, search twice with different angles.
- **Act on results**: Integrate recalled memories into your response naturally — don't just list them.
- **Store important discoveries**: When you learn something significant (user preferences, project decisions, debugging solutions), use `pin_memory` to preserve it.
- **Periodic maintenance**: Use `distill_memory` after complex multi-session work to consolidate related memories.
