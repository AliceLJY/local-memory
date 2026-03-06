# RecallNest Eval Memo

This file is the operator memo for improving retrieval quality without relying on intuition.

## Why this exists

RecallNest will keep evolving with:
- upstream retrieval changes from `memory-lancedb-pro`
- local tuning for your own workflows
- new asset behavior (`pin`, `brief`, cleanup rules)

Without a repeatable eval, it is impossible to tell whether recall actually improved.

## Core files

| File | Purpose |
|------|---------|
| `eval/cases.json` | real-world recall cases to protect |
| `src/eval.ts` | eval runner |
| `eval/reports/` | saved baselines to compare across upgrades |

## What to evaluate

Use queries that matter in real usage:
- bot / bridge maintenance
- OpenClaw memory architecture
- writing style and user preference recall
- visual style preference recall
- AWS / config operations

Important:
- prefer the wording the operator actually types
- do not invent a cleaner label if the real query is messier but more common
- if `aws ssh` is what gets used in practice, benchmark `aws ssh`, not `aws bot config`
- abstract, summarized queries are valid benchmarks if that is how the operator naturally searches
- protect both query styles: exact operational wording and high-level conceptual wording

Each case should define:
- `query`
- `profile`
- optional `scope`
- `expectAny`
- `expectAll`
- `expectScopePrefixes`
- optional `forbid`

## Recommended workflow

### Before changing retrieval

Run:

```bash
bun run src/eval.ts --output eval/reports/latest.md
```

If the change is important, also save a dated snapshot:

```bash
bun run src/eval.ts --output eval/reports/2026-03-06-baseline.md
```

### After changing retrieval

Run the same eval again and compare:
- pass count
- average score
- top scopes
- top snippet quality

## What counts as a good change

Good:
- relevant source scopes move up
- user preference memories stay stable
- bridge / ops / config queries become easier to recover
- `pin` and `brief` behave differently on purpose

Bad:
- asset recursion comes back
- old noisy `brief` objects dominate retrieval
- exact operational queries stop surfacing recent config changes
- writing/style queries drift away from user preference memories

## Maintenance note

Whenever a new recurring workflow appears, add it to `eval/cases.json`.

That turns “I hope this still works” into “I can prove it still works.”
