# RecallNest

> 面向 Claude Code、Codex、Gemini CLI 的共享记忆层。

RecallNest 是一个本地优先的记忆系统，目标不是单纯“搜索聊天记录”，而是让三个终端共享同一套长期记忆，在换窗口后也能尽量延续有价值的上下文，并逐步把原始 transcript 沉淀成可复用知识。

[English](README.md) · [Roadmap](ROADMAP.md)

## 它要解决的问题

- 你的历史上下文分散在 Claude Code、Codex、Gemini CLI 三个终端里。
- 一开新窗口就容易像从零开始，明明有些稳定背景本该继续记得。
- 纯搜索式记忆太被动，agent 不主动查，就等于忘了。
- 原始 transcript 很多，但真正高价值、可工作的记忆很少。
- 很多记忆方案只服务一个客户端，不能覆盖整个终端工作流。

## RecallNest 现在已经能做什么

- 给 Claude Code、Codex、Gemini CLI 提供同一个基于 LanceDB 的共享记忆索引。
- 同时提供 MCP 和 HTTP API，让 CLI 工具和自定义 agent 共用同一层记忆。
- 一键接入脚本会同时安装 MCP 和 continuity 规则，让 Claude Code、Codex、Gemini CLI 默认带这套跨窗口行为。
- 支持把已有对话历史和记忆文件 ingest 进统一索引。
- 提供向量检索 + BM25 + rerank + 分类 + tier + 衰减的混合召回。
- 提供 pin / brief / distill 这类结构化资产，让有效上下文不只停留在原始日志里。
- 提供 session checkpoint 和 `resume_context`，让新窗口可以恢复稳定背景，而不是只拿到一堆原始搜索结果。
- 提供显式的 evidence -> durable promotion 与 `canonicalKey` 守卫，避免 transcript 片段静默污染长期记忆。
- 提供面向终端的 conflict review、audit、escalation、merge 和 audit export，让记忆冲突变成可见、可处理、可交接的工作流。

这意味着它现在已经适合用来回忆过去的修复方案、项目背景、常见实体、复用模式，以及一些稳定偏好。

## 接下来要补什么

- 先把 continuity eval 和 live checkpoint 隔离开。
  目标：避免日常存了新 checkpoint 之后，连续性评测结果被环境状态带偏。
- 补 conflict audit / export 的定时巡检能力。
  目标：把现在可手动执行的冲突巡检，推进成轻量的持续运营流。
- 继续增强高价值记忆提取，以及 merge / promotion 的判断质量。
  目标：沉淀更多 durable working knowledge，减少低信号记忆和人工裁决成本。

## 当前状态

### 已做到

- [x] HTTP API：`/v1/recall`、`/v1/store`、`/v1/capture`、`/v1/pattern`、`/v1/case`、`/v1/checkpoint`、`/v1/checkpoint/latest`、`/v1/resume`、`/v1/search`、`/v1/stats`、`/v1/health`
- [x] MCP 工具：`store_memory`、`store_workflow_pattern`、`store_case`、`checkpoint_session`、`latest_checkpoint`、`resume_context`、`search_memory`、`explain_memory`、`distill_memory`、`brief_memory`、`pin_memory`、`memory_stats`
- [x] Claude Code、Gemini CLI、Codex 的一键接入脚本，并自动安装 continuity 规则
- [x] 三个终端共享同一个本地记忆索引
- [x] 已有 transcript 和 memory 文件的 ingest 管线
- [x] 6 类记忆分类、混合检索、检索 profile、tier 和衰减
- [x] 可回写索引的 brief / pin 资产机制
- [x] 独立的 session checkpoint 存储层
- [x] 面向新窗口的 `resume_context` 启动上下文编排
- [x] retrieval / continuity 两套评测入口、seed cases 和 baseline 报告
- [x] 专门面向 durable `patterns` 的 workflow pattern 写入入口
- [x] `doctor` 诊断命令和轻量 Web UI
- [x] 显式的 evidence -> durable promotion、`canonicalKey`、provenance 和 conflict candidate 流
- [x] 面向终端的 conflict review：`recallnest conflicts list/show/resolve`，并支持建议与聚类视图
- [x] 对 canonicalKey 冲突的显式守卫，包括跨 category durable 写入冲突
- [x] conflict audit / escalation，以及 same-category durable conflict 的 `merge` resolution
- [x] `recallnest conflicts audit --export --format md|json` 导出当前冲突巡检快照

### 当前缺口

- [ ] 有一条 continuity eval case 仍依赖“当前最新 live checkpoint”，会被日常新 checkpoint 影响
- [ ] conflict audit / export 目前已可用，但还没有定时巡检这一层
- [ ] 高价值记忆提取仍有提升空间，召回里还能继续减少低信号 transcript 碎片

### 如果后面继续开发

- [ ] 先把 continuity eval 和 live checkpoint 状态隔离
- [ ] 再做 conflict audit / export 的定时巡检
- [ ] 然后继续收 capture、merge、promotion heuristics

## 快速开始

```bash
git clone https://github.com/AliceLJY/recallnest.git
cd recallnest
bun install
cp config.json.example config.json
cp .env.example .env
# 编辑 .env -> 填入 JINA_API_KEY
```

### 启动 API 服务

```bash
bun run api
# -> RecallNest API running at http://localhost:4318
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
bun run seed:patterns
bun run seed:cases
bun run src/cli.ts doctor
bun run eval:continuity
```

## 集成方式

RecallNest 提供两条接入路径：

