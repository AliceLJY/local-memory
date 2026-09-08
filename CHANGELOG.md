# Changelog

<!-- Before cutting a release, run every entry past these five:
     1. before / after — a number, not an adjective. No number, no claim.
        (Nothing measurable? Then one plain sentence. Do not manufacture a figure.)
     2. under what conditions was it measured — version, sample size, environment.
     3. what does this cost and who gets hit by it — state it, do not bury it.
     4. what alternative was rejected and why — the reason must be specific
        enough that someone could refute it.
     5. what looks like it belongs here but deliberately does not, and on what evidence.

     When condensing this file into a GitHub Release body, 2 / 4 / 5 are the first
     things to go: a conclusion reads as information, a reason reads as filler.
     Protect them by name. The v3.0.0 Release body dropped 11 of 11 such items in
     exactly that step, while this file had every one of them. -->

## Unreleased

### Fixed

- **Codex subagent rollouts are no longer ingested as user conversation.** Codex `multi_agent` spawns each subagent as its own rollout file whose first `session_meta` line carries `parent_thread_id`; inside it, `role: user` turns are the parent agent's task briefs, not a person speaking. `ingestCodexSessions` now skips those files whole (`isCodexSubagentSessionFile`, first line only) and reports `N subagent files skipped`; on the machine this was measured, 45.6% of Codex rollout files were subagents and they held 46.7% of all "user" turns. The Claude Code parser also drops `isSidechain:true` rows defensively (CC currently stores sidechains in separate `subagents/` files that the ingester never enumerates, so this is a guard against future inlining). Same rule the Kimi path already used by reading only `agents/main/wire.jsonl`: decide who is speaking from structural fields, not from `role`.

## v3.0.1 — Publication hygiene (2026-09-06)

### Added

- **`embedding.timeoutMs` — an opt-in per-request timeout for the embedding client**
  (config.json, or `RECALLNEST_EMBEDDING_TIMEOUT_MS`, which wins over the file so one
  deployment can bound itself without editing a shared config). **Default behavior is
  unchanged**: with neither set, no `timeout` is passed to the SDK at all and the client
  keeps its own default — 600s in `openai` v7 — exactly as in every release through
  v3.0.0. The knob exists because that default stacks badly: the SDK retries twice on its
  own and `Embedder` retries twice more, so a black-holed endpoint issues **9 requests for
  a single `embedPassage` call** (measured against a loopback endpoint that never answers),
  putting the worst case at roughly 90 minutes. Lowering the default for everyone was
  rejected instead of shipped — bulk embedding of long documents is legitimately slow, and
  a global cut would turn working ingests into failures — so the timeout is only ever
  shortened by a caller that asks. Non-finite, zero and negative values are ignored rather
  than throwing, so a typo degrades to the old behavior instead of to an embedder that
  aborts every request. Covered by the loopback suite (abort within the configured budget)
  and by `runtime-config-embedding.test.ts` (config.json → client, env precedence, and a
  whole-client comparison against the pre-change construction expression proving the unset
  path is unchanged).

### Changed

- **Publication hygiene: no machine-local identifiers in the tree, no tests in the tarball.**
  Three eval scripts (`eval/ghost-scan.ts`, `eval/lengthnorm-shadow.ts`,
  `eval/term-registry-shadow.ts`) imported the runtime through an absolute path that only
  existed on the author's machine; they now resolve the repository root from
  `RECALLNEST_ROOT`, falling back to `~/recallnest` — the identical path on the original
  install, a working one everywhere else. `scripts/pivot-distill-supervisor.ts` derives its
  user-level launchd labels from the current account (`com.<user>.<task>`, overridable via
  `PIVOT_DISTILL_LAUNCHD_PREFIX`) instead of a hardcoded username; the supervised set is
  unchanged for the original account, and the suite now asserts the derivation rule and the
  override. `package.json#files` excludes `src/**/__tests__/**` — `.npmignore` alone never
  could, because `files` wins — so the dry-run tarball goes from 357 files / 965.8 kB
  (3.8 MB unpacked) to 189 files / 620.0 kB (2.1 MB unpacked), measured with npm 11.19.0
  on this commit; `scripts/verify-package-contents.mjs` now rejects any `__tests__` directory,
  so the CI gate turns red if this regresses. A new `privacy-regression.test.ts` scans
  `src/`, `scripts/`, `eval/`, `bin/`, root-level `*.md` and shipped `data/*.example.*` for the
  removed identifiers and for macOS home paths (obvious placeholder accounts excepted).
  Rejected: relative imports in the eval scripts, because these are reproduction tools for
  figures measured against the production install and must keep pointing at it even when
  invoked from another checkout. Deliberately not here: the README acknowledgements are unchanged.

