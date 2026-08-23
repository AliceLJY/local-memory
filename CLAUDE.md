# RecallNest 项目规则

## 1. 技术栈约束（强制）

- **运行时：Bun**。禁止使用 `npm`、`yarn`、`pnpm`，所有命令走 `bun`
- **语言：TypeScript strict**。禁止 `any` 类型，复杂接口提取到独立类型文件
- **向量存储：LanceDB**。不引入其他向量数据库
- **嵌入模型：Jina v5**。不替换嵌入方案
- **MCP 协议：`@modelcontextprotocol/sdk`**。MCP tools 统一走 `registerTool()`

## 2. 编码规范

- 新增 MCP tool 必须同时写测试（`src/__tests__/`）
- 禁止生成带 `// TODO` 或 `// placeholder` 的半成品代码——缺信息就停下来问
- 修改已有 tool 的 schema 前，先确认调用方兼容性
- 脚本放 `scripts/`，不在 `src/` 之外创建业务 `.ts` 文件

## 3. Agent 行为准则

- **写代码后必须自己跑测试**：执行 `bun test`，读报错，自主修复，直到全绿才交付
- 实现新功能前，先输出分步计划并等待确认，再进入执行阶段
- 任务颗粒度过大时，主动拆分子任务逐步推进，不要一口气撸完然后崩溃
- 禁止用未验证的 `git status` 结果写入 checkpoint

## 4. Git Push 规则（重要！）

- **所有 push 只推 origin**（`AliceLJY/recallnest`）
- **绝对不要 push 到 upstream**（`CortexReach/memory-lancedb-pro`）—— 那是上游公开仓库，推了等于暴露私有改造
- `trihippo/recallnest` 已停止维护，不再推送
- 默认 `git push` 即可（默认推 origin）
- 需要给上游提 PR 时，走 fork + PR 流程，不直接 push

## 5. Feature Flag

- `RECALLNEST_MULTI_VECTOR=true` — 多向量 L0/L1/L2 检索
- `RECALLNEST_KG_MODE=true` — KG 三元组提取 + 图遍历
- `RECALLNEST_EMOTION_SCORING=true` — Emotion detection + salience-weighted Weibull decay + arousal boost + retrieval scoring
- `RECALLNEST_CONSTRUCTIVE_RETRIEVAL=true` — Multi-source candidate expansion + source-map grounded reconstruction (resume default, search opt-in)
- `RECALLNEST_NARRATIVE_MODE=true` — Autobiographical narrative metadata layer (life-period / general-event / specific-event)
- `RECALLNEST_PREDICTIVE_MEMORY=true` — Heuristic-predicted prospective reminders (zero LLM, behavioral signals)

非布尔旋钮（不是 feature flag，默认不设即保持老行为）：

- `RECALLNEST_SYNTHESIS_MODEL=<模型名>` — dream 合成（cluster insight / cross-memory pattern）**专用**模型，
  只覆盖这两处调用，不影响 ingest 侧的 smartExtract 等全局 LLM 调用。未设 → 用 `config.llm.model`。
  **2026-08-23 实测（n=40 真实簇，与三臂实验同批同种子，跑的是生产代码本身）**：
  契约修好之后 `qwen-turbo` 已达标（结论连接词 88.9%、性向归因 0.0%、产出 45/80），
  `qwen-plus` 更好但更贵也更保守（100% / 0.0% / 产出 24/80，均长 105→117 字、结论明显更完整）。
  **所以默认维持 turbo，这个旋钮是留给「想要更狠的质量、愿意付更多钱」时一行切换用的。**

## 6. 测试基线

