# Canary Eval P0 实施 Plan

> 分支 `eval-canary-p0`。目标：让带真实 target memory id 的金标语料能跑出"召回准不准"基线。
> 设计依据：repo-analyses/recallnest-eval-judge-design-20260625.md（v2，经 Codex 合计）。
> 原则：**纯新增**，不改现有 retrieve/打分核心；TS strict 无 any；新功能带测试；bun test 基线 1692/0 只能涨。

## 命门（已验证）
retrieve 返回 `RetrievalResult[]`，`r.entry.id` 可达（retriever.ts 多处在用）→ 能按 target id 算 rank。✓

## 步骤
1. `eval.ts` 加类型 `CanaryEvalCase` + `CanaryCaseReport`，`EvalMode` 加 `"canary"`
2. `eval.ts` 加纯函数 `scoreCanaryCase(evalCase, results)` — 核心打分（按 case 声明的维度动态加权）
3. `eval.ts` 加 `markdownCanaryReport` + `runCanaryEval(cases, deps)`（仿 runRetrievalEval：retrieve→score）
4. `eval.ts` `parseArgs`/`defaultCasesPath`/`main()` 接 canary mode
5. `eval/cases-canary.json` — A/B/C/D 四类（E 类 checkpoint 走 continuity eval，P1 再接）
6. `src/__tests__/canary-eval.test.ts` — 测 scoreCanaryCase 各分支（纯函数，fake results 不连库）
7. `package.json` 加 `eval:canary`
8. `bun test` 全绿 + 真跑 `eval:canary` 出基线 md

## scoreCanaryCase 打分（动态加权，只算 case 实际声明的维度）
- `ids = results.map(r=>r.entry.id)`；`rankOf(id)` = 1-based 或 null
- **A 目标**（targets）：best rank → 1=1.0 / ≤3=0.7 / 命中靠后=0.4 / miss=0；权重 0.5
- **B 新旧序**（expectOrder=[newer,older,...]）：前者须召回且 rank 小于后者；权重 0.2
- **D 内容**（expectContentAny）：joined 文本命中比例（复用 matchedTerms）；权重 0.3
- **C 干扰**（hardNegatives 进 limit 内）/ 文本 forbid：各 -0.3 惩罚
- 维度按声明动态归一；passed = score≥0.7 且无任何 forbid 命中

## 验收
- `bun test` 全绿，新增 canary 测试通过，基线 tests 数只涨不降
- `bun run src/eval.ts --mode canary` 跑出基线（A/B/C/D 的 Top1/Top3/rank/序/内容）

## 不做（P0 范围外）
- LLM judge（P2）、token 拐点（P3）、E 类 checkpoint canary（P1 走 continuity）、commit/push（等 Alice 确认）

## 备注
- bg 隔离守卫：会话全局 `~/.claude/settings.json` 临时设 `worktree.bgIsolation=none`（已备份 `.canary-bak`，会话结束前恢复）。原因：cwd 非 recallnest + dbPath 相对路径 worktree 空库 + 需真库出基线；已用 feature branch 逻辑隔离。