## v3.0.0 — Node 22, and conclusions that can be used (2026-08-24)

Two things make this a major release: the runtime floor moves, and a synthesized
conclusion can finally reach stable memory. Everything else here is either in service of
those or was found while doing them.

### Changed

- **`engines.node` is now `>=22`** (was `>=18.14.1`). This is the only breaking change in
  the release; Bun users are unaffected.
- **`openai` migrated from `^4.0.0` to `^7.5.0`**, which removes the
  `openai@4 → formdata-node@4.4.1 → node-domexception@1.0.0` deprecated chain from the
  dependency tree. Every `openai` release since v5 has zero dependencies, so the chain
  disappears on any upgrade — v7 was chosen because it declares `engines.node >= 22.0.0`,
  making the Node floor and the dependency cleanup one decision instead of two. Verified
  against the SDK rather than its migration guide: the guide documents the `httpAgent`
  removal, the move to built-in `fetch`, and the Node 22 floor, but says nothing about the
  three things this codebase actually depends on — `embeddings.create`, the second
  `RequestOptions` argument on `chat.completions.create`, and the error classes exposed as
  statics on the default export. All three hold.
- **MCP tool count is 44**, up from 43 (`promote_synthesis`, governance tier).

### Added

- **`promote_synthesis` (MCP) and `recallnest promote-synthesis` (CLI)** — a promotion road
  for dream-synthesized conclusions. `buildDerivedBoundary` marks every cluster insight and
  cross-memory pattern `layer: "evidence"` on purpose, and `shouldUseStableMemoryResult`
  refuses the evidence layer, so a synthesized conclusion could never take part in stable
  memory regardless of how well supported it was. Eligibility comes from the conclusion's
  own validated evidence set — `synthesis_contract >= 2`, at least two distinct still-active
  evidence memories — rather than from repetition, because a synthesis is already a
  cross-entry aggregate. It abstains when the evidence cannot be resolved, counts every
  rejection reason, defaults to dry-run, never modifies the synthesized row, and writes
  through the existing `promoteMemory` path so `canonicalKey` dedup makes a re-run a
  revision instead of a duplicate.
- **Retrieve audit rows carry revision and provenance.** `retrieved[]` records each served
  result's id, `evolution.version`, lifecycle status, and boundary layer/authority;
  `retrievedTotal` appears when the capped list is shorter than the truth. Beliefs are
  revised in place — the canonical id survives, the version increments, the old text
  remains as a `superseded` row — so a row saying only `hits=N` could not distinguish a
  current answer from a stale one after the fact.
- **HTTP contract tests for embeddings and chat completions** (`openai-contract.test.ts`).
  Every prior embedder/LLM test stubbed the SDK client, so none of them touched a socket
  and a transport-level regression would have passed all of them. These drive the real
  `Embedder` and `LLMClient` through the real SDK against a loopback `node:http` server,
  covering success, error, and timeout for the default OpenAI request shape plus the Jina
  (`task`/`normalized`/`dimensions`) and Qwen-compatible profiles. No network egress, no
  vendor credentials, no paid calls.
- **A repeatable regression for verbatim self-recall** (`verbatim-self-recall.test.ts`).
  A long, older, rarely-read entry can fail to be recalled by words copied out of its own
  body while short, fresh, frequently-read entries outrank it. The reproduction pins the
  mechanism: the entry is *not* filtered — `hard_min_score`, `layer_admission` and
  `noise_filter` each drop zero rows and its score clears the threshold — it is admitted
  and then ranked last. The ranking fix is deliberately not in this release.
