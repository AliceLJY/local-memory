# Changelog

## v2.5.4 — npm 发布边界修复 (2026-07-17)

- package.json 改为严格 files 白名单，只发布运行所需源码、示例配置、UI、集成脚本和必要文档。
- 新增实际 tarball 内容检查：环境文件、运行配置、日志、会话、数据库、密钥材料和开发工作树一旦进入包即失败。
- npm publish 前自动执行同一检查，CI 也验证最终包清单，避免本地运行数据再次随包发布。
- 补齐 npm 包中的 UI 资源与 README 引用文档，并将中文 README 的 MCP 工具数对齐为 43。
- 清理历史可视化 HTML 中遗留的两段 provider-shaped token，并增加只报路径/行号的 tracked-file 凭据扫描。
- `doctor` 不再显示 API key 前缀，只报告是否已设置。

> **CHANGELOG gap notice**: v1.3.1 (2026-03-12) → v2.5.2 (2026-05-27) 中间有较长开发期未更新 CHANGELOG。v2.5+ 系列以下开始恢复跟踪。历史 v1.4 - v2.4 间的变更见 git log。

## v2.5.3 — 诊断工具失明 + 失效功能 + score 显示 三批修复 (2026-05-29)

一轮临床向审查(CC 多 agent + Codex trio 二审)发现的一组修复:诊断工具在生产给虚假健康信号、三个功能完全失效、检索 score 显示失去区分度。

### Fixed

- **三处让功能完全失效的 bug**:
  - `distill_session` MCP tool 引用未声明的 `llmClient` → 调用必抛 ReferenceError、工具 100% 不可用(SDK 接住转错误响应,server 不崩但永远 distill 不了)。改用模块级已初始化的 `llm`。
  - `ingest --no-llm` 空操作:commander 把 `--no-llm` 解析成 `options.llm=false`,代码却读 `options.noLlm`(恒 undefined)→ 想跳过 LLM 实际仍全程调用。改读 `options.llm===false`,Gemini/memory 两源同步遵守。
  - `tool-output-compressor` 正则 lookahead 末项 `\z` 在 JS 中是字面字符 z(非锚点)→ 末尾工具输出漏压缩、在字面 z 处误截断。改为 `(?![\s\S])`。
- **`memory_lint` / `data_checkup` 因空向量假报健康** — `store.list()` 为性能返回 `vector:[]`,而矛盾/去重/维度/干扰检查全靠向量算相似度 → cosine 恒 0 → 静默失效(实测 contradictions=0/duplicates=0、维度检查把"全 0 维"假报 OK)。现在经 `store.getVectors()`(已加分批)补回真实向量再检查;维度检查排除取不到向量的条目、空库才判 ok。真实库验证:矛盾 0→174、重复 0→1473。
- **诊断扫描截断不透明** — `memory_lint`/`data_checkup` 只扫最近 10000 条(库 9 万+),新增 `scanLimited`/`totalAvailable` 截断披露。
- **检索 score 显示失去区分度** — `memory-output` 的 search/brief/full 三处用 `toFixed(0)`/`round` 把 score 取整(0.996 与 1.0 都显示 100%),改为 `toFixed(1)`。`search_memory` MCP description 从 "by semantic similarity" 改为明确 "fused ranking score, NOT pure cosine similarity"。

### Internal

- 修测试 mock 失真:`memory-lint` / `data-checkup` / `source-heartbeat` 三个测试的 mock store 原本直接返回带向量 entry(与生产 `vector:[]` 不符,正是它放过了诊断哑火 bug),改为复刻真实行为(list 空向量 + getVectors 补回)。
- 基线 1525 tests / 0 fail。

## v2.5.2 — store.delete(prefix) bug fix (2026-05-27)

Codex trio review (2026-05-27, ref `~/Desktop/codex-v2.5.1-fix-review-20260527.md`) 发现的独立非阻塞 bug。

### Fixed

- **`store.delete(prefix)` 在 90K+ 库下可能漏删** — 旧实现先 `.select(["id","scope"]).limit(1000).toArray()` 再 app-layer filter，若目标 entry 不在前 1000 行就漏查。现在改成和 `store.getById` 对齐的 SQL LIKE：`where("id LIKE 'prefix%'").limit(2)`，ambiguous prefix 通过 `limit(2)` 检测并 throw。**不影响 `forget_memory` 主路径**（`forget-engine` 走 `store.get(memoryId)` 解析成完整 entry.id 再 `store.delete(entry.id)`），是 direct prefix delete caller 的潜在风险修补。
- 基线 1523 / 0 fail（修补未引入新 test，依赖 Codex 上轮 LanceDB LIKE 临时验证 + 全量回归测试不破坏）

## v2.5.1 — P0 production path: API exposure surface fixes (2026-05-27)

Fresh CC session 第一次真用 `store_skill → workflow_observe(skillId=prefix) → retrieve_skill` 链路就**死锁**——返回 `Skill 1d9420b2 → not updated (skill_not_found)`。诊断出 3 处 API 暴露面割裂。

Codex trio 二审评分 **8.5/10**，子 agent production smoke 验证 successCount 0→1 真递增 ✅。

### Fixed

