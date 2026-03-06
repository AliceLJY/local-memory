# RecallNest Roadmap

RecallNest is moving from a local transcript search tool into an MCP-native memory layer with a human-facing workbench.

## Direction

| Track | Goal |
|------|------|
| Retrieval Quality | Raise hit quality with eval, failure review, and cleaner memory assets |
| MCP + UI First | Make agents and humans operate the same memory layer from different surfaces |
| Workflow Integration | Make RecallNest useful for writing, debugging, and research loops |

## Near-Term Priorities

## 1. Retrieval Quality

Goal: improve recall quality with measured iteration instead of intuition.

Planned work:
- expand eval cases from real daily queries
- maintain a failure notebook for misses, weak hits, and noisy hits
- tune retrieval profiles with explicit before/after reports
- keep brief and pin lifecycle clean so assets do not pollute recall

## 2. MCP + UI First Product

Goal: make RecallNest easiest to use through an agent or the local workbench, not by memorizing CLI commands.

Planned work:
- keep MCP tools as the primary integration contract
- add UI operations for cleanup, inspection, and regeneration flows
- reduce CLI-only workflows unless they support MCP and UI directly
- make demo and onboarding flows obvious in one screen

## 3. Writing Workflow

Goal: turn transcript recall into reusable output for articles, briefs, and research.

Planned work:
- add writing-oriented distill modes and templates
- package topic evidence into exportable briefing bundles
- improve recall profiles for drafting and idea mining
- support smoother handoff into article workflows

## Principles

- local-first by default
- MCP-native interfaces
- transcript evidence before abstraction
- reusable memory over one-off search hits
- measured retrieval changes over "feels better"
