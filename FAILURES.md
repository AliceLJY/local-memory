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
| abstract relationship queries | must keep working without exact keywords | watch |
| asset-heavy topics | old briefs can pollute recall if asset hygiene is ignored | mitigated, keep watching |
| life facts (subscriptions / friends / emails / addresses) | never captured — user must re-narrate | new 2026-05-13 — `capture gap` |
| cross-window real-time sync | async ingest / no auto-checkpoint before window switch | new 2026-05-13 — `capture gap` |
| entity aliases (e.g. "我的记忆项目"→recallnest) | alias map absent, requires explicit URL/name | new 2026-05-13 — `composition gap` |
| MCP / tool / infra provenance (source URL, official flag, endpoints) | install + setup metadata never sinks into RN | new 2026-05-13 — `capture gap` |
| store_memory promise drift | CC promises to record but doesn't execute; no audit trail | new 2026-05-13 — `checkpoint gap` |
| scope spelling drift | typo / wrong convention silently returns 0 hits, no fallback | new 2026-05-13 — `retrieval gap` |
| RN self-introspection (capability digest, own telemetry) | RN can't answer questions about itself | new 2026-05-13 — `composition / capture gap` |

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

## 2026-03-06 - working_relationship_positive

| Field | Value |
|------|------|
| Query | `我们相处态度` |
| Profile | `default` |
| Scope | `cc / codex / gemini / memory` |
| Surface | `UI` |
| Expected | abstract relationship and collaboration preferences should still surface the right context |
| Actual | user reported the result felt right; eval later passed at `73%`, which means it works but is still weaker than exact operational queries |
| Failure Type | `weak hit / positive signal` |
| Hypothesis | semantic recall is working for summarized wording, but abstract preference queries still need stronger ranking and cleaner memory prioritization |
| Fix | keep this query as a protected eval case and treat it as a primary target for future retrieval tuning |
| Eval Case Added | `yes` |

<!--
2026-05-13 batch — 下面 11 条由 session-jsonl grep 抽样得到，覆盖最近 30 天 CC sessions
Gap 分布: capture×5, retrieval×3, composition×2, checkpoint×1
印证 Codex ROI 第一步先盯 capture gap：用户从未明说"记一下"的隐性事实根本没进库才是核心痛点，而非 retrieval 算法问题
全部 Eval Case Added = no，下一轮决定哪些升 cases.json 做永久回归
-->

## 2026-05-12 - chatgpt_subscription_history

| Field | Value |
|------|------|
| Query | `我买的是群友在加拿大帮我顶的，我堂姐在澳洲也帮我订过，你忘了啊` |
| Profile | `default` |
| Scope | `cc` |
| Surface | `MCP` |
| Expected | RN 应回忆出 ChatGPT 订阅来源链（堂姐 / 加拿大群友 / 被封号邮箱 `aliceljyalice@gmail.com`），CC 不应让用户复述 |
| Actual | CC 当场承认"没主动查 RecallNest"，用户被迫复述 |
| Failure Type | `miss` |
| Hypothesis | capture gap — 生活实事（订阅来源 / 朋友关系 / 历史邮箱）从未被显式 store_memory，没进库自然搜不到 |
| Fix | TBD — 候选 (a) 加 entity-level life-fact 自动捕获器；(b) resume_context 浅注入 user_profile 段 |
| Eval Case Added | `no` |

## 2026-05-12 - email_archive_lookup

| Field | Value |
|------|------|
| Query | `真不记得了你可以看一下我的邮箱，有信，我之前也找你写过，你翻一下记录吧` |
| Profile | `default` |
| Scope | `cc` |
| Surface | `MCP` |
| Expected | RN 该索引过用户之前关于这个话题的 CC 对话，让"翻一下记录"的 ask 自动走 search_memory |
| Actual | RN 无召回，CC 最后改去翻 Gmail |
| Failure Type | `miss` |
| Hypothesis | retrieval gap — 用户用"翻一下记录"这种隐式信号未触发 auto-recall；同时 ingest 可能漏了相关 session |
| Fix | TBD — ingest 加"用户提到的实体 + 时间窗"语义索引，让模糊请求能命中 |
| Eval Case Added | `no` |

## 2026-05-10 - cross_window_realtime_sync

| Field | Value |
|------|------|
| Query | `你查一下就刚刚我和隔壁的你讨论的那种，这种记录我怎么避免会漏掉？` |
| Profile | `default` |
| Scope | `cc` |
| Surface | `MCP` |
| Expected | 隔壁窗口刚结束的对话能在本窗口被 resume_context / search_memory 召回 |
| Actual | 隔壁窗口 checkpoint 还没落 / ingest 未追上，本窗口完全看不见 |
| Failure Type | `miss` |
| Hypothesis | capture gap — checkpoint 必须主动调，没有"窗口切换前自动写"机制；ingest 异步有延迟 |
| Fix | TBD — 候选 (a) hook 在 SessionEnd 前 auto-checkpoint；(b) 拉低 ingest 延迟阈值 |
| Eval Case Added | `no` |

## 2026-05-01 - taobao_mcp_provenance

| Field | Value |
|------|------|
| Query | `taobao 这个好像是官方的，我忘了…你搜搜` |
| Profile | `default` |
| Scope | `cc` |
| Surface | `MCP` |
| Expected | RN 该记得 taobao MCP 的来源标记（官方 / 第三方 / 源 URL） |
| Actual | RN 无相关元数据，CC 也没搜 |
| Failure Type | `miss` |
| Hypothesis | capture gap — MCP 工具的来源/官方标记从未沉淀，缺 "tool provenance" 元数据类型 |
| Fix | TBD — MCP install 时加 metadata capture hook，把 source URL / 官方与否写入 entities |
| Eval Case Added | `no` |

