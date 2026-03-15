# RecallNest

> 给任何 AI agent 加上会自我进化的记忆。

让你的 AI agent 拥有跨会话的持久记忆——自动整合、越用越聪明。支持任何框架：Claude Agent SDK、OpenAI Agents SDK、LangChain，或直接用 HTTP API。

[English](README.md)

## 为什么选 RecallNest

| 特性 | RecallNest | 同类方案 |
|------|:---------:|:-------:|
| 支持任何 agent 框架 | ✅ HTTP API + MCP | ❌ 单工具绑定 |
| 自我进化（整合 + 缺口检测） | ✅ | ❌ |
| 6 类记忆分类 | ✅ | ❌ |
| Weibull 衰减 + 三层生命周期 | ✅ | ❌ |
| 混合检索（向量 + BM25 + 重排序） | ✅ | 部分 |
| 一键集成脚本 | ✅ | ❌ |

## 快速开始

```bash
git clone https://github.com/AliceLJY/recallnest.git
cd recallnest
bun install
cp config.json.example config.json
cp .env.example .env
# 编辑 .env → 填入 JINA_API_KEY
```

### 启动 API 服务

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

### 索引已有对话

```bash
bun run src/cli.ts ingest --source all
bun run src/cli.ts doctor   # 验证配置
```

## 集成方式

RecallNest 提供两种接入方式：**HTTP API**（任何语言）和 **MCP**（Claude Code、Gemini CLI、Codex）。

### CLI 工具（一键安装）

```bash
# Claude Code
bash integrations/claude-code/setup.sh

# Gemini CLI
bash integrations/gemini-cli/setup.sh

# Codex
bash integrations/codex/setup.sh
```

### Agent 框架示例

现成的接入示例，见 [`integrations/examples/`](integrations/examples/)：

| 框架 | 示例文件 | 语言 |
|------|---------|------|
| [Claude Agent SDK](integrations/examples/claude-agent-sdk/) | `memory-agent.ts` | TypeScript |
| [OpenAI Agents SDK](integrations/examples/openai-agents-sdk/) | `memory-agent.py` | Python |
| [LangChain](integrations/examples/langchain/) | `memory-chain.py` | Python |

每个示例约 30 行代码，展示如何给 agent 加上 `recall_memory` 和 `store_memory` 工具。

## API 端点

基础地址：`http://localhost:4318`

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/recall` | POST | 语义搜索（快速模式） |
| `/v1/store` | POST | 存入新记忆 |
| `/v1/search` | POST | 高级搜索（含完整元数据） |
| `/v1/stats` | GET | 记忆统计 |
| `/v1/health` | GET | 健康检查 |

完整文档：[`docs/api-reference.md`](docs/api-reference.md)

## MCP 工具

通过 MCP 连接后，agent 可使用以下工具：

| 工具 | 说明 |
|------|------|
| `search_memory` | 主动回忆——agent 被引导在每个任务开始时使用 |
| `explain_memory` | 解释为什么这些记忆被匹配 |
| `distill_memory` | 将结果提炼为简报 |
| `brief_memory` | 创建结构化简报并回写到索引 |
| `pin_memory` | 将记忆提升为固定资产 |
| `memory_stats` | 索引统计（含分类分布） |

## 记忆分类

RecallNest 在入库时自动将记忆分为 6 类：

| 分类 | 说明 | 策略 |
|------|------|------|
| `profile` | 用户身份和背景 | 合并 |
| `preferences` | 习惯、风格、偏好 | 合并 |
| `entities` | 项目、工具、人物 | 合并 |
| `events` | 发生过的事情 | 追加 |
| `cases` | 问题 → 解决方案 | 追加 |
| `patterns` | 可复用的工作流 | 合并 |

详情：[`docs/memory-categories.md`](docs/memory-categories.md)

## 检索 Profile

| Profile | 适用场景 | 偏向 |
|---------|---------|------|
| `default` | 日常回忆 | 均衡 |
| `writing` | 写作、灵感挖掘 | 语义更宽、允许较旧的内容 |
| `debug` | 报错、命令、修复 | 关键词优先、偏向近期 |
| `fact-check` | 证据查找 | 精确匹配、更严格的阈值 |

## 架构

```
┌─────────────────────────────────────────────────┐
│                   AI Agents                      │
├──────────┬──────────┬──────────┬────────────────┤
│ Claude   │ OpenAI   │ LangChain│ 任何 HTTP      │
│ Agent SDK│ Agents   │          │ 客户端         │
└────┬─────┴────┬─────┴────┬─────┴──────┬─────────┘
     │          │          │            │
     ▼          ▼          ▼            ▼
┌─────────────────────────────────────────────────┐
│             RecallNest 接入层                     │
├─────────────────┬───────────────────────────────┤
│  HTTP API :4318 │   MCP Server (stdio)          │
└────────┬────────┴────────────┬──────────────────┘
         │                     │
         ▼                     ▼
┌─────────────────────────────────────────────────┐
│             RecallNest 核心引擎                   │
│  混合检索 · 6 类分类 · Weibull 衰减              │
│  三层生命周期 · 智能提取 · 自我进化（规划中）      │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│       LanceDB + Jina Embeddings v5              │
└─────────────────────────────────────────────────┘
```

详情：[`docs/architecture.md`](docs/architecture.md)

## 其他接口

### 命令行

```bash
bun run src/cli.ts search "你的查询"
bun run src/cli.ts explain "你的查询" --profile debug
bun run src/cli.ts distill "主题" --profile writing
bun run src/cli.ts stats
```

### Web UI（调试工具）

提供轻量级 Web 界面用于调试和浏览记忆：

```bash
bun run src/ui-server.ts
# → http://localhost:4317
```

> Web UI 是开发调试工具，不是主要接口。生产环境请使用 HTTP API 或 MCP。

## 路线图

见 [ROADMAP.md](./ROADMAP.md)。

**即将到来：**
- 记忆整合（自动合并重复内容）
- 缺口检测（发现覆盖不足的主题）
- 上浮建议（高频记忆推荐写入持久配置）

## 致谢

感谢秦超老师（[@win4r](https://github.com/win4r)）和 [CortexReach](https://github.com/CortexReach) 团队。RecallNest 的检索设计——混合搜索、重排序、scope 感知、记忆工程化——直接源自 `memory-lancedb-pro` 的思路。RecallNest 走了不同的方向（通用 agent 记忆层），但共享同一个基础。

| 来源 | 贡献 |
|------|------|
| [claude-memory-pro](https://github.com/CortexReach/claude-memory-pro) by [@win4r](https://github.com/win4r) | 检索核心思路和实现基础 |
| Claude Code | 基础架构和早期搭建 |
| OpenAI Codex | 产品化和 MCP 扩展 |

## 许可证

MIT