- **`store.getById` 加 8+ hex prefix lookup** — 之前只接完整 UUID，与 `store.update / store.delete` 行为不一致；现在通过 SQL `LIKE 'prefix%' limit(2)` 检测歧义并返回 null。现有 caller（access-tracker / persistSkill / capture-engine 等 13 处）全部传完整 UUID，向后兼容零隐患（Codex 全仓库 grep 验证）。
- **`store_skill` MCP handler 返回加 `Skill ID: <full UUID>` 行** — 之前只显示 `Stored skill <8 hex prefix>` 截断到 8 位，agent 拿不到完整 UUID 后续没法传给 `workflow_observe`。保留 short prefix 显示给人看。
- **`retrieve_skill` MCP handler markdown 加 `**ID**:` + `**Outcome counts**: success=N failure=M [(last: ISO)]`** — 之前不暴露 id / successCount / failureCount / lastRefinedAt，agent 看不到反馈循环效果。
- **`recordSkillOutcome` 用 `entry.id` 调 `store.update`** — 之前用 caller-provided skillId（可能 prefix）直接调 store.update，ambiguous prefix 在写操作风险翻倍；改用 getById 已 disambiguated 的完整 entry.id。

### Notes

- **8-char prefix 全库碰撞数学**: 4.3 亿组合 vs 90K 条记录，生日悖论 P(any collision) ≈ 61%；但 P(specific prefix collides) ≈ 0.002% (1/47,722)。**首选 full UUID 输入**，8-char prefix 作为兼容；歧义时返回 `skill_not_found`，不会误更新。
- **Codex 5 步 smoke troubleshooting**: 见 `~/Desktop/codex-v2.5.1-fix-review-20260527.md` line 186-192。

### Tests

- 基线 1521 → 1523 / 0 fail（+2 prefix lookup case：`resolves 8+ hex prefix to full UUID and bumps successCount` / `returns skill_not_found for ambiguous prefix`）

## v2.5.0 — SkillImplementationType schema 收缩 (2026-05-27)

brgsk《agent memory: an anatomy》借鉴审计 + Codex trio 二审建议 "P1 选收缩 / 删承诺，不接 evaluator"。

### Changed (Breaking)

- **`SkillImplementationTypeSchema` 收缩到 `["instruction_sequence"]` 唯一值** — 原 enum 含 `bash` / `python` / `mcp_tool_chain` / `instruction_sequence` 四种，但 `implementation` 字段**从未真执行**（无 evaluator，仅作 context 给 agent 读）——是 schema 撒谎暗示可执行。现在明确 skill 是 **agent-readable runbook** 而非可执行物。
- **`implementation` 字段 describe**: `"Executable content"` → `"Agent-readable runbook content: markdown steps, natural language workflow, or structured procedure. RecallNest does NOT execute this — it stores runbooks for agents to read and follow as context."`
- **`store_skill` MCP tool description** 更新强调 "agent-readable skill runbook" + "RecallNest does NOT execute skills"。

### Migration

- 新写入受新 schema 约束，`bash` / `python` / `mcp_tool_chain` 会被拒。
- **`parseSkillFromEntry` 用 type cast 不走 schema 校验** — 历史 `bash` / `python` skill records 仍可 retrieve（backward-compat path）。
- production 库 2026-05-27 实测**无真实 skill 数据**（3 条 category=skills 是历史抓取噪声），破坏面接近 zero。

### Tests

- 基线 1520 → 1521 / 0 fail（删 1 个 "accepts all 4 types"，加 2 个 "accepts only instruction_sequence" / "rejects pre-v2.5 implementationType values"）

## v2.5.0-pre — workflow_observe ↔ skill outcome 绑定 (2026-05-27)

P0 反馈闭环：让 skill 的 `successCount` / `failureCount` 真有真实使用回流。commit `09dec62`，后由 v2.5.0 schema 收缩 + v2.5.1 API 暴露面 + v2.5.2 store.delete 补丁一起构成完整 P0 工作。

### New

- **`WorkflowObservationInputSchema` 加可选 `skillId` 字段** — `workflow_observe` 带 skillId + outcome 时自动 bump skill 的 successCount/failureCount，回写 lastRefinedAt。
- **`recordSkillOutcome()` 导出函数** — `skill-engine.ts`，二分映射：`success` → successCount +1；`failure` / `corrected` / `missed` → failureCount +1。返回结构化结果不抛错，skill_not_found / not_a_skill / metadata_missing 静默跳过。
- **`mcp-server.ts workflow_observe` + `api-server.ts /v1/workflow-observe`** 接 recordSkillOutcome。

### Deployment

- **新增 `RECALLNEST_MCP_TIER=full` 环境变量需求** — `workflow_observe` 在 TOOL_TIERS 标 governance，需 full tier 才暴露给 MCP ToolSearch。MacBook + mini × CC + Codex 4 处 config 已加（args inline / [env] 段）。

### Tests

- 基线 1486 → 1520 / 0 fail（+13 新 case 覆盖 outcome 映射 + 错误路径 + 元数据完整性 + 时间戳；+1 顺手修 workflow-observation.test.ts dashboard 漏传 now 参数 pre-existing bug）

## v1.3.1 — Upstream Sync (2026-03-12)

Synced with [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) master (v1.1.0-beta.6+).

### Changed

- **Retriever**: Added `source` field to `RetrievalContext` — access reinforcement now only fires on manual retrieval, preventing auto-recall from strengthening noise memories (synced from upstream beta.2 design).
- **Noise filter**: Added Chinese meta-question patterns (`你记得`, `记不记得`, `还记得…吗`, `上次…说`, `之前…提到`) and diagnostic artifact filter (synced from upstream beta.3).
- **README**: Updated upstream credit link from `win4r/memory-lancedb-pro` to `CortexReach/memory-lancedb-pro`, added CortexReach team acknowledgement.

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
