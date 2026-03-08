# Changelog

## v1.2.0 — First Distributable Release (2026-03-08)

The goal of this release: a new user can go from `git clone` to first search result in 15 minutes.

### New

- **`lm doctor`** — one-command pre-flight check for Bun, config, API key, data directory, transcript paths, and index health. Supports `--ci` mode for GitHub Actions.
- **`lm demo`** — run sample queries to see RecallNest in action before writing your own.
- **`config.json.example`** — ships with absolute `~/.recallnest/data/lancedb` path. New users copy this instead of editing the tracked config.
- **GitHub Actions CI** — runs `doctor --ci` and TypeScript check on every push.
- **Ingest pre-validation** — embedding API is tested before processing any files. Invalid Jina key now fails fast with a clear message instead of crashing mid-ingest.

### Changed

- **README rewritten** — added Prerequisites table (Bun + Jina key), 5-step quickstart with expected output, Troubleshooting section.
- **Gemini support marked "coming soon"** — README, config example, and doctor all honestly reflect that Gemini CLI sessions are encrypted protobuf and not yet parseable. The `lm ingest` command prints a clear skip message instead of silently failing.
- **Config path robustness** — default `dbPath` changed from relative `./data/lancedb` to absolute `~/.recallnest/data/lancedb` in config example. Auto-detect failure messages now include the user's actual home path.
- **`config.json` untracked** — added to `.gitignore` so user config is not overwritten by `git pull`.

### Fixed

- Auto-detect hint in `doctor` now shows a real example path based on the current user's home directory.
- `findConfigPath()` error message now suggests `cp config.json.example config.json` when the example file exists.

## v1.1.0 — Hybrid Retrieval + MCP + UI (2026-02)

- Hybrid retrieval: LanceDB vector + BM25 keyword search with configurable weights
- Retrieval profiles: `default`, `writing`, `debug`, `fact-check`
- MCP server with 9 tools: search, explain, distill, brief, pin, list assets/pins, export, stats
- Local web workbench UI at `http://localhost:4317`
- Multi-source ingest: Claude Code transcripts, Codex sessions, Gemini sessions, markdown notes
- Asset system: pin, brief, export with re-indexing
- Time-aware scoring with configurable decay

## v1.0.0 — Initial Release (2026-01)

- Basic vector search over Claude Code transcripts
- LanceDB storage with Jina embeddings
- CLI interface