- **`scripts/tier-exemption-snapshot.ts`** — captures tier and decay-exemption distribution
  so "we did not change tiers" becomes checkable later rather than asserted.

### Added — synthesis quality (generation side)

Six changes to what `dream` produces, from a full diagnostic on 2026-08-22 whose core
finding was that **derived memories had a lower conclusion density than their own input**:
over the same 40–160 character band, with a deterministic regex and no LLM judge,
hand-written pivots scored 40.4%, raw transcripts 25.1%, insights 14.4%, patterns 12.1%.
Synthesis was subtracting.

- **`cluster_insight` no longer routes through `generateL0`.** That prompt is a chunk
  summariser — it asks for a one-line summary for retrieval and explicitly preserves ports,
  IPs, URLs and file paths verbatim; it never asks for a conclusion, a cause, or a decision.
  The new `synthesizeClusterInsight` goes through `synthesis-contract.ts`, asks for a
  reusable conclusion, and **may abstain**. The old path's `if (!insight)` only fired when
  the LLM call itself failed, so "this cluster is not worth keeping" had no way to be
  expressed and all 2,427 rows were episode summaries by construction.
- **`extractPattern` changed target concept and now requires evidence.** The old prompt
  asked for recurring preferences, behavioural tendencies and values — a personality-profile
  frame, which produced dispositional attribution in 56.1% of outputs against 1.4% in the
  source material. The old prompt also claimed to want "at least 2 memories as supporting
  evidence" while the implementation neither received nor checked any numbering, making the
  sentence free. Two pieces of evidence is now a hard gate.
- **`validateSynthesis` runs before anything is written.** The old path checked only
  `response.length < 5`, which is how 28 memories ended up holding their own system prompt
  as their body. `has` must be a boolean, length must be in range, the text must not echo
  the prompt, and evidence numbers must refer to real, distinct cluster members. Failures
  are counted by reason instead of collapsing into one `null`.
- **Pattern and insight are decoupled.** `if (!insight) { continue; }` bound two different
  target concepts to one fate: an abstaining insight meant pattern extraction never ran.
  They now fail and abstain independently, and "this round produced nothing" is judged on
  whether the cluster had any effect at all rather than on whether an insight existed.
- **Derived rows carry an explicit `boundary`.** All 4,749 historical derivatives had none;
  the retriever's `isEvidenceLayer` fell back to scope matching, so 96.4% were classified
  correctly only because they happened to sit in a `cc:`/`codex:` scope — by luck of naming,
  not by design. The remaining 173 sat in `memory`/`project:*` scopes and silently held
  durable authority. Derived rows are `layer: "evidence"`, `authority: "distillation"`.
- **`synthesis_contract` version stamp**, so "which code produced this output" stops being
  a guess from timestamps. v2 adds a single-JSON-object constraint: v1 emitted multiple JSON
  objects on 3.3% of calls (all with `finish_reason: stop`, unrelated to truncation), which
  made the whole response unparsable; the same measurement after the constraint is 0.0%.

### Added — memory utility (MemOS value backtracking)

- **Value-backtracking join key (P0).** `workflow_observe` now records `readerId` and
  `recalledIds`, supplying the `(memory_id, outcome)` pairing the database never had: one
  side had outcomes without participants (observations did not record memories), the other
  had participants without outcomes (the access tracker recorded hits but not task success).
  New `src/recall-ledger.ts` keeps process-level reader identity and a retrieval-hit ledger;
  managed observations from `resume_context` / `checkpoint_session` carry it automatically.
  New CLI `memory-utility <id>` reports the success rate of tasks a memory took part in.
- **`utility` column (P1).** `src/memory-utility.ts` weights outcomes (success +0.8 /
  corrected +0.2 / missed −0.3 / failure −0.8) with a 30-day half-life; **it can be
  negative**. It lands in `metadata.utility` and deliberately not in `importance`, which is
  threshold-valued (≥0.95 grants permanent decay exemption) and already written by structured
  memory. Retrieval gained `utilityWeight`, default 0 (off), feeding ranking only — not tier,
  not decay exemption.
