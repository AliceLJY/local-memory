# RecallNest 进化计划

## 愿景

> **RecallNest：给任何 AI agent 加上会自我进化的记忆。**
> Agent-agnostic. Self-evolving. One-click setup.

不跟 claude-memory-pro 抢 CC 深度专精的赛道。
RecallNest 走通用路线：**任何 agent 框架、任何 LLM、任何接入方式**都能用。

---

## 定位对比

| | claude-memory-pro（秦超老师） | RecallNest（我们） |
|---|---|---|
| **定位** | CC 最佳记忆体验 | 任何 agent 的通用记忆层 |
| **用户** | CC 用户 | 搭 agent 的开发者 |
| **接入** | CC hooks + MCP | HTTP API + MCP + SDK |
| **深度** | reflection、self-improvement、CC 全家桶 | 自我进化（整合、缺口检测、上浮） |
| **广度** | CC 专属 | Claude SDK / OpenAI SDK / LangChain / 任何能发 HTTP 的 |
| **关系** | 互补，不竞争 | 致敬来源，走自己的路 |

---

## 方向取舍

**这是我们的护城河**：
- **通用 HTTP API** — 任何语言、任何框架、任何 agent 都能调
- **自我进化引擎** — 记忆整合、缺口检测、高频上浮
- **MCP 通用接入** — CC / Gemini / Codex / 任何支持 MCP 的 agent
- **检索质量** — 混合检索 + Weibull 衰减 + 6 类分类 + 4 种 profile

**这些让给秦超老师**：
- CC hooks 深度集成（他已经做了 memory-recall.sh / memory-capture.sh）
- CC reflection 系统（他的 reflection-store 已经很深）
- CC self-improvement（LEARNINGS.md / ERRORS.md 体系）

**降低优先级**：
- Web UI — 调试用，不是重点
- 更多 MCP 工具 — 够用就行

---

## 架构：通用记忆层

```
┌─────────────────────────────────────────────────────┐
│                    AI Agents                         │
├──────────┬──────────┬──────────┬────────────────────┤
│ Claude   │ OpenAI   │ LangChain│ 任何自建 agent      │
│ Agent SDK│ Agents   │ /LangGraph│                    │
│          │ SDK      │          │                    │
└────┬─────┴────┬─────┴────┬─────┴──────┬─────────────┘
     │          │          │            │
     ▼          ▼          ▼            ▼
┌─────────────────────────────────────────────────────┐
│              RecallNest 接入层                        │
├─────────────┬───────────────┬───────────────────────┤
│  HTTP API   │   MCP Server  │   Node SDK (future)   │
│  (通用)      │  (CC/Gemini/  │   (npm install)       │
│  port 4318  │   Codex)      │                       │
└─────┬───────┴───────┬───────┴───────────┬───────────┘
      │               │                   │
      ▼               ▼                   ▼
┌─────────────────────────────────────────────────────┐
│              RecallNest 核心引擎                      │
├─────────────────────────────────────────────────────┤
│  Hybrid Retrieval (Vector + BM25 + RRF)             │
│  6-Category Classification                          │
│  Weibull Decay + 3-Tier Lifecycle                   │
│  Smart Extraction (LLM-powered)                     │
│  Self-Evolution (consolidation + gap detection)     │
└─────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────┐
│  LanceDB + Jina Embeddings                          │
└─────────────────────────────────────────────────────┘
```

### 目标目录结构

