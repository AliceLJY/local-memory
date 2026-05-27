# RecallNest Follow-up（来自 2026-05-27 brgsk 借鉴审计 P0 闭环 + Codex trio 三轮二审）

> 这份清单**只在 RecallNest 仓库**——其他 follow-up 在 hippo-wiki / learnings / shared-research 各自归档。
> 整套 brgsk → P0 闭环背景：`~/Downloads/sync-bridge/shared-research/借鉴审计/brgsk-agent-memory-anatomy-2026-05-27.md`

## 状态摘要

| 工作 | 状态 | Commit |
|---|---|---|
| P0 反馈闭环代码连线 | ✅ DONE | 09dec62 (v2.5.0-pre) |
| Schema 收缩 instruction_sequence 唯一 | ✅ DONE | d10421b (v2.5.0) |
| API 暴露面割裂 3 处修 | ✅ DONE | 7eb5514 (v2.5.1) |
| store.delete(prefix) limit(1000) 漏删 | ✅ DONE | 7111674 (v2.5.2) |
| CHANGELOG + version bump 2.4.0→2.5.2 | ✅ DONE | 1cb2dd6 |
| Production smoke successCount 0→1 验证 | ✅ DONE | 子 agent 2026-05-27 |
| 4 处 config RECALLNEST_MCP_TIER=full | ✅ DONE | MacBook + mini × CC + Codex |

**整套 P0 真闭合**：代码 + 部署 + API + production 4 个层次都 ✅。基线 1486 → 1523 tests / 0 fail。

## 待办（按优先级）

### P1 — 数据问题（等运营或主动播种）

**production 库没有真实 skill 数据**。memory_stats 实测：
- patterns: 6521 条
- cases: 31328 条
- **skills: 仅 3 条**（且都是历史抓取噪声，没真 metadata.skill）

反馈闭环代码通了 + 部署暴露了 + API 修了，但**上游空仓库 → successCount 没东西可绑**。scanForPromotions 升华管线常年没产出本就是 P0 想解决的核心问题。

**两条路径选一**（trio 协议下让 Alice 决策）：

1. **主动播种**（1-2h 设计 + 持续追踪）：用 store_skill 写一批真实 workflow primitive 作为 skill
   - 候选：trio handoff bundle 生成 / 借鉴审计 6 步 ingest / 三写归档 / brgsk 试金石五点 / weekly-distill 重试 / ...
   - 写完观察 1-2 周看 workflow_observe 真实使用是否有 successCount 信号产出
   - 风险：用户认为是"假装在用"而非真实使用

2. **等运营自然产出**：保留 scanForPromotions 升华管线 + 等 31K cases 自然聚类成 patterns 再升华成 skills
   - 工作量低但产出时机不可控
   - 当前 6521 patterns 但只 3 skills → 升华管线本身可能有阈值过严问题

### P2 — 三层打通（CLAUDE.md ↔ SKILL.md ↔ skill-engine）

skill-engine 升华出新 skill 时**应回流提示**到 `~/.claude/skills/auto-promoted/`（让 CC 真触发），不只是被 retrieve 出来当 context。

Codex 上轮二审倾向方向：**`export_skill_to_md` MCP tool + 人审导出**，不倾向自动写 skill 目录。

**等 P1 数据再设计**（先看播种后 1-2 周 successCount 信号决定 export 哪些 skill）。

### P3 — dream-pipeline 调度化

`runDream()` 已经是 4 阶段 Orient/Gather/Consolidate/Prune offline pipeline（仿 Auto Dream），但没 scheduled——cron/LaunchAgent/boot hook 都未配。

Codex 上轮二审 review：**先手动跑一次 `dream` MCP tool 确认输出质量 + side effects**，再决定是否加 LaunchAgent。

**前置依赖**：mini 现有 `weekly-distill` LaunchAgent `last exit code = 1`，说明调度面已有冷启动/认证风险。先观察 weekly-distill 5-22 加的重试机制（`scripts/weekly-distill.sh`）是否修复了 exit 1 问题，再决定 dream 调度方案。

### B — IDOR scope check

Codex 上轮 + 这轮都明确：**不做**，除非 RecallNest API/MCP 暴露给多用户或外部写入。personal harness 单用户环境威胁接近 0。

### 运维

- **mini 上 18 个 mcp-server.ts 进程并存**——历史 CC/Codex client 各自 spawn 累积。不是 P0 bug 但占资源。**独立 task cleanup**——找一个空窗期一键 `pkill -f mcp-server.ts` + 让各 client 下次自然重启 spawn fresh。
- **1d9420b2 fixture cleanup**——v2.5.1 production smoke 创建的 verify fixture，子 agent 跑完 successCount=1 已完成验证使命。**实测 search_memory 没找到，可能已被 cleanup**。无阻塞，但下次有 RecallNest CLI 操作时可 grep 确认。

## trio-handoff bundle v1.11 候选

下次 trio skill 解冻条件 (2)/(3) 触发时考虑加：

- **`API exposure surface check`** ✅ 真实战触发（本次 v2.5.1 修补依据）：每个 MCP tool 的返回 markdown 是否包含足够字段让 agent 后续操作 + 接口契约自洽性
- ⏸️ `diff 自动分组`（task-related / pre-existing dirty / generated noise）—— Codex 上轮提了但本次未触发关键依赖，等下次实战 trigger

## 元层教训沉淀

1. **"代码改对 + 单测全过 + 端到端 smoke 通" 还需要细分到"哪一层端到端"**——unit test / 单进程内 mock / ssh fresh process / production fresh session 各自验证的层次不同。本次连续暴露三层 bug（代码连线 → 部署面 → API 暴露面）说明任何一层不验证都可能掩盖下一层 bug。
2. **trio 协议下"代为执行"模式**——Alice 主心骨判断方向，CC 派活，子 agent 执行。Alice 在外面手机不便也能完成 production smoke。这套工作流是这次最大产物之一。
3. **审计自家产品最容易出 false positive**——CC 上轮判断 "RecallNest skill 设计上 OK" 是没考虑 deployment surface（governance tier）；这轮判断 "v2.5 commit 修了 schema 撒谎" 是没考虑 API 暴露面（store_skill 截断 UUID）。用外部框架（brgsk 五点试金石）+ Codex trio 二审才暴露多层盲区。

---

**最后更新**：2026-05-27 夜（CHANGELOG commit 1cb2dd6 之后）
**下次回看触发**：(a) P1 主动播种实施 (b) production 库 skill 数据真有了 (c) Alice 主动想动 P2/P3 (d) Codex 主动建议