- **Cross-source criterion for promotion (P2).** `scanForPromotions` gained
  `minDistinctSources` (default 2). Counting "how many similar cases" and "how many distinct
  episodes" differ in dimension, not degree — hitting the same problem three times is one
  experience repeated, which belongs on the failure-burst path instead. It **abstains** when
  source pointers are unavailable: only 1.2% of cases across the database carry a `src:` tag,
  so judging strictly would mostly punish three different problems solved on one day.

### Fixed

- **A rate-limit reply could trigger an unbounded request storm.** Found by the new contract
  tests. `embedSingle` retried a context-length error by chunking, and each chunk recursed
  back into `embedSingle`, able to re-enter the same branch. Two facts made that
  non-terminating: `smartChunk` returns short text unchanged, so the recursion re-embedded
  the identical string and reproduced the identical error; and the gate
  `/context|too long|exceed|length/i` also matches rate-limit wording — both
  `"Rate limit exceeded"` and `"429 quota exceeded"` trigger chunking. Measured before the
  fix: **61,724 requests in five seconds** against an endpoint asking us to slow down. The
  batch path had the same shape. The missing terminating condition is now present: chunking
  that cannot produce anything smaller than its input throws instead of recursing, and a
  chunk's own embed call cannot re-enter the branch. After: 4 ms, one request, correct error.
- **Multiple `AccessTracker` instances in one process no longer invent separate readers.**
  `createComponentResolver` caches components per profile, so one session opening two
  profiles produced a phantom second reader, inflating `distinctReaderCount` and the
  skill-promotion read boost. The implementation now matches what `access-tracker.ts` says
  about itself ("one stdio MCP server process ≈ one CC session").

### Documentation

- `docs/memory-boundary-contract.md` documents both promotion scans, why their eligibility
  gates differ, and the abstention rule.
- `retriever.ts` records that `candidatePoolSize` above 20 has never had any effect — both
  candidate legs land in `store.ts`'s `clampInt(limit, 1, 20)`. The clamp has been there
  since the first commit while the 2026-07-16 tuning only touched the retriever, so that
  `30` was inert from the day it landed. Left alone deliberately: raising it means widening
  the candidate pool, which was measured and rejected on 2026-08-22.

### Upgrade notes

- **Node 22 or newer is required.** This is the release's only breaking change.
- Existing LanceDB data opens in place; no export/import step.
- `promote_synthesis` defaults to dry-run and writes nothing until `dryRun=false`.
- `audit.jsonl` retrieve rows are larger now that they list what was served. The list is
  capped at 10 entries with `retrievedTotal` marking truncation. Rotation is still manual;
  archive it if it approaches 50 MB.
- `utilityWeight` defaults to 0 and `metadata.utility` is written only by an explicit
  `memory-utility --apply` run, so the MemOS work above is **available but not yet acting on
  anything**. The resident MCP server was restarted on 2026-08-24, so `readerId` is now being
  written (verified end-to-end on a fresh server: a `workflow_observe` call landed an
  observation carrying `readerId`); `recalledIds` only gets a value when a retrieval hit
  actually occurs, and no row carries `metadata.utility` yet because `--apply` has not been
  run. Real data therefore starts accumulating from this release forward, not before it.
  This is the intended shadow period, not a defect.

### Verification

- 2,324 tests pass across 165 files, 0 fail (2,281 at the 3.0 gate → +14 contract, +6 audit
  revision, +8 verbatim self-recall, +15 synthesis promotion). Verified under three
  feature-flag combinations, including the CI default, after CI caught one assertion
  that had been reading the developer's local `.env` rather than product behaviour.
- The deprecated chain is absent from `npm ls`, `node_modules/`, `bun.lock` and
  `package-lock.json`; installed `openai@7.5.0` reports zero dependencies and
  `engines.node >= 22.0.0`.
- SDK compatibility was measured, not assumed: 20 sandbox probes against v7.5.0 (9 API
  surface, 11 loopback-HTTP runtime) plus a `tsc --strict` check of all five call sites,
  with a deliberately-broken control run to confirm the type check actually reports errors.