- 改完代码必须跑 `bun test`，全量通过才能 commit
- 当前基线：**2323 tests / 0 fail**（2026-08-24 核实，v3.0.0 发版批 +42：`openai-contract.test.ts` 新增 14〔三家 provider 请求形态 5 + 错误 2 + 限流回归 1 + 超时 2 + chat 成功/JSON模式/错误/超时/断路器 4〕、`retrieve-audit-revision.test.ts` 新增 6〔revision+provenance 记录 / superseded 与 active 区分 / 老行默认值 / 封顶且截断可见 / 空结果不写字段 / 经真实 logger 落盘往返〕、`verbatim-self-recall.test.ts` 新增 7〔3 条不变量 + 4 条失败复现〕、`synthesis-promotion.test.ts` 新增 15〔准入 4 + 拒绝与弃权 8 + 边界保证 3〕，`contracts.test.ts` 工具数 43→44 不计增量。**三处做过反向验证**：拿掉「证据仍存活」判据 / 拿掉契约版本闸 / 去掉检索降权因素，各自只让对应测试变红，还原即绿，不是同义反复。**此前 2281**（= 08-23 闸门判定时的实测值，2245 之后由 MemOS P0/P1/P2 那批 +36 带来：`memory-utility.test.ts` / `promotion-distinct-sources.test.ts` / `utility-weight.test.ts` / `access-tracker-novelty.test.ts` 增量）。此前 2245（2026-08-23 核实，dream 合成契约 +42：`synthesis-contract.test.ts` 新增 31〔预算等额分配 5 + JSON 解析 5 + 写库前校验 12 + 提示词回声 4 + 提示词自身契约 4〕、`cluster-consolidation.test.ts` +8〔弃权与校验拦截 2 + pattern/insight 解耦 3 + boundary 与 evidence 落库 3〕、`env-config.test.ts` +3〔synthesisModel 旋钮〕。**做过反向验证**：提示词回声那条闸有一条反向断言要求「每个标记必须真的出现在提示词原文里」，本轮改提示词时它当场变红、揪出一条已失效的死标记，不是同义反复）。此前 2203（2026-08-20 核实，minis ingest 源接线 +5〔`ingest-scope-prefix.test.ts`：每个会话源的 scope 前缀必须在 `TRANSCRIPT_SCOPE_PREFIXES` 里登记 + 一条反向断言。**做过反向验证**：把 `minis:` 从清单摘掉会让其中 2 条变红，恢复即绿，不是同义反复〕。**⚠️ 2152 → 2198 这 46 个增量本次没有逐一追溯**——那是 08-13 之后其他提交带来的，本轮改动只贡献了最后 +4。按这行自己写的规矩「说得清每一个增量从哪来」，这 46 个是欠着的账，下次谁碰这行顺手用 `git log --oneline 2026-08-13..` 补上。此前 2152（2026-08-13 核实，dream 三处防护缺口 +7〔LLM 抛异常不炸整轮 ×3 + `formatDreamMetrics` 格式契约 ×4〕；**基线记录本身漏了 2 个**——08-12 记 2143 之后 `adb96fc`/`ee008ce` 两个 release 提交改了 `contracts.test.ts` 却没更新这行，所以本次核对时 2143+7 与实测 2152 对不上，查 git log 才补齐。**别把对不上的数字当噪音放过**：这行的价值全在"说得清每一个增量从哪来"。此前 2143（2026-08-12 核实，端清单回归 +7〔`it.each` 遍历全部在栈端 + 一条反向断言防同义反复〕；此前 2136 = 08-08 后四个提交〔audit 补接 / dream 产出断言 / dream scope 修复 / SDK 1.30.0〕带来 +12。再往前 2124（2026-08-08 核实，stableContext 长度契约 +2 与端清单术语簇 +7；此前 2115 = 同日 `6c8ebae` retriever 惰性初始化分派修复 +3，2112 停在 08-06，2110 停在 08-04 pivot-apply 专用写入通道 +14，再往前 2096 = B 段 pivot-distill 修复批新增、2013 停在 07-30））
- **⚠️ 「0 fail」这条 08-05 14:19 到 08-06 03:5x 之间其实是假的**：`chore(pivot-apply): 二轮收尾连带清理脚本` 引入的 `scripts/pivot-apply-cleanup-sidecar-20260805.ts` 硬编码了 lancedb 路径，撞 `resolve-db-path` 守卫测试，**main 上的 CI 连红 4 次没人处理**（每次 push 都红，红的一直是同一条）。教训不是"忘了跑测试"，是**红了没人看**——下次看到 CI 红先查它红了多久，别默认是自己这次改红的。
- 新增功能必须配套测试，基线只能涨不能降