- MCP：给 Claude Code、Gemini CLI、Codex 这种终端工具使用
- HTTP API：给自定义 agent 和 SDK 应用使用

### CLI 工具

```bash
bash integrations/claude-code/setup.sh
bash integrations/gemini-cli/setup.sh
bash integrations/codex/setup.sh
```

### Agent 框架示例

示例位于 [`integrations/examples/`](integrations/examples/)：

| 框架 | 示例文件 | 语言 |
|------|---------|------|
| [Claude Agent SDK](integrations/examples/claude-agent-sdk/) | `memory-agent.ts` | TypeScript |
| [OpenAI Agents SDK](integrations/examples/openai-agents-sdk/) | `memory-agent.py` | Python |
| [LangChain](integrations/examples/langchain/) | `memory-chain.py` | Python |

## API 端点

基础地址：`http://localhost:4318`

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/recall` | POST | 快速语义搜索 |
| `/v1/store` | POST | 写入一条新记忆 |
| `/v1/capture` | POST | 批量写入结构化记忆 |
| `/v1/pattern` | POST | 写入结构化 workflow pattern |
| `/v1/case` | POST | 写入结构化 problem-solution case |
| `/v1/promote` | POST | 把 evidence 显式升级成 durable memory |
| `/v1/conflicts` | GET | 列出或查看 promotion conflict candidates |
| `/v1/conflicts/audit` | GET | 汇总 stale / escalated conflict 的优先级 |
| `/v1/conflicts/escalate` | POST | 预览或应用 conflict escalation metadata |
| `/v1/conflicts/resolve` | POST | 解决一条已存 conflict candidate（保留 / 接受 / 合并） |
| `/v1/checkpoint` | POST | 写入当前工作状态的 checkpoint |
| `/v1/checkpoint/latest` | GET | 按 session 或 scope 取最新 checkpoint |
| `/v1/resume` | POST | 为新窗口编排启动上下文 |
| `/v1/search` | POST | 高级搜索，返回完整元数据 |
| `/v1/stats` | GET | 查看记忆统计 |
| `/v1/health` | GET | 健康检查 |

完整文档：[`docs/api-reference.md`](docs/api-reference.md)

## MCP 工具

| 工具 | 说明 |
|------|------|
| `store_memory` | 存一条可跨窗口复用的长期记忆 |
| `store_workflow_pattern` | 把可复用工作流存成 durable `patterns` 记忆 |
| `store_case` | 把可复用问题-解决方案存成 durable `cases` 记忆 |
| `promote_memory` | 把 evidence 显式升级成 durable memory |
| `list_conflicts` | 列出或查看 promotion conflict candidates |
| `audit_conflicts` | 汇总 stale / escalated conflict 的优先级 |
| `escalate_conflicts` | 预览或应用 conflict escalation metadata |
| `resolve_conflict` | 解决一条已存 conflict（保留 / 接受 / 合并） |
| `checkpoint_session` | 把当前工作状态存成独立 checkpoint |
| `latest_checkpoint` | 查看某个 session 或 scope 的最新 checkpoint |
| `resume_context` | 为新窗口编排启动上下文 |
| `search_memory` | 在任务开始时主动回忆 |
| `explain_memory` | 解释为什么这些记忆被命中 |
| `distill_memory` | 把结果提炼成简报 |
| `brief_memory` | 创建结构化 brief 并回写索引 |
| `pin_memory` | 把记忆提升成 pinned asset |
| `memory_stats` | 查看索引统计 |

## 记忆分类

| 分类 | 说明 | 策略 |
|------|------|------|
| `profile` | 用户身份和背景 | 合并 |
| `preferences` | 习惯、风格、偏好 | 合并 |
| `entities` | 项目、工具、人物 | 合并 |
| `events` | 发生过的事情 | 追加 |
| `cases` | 问题 -> 解决方案 | 追加 |
| `patterns` | 可复用工作流 | 合并 |

详情：[`docs/memory-categories.md`](docs/memory-categories.md)

## 检索 Profile

| Profile | 适用场景 | 偏向 |
|---------|---------|------|
| `default` | 日常回忆 | 均衡 |
| `writing` | 写作和灵感挖掘 | 语义更宽，较旧内容也可保留 |
| `debug` | 报错、命令、修复 | 关键词优先，更偏近期 |
| `fact-check` | 证据查找 | 阈值更严，偏精确匹配 |

## 架构

详见 [`docs/architecture.md`](docs/architecture.md)。

## 其他接口

### CLI

```bash
bun run src/cli.ts search "你的查询"
bun run src/cli.ts explain "你的查询" --profile debug
bun run src/cli.ts distill "主题" --profile writing
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
bun run src/cli.ts stats
```

### Web UI

```bash
bun run src/ui-server.ts
# -> http://localhost:4317
```

Web UI 主要用于调试和探索，不是主要生产接口。

## 致谢

| 来源 | 贡献 |
|------|------|
| [claude-memory-pro](https://github.com/CortexReach/claude-memory-pro) by [@win4r](https://github.com/win4r) | 检索核心思路和实现基础 |
| Claude Code | 基础架构和早期搭建 |
| OpenAI Codex | 产品化和 MCP 扩展 |

特别感谢秦超老师（[@win4r](https://github.com/win4r)）和 [CortexReach](https://github.com/CortexReach) 团队。RecallNest 延续了 `memory-lancedb-pro` 在混合检索、scope 感知和记忆工程化上的核心思路，但把方向放在更广义的三终端共享记忆层。

## 许可证

MIT
