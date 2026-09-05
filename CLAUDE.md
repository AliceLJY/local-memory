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
- 当前基线：**2375 tests / 0 fail**（2026-08-30 核实，本批宿主证据坐标 +8：`pivot-distill.test.ts` +6〔Claude sidechain 排除 / 非连续证据窗口与 digest / 重复引文歧义拒绝 / 模型伪造坐标拒绝 / 旧 bundle 拒绝 / apply 前源文件重读漂移拒绝〕，`pivot-apply.test.ts` +2〔v2 坐标契约完整性 / 固定历史批 v1 兼容〕。**2364→2367 的 +3 不是本批**：`166adba` 在基线行最后更新后给 KG 覆盖写入修复新增 `capture-engine.test.ts` +2、`kg-extractor.test.ts` +1；本次先追清这 3 条再记 2367+8=2375，没有把差额当噪音。全量测试因 22 条 loopback 协议用例需监听 `127.0.0.1`，在沙箱外执行通过）。此前 **2364 tests / 0 fail**（2026-08-28 核实。**本批把那个长期挂着的 1 fail 修掉了**：`ingest-scope-prefix.test.ts` 的「minis 源已接线」原先无条件断言 `config.sources.minis` 存在，而 `config.json` 是被 `.gitignore` 掉的**本机私有配置**——只有真正跑 ingest 的那台才需要配 minis，所以它在任何没配这个源的机器上必红，**红的是环境不是代码**。改法是把混在一起的两半拆开：前缀识别（`SOURCE_SCOPE_PREFIX.minis` 与 `isTranscriptScope`）是代码契约、无条件断言；config 条目的形状改成「本机配了才检查」。反方向的覆盖由同文件第一条 it 负责（config 里有的源都必须在映射表里登记过），不重复。同批 session 图片标记从 +11 增到 +15（补 codex/kimi 两端解析与补集语义的用例）。此前 **2357 tests / 1 fail**（2026-08-27 核实，图片可寻址 +11：`ingest-image-refs.test.ts` 新增 9〔有配文时正文不塞标记 + 0 字 7 图不再整条丢 + 短配文配图保得住 + 多图 index 同序 + 反向断言 4：短文无图仍丢弃 / 无图不带 imageRefs / tool_result 的图不冒充用户贴图 / 分块层无图不带字段〕、`memory-output.test.ts` +2〔imgs 行渲染 + 反向断言不给无图记忆添行〕；同批 rebase 吃进另一窗口的 checkpoint 修复 +5。**做过真实数据验证**：真实 transcript `05a9a168` 解析出 1 条带坐标轮次、正文一字未改、坐标穿过分块层到达 chunk，另拿一个纯工具产图的会话对照解析出 0 条（有意不收那 91%）。
  **⚠️ 这个 `1 fail` 不是本批引入的，它在这行还写着「0 fail」的时候就已经红了**：`ingest-scope-prefix.test.ts` 的「minis 源已接线」断言 `config.sources.minis`，而 `config.json` 被 `.gitignore`、是每台机各自的私有配置——MacBook 这台的源列表是 `cc/codex/kimi/memory`，没有 minis，所以在这台机上**必红**。**它把「本机配置」当成「代码契约」来断言了**。修法二选一（未定，故留红）：把断言改成条件式（config 里有 minis 才要求前缀登记），或这台机补上 minis 源。
  **同时订正两个对不上的数字**：本批动手前实测是 **2341 tests / 1 fail**，而这行当时写的是 2324 / 0 fail——tests 漂了 17 个、fail 数直接写错。按这行自己立的规矩「别把对不上的数字当噪音放过」，那 17 个欠着的账下次谁碰这行用 `git log --oneline 2026-08-24..` 补。此前 **2324 tests / 0 fail**（2026-08-24 核实，v3.0.0 发版批 +43：`openai-contract.test.ts` 新增 14〔三家 provider 请求形态 5 + 错误 2 + 限流回归 1 + 超时 2 + chat 成功/JSON模式/错误/超时/断路器 4〕、`retrieve-audit-revision.test.ts` 新增 6〔revision+provenance 记录 / superseded 与 active 区分 / 老行默认值 / 封顶且截断可见 / 空结果不写字段 / 经真实 logger 落盘往返〕、`verbatim-self-recall.test.ts` 新增 8〔4 条不变量 + 4 条失败复现〕、`synthesis-promotion.test.ts` 新增 15〔准入 4 + 拒绝与弃权 8 + 边界保证 3〕，`contracts.test.ts` 工具数 43→44 不计增量。**三处做过反向验证**：拿掉「证据仍存活」判据 / 拿掉契约版本闸 / 去掉检索降权因素，各自只让对应测试变红，还原即绿，不是同义反复。**此前 2281**（= 08-23 闸门判定时的实测值，2245 之后由 MemOS P0/P1/P2 那批 +36 带来：`memory-utility.test.ts` / `promotion-distinct-sources.test.ts` / `utility-weight.test.ts` / `access-tracker-novelty.test.ts` 增量）。此前 2245（2026-08-23 核实，dream 合成契约 +42：`synthesis-contract.test.ts` 新增 31〔预算等额分配 5 + JSON 解析 5 + 写库前校验 12 + 提示词回声 4 + 提示词自身契约 4〕、`cluster-consolidation.test.ts` +8〔弃权与校验拦截 2 + pattern/insight 解耦 3 + boundary 与 evidence 落库 3〕、`env-config.test.ts` +3〔synthesisModel 旋钮〕。**做过反向验证**：提示词回声那条闸有一条反向断言要求「每个标记必须真的出现在提示词原文里」，本轮改提示词时它当场变红、揪出一条已失效的死标记，不是同义反复）。此前 2203（2026-08-20 核实，minis ingest 源接线 +5〔`ingest-scope-prefix.test.ts`：每个会话源的 scope 前缀必须在 `TRANSCRIPT_SCOPE_PREFIXES` 里登记 + 一条反向断言。**做过反向验证**：把 `minis:` 从清单摘掉会让其中 2 条变红，恢复即绿，不是同义反复〕。**⚠️ 2152 → 2198 这 46 个增量本次没有逐一追溯**——那是 08-13 之后其他提交带来的，本轮改动只贡献了最后 +4。按这行自己写的规矩「说得清每一个增量从哪来」，这 46 个是欠着的账，下次谁碰这行顺手用 `git log --oneline 2026-08-13..` 补上。此前 2152（2026-08-13 核实，dream 三处防护缺口 +7〔LLM 抛异常不炸整轮 ×3 + `formatDreamMetrics` 格式契约 ×4〕；**基线记录本身漏了 2 个**——08-12 记 2143 之后 `adb96fc`/`ee008ce` 两个 release 提交改了 `contracts.test.ts` 却没更新这行，所以本次核对时 2143+7 与实测 2152 对不上，查 git log 才补齐。**别把对不上的数字当噪音放过**：这行的价值全在"说得清每一个增量从哪来"。此前 2143（2026-08-12 核实，端清单回归 +7〔`it.each` 遍历全部在栈端 + 一条反向断言防同义反复〕；此前 2136 = 08-08 后四个提交〔audit 补接 / dream 产出断言 / dream scope 修复 / SDK 1.30.0〕带来 +12。再往前 2124（2026-08-08 核实，stableContext 长度契约 +2 与端清单术语簇 +7；此前 2115 = 同日 `6c8ebae` retriever 惰性初始化分派修复 +3，2112 停在 08-06，2110 停在 08-04 pivot-apply 专用写入通道 +14，再往前 2096 = B 段 pivot-distill 修复批新增、2013 停在 07-30））
- **⚠️ 「0 fail」这条 08-05 14:19 到 08-06 03:5x 之间其实是假的**：`chore(pivot-apply): 二轮收尾连带清理脚本` 引入的 `scripts/pivot-apply-cleanup-sidecar-20260805.ts` 硬编码了 lancedb 路径，撞 `resolve-db-path` 守卫测试，**main 上的 CI 连红 4 次没人处理**（每次 push 都红，红的一直是同一条）。教训不是"忘了跑测试"，是**红了没人看**——下次看到 CI 红先查它红了多久，别默认是自己这次改红的。
- 新增功能必须配套测试，基线只能涨不能降