- `promote_synthesis` was exercised read-only against the live database: 52 contract-stamped
  derivatives exist; `project:codex-self-evolution` yielded 10 candidates from 10 examined,
  `project:antigravity-cli` 4 from 9 (5 below importance), `learnings` 3 from 4 (1 with too
  few distinct sources). Nothing was written.
- The verbatim self-recall and synthesis-promotion suites were both reverse-verified —
  removing the behaviour each asserts turns the relevant tests red and no others.

### A note on npm history

`recallnest@2.6.1` was a maintenance release published before Trusted Publishing was
configured for this package and therefore carries no build provenance. That describes how it
was published; it is not retroactively fixable, since the same npm version cannot be
republished to add provenance.

## v2.6.0 — Cross-process consistency and reliable distribution (2026-08-13)

### Added

- Claude Code marketplace installation now registers the RecallNest MCP server and continuity skill instead of shipping metadata only. Jina credentials use sensitive plugin configuration; generated config and LanceDB data live under `${CLAUDE_PLUGIN_DATA}` and survive plugin updates.
- Kimi, AGY/Antigravity, and minis transcript sources are recognized across ingestion, memory-boundary policy, and term resolution.
- Retrieval audit logging is connected to the live retriever, and the opt-in layer-admission shadow/enforcement pipeline is available through `RECALLNEST_LAYER_ADMISSION=observe|on`.

### Changed

- `package.json` is now the single version source for CLI output, MCP server metadata, HTTP health responses, npm metadata, and the Claude Code marketplace. All public surfaces report `2.6.0`.
- LanceDB uses strong cross-process read consistency by default. `RECALLNEST_READ_CONSISTENCY_INTERVAL=<seconds>` selects bounded staleness; `off` restores the legacy unchecked handle behavior.
- Belief changes preserve prior rows as `superseded`; procedural memories avoid time decay; cold-start scoring, length normalization, and short single-token queries have safer retrieval behavior.
- `dream` adds failure classification, wall-clock budgeting, vector refill before clustering, and output assertions so a successful status means useful work was produced.
- `@modelcontextprotocol/sdk` is updated to 1.30.0, with both npm and Bun lockfiles aligned.

### Fixed

- Empty legacy LanceDB tables now receive schema migrations before their first new write.
- Long-lived retrievers now see writes committed by CLI ingest and other processes without a restart.
- Runtime and maintenance scripts resolve the configured database path consistently instead of silently opening a second database.
- Local HTTP access is constrained to the intended loopback boundary, and tracked credential scans cover release contents without printing secret values.
- Per-cluster LLM timeouts no longer abort an entire `dream` scope; failures are counted, single-scope runs emit the same metrics contract as automatic runs, and the launch wrapper no longer fails after successful work because of an undefined log-file variable.

### Upgrade notes

- v2.5.4 databases open in place; no export/import step is required. The schema migration also covers empty tables.
- Plugin users need Bun and will be prompted for a Jina API key on first install. Existing manual-clone installations keep their current configuration and data path.
- Retrievals now add audit rows. `audit.jsonl` has no automatic rotation; archive it when it approaches 50 MB.
- Layer admission remains off by default. Use `observe` before enabling enforcement on an existing memory corpus.

### Verification

- 2,152 tests pass across 152 files.
- A database written by the remote v2.5.4 release was opened, read, and extended by v2.6.0 in an isolated upgrade smoke test.
- An isolated Claude Code installation connected to the plugin MCP server with all 43 tools; packed npm installs reported `2.6.0` from both `recallnest` and the legacy `local-memory` alias.

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

## v2.3 — Connector ecosystem + source health

> Migrated out of README on 2026-08-28. These three entries lived in the README as
> "New in vX" sections and were never in this file; release dates were not recorded at
> the time, so none is stated here rather than guessed. They sit between v2.5.0-pre
> (2026-05-27) and v1.3.1 (2026-03-12) by position in the sequence.

v2.2 hardened retrieval quality; v2.3 opens RecallNest to external data sources with a standard connector framework and operational health monitoring.

- **Connector-v1 Standard** *(GB-2)* — A JSON format (`ConnectorOutputV1`) that any external script can produce. Obsidian vaults, emails, RSS feeds, log files — normalize once, ingest through the full dedup/embed/extract pipeline. See [`docs/connector-spec.md`](docs/connector-spec.md) for the specification and [`connectors/examples/`](connectors/examples/) for adapter skeletons (email, logs, RSS).