## 2026-04-25 - recallnest_alias_resolution

| Field | Value |
|------|------|
| Query | `https://github.com/AliceLJY/recallnest 帮我看一下我的记忆项目有没有什么可以提升的地方` |
| Profile | `default` |
| Scope | `cc` |
| Surface | `MCP` |
| Expected | "我的记忆项目"应被 RN 解析为 recallnest 实体，自动召回最近 patterns/cases |
| Actual | 用户被迫附 GitHub URL 才完成实体绑定 |
| Failure Type | `weak hit` |
| Hypothesis | composition gap — entity alias 表缺 "我的记忆项目" / "记忆项目" → recallnest 的映射 |
| Fix | TBD — entities/recallnest 加 aliases 字段，resume_context 用 alias 匹配 |
| Eval Case Added | `no` |

## 2026-04-24 - store_memory_promise_drift

| Field | Value |
|------|------|
| Query | `之前应该都没有追加到 memory 好像，我都不记得了…` |
| Profile | `default` |
| Scope | `cc` |
| Surface | `MCP` |
| Expected | 之前 CC 答应"会记进 memory"的内容确实写入了 |
| Actual | CC 当时承诺但没真调 store_memory，用户事后发现缺漏 |
| Failure Type | `miss` |
| Hypothesis | checkpoint gap — store_memory 承诺-执行差距，无 audit trail 让用户/CC 自查"答应过但没写" |
| Fix | TBD — 候选 (a) CC 侧 promise-tracking；(b) RN 出 `verify_promise(query)` MCP tool 让 CC 复盘 |
| Eval Case Added | `no` |

## 2026-04-21 - skill_lifecycle_amnesia

| Field | Value |
|------|------|
| Query | `我们是只保留 repo-insight 吧？还是之前有个 github analyzer 这个，后面删除了，我都不记得了` |
| Profile | `default` |
| Scope | `cc` |
| Surface | `MCP` |
| Expected | RN 该记得 skill 演进历史：github-analyzer 被 repo-insight 取代 |
| Actual | RN 无召回，用户得自己查 `~/.claude/skills/` |
| Failure Type | `miss` |
| Hypothesis | capture gap — skill 生命周期事件（创建/废弃/合并）没自动入库 |
| Fix | TBD — scan_skill_promotions 已存在但只看 promotion，扩展捕获 replace / deprecate 信号 |
| Eval Case Added | `no` |

## 2026-04-20 - rn_self_introspection

| Field | Value |
|------|------|
| Query | `subcommand 也写上吧，我肯定不记得。memory_forget reason / audit log 不是我本地走 recallnest 么？` |
| Profile | `default` |
| Scope | `cc` |
| Surface | `MCP` |
| Expected | RN 能回答自身能力清单（暴露哪些 MCP tool / audit log 存在与否） |
| Actual | 用户对 RN 自身能力存疑，没办法自证 |
| Failure Type | `weak hit` |
| Hypothesis | composition gap — RN 缺 self-introspection 接口，能力清单只在源码不在记忆里 |
| Fix | TBD — list_tools 输出做基础 self-knowledge entity，或 resume_context 注入 capability digest |
| Eval Case Added | `no` |

## 2026-04-20 - rn_ingest_telemetry_blackbox

| Field | Value |
|------|------|
| Query | `那这两天 recallnest 那些 ingest codex 有没有成功？` |
| Profile | `default` |
| Scope | `cc` |
| Surface | `MCP` |
| Expected | RN 能查询自身 ingest 运行状态（最近 N 次：成功/失败次数、ingest 范围） |
| Actual | 没有可查询的 telemetry 事实，用户只能猜 |
| Failure Type | `miss` |
| Hypothesis | capture gap — RN 自身 telemetry 没回流为可查事实条目；ingest 完成后没 store_memory(type=event) |
| Fix | TBD — ingest pipeline 收尾自动写 event memory（importance 低但可查可统计） |
| Eval Case Added | `no` |

## 2026-04-17 - mini_migration_scope_miss

| Field | Value |
|------|------|
| Query | `project:mini-migration 里用关键词 mini migration 没搜到结果…全都查不到` |
| Profile | `default` |
| Scope | `project:mini-migration` |
| Surface | `MCP` |
| Expected | scope=project:mini-migration 下 search_memory 命中 mini 搬迁的 checkpoints |
| Actual | 双 CC + Codex 三端都搜不到 |
| Failure Type | `miss` |
| Hypothesis | retrieval gap — scope 命名拼写漂移（mini-migration vs migration:mini）；scope miss 时未触发兜底跨 scope 搜索 |
| Fix | TBD — 候选 (a) scope normalize；(b) 0 hit 时自动 allScopes=true 重试并提示用户 |
| Eval Case Added | `no` |

## 2026-04-14 - infra_endpoint_capture

| Field | Value |
|------|------|
| Query | `我的 cc-genius 的 tailscale 的网址是什么？我一下子没保存忘记了` |
| Profile | `default` |
| Scope | `cc` |
| Surface | `MCP` |
| Expected | Tailscale endpoint 这类硬事实在 RN 里有结构化条目 |
| Actual | 没有相关记录 |
| Failure Type | `miss` |
| Hypothesis | capture gap — 基础设施 endpoint（域名 / 端口 / 服务名）从未触发 store_memory，缺 infra entity 类型 |
| Fix | TBD — 增 infra-endpoint entity；或扫描 `~/.ssh/config` + `tailscale status` 定期 ingest |
| Eval Case Added | `no` |
