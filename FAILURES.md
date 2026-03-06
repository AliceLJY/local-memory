# RecallNest Failure Notebook

Use this file to record misses, weak hits, and noisy hits.

Do not rely on memory when retrieval quality changes. Add an entry, then update `eval/cases.json` if the failure should become a permanent benchmark.

## How To Use

| Step | Action |
|------|------|
| 1 | Record the exact query you ran |
| 2 | Note the mode, scope, and surface (`UI`, `MCP`, or `CLI`) |
| 3 | Write what you expected to see |
| 4 | Write what actually happened |
| 5 | Make one concrete hypothesis, not five vague ones |
| 6 | After a fix, record whether the issue moved into `eval/cases.json` |

## Entry Template

```md
## YYYY-MM-DD - short_name

| Field | Value |
|------|------|
| Query | `...` |
| Profile | `default / writing / debug / fact-check` |
| Scope | `...` |
| Surface | `UI / MCP / CLI` |
| Expected | ... |
| Actual | ... |
| Failure Type | `miss / weak hit / noisy hit / asset pollution / bad ranking` |
| Hypothesis | ... |
| Fix | ... |
| Eval Case Added | `yes / no` |
```

## Current Known Weak Spots

| Query family | Current issue | Status |
|------|------|------|
| `aws ssh` | needs to stay strong because this is the real operator wording | watch |
| asset-heavy topics | old briefs can pollute recall if asset hygiene is ignored | mitigated, keep watching |

## Entries

## 2026-03-06 - aws_query_wording

| Field | Value |
|------|------|
| Query | `aws bot config` vs `aws ssh` |
| Profile | `debug` |
| Scope | `cc / codex / gemini / memory` |
| Surface | `UI` |
| Expected | the AWS access path should be easy to recover using the wording the operator naturally types |
| Actual | `aws ssh` returns stronger and more directly useful hits than `aws bot config` |
| Failure Type | `bad ranking` |
| Hypothesis | the earlier eval case used an artificial wording closer to a label than a real operator query |
| Fix | replace the eval case with `aws ssh` and treat operator wording as the benchmark source of truth |
| Eval Case Added | `yes` |
