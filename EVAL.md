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

## 已否决：不跑公开记忆 benchmark（2026-07-25 Alice 拍板）

**这一节写在这里，是因为改检索的人真正会读的是本文件，而不是 hippo。**

**否决了什么**：把 LongMemEval / LoCoMo / BEAM 这类公开记忆 benchmark 当作 RecallNest 的优化靶子或验收判据；
包括「照着别人的 benchmark 脚手架搭一套跑起来」这个提法的各种变体。

**为什么否决**（理由具体到可被推翻，别读成「benchmark 无用论」）：
不是没跑过——**2026-04-05 跑过 LongMemEval 500 题，29.6%（148/500），六维度全胜 UltraMemory**，
做过完整错误归因（全局 50.0% 检索失败 vs 20.4% 推理失败）并产出四阶段路线图（预期 29.6% → 55-65%）。
报告与三份 bench config 在 `~/repo-analyses/recallnest-longmemeval-research-202604/`。
否决的理由是**这个 benchmark 不是这个系统的分**：LongMemEval 的 500 题是别人的对话、别人的偏好、别人的语言习惯
（偏好类失败样本形如 `I enjoy to use Adobe Premiere Pro` / `I have a Sony camera`），
而 RecallNest 的真实负载是中英混杂、高度私人术语（河马 / 照见 / 三写）的个人 harness 召回。
**针对前者编译 extraction prompt，优化出的是一个更懂英文视频剪辑爱好者的提取器。**
Alice 原话：**「我不会再跑那个测试，就跟应试教育一样，跑分高未必召回质量高。」**

**要推翻它必须拿出什么新证据**（举证责任在提案方，不是重新引用「业界都在跑 benchmark」）：
1. 一个**查询分布与本库真实负载可比**的评估集——中英混杂、含私人术语、含「同一事实的逐字记录与人工提炼并存」的同义替代关系；或
2. 证明该公开 benchmark 上的提升**能迁移到自有 canary 上**（同一改动在 `eval/cases.json` 系列上同向提升），而不是只在别人的考纲上涨分；或
3. 目标从「优化召回质量」换成「对外可比较的公开成绩」（宣传、投稿、对标），且 Alice 明确接受这个新目标。

**仍然有效、不受本否决影响的部分**：
- 那次研究的**方法**——把失败归因到提取/检索/推理三段再对症下药；
- 那次研究的**否决清单**——benchmark 数据不支持投入的方向（noise filter / RIF 阈值 / embedding 更换 / reranker）；
- **LLM 判官的可信度判据**（与跑不跑公开 benchmark 无关）：判官会把「拒答」算成正确答案、把「幻觉」算成正确弃权
  （2026-08-30 在 `vbcherepanov/total-agent-memory` 的 benchmark 修复 commit 中实证），
  对应 2026-08-24 外部咨询给的四条准入里「含专门对抗的反例」那条；
  本地同族先例：derived-insights 窗口 qwen-max 打 86% T3，人工验货发现它奖励的是名词具体度而非可复用性，结果整体作废。

**自有 canary 的定位**（别当靶子）：`eval/cases.json` 20 条 + `cases-canary.json` 6 条 + `cases-scope-robustness.json` 24 条，
定位是**回归护栏**（本文件原词 protect），不是优化靶子——当成靶子会重演同一个应试问题，只是考纲换成自家出的。

**为什么这一节存在**：2026-08-30 一个窗口做外部记忆项目对比时，读了本仓、grep 了 `LongMemEval|LoCoMo|BEAM`，
只命中两处注释（`src/eval.ts:91` 甚至明写 "this suite is not LoCoMo"），据此判断「RecallNest 没跑过任何公开 benchmark」，
并差点建议 Alice 去搭一套跑分脚手架——**用正确方法、在正确的地方查，仍然得出了错误结论**。
根因是这条否决当时只存在 hippo-wiki 四处，本文件零记录。参见 shared-behaviors §5.3「否决单独立一格」。