```
recallnest/
├── src/                              # 核心引擎
│   ├── store.ts                      # LanceDB 存储
│   ├── retriever.ts                  # 混合检索
│   ├── ingest.ts                     # 多源入库
│   ├── mcp-server.ts                 # MCP 工具
│   ├── api-server.ts                 # 🆕 通用 HTTP API（核心新增）
│   ├── decay-engine.ts              # Weibull 衰减
│   ├── access-tracker.ts            # 用进废退
│   ├── consolidator.ts              # 🆕 记忆整合
│   ├── gap-detector.ts              # 🆕 缺口检测
│   └── ...
│
├── integrations/                     # Agent 集成（开箱即用）
│   ├── README.md                     # 集成总览
│   ├── claude-code/                  # CC 快速接入
│   │   ├── README.md
│   │   ├── claude-md-snippet.md      # CLAUDE.md 记忆规则模板
│   │   └── setup.sh                  # 一键配 MCP
│   ├── gemini-cli/
│   │   └── setup.sh
│   ├── codex/
│   │   └── setup.sh
│   └── examples/                     # 🆕 Agent 框架示例
│       ├── claude-agent-sdk/         # Claude Agent SDK 接入示例
│       │   └── memory-agent.ts
│       ├── openai-agents-sdk/        # OpenAI Agents SDK 接入示例
│       │   └── memory-agent.py
│       └── langchain/                # LangChain 接入示例
│           └── memory-chain.py
│
├── docs/                             # 面向开源用户
│   ├── self-evolution.md             # 自我进化原理（卖点文档）
│   ├── api-reference.md              # 🆕 HTTP API 文档
│   ├── memory-categories.md          # 6 类分类说明
│   ├── retrieval-profiles.md         # 4 种检索 profile
│   └── architecture.md              # 架构图
│
├── data/                             # 运行时数据（.gitignore）
├── config.json
└── README.md                         # 突出：通用 + 自我进化 + 一键接入
```

---

## Phase 1：通用 HTTP API（P0，最高优先级）

这是跟 claude-memory-pro 拉开差距的关键。他只有 CC hooks，我们有通用 API。

### 1a. API Server（3 小时）

**新建**：`src/api-server.ts`
**端口**：4318

**核心端点**：

```
POST /v1/recall          — 搜索记忆（主动回忆）
POST /v1/store           — 存入新记忆
POST /v1/search          — 带分类/profile 的高级搜索
GET  /v1/stats           — 记忆统计（含分类分布、层级分布）
GET  /v1/health          — 健康检查
POST /v1/consolidate     — 触发记忆整合（dry-run 模式）
GET  /v1/gaps            — 获取记忆缺口报告
```

**设计原则**：
- RESTful，JSON in/out
- 无状态，每个请求自包含
- API key 可选（本地用不需要，远程部署可以加）
- `/v1/` 前缀，为未来版本留余地

**`POST /v1/recall` 示例**：
```json
// Request
{ "query": "Docker bot 怎么排障", "limit": 3, "minScore": 0.5 }

// Response
{
  "results": [
    {
      "id": "a1b2c3d4",
      "text": "Docker bot 崩溃排查：先看日志...",
      "category": "cases",
      "tier": "core",
      "score": 0.87,
      "date": "2026-03-04"
    }
  ],
  "query": "Docker bot 怎么排障",
  "totalMemories": 1247
}
```

**`POST /v1/store` 示例**：
```json
// Request
{
  "text": "用户偏好：代码改完必须 commit + push",
  "category": "preferences",
  "source": "my-custom-agent",
  "importance": 0.85
}

// Response
{ "id": "e5f6g7h8", "stored": true }
```

**为什么这是 P0**：
- 有了 HTTP API，任何语言的 agent 都能接入（Python/JS/Go/Rust/...）
- Claude Agent SDK 的 agent 可以直接 fetch
- OpenAI Agents SDK 的 agent 可以作为 function call 调
- 甚至 curl 都能测试

---

### 1b. MCP 工具描述优化（10 分钟）

**改什么**：`src/mcp-server.ts`

`search_memory` 描述改成主动引导：

> "IMPORTANT: Use this tool proactively at the start of tasks to recall relevant past conversations, decisions, and patterns. Do NOT wait for the user to ask. Query with key nouns from the user's message."

三家 MCP 用户立刻受益。

---

### 1c. 暴露分类过滤（20 分钟）

**改什么**：`src/mcp-server.ts`

