<div align="center">

# RecallNest

**面向 Claude Code、Codex、Gemini CLI 的共享记忆层**

*一套记忆，三个终端，上下文跨窗口延续。*

基于 LanceDB 的本地优先记忆系统，把散落在三个终端的对话历史沉淀为可复用知识，跨终端共享，自动召回。

[![GitHub](https://img.shields.io/github/stars/AliceLJY/recallnest?style=social)](https://github.com/AliceLJY/recallnest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vector+FTS-orange)](https://lancedb.com)
[![MCP](https://img.shields.io/badge/MCP-25_tools-blue)](https://modelcontextprotocol.io)

[English](README.md) | **简体中文** | [Roadmap](ROADMAP.md)

</div>

---

## 为什么需要 RecallNest？

大多数编程 Agent 一开新窗口就失忆。更糟的是，你的历史上下文分散在三个终端里，互相不通。

### 没有 RecallNest —— 每个窗口从零开始：

> **你（Claude Code）：**"Docker 配置在 `/opt/app/config.json`，用 4318 端口。"
>
> *（切到 Codex）*
>
> **你：**"配置路径是……等下让我再找找。"😤
>
> *（第二天，新开 Claude Code 窗口）*
>
> **你：**"这个 bug 上周刚修过！方案是……"
>
> **Agent：**"我没有之前会话的上下文。"🤷

### 有了 RecallNest —— 上下文无缝延续：

> **你（Claude Code）：**"Docker 配置在 `/opt/app/config.json`，用 4318 端口。"
>
> *（切到 Codex —— 同一套记忆层）*
>
> **Agent：**（自动召回项目实体）"使用 `/opt/app/config.json`，端口 4318。"✅
>
> *（第二天，新窗口）*
>
> **Agent：**（resume_context 自动触发）"接续昨天 —— Docker 端口冲突已通过……解决。"✅

核心差异：**三个终端共享一套记忆**，上下文跨窗口存活。

### 能力一览

| | 能力 |
|---|---|
| **共享索引** | Claude Code、Codex、Gemini CLI 共用同一个 LanceDB 存储 |
| **双通道接入** | MCP（stdio）给 CLI 工具 + HTTP API 给自定义 Agent |
| **一键接入** | 集成脚本同时安装 MCP 和 continuity 规则 |
| **混合检索** | 向量 + BM25 + 重排序 + Weibull 衰减 + 分层提升 |
| **会话连续性** | `checkpoint_session` + `resume_context` 跨窗口恢复 |
| **Workflow Observation** | 专门的 append-only 工作流观测层，不混入普通 memory |
| **结构化资产** | Pin、Brief、Distill —— 不只是原始日志 |
| **显式升级** | Evidence → Durable Memory，带冲突守卫和合并决议 |
| **6 类记忆** | profile、preferences、entities、events、cases、patterns |
| **4 套检索策略** | default、writing、debug、fact-check —— 按任务类型调优 |
| **多源导入** | 导入三个终端已有的对话历史 |

---

## 快速开始

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
│  │  25 个工具           │  │  19 个端点                  │ │
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
│  │（Weibull） │  │（审计 +    │  │（evidence → durable）│ │
│  │            │  │  合并）     │  │                      │ │
│  └────────────┘  └────────────┘  └──────────────────────┘ │
└──────────────────────────┬───────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────┐
│                      存储层                               │
│  ┌─────────────────────┐  ┌────────────────────────────┐ │
│  │ LanceDB             │  │ Jina Embeddings v5         │ │
│  │（向量 + 列式存储）    │  │（1024 维，任务感知）        │ │
│  └─────────────────────┘  └────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

> 完整架构详解：[`docs/architecture.md`](docs/architecture.md)

---

## 集成方式

RecallNest 提供两条接入路径：

- **MCP** —— 给 Claude Code、Gemini CLI、Codex 等终端工具使用
- **HTTP API** —— 给自定义 Agent 和 SDK 应用使用

### Agent 框架示例

示例位于 [`integrations/examples/`](integrations/examples/)：

| 框架 | 示例文件 | 语言 |
|------|---------|------|
| [Claude Agent SDK](integrations/examples/claude-agent-sdk/) | `memory-agent.ts` | TypeScript |
| [OpenAI Agents SDK](integrations/examples/openai-agents-sdk/) | `memory-agent.py` | Python |
| [LangChain](integrations/examples/langchain/) | `memory-chain.py` | Python |

---

## 核心特性

### 混合检索

```
查询 → 向量嵌入 ──┐
                  ├── 混合融合 → 重排序 → Weibull 衰减 → 过滤 → Top-K
查询 → BM25 全文 ─┘
```

- **向量搜索** —— 基于 LanceDB ANN 的语义相似度匹配
- **BM25 全文搜索** —— 基于 LanceDB FTS 的精确关键词匹配
- **混合融合** —— 向量 + BM25 组合评分
- **重排序** —— Jina 交叉编码器重排
- **衰减 + 分层** —— Weibull 时间衰减模型，Core / Working / Peripheral 三层

### 会话连续性

跨窗口工作流的核心能力：

- **`checkpoint_session`** —— 快照当前工作状态（决策、未完成项、下一步）
- **repo-state 守卫** —— 保存 checkpoint 前会清洗 `git status` / modified-file 文本，避免易变 repo 状态污染后续 handoff
- **`resume_context`** —— 从 checkpoint + 长期记忆 + pin 编排启动上下文
- **托管规则** —— 集成脚本自动安装 continuity 规则，新窗口自动触发 `resume_context`

### Workflow Observation

RecallNest 现在把 workflow observation 放在专门的 append-only store，而不是硬塞进普通记忆索引：

- **`workflow_observe`** —— 记录 `resume_context`、`checkpoint_session` 等 workflow primitive 是成功、失败、被纠正，还是被漏掉
- **`workflow_health`** —— 汇总单个 workflow 的 7 天 / 30 天健康度，或输出退化 workflow dashboard
- **`workflow_evidence`** —— 打包最近 issue observation、top signals 和后续建议，方便做规则或测试收口

这些记录默认落在 `data/workflow-observations`，不属于那 6 类 memory，也不会被 `resume_context` 当成 stable recall 回注。

### 记忆升级与冲突决议

原始 transcript 不会静默变成长期记忆：

- **Evidence → Durable** —— 显式 `promote_memory`，带 `canonicalKey` 和来源追踪
- **冲突守卫** —— canonicalKey 碰撞会生成冲突候选项
- **决议方式** —— 保留已有、接受新的、或合并 —— 带建议和聚类视图
- **审计 + 升级** —— `conflicts audit --export` 输出运营审查报告

### 检索策略

| 策略 | 适用场景 | 偏向 |
|------|---------|------|
| `default` | 日常回忆 | 均衡 |
| `writing` | 写作和灵感挖掘 | 语义更宽，较旧内容也保留 |
| `debug` | 报错、命令、修复 | 关键词优先，偏近期 |
| `fact-check` | 证据查找 | 阈值更严，偏精确匹配 |

### 记忆分类

| 分类 | 说明 | 策略 |
|------|------|------|
| `profile` | 用户身份和背景 | 合并 |
| `preferences` | 习惯、风格、偏好 | 合并 |
| `entities` | 项目、工具、人物 | 合并 |
| `events` | 发生过的事情 | 追加 |
| `cases` | 问题 → 解决方案 | 追加 |
| `patterns` | 可复用工作流 | 合并 |

详情：[`docs/memory-categories.md`](docs/memory-categories.md)

---

<details>
<summary><strong>MCP 工具（25 个）</strong></summary>

| 工具 | 说明 |
|------|------|
| `workflow_observe` | 记录一条 append-only workflow observation，不写进普通 memory |
| `workflow_health` | 查看单个 workflow 的健康度，或输出退化 workflow dashboard |
| `workflow_evidence` | 为某个 workflow primitive 生成 evidence pack |
| `store_memory` | 存一条可跨窗口复用的长期记忆 |
| `store_workflow_pattern` | 把可复用工作流存成 durable `patterns` 记忆 |
| `store_case` | 把可复用问题-解决方案存成 durable `cases` 记忆 |
| `promote_memory` | 把 evidence 显式升级成 durable memory |
| `list_conflicts` | 列出或查看 promotion 冲突候选项 |
| `audit_conflicts` | 汇总 stale / escalated 冲突的优先级 |
| `escalate_conflicts` | 预览或应用冲突升级元数据 |
| `resolve_conflict` | 解决一条冲突候选项（保留 / 接受 / 合并） |
| `checkpoint_session` | 把当前工作状态存成独立 checkpoint |
| `latest_checkpoint` | 查看某个 session 或 scope 的最新 checkpoint |
| `resume_context` | 为新窗口编排启动上下文 |
| `search_memory` | 在任务开始时主动回忆 |
| `explain_memory` | 解释为什么这些记忆被命中 |
| `distill_memory` | 把结果提炼成简报 |
| `brief_memory` | 创建结构化 brief 并回写索引 |
| `pin_memory` | 把一条带 scope 边界的记忆提升成 pinned asset |
| `export_memory` | 把 distill 结果导出到磁盘 |
| `list_pins` | 列出 pinned 记忆 |
| `list_assets` | 列出所有结构化资产 |
| `list_dirty_briefs` | 预览旧规则生成的 dirty brief 资产 |
| `clean_dirty_briefs` | 归档 dirty brief 并清理其索引行 |
| `memory_stats` | 查看索引统计 |

</details>

<details>
<summary><strong>HTTP API（19 个端点）</strong></summary>

基础地址：`http://localhost:4318`

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/recall` | POST | 快速语义搜索 |
| `/v1/store` | POST | 写入一条新记忆 |
| `/v1/capture` | POST | 批量写入结构化记忆 |
| `/v1/pattern` | POST | 写入结构化 workflow pattern |
| `/v1/case` | POST | 写入结构化 problem-solution case |
| `/v1/promote` | POST | 把 evidence 显式升级成 durable memory |
| `/v1/conflicts` | GET | 列出或查看冲突候选项 |
| `/v1/conflicts/audit` | GET | 汇总冲突优先级 |
| `/v1/conflicts/escalate` | POST | 预览或应用冲突升级元数据 |
| `/v1/conflicts/resolve` | POST | 解决一条冲突候选项（保留 / 接受 / 合并） |
| `/v1/checkpoint` | POST | 写入当前工作状态的 checkpoint |
| `/v1/workflow-observe` | POST | 把 workflow observation 写到独立 store，不混入 durable memory |
| `/v1/checkpoint/latest` | GET | 按 session 或 scope 取最新 checkpoint |
| `/v1/workflow-health` | GET | 查看 workflow 健康度，或返回退化 workflow dashboard |
| `/v1/workflow-evidence` | GET | 从最近 issue observation 生成 workflow evidence pack |
| `/v1/resume` | POST | 为新窗口编排启动上下文 |
| `/v1/search` | POST | 高级搜索，返回完整元数据 |
| `/v1/stats` | GET | 查看记忆统计 |
| `/v1/health` | GET | 健康检查 |

完整文档：[`docs/api-reference.md`](docs/api-reference.md)

</details>

<details>
<summary><strong>CLI 命令</strong></summary>

```bash
# 搜索与探索
bun run src/cli.ts search "你的查询"
bun run src/cli.ts explain "你的查询" --profile debug
bun run src/cli.ts distill "主题" --profile writing
bun run src/cli.ts stats

# Workflow observation
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

# 导入与诊断
bun run src/cli.ts ingest --source all
bun run src/cli.ts doctor
```

</details>

<details>
<summary><strong>Web UI（调试用）</strong></summary>

```bash
bun run src/ui-server.ts
# → http://localhost:4317
```

Web UI 主要用于调试和探索，不是主要生产接口。

</details>

---

## 与 memory-lancedb-pro 的关系

RecallNest 最初从 [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) fork 而来，共享其混合检索、衰减建模和记忆工程化的核心思路。关键区别：

- **memory-lancedb-pro** 是 OpenClaw 插件 —— 为单个 OpenClaw Agent 添加长期记忆。
- **RecallNest** 是独立记忆层 —— 同时服务 Claude Code、Codex 和 Gemini CLI，内建会话连续性、结构化资产和冲突管理。

## 致谢

| 来源 | 贡献 |
|------|------|
| [claude-memory-pro](https://github.com/CortexReach/claude-memory-pro) by [@win4r](https://github.com/win4r) | 检索核心思路和实现基础 |
| Claude Code | 基础架构和早期搭建 |
| OpenAI Codex | 产品化和 MCP 扩展 |

特别感谢秦超老师（[@win4r](https://github.com/win4r)）和 [CortexReach](https://github.com/CortexReach) 团队的基础工作。

## Star History

<a href="https://star-history.com/#AliceLJY/recallnest&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=AliceLJY/recallnest&type=Date&theme=dark&transparent=true" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=AliceLJY/recallnest&type=Date&transparent=true" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=AliceLJY/recallnest&type=Date&transparent=true" />
  </picture>
</a>

## 许可证

MIT
