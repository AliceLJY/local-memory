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
| `aws bot config` | weakest baseline case in current eval report | open |
| asset-heavy topics | old briefs can pollute recall if asset hygiene is ignored | mitigated, keep watching |

## Entries

## 2026-03-06 - aws_bot_config

| Field | Value |
|------|------|
| Query | `aws bot config` |
| Profile | `debug` |
| Scope | `cc / codex / gemini / memory` |
| Surface | `eval` |
| Expected | configuration-related evidence should rank near the top |
| Actual | baseline score is lower than other starter cases |
| Failure Type | `weak hit` |
| Hypothesis | retrieval still needs stronger keyword bias and cleaner config-oriented assets for this topic |
| Fix | keep this query in the eval set and compare after upstream retrieval changes |
| Eval Case Added | `yes` |