给 `search_memory` 加 `category` 参数：
```typescript
category: z.enum(["profile", "preferences", "entities", "events", "cases", "patterns"])
  .optional()
  .describe("Filter by memory category")
```

---

### 1d. 搜索结果显示分类和层级（30 分钟）

**改什么**：`src/memory-output.ts`

每条结果加标签：
```
[cases | core] Score: 0.87 | cc:a1b2c3d4 | 2026-03-10
```

---

## Phase 2：Agent 框架集成示例（P0）

有 API 还不够，要让开发者**看到就能抄**。

### 2a. Claude Agent SDK 示例（1 小时）

**新建**：`integrations/examples/claude-agent-sdk/memory-agent.ts`

一个最小的 Claude Agent SDK agent，带 RecallNest 记忆：
```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const RECALLNEST = "http://localhost:4318";

// 定义 recall 和 store 两个 tool
const tools = [
  {
    name: "recall_memory",
    description: "Recall relevant memories from past conversations",
    input_schema: { type: "object", properties: { query: { type: "string" } } }
  },
  {
    name: "store_memory",
    description: "Store an important fact for future recall",
    input_schema: { type: "object", properties: { text: { type: "string" }, category: { type: "string" } } }
  }
];

// tool handler: 调 RecallNest HTTP API
async function handleTool(name, input) {
  if (name === "recall_memory") {
    const res = await fetch(`${RECALLNEST}/v1/recall`, {
      method: "POST",
      body: JSON.stringify({ query: input.query, limit: 3 })
    });
    return await res.json();
  }
  // ...
}
```

**为什么重要**：这是开发者看到的第一个东西。"哦，原来 10 行代码就能给我的 agent 加记忆。"

---

### 2b. OpenAI Agents SDK 示例（1 小时）

**新建**：`integrations/examples/openai-agents-sdk/memory-agent.py`

Python 版，用 OpenAI Agents SDK：
```python
from agents import Agent, function_tool
import httpx

RECALLNEST = "http://localhost:4318"

@function_tool
def recall_memory(query: str) -> str:
    """Recall relevant memories from past conversations."""
    r = httpx.post(f"{RECALLNEST}/v1/recall", json={"query": query, "limit": 3})
    return r.text

agent = Agent(
    name="Memory Agent",
    instructions="Use recall_memory at the start of every task.",
    tools=[recall_memory],
)
```

---

### 2c. LangChain 示例（1 小时）

**新建**：`integrations/examples/langchain/memory-chain.py`

LangChain 用户数量大，必须有。

---

### 2d. CLI 工具集成模板更新（30 分钟）

`integrations/claude-code/`、`gemini-cli/`、`codex/` 各有 setup.sh，保持简单：
- 配 MCP server
- 注入记忆检索规则到对应的 MD 文件
- 不做深度 hook（CC 的深度 hook 让秦超老师做）

---

## Phase 3：自我进化引擎（P1）

这是 RecallNest 的第二个核心卖点（第一个是通用性）。

### 3a. 记忆整合（3 小时）

**新建**：`src/consolidator.ts`
**触发方式**：`POST /v1/consolidate` 或 CLI `lm consolidate` 或定时任务

1. 找同类别下余弦相似度 >0.85 的记忆簇
2. merge 策略类（profile/preferences/entities/patterns）：LLM 合并成一条，归档原件
3. append 策略类（events/cases）：去重但保留独立条目
4. 升级高频 peripheral → working
5. 降级沉寂 working → peripheral

**安全措施**：归档原件，默认 dry-run。

---

### 3b. 记忆缺口检测（2 小时）

**新建**：`src/gap-detector.ts`
**触发方式**：`GET /v1/gaps` 或 CLI `lm gaps`

1. 分析近期搜索中低分/零结果的 query
2. 按主题聚类
3. 返回缺口报告

---

### 3c. 高频记忆上浮建议（1 小时）

