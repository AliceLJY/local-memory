<div align="center">

# RecallNest

**面向 Claude Code、Codex、Gemini CLI 的共享记忆层**

*一套记忆，三个终端，上下文跨窗口延续。*

基于 LanceDB 的本地优先记忆系统，把散落在三个终端的对话历史沉淀为可复用知识，跨终端共享，自动召回。

[![GitHub](https://img.shields.io/github/stars/AliceLJY/recallnest?style=social)](https://github.com/AliceLJY/recallnest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Runtime](https://img.shields.io/badge/Runtime-Bun_|_Node.js_18+-f9f1e1?logo=bun)](https://bun.sh)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vector+FTS-orange)](https://lancedb.com)
[![MCP](https://img.shields.io/badge/MCP-42_tools-blue)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/Tests-1573_pass-brightgreen)](https://github.com/AliceLJY/recallnest)
[![CC Plugin](https://img.shields.io/badge/Claude_Code-Plugin-blueviolet)](https://github.com/AliceLJY/recallnest)

[English](README.md) | **简体中文** | [Roadmap](ROADMAP.md)

</div>

---

## 为什么需要 RecallNest？

编程 Agent 每开一个窗口就失忆。项目配置、调试决策、实体映射——散落在 Claude Code、Codex、Gemini CLI 三个终端里，互相不通。

RecallNest 的解法：**一个 LanceDB 驱动的记忆层，供你的编程 Agent 共读共写**。一个窗口存入的上下文，另一个窗口自动召回。会话退出时 checkpoint，启动时 resume。记忆会衰减、演化、自组织——不是简单的日志堆积。


## 快速开始

### 方式 A：Claude Code Plugin（推荐）

```bash
/plugin marketplace add AliceLJY/recallnest
/plugin install recallnest@AliceLJY
```

RecallNest 随 Claude Code 自动启动，无需手动配置 MCP。

> **前置要求：** [Bun](https://bun.sh)（推荐）或 Node.js 18+。首次启动自动安装依赖。

### 方式 B：npm 安装

```bash
npx recallnest --help          # 直接运行
# 或
npm install -g recallnest      # 全局安装
recallnest doctor
```

支持 Node.js 18+（通过 tsx）或 Bun，无需 clone 仓库。

### 方式 C：手动安装

```bash
git clone https://github.com/AliceLJY/recallnest.git
cd recallnest
bun install
cp config.json.example config.json
cp .env.example .env
# 编辑 .env → 填入 JINA_API_KEY
```

### 启动服务

```bash
bun run api
# → RecallNest API running at http://localhost:4318
```

### 试一下

```bash
# 存入一条记忆
curl -X POST http://localhost:4318/v1/store \
  -H "Content-Type: application/json" \
  -d '{"text": "用户偏好暗色模式", "category": "preferences"}'

# 搜索记忆
curl -X POST http://localhost:4318/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "用户偏好"}'

# 查看统计
curl http://localhost:4318/v1/stats
```

### 接入终端

```bash
bash integrations/claude-code/setup.sh
bash integrations/gemini-cli/setup.sh
bash integrations/codex/setup.sh
```

每个脚本会同时安装 MCP 和 continuity 规则，新窗口自动触发 `resume_context`。

### 索引已有对话

```bash
bun run src/cli.ts ingest --source all
bun run seed:continuity
bun run src/cli.ts doctor
```

---

## Web UI

<p align="center">
  <img src="assets/dashboard.png" alt="RecallNest Dashboard" width="800" />
  <br><em>Dashboard —— 总量、类别分布、健康评分、增长趋势一目了然。</em>
</p>

<p align="center">
  <img src="assets/screenshots/ui-full.png" alt="RecallNest Search Workbench" width="800" />
  <br><em>Search Workbench —— 混合检索 + Topic Tag 过滤 + 4 套检索策略 + Skills 浏览 + 资产管理。</em>
</p>

<p align="center">
  <img src="assets/knowledge-graph.png" alt="RecallNest Knowledge Graph" width="800" />
  <br><em>Knowledge Graph —— 交互式力导向图，语义桥接揭示跨域隐藏关联。</em>
</p>

```bash
bun run src/ui-server.ts
# → http://localhost:4317
```

---

## 核心能力

### 接入与安装

| 能力 | 说明 |
|---|---|
| **CC Plugin** | 一行命令装入 Claude Code，无需手动配置 MCP |
| **共享索引** | Claude Code、Codex、Gemini CLI 共用同一个 LanceDB 存储 |
| **双通道接入** | MCP（stdio）给 CLI 工具 + HTTP API 给自定义 Agent |
| **一键接入** | 集成脚本同时安装 MCP 和 continuity 规则 |

### 检索与连续性

| 能力 | 说明 |
|---|---|
| **混合检索** | 6 通道：向量 + BM25 + L0/L1/L2 多向量 + KG 图（PPR） |
| **4 套检索策略** | default、writing、debug、fact-check —— 按任务类型调优 |
| **会话连续性** | `checkpoint_session` + `resume_context`（full/light/summary 三种模式）+ 仓库状态守卫 |
| **会话蒸馏** | 3 层对话压缩：微缩 → LLM 结构化摘要 → 知识提取 |
| **对话导入** | 支持 Claude Code、Claude.ai、ChatGPT、Slack、纯文本 |
| **Topic Tags** | scope 内 topic 分区，自动检测，搜索时可过滤 |

### 记忆生命周期与治理

| 能力 | 说明 |
|---|---|
| **记忆演化** | Supersede 链、衰减评分、LLM 重要性、聚合、归档 |
| **显式升级** | Evidence → Durable Memory，带冲突守卫、合并决议、审计日志 |
| **隐私分级** | 4 级（`ephemeral` / `private` / `durable` / `shared`）+ 级联遗忘 |
| **准入控制** | 写入时门控：噪音过滤、重要性下限、去重、限流 |
| **Memory Lint** | 矛盾、重复、过期、孤儿检测 + 健康评分 |
| **离线整合** | `dream` 命令：聚类、合并、修剪积累的记忆 |

### 推理与结构

| 能力 | 说明 |
|---|---|
| **Knowledge Graph** | 实体关系图 + PPR 算法，支持多跳问题 |
| **建构式检索** | 多源候选扩展 + 溯源锚定的上下文重建 |
| **叙事架构** | 三层自传式元数据（生命阶段 → 一般事件 → 具体事件） |
| **Skill Memory** | 存储、检索、自动提升来自重复模式的可执行技能 |
| **预测式提醒** | 行为信号预测引擎，主动浮现"你可能需要这个" |
| **6 类记忆** | profile、preferences、entities、events、cases、patterns —— 类别分化合并策略 |

### 可视化与运维

| 能力 | 说明 |
|---|---|
| **Dashboard** | Web UI 首页：统计卡片、类别分布、增长趋势、健康概览 |
| **Workflow Observation** | 专门的 append-only 工作流观测层，不混入普通 memory |
| **结构化资产** | Pin、Brief、Distill —— 不只是原始日志 |
| **Data Checkup** | 记忆存储数据质量健康检查（含数据源健康） |
| **数据源心跳** | 按数据源自动追踪 ingest 健康状态，过期告警 |
| **导出图谱** | 导出交互式 HTML 知识图谱可视化 |
| **批量操作** | 单次调用存储最多 20 条记忆，自带去重 |
| **Connector 框架** | 标准 connector-v1 格式接入外部数据源，附带适配器示例 |

---

## v2.1 新增：记忆哲学驱动的架构升级

v2.0 建立了完整的记忆操作平台；v2.1 加入了记忆哲学驱动的记忆行为。

来自 9 个记忆哲学研究维度的 5 项工程升级：

- **情绪感知衰减** *（情感记忆理论）* —— 带有强烈情绪的记忆衰减慢 20-30%。基于关键词的情绪检测计算 `salience`（记忆显著性），注入 Weibull 半衰期公式和重新平衡的 4 因子演化评分。零 LLM 成本。

- **记忆伦理层** *（遗忘权 / GDPR 第 17 条）* —— 四级隐私：`ephemeral`（临时）/ `private`（私密）/ `durable`（持久）/ `shared`（共享）。级联遗忘引擎贯穿 KG 三元组、演化链、Pin 资产和摘要。完整审计日志。`forget_memory` MCP 工具支持 Agent 驱动的删除。

- **自传叙事架构** *（叙事身份理论 / Conway 三层模型）* —— 记忆标注 `生命阶段 → 一般事件 → 具体事件` 层级，正交于现有 6 类别。检索自动拉取叙事兄弟。上下文渲染按生命阶段分组。支持中英文的规则式标注器。

- **建构式检索** *（模拟理论 / Michaelian）* —— 不再返回原始存储文本，而是从扩展候选集（KG 邻居 + 演化链 + 聚类成员 + 叙事兄弟）中重建上下文。Source-map 语义覆盖率替代词汇重叠。矛盾检测与标记。

- **预测式前瞻记忆** *（精神时间旅行 / Tulving）* —— 启发式预测引擎从行为信号中浮现"你可能需要这个"提醒：过期的 checkpoint 待办事项、被纠正的工作流观察、高频休眠记忆和未覆盖的查询主题。零 LLM 成本。7 天未接受自动过期。

---

## v2.2 新增：检索质量强化

v2.1 加入了哲学记忆行为；v2.2 补齐前沿扫描（ACC、PI-LLM、TSM）发现的最后三个引擎层空白。

- **记忆置信度元标签** *（ACC / 双过程不确定性量化）* —— 每条记忆携带结构化 `ConfidenceMetadata`（分数 + 可靠性层级：`direct` 用户亲述 / `inferred` LLM 推断 / `hearsay` 二手转述）。写入时根据 source 自动赋值（manual=0.9, agent=0.7, conversation_import=0.5）。检索评分加权置信度。`resume_context` 对低置信条目标注 `[低置信]`。

- **干扰检测 + 主动遗忘门** *（PI-LLM / SleepGate）* —— 语义聚簇检测识别竞争检索的近重复记忆群。增强版 RIF 每簇仅保留 top-K（默认 3），多余的降权 50% 而非删除。写入时预警：scope 内累积 ≥5 条高相似活跃记忆时，最弱的标记 `pending_review`。`data_checkup` 报告干扰密度。

- **时间有效性窗口** *（TSM / TiMem / Zep）* —— `store_memory` 接受 `validUntil`（过期时间）和 `eventTime`（事件发生时间）。`search_memory` 支持 `validAt`（时间点查询）和 `includeExpired`（降权 80% 而非隐藏）。auto-GC 对过期记忆施加 2 倍衰减加速。

---

## v2.3 新增：Connector 生态 + 数据源健康

v2.2 强化了检索质量；v2.3 通过标准 Connector 框架和运维健康监控，把 RecallNest 开放给外部数据源。

- **Connector-v1 标准** *（GB-2）* —— 一套 JSON 格式（`ConnectorOutputV1`），任何外部脚本都可以输出。Obsidian 笔记、邮件、RSS、日志文件——标准化一次，走完整的 dedup/embed/extract 管线入库。规范见 [`docs/connector-spec.md`](docs/connector-spec.md)，适配器骨架见 [`connectors/examples/`](connectors/examples/)（email、logs、RSS）。

- **Obsidian Vault 接入** *（GB-1）* —— 官方 Obsidian 连接器：扫描 `.md` 文件，提取 frontmatter + wikilink，文件夹结构映射为 tag。一条命令：`lm ingest --obsidian /path/to/vault`。

- **数据源健康监控** *（GB-3）* —— 每次 connector ingest 写心跳到 `data/source-heartbeat.json`。`data_checkup` 标记过期数据源（>7 天 warning，>30 天 error）。`doctor --ci` 按数据源展示心跳摘要（如"obsidian: 2h ago"）。

---

## 架构

```
┌──────────────────────────────────────────────────────────┐
│                       客户端层                            │
├──────────┬──────────┬──────────┬──────────────────────────┤
│ Claude   │ Gemini   │ Codex    │ 自定义 Agent / curl      │
│ Code     │ CLI      │          │                          │
└────┬─────┴────┬─────┴────┬─────┴──────┬──────────────────┘
     │          │          │            │
     └──── MCP (stdio) ───┘     HTTP API（端口 4318）
                │                       │
                ▼                       ▼
┌──────────────────────────────────────────────────────────┐
│                      集成层                               │
│  ┌─────────────────────┐  ┌────────────────────────────┐ │
│  │  MCP Server         │  │  HTTP API Server           │ │
│  │  42 个工具           │  │  21 个端点                  │ │
│  └─────────┬───────────┘  └──────────┬─────────────────┘ │
└────────────┼─────────────────────────┼───────────────────┘
             └──────────┬──────────────┘
                        ▼
┌──────────────────────────────────────────────────────────┐
│                      核心引擎                             │
│                                                           │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────────┐ │
│  │ 检索器      │  │ 分类器      │  │ 上下文编排器         │ │
│  │（向量 +     │  │（6 类分类） │  │（resume_context）   │ │
│  │ BM25 + RRF）│  │            │  │                      │ │
│  └────────────┘  └────────────┘  └──────────────────────┘ │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────────┐ │
│  │ 衰减引擎    │  │ 冲突引擎    │  │ 捕获引擎             │ │
│  │（Weibull） │  │（审计 +     │  │（evidence → durable）│ │
│  │            │  │  合并）     │  │                      │ │
│  └────────────┘  └────────────┘  └──────────────────────┘ │
└──────────────────────────┬───────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────┐
│                      存储层                               │
│  ┌─────────────────────┐  ┌────────────────────────────┐ │
│  │ LanceDB             │  │ Jina Embeddings v5         │ │
│  │（向量 + 列式存储）   │  │（1024 维，任务感知）       │ │
│  └─────────────────────┘  └────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### 内部设计

- **L0 / L1 / L2 动态折叠** —— 每条记忆存储 3 个粒度层（一句话 / 要点概要 / 完整内容）；检索时根据相关性分数和 token 预算动态选择返回哪个层级
- **Weibull 衰减 + 情绪调制** —— 记忆沿参数化 Weibull 曲线衰减；情绪显著性可额外延长半衰期最高 30%
- **向量预筛 + LLM 去重** —— 90% 的去重决策用低成本余弦相似度（≥ 0.92）；仅临界情况调用 LLM 判断
- **类别分化合并策略** —— `profile` 和 `preferences` 采用冲突合并（新版覆盖）；`events` 和 `cases` 采用追加（保留历史）
- **展示分 vs 淘汰分双轨制** —— 检索使用双轨评分：tier floor 防止核心记忆被淘汰，decay boost 让新鲜记忆临时浮现而不永久挤掉稳定记忆

> 完整架构详解：[`docs/architecture.md`](docs/architecture.md)

---

## 接口

RecallNest 提供两种接口：

- **MCP** —— 给 Claude Code、Gemini CLI、Codex 使用（原生工具访问）
- **HTTP API** —— 给自定义 Agent、SDK 应用和任何 HTTP 客户端使用

### Agent 框架示例

示例代码位于 [`integrations/examples/`](integrations/examples/)：

| 框架 | 示例 | 语言 |
|------|------|------|
| [Claude Agent SDK](integrations/examples/claude-agent-sdk/) | `memory-agent.ts` | TypeScript |
| [OpenAI Agents SDK](integrations/examples/openai-agents-sdk/) | `memory-agent.py` | Python |
| [LangChain](integrations/examples/langchain/) | `memory-chain.py` | Python |

---

<details>
<summary><strong>MCP 工具（42 个）</strong></summary>

| 工具 | 说明 |
|------|------|
| `workflow_observe` | 存储 append-only 工作流观察记录 |
| `workflow_health` | 查看工作流健康状态或降级面板 |
| `workflow_evidence` | 构建工作流证据包 |
| `store_memory` | 存储一条持久记忆 |
| `store_workflow_pattern` | 存储可复用工作流模式 |
| `store_case` | 存储问题-方案对 |
| `promote_memory` | 显式升级 evidence 为持久记忆 |
| `promote_scan` | 扫描近期 evidence，自动晋升合格记忆为持久存储 |
| `list_conflicts` | 列出或查看冲突候选 |
| `audit_conflicts` | 汇总过期/升级的冲突优先级 |
| `escalate_conflicts` | 预览或应用冲突升级元数据 |
| `resolve_conflict` | 解决冲突（保留 / 接受 / 合并） |
| `checkpoint_session` | 保存当前工作状态 |
| `latest_checkpoint` | 查看最近的 checkpoint |
| `resume_context` | 为新窗口编排启动上下文 |
| `search_memory` | 任务开始时主动召回 |
| `explain_memory` | 解释为什么这些记忆被匹配 |
| `distill_memory` | 将结果蒸馏为精简摘要 |
| `brief_memory` | 创建结构化摘要并重新索引 |
| `pin_memory` | 将记忆升级为 Pin 资产 |
| `export_memory` | 导出蒸馏摘要到磁盘 |
| `list_pins` | 列出所有 Pin |
| `list_assets` | 列出所有结构化资产 |
| `list_dirty_briefs` | 预览过时的 Brief 资产 |
| `clean_dirty_briefs` | 归档过时 Brief 并移除索引 |
| `memory_stats` | 查看索引统计 |
| `memory_drill_down` | 查看记忆完整元数据和溯源 |
| `auto_capture` | 启发式提取记忆信号（零 LLM） |
| `set_reminder` | 设置前瞻记忆提醒 |
| `consolidate_memories` | 聚类合并近似记忆（默认 dry-run） |
| `store_skill` | 存储可执行技能 |
| `retrieve_skill` | 按语义相似度检索技能 |
| `scan_skill_promotions` | 扫描可升级为技能的候选 |
| `list_tools` | 按层级发现工具（core/advanced/full） |
| `batch_store` | 批量存储最多 20 条记忆 |
| `distill_session` | 三层管线蒸馏对话为结构化知识 |
| `import_conversations` | 导入 Claude Code、ChatGPT、Slack 等对话 |
| `data_checkup` | 运行数据质量健康检查 |
| `dream` | 离线记忆整合（聚类、合并、修剪） |
| `memory_lint` | 记忆质量检查：矛盾、重复、过期、孤儿 |
| `forget_memory` | 级联删除记忆 + KG 清理 + Pin 归档 + 审计 |
| `export_graph` | 导出交互式 HTML 知识图谱 |

</details>

<details>
<summary><strong>HTTP API（21 个端点）</strong></summary>

基地址：`http://localhost:4318`

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/recall` | POST | 快速语义搜索 |
| `/v1/store` | POST | 存储一条记忆 |
| `/v1/capture` | POST | 批量存储结构化记忆 |
| `/v1/pattern` | POST | 存储工作流模式 |
| `/v1/case` | POST | 存储问题-方案对 |
| `/v1/promote` | POST | 升级 evidence 为持久记忆 |
| `/v1/conflicts` | GET | 列出冲突候选 |
| `/v1/conflicts/audit` | GET | 冲突审计汇总 |
| `/v1/conflicts/escalate` | POST | 冲突升级 |
| `/v1/conflicts/resolve` | POST | 解决冲突 |
| `/v1/checkpoint` | POST | 保存工作检查点 |
| `/v1/workflow-observe` | POST | 存储工作流观察 |
| `/v1/checkpoint/latest` | GET | 获取最近检查点 |
| `/v1/workflow-health` | GET | 工作流健康面板 |
| `/v1/workflow-evidence` | GET | 工作流证据包 |
| `/v1/resume` | POST | 编排新窗口启动上下文 |
| `/v1/search` | POST | 高级搜索（含完整元数据） |
| `/v1/stats` | GET | 记忆统计 |
| `/v1/lint` | GET | 记忆质量报告 |
| `/v1/health` | GET | 健康检查 |

完整文档：[`docs/api-reference.md`](docs/api-reference.md)

</details>

<details>
<summary><strong>CLI 命令</strong></summary>

```bash
# 搜索与探索
bun run src/cli.ts search "your query"
bun run src/cli.ts explain "your query" --profile debug
bun run src/cli.ts distill "topic" --profile writing
bun run src/cli.ts stats

# 工作流观察
bun run src/cli.ts workflow-observe resume_context "Fresh window skipped continuity recovery." --outcome missed --scope project:recallnest
bun run src/cli.ts workflow-health resume_context --scope project:recallnest
bun run src/cli.ts workflow-evidence checkpoint_session --scope project:recallnest

# 冲突管理
bun run src/cli.ts conflicts list
bun run src/cli.ts conflicts list --attention resolved
bun run src/cli.ts conflicts list --group-by cluster --attention resolved
bun run src/cli.ts conflicts audit
bun run src/cli.ts conflicts audit --export --format md
bun run src/cli.ts conflicts escalate --attention stale
bun run src/cli.ts conflicts show af70545a
bun run src/cli.ts conflicts resolve af70545a --keep-existing
bun run src/cli.ts conflicts resolve af70545a --merge
bun run src/cli.ts conflicts resolve --all --keep-existing --status open

# 记忆健康与可视化
bun run src/cli.ts lint                         # 记忆质量报告
bun run src/cli.ts lint --scope project:myapp   # 指定 scope
bun run src/cli.ts graph --open                 # 导出并打开知识图谱
bun run src/cli.ts graph --max-nodes 50         # 较小的图

# 导入与诊断
bun run src/cli.ts ingest --source all
bun run src/cli.ts doctor
```

</details>

---

## 多语言支持

RecallNest 开箱即用支持英文。如需多语言记忆（中文、日文、泰文及 20+ 种语言），安装 [babel-memory](https://github.com/AliceLJY/babel-memory) 及所需语言包：

```bash
# 中文
npm install babel-memory jieba-wasm

# 日文
npm install babel-memory @sglkc/kuromoji

# 泰文
npm install babel-memory wordcut

# 欧洲语言（德语、法语、西班牙语、俄语等）
npm install babel-memory snowball-stemmers

# 同时安装多种语言
npm install babel-memory jieba-wasm @sglkc/kuromoji snowball-stemmers
```

RecallNest 启动时自动检测 babel-memory，无需额外配置。未安装 babel-memory 时，RecallNest 仍正常工作，使用标准 BM25 文本搜索。

---

## 项目状态与路线图

RecallNest 持续维护中。所有主要架构阶段已完成——完整路线图和未来计划见 [Roadmap](ROADMAP.md)。

---

## 与 memory-lancedb-pro 的关系

RecallNest 起源于 [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) 的 fork，共享混合检索、衰减建模、记忆即系统的核心理念。关键区别：

- **memory-lancedb-pro** 是 OpenClaw 插件——为单个 OpenClaw Agent 添加长期记忆。
- **RecallNest** 是独立记忆层——通过 MCP + HTTP API 同时服务 Claude Code、Codex、Gemini CLI，内建会话连续性、结构化资产和冲突管理。

## 致谢

| 来源 | 贡献 |
|------|------|
| [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) by [@win4r](https://github.com/win4r) | Fork 基础——混合检索、衰减建模、记忆架构 |
| Claude Code | 基础搭建与早期脚手架 |
| OpenAI Codex | 产品化和 MCP 扩展 |

特别感谢秦超（[@win4r](https://github.com/win4r)）和 [CortexReach](https://github.com/CortexReach) 团队的基础性工作。

<details>
<summary><strong>生态系统</strong></summary>

**小试AI** 开源 AI 工作流矩阵：

| 项目 | 说明 |
|------|------|
| [babel-memory](https://github.com/AliceLJY/babel-memory) | BM25 多语言预处理——27+ 种语言，零依赖 |
| [content-alchemy](https://github.com/AliceLJY/content-alchemy) | 5 阶段 AI 写作管线 |
| [content-publisher](https://github.com/AliceLJY/content-publisher) | 图片生成 + 排版 + 微信公众号发布 |
| [wechat-ai-bridge](https://github.com/AliceLJY/wechat-ai-bridge) | 在微信中运行 Claude Code / Codex / Gemini |
| [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge) | Telegram Bot：Claude、Codex、Gemini |
| [telegram-cli-bridge](https://github.com/AliceLJY/telegram-cli-bridge) | Telegram CLI 桥接 Gemini CLI |
| [openclaw-tunnel](https://github.com/AliceLJY/openclaw-tunnel) | Docker ↔ 宿主机 CLI 桥接 |
| [openclaw-config](https://github.com/AliceLJY/openclaw-config) | OpenClaw Bot 配置与记忆备份 |
| [digital-clone-skill](https://github.com/AliceLJY/digital-clone-skill) | 从语料构建数字分身 |
| [claude-code-studio](https://github.com/AliceLJY/claude-code-studio) | Claude Code 多会话协作平台 |
| [cc-genius](https://github.com/AliceLJY/cc-genius) | Web 版 Claude 客户端（PWA）—— 自托管，iPad 可用 |
| [agent-nexus](https://github.com/AliceLJY/agent-nexus) | 一键安装：记忆 + 远程控制 |
| [cc-cabin](https://github.com/AliceLJY/cc-cabin) | Claude Code 完整工作流脚手架 |

</details>

## License

MIT