- **Obsidian Vault Ingestion** *(GB-1)* — First-party Obsidian connector: scans `.md` files, extracts frontmatter + wikilinks, maps folder structure to tags. One command: `lm ingest --obsidian /path/to/vault`.

- **Source Health Monitoring** *(GB-3)* — Every connector ingest writes a heartbeat to `data/source-heartbeat.json`. `data_checkup` flags stale sources (>7d warning, >30d error). `doctor --ci` shows a per-source heartbeat summary with human-readable age.

## v2.2 — Retrieval quality hardening

v2.1 added philosophy-informed behavior; v2.2 closes the last three engine-layer gaps identified by a frontier research scan (ACC, PI-LLM, TSM).

- **Memory Confidence Meta-tags** *(ACC / Dual-Process UQ)* — Each memory now carries structured `ConfidenceMetadata` (score, reliability tier: `direct` / `inferred` / `hearsay`). Auto-assigned from source on write (`manual` = 0.9, `agent` = 0.7, `conversation_import` = 0.5). Retrieval scores are weighted by confidence. `resume_context` tags low-confidence items with `[低置信]`.

- **Interference Detection + Active Forgetting Gate** *(PI-LLM / SleepGate)* — Semantic cluster detection identifies groups of near-duplicate memories competing for retrieval. Enhanced RIF keeps only top-K (default 3) per cluster; extras are demoted 50% instead of removed. Write-time pre-warning: when a scope accumulates ≥5 high-similarity active memories, the weakest is flagged `pending_review`. `data_checkup` reports interference density.

- **Temporal Validity Windows** *(TSM / TiMem / Zep)* — `store_memory` accepts `validUntil` (expiration) and `eventTime` (when the event actually happened). `search_memory` supports `validAt` (point-in-time query) and `includeExpired` (demote 80% instead of hide). Auto-GC applies 2× decay acceleration to expired memories.

- **Usage-Adjusted Auto-GC** *(off by default)* — `RECALLNEST_USAGE_DECAY=true` enables a GC-only cold-memory penalty when constructive retrieval is also active. Cold memories discount the frequency component instead of changing online retrieval ranking.

## v2.1 — Philosophy-informed memory

v2.0 built the operational memory platform; v2.1 added philosophy-informed memory behavior.

Five upgrades derived from 9 research dimensions in philosophy of memory, each mapped to concrete engineering:

- **Emotion-Aware Decay** *(Affective Memory Theory)* — Memories with strong emotional content decay 20-30% slower. Keyword-based emotion detection computes `salience` (mnemonic significance), which feeds into the Weibull half-life formula and a rebalanced 4-factor evolution score. Zero LLM cost.

- **Memory Ethics Layer** *(Right to Be Forgotten / GDPR Art. 17)* — Four privacy tiers (`ephemeral` / `private` / `durable` / `shared`). Cascade forgetting engine that propagates deletion through KG triples, evolution chains, pin assets, and briefs. Full audit trail. `forget_memory` MCP tool for agent-driven deletion.

- **Autobiographical Narrative** *(Narrative Identity Theory / Conway's 3-layer model)* — Memories are tagged with `lifePeriod → generalEvent → specificEvent` hierarchy, orthogonal to existing 6 categories. Retrieval pulls narrative siblings. Context rendering groups by life period. Rule-based tagger with EN+CN support.

- **Constructive Retrieval** *(Simulation Theory / Michaelian)* — Instead of returning raw stored text, RecallNest now reconstructs context from an expanded candidate set: KG neighbors + evolution chains + cluster members + narrative siblings. Source-map grounded coverage replaces lexical overlap. Contradictions are detected and flagged.

- **Predictive Prospective Memory** *(Mental Time Travel / Tulving)* — Heuristic prediction engine that surfaces "you might need this" reminders from behavioral signals: stale checkpoint open loops, corrected workflow observations, high-frequency dormant memories, and uncovered query topics. Zero LLM cost. Auto-expire in 7 days if unaccepted.

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