在 consolidator 里加：
- core 层级 + 访问 ≥ 10 的记忆 → 建议"应该写到 agent 的持久配置里"
- 通过 `/v1/consolidate` 返回 `promotionSuggestions` 字段

---

## Phase 4：文档 + 开源门面（P1）

### 4a. README 重写

突出三个卖点：

```markdown
# RecallNest 🧠

Memory layer for AI agents that evolves itself.

## Why RecallNest?

| Feature | RecallNest | Other solutions |
|---------|:---------:|:--------------:|
| Works with any agent framework | ✅ | ❌ CC-only |
| HTTP API (any language) | ✅ | ❌ |
| Self-evolution (consolidation + gap detection) | ✅ | ❌ |
| MCP Server | ✅ | ✅ |
| 6-category classification | ✅ | ✅ |
| Weibull decay lifecycle | ✅ | ✅ |

## Quick Start

# Start the API server
bun run src/api-server.ts

# From any agent, any language:
curl -X POST http://localhost:4318/v1/recall \
  -d '{"query": "how to debug Docker"}'

## Integrations
- [Claude Code](integrations/claude-code/)
- [Gemini CLI](integrations/gemini-cli/)
- [Claude Agent SDK example](integrations/examples/claude-agent-sdk/)
- [OpenAI Agents SDK example](integrations/examples/openai-agents-sdk/)
- [LangChain example](integrations/examples/langchain/)
```

### 4b. API 文档（`docs/api-reference.md`）

每个端点的详细说明 + 请求/响应示例。

### 4c. 自我进化原理文档（`docs/self-evolution.md`）

解释 Weibull 衰减、分层、整合、缺口检测的原理。**这篇文档本身就能吸引 star。**

### 4d. 致敬

README 底部：
> Inspired by [claude-memory-pro](https://github.com/CortexReach/claude-memory-pro) by Qin Chao.

---

## 给 claude-memory-pro 提的 PR（独立轨道）

小而精，容易合，展示价值：

| PR | 内容 | 难度 |
|----|------|------|
| 1 | MCP search_memory 加 category 过滤参数 | 低 |
| 2 | 搜索结果显示分类和层级标签 | 低 |
| 3 | MCP 工具描述优化（主动引导 agent 搜索） | 低 |
| 4 | 文档：分类体系使用指南 | 低 |

这些 PR 都是从 RecallNest 实践中提炼的，跟 RecallNest 的方向不冲突。

---

## 实施节奏

| 时间 | 步骤 | 效果 |
|------|------|------|
| **第 1 周** | 1a HTTP API + 1b/1c/1d MCP 优化 | 通用 API 可用，MCP 更智能 |
| **第 2 周** | 2a/2b/2c Agent 框架示例 + 2d 集成模板 | 开发者看到就能接入 |
| **第 3 周** | 3a/3b/3c 自我进化引擎 | 记忆会自我维护 |
| **第 4 周** | 4a-4d 文档 + README + 致敬 | 开源门面完成 |
| **持续** | 给 claude-memory-pro 提小 PR | 维护关系，展示价值 |

---

## 验收标准

### 通用性
- [ ] `curl localhost:4318/v1/recall` 能正常返回结果
- [ ] `POST /v1/store` 能存入新记忆并被后续搜索命中
- [ ] Claude Agent SDK 示例跑通
- [ ] OpenAI Agents SDK 示例跑通
- [ ] 三家 CLI 工具的 setup.sh 一键跑通

### 自我进化
- [ ] `POST /v1/consolidate` 能识别合并候选（dry-run）
- [ ] `GET /v1/gaps` 能返回记忆缺口报告
- [ ] 搜索结果显示分类和层级标签
- [ ] search_memory 支持 category 过滤

### 开源门面
- [ ] README 突出：通用 + 自我进化 + 一键接入
- [ ] API 文档完整，每个端点有示例
- [ ] 致敬 claude-memory-pro

### 与 claude-memory-pro 的关系
- [ ] 至少提 2 个小 PR 被合并
- [ ] README 有致敬链接
