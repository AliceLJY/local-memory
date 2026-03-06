# RecallNest 30-Second Demo

Use this script when you want to explain RecallNest fast on GitHub, X, Telegram, or in a live screen recording.

## Demo Goal

Show three things in one pass:

| What to prove | What the viewer should understand |
|------|------|
| Recall | old AI conversations can be found quickly |
| Explainability | hits are not opaque |
| Reusability | useful context can become a long-lived asset |

## Fast Setup

```bash
cd $HOME/local-memory
bun run src/ui-server.ts
```

Open:

```text
http://localhost:4317
```

## Recommended Demo Query

Use:

```text
telegram bridge
```

Reason:

| Why this query works | Result |
|------|------|
| already appears in the current dataset | likely to return hits immediately |
| has operational context | good for showing explainability |
| already has assets | good for showing reuse |

## 30-Second Talk Track

### Version A

```text
This is RecallNest, a local-first memory workbench for AI conversations.
It turns Claude Code, Codex, Gemini, and notes into a recall layer.
I can search an old topic, inspect why it matched, then pin useful context back into memory so it can be recalled again later.
The same memory layer is exposed through MCP, so an agent can use it and I can still verify it in the UI.
```

### Version B

```text
RecallNest is not just transcript search.
It lets me search, explain, distill, and reuse past AI conversations.
The key idea is that useful hits do not disappear again: I can turn them into assets and feed them back into recall.
```

## Demo Click Path

| Step | UI action | What to say |
|------|------|------|
| 1 | show the loaded `telegram bridge` query | "This starts from a real transcript topic." |
| 2 | click `Search` | "I can recall the relevant conversation history." |
| 3 | click `Details` on one result | "The hit is inspectable, not a black box." |
| 4 | click `Pin` or `Brief` | "Useful context becomes a reusable asset." |
| 5 | switch to `Assets` | "Assets stay visible and can be recalled later." |

## Screenshot Rules

| Rule | Why |
|------|------|
| keep the browser crop tight | the product, not Chrome, should dominate the frame |
| show real hits in the result area | empty states spread poorly |
| keep `Trace Output` collapsed unless you are explaining it | it distracts from the main product story |
| prefer one strong screenshot over many average ones | easier to share and understand |

## If The UI Opens Empty

Check:

1. the server is running
2. the current dataset was ingested
3. the page has been refreshed after startup

If needed, re-run:

```bash
bun run src/ui-server.ts
```
