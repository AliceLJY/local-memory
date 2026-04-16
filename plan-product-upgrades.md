# RecallNest 产品化升级实施计划

## 目标

把 RecallNest 从"引擎很强但用户无感"变成"用户能看到记忆在成长"。

## 四个升级（按优先级）

---

### Upgrade 1: SKILL.md — 记忆伙伴使用协议

**做什么**：在 repo 根目录创建 `SKILL.md`，教 LLM 怎么当好记忆伙伴（不只是 API 文档）。

**内容结构**：
- Session Protocol（resume → work → checkpoint）
- Onboarding Flow（首次检测：memory_stats 为 0 时引导）
- Memory Feedback（store 后回显，search 后展示匹配）
- Tool Decision Tree（什么时候 store vs checkpoint vs pin）
- Weekly Health Check（data_checkup + dream + lint）

**改动**：
- 新建 `SKILL.md`（~250 行 markdown）
- 零代码改动

**风险**：低。纯文档。

---

### Upgrade 2: Memory Lint — 记忆体检

**做什么**：新增 MCP tool + CLI 命令，对记忆做质量自检。

**检查项**：
| 检查 | 复用什么 | 怎么做 |
|------|---------|--------|
| 矛盾检测 | `detectHeuristicContradiction`（consolidation-engine.ts） | 同 scope 同 category 内两两比较 |
| 重复检测 | `cosineSimilarity`（multi-vector.ts） | 向量相似度 > 0.92 的配对 |
| 陈旧检测 | `parseEvolution` 的 accessCount/lastAccessedAt | 90 天未被召回 + accessCount ≤ 1 |
| 孤儿检测 | consolidatedInto 指向的 ID | 不存在的引用 |
| 健康分 | 综合以上 | 100 - (矛盾×10 + 重复×5 + 陈旧×2 + 孤儿×3) |

**改动**：
- 新建 `src/memory-lint.ts`（~180 行）
- 新建 `src/__tests__/memory-lint.test.ts`（~150 行）
- 改 `src/mcp-server.ts`：注册 `memory_lint` tool（~25 行）
- 改 `src/cli.ts`：增加 `lint` 命令（~30 行）
- 改 `src/api-server.ts`：增加 `GET /v1/lint`（~20 行）
- 改 `src/consolidation-engine.ts`：export `detectHeuristicContradiction`（1 行）
- 改 `package.json`：增加 `lint:memory` 脚本

**性能守卫**：矛盾/重复检测是 O(n²)，每个 scope/category 组限 200 条，按 importance 降序取。

**预计**：~405 LOC

**风险**：中。矛盾检测基于启发式，会有误报，报告中标注"启发式建议"。

---

### Upgrade 3: Dashboard 仪表盘首页

**做什么**：现有 UI（port 4317）只有搜索，加一个 Dashboard 首页 tab。

**展示内容**：
- 总记忆数 + 分类分布（bar chart，纯 CSS 实现，不引入图表库）
- 本周/本月新增趋势
- 健康分（来自 Lint）
- 最近召回 Top N
- 沉睡记忆列表（90天未召回）

**改动**：
- 改 `src/ui-server.ts`：新增 4 个 API endpoint（~80 行）
  - `GET /api/dashboard-stats`
  - `GET /api/recent-recalls`
  - `GET /api/lint-summary`
  - `GET /api/stale-memories`
- 改 `assets/ui/index.html`：增加 Dashboard tab（~60 行）
- 改 `assets/ui/app.js`：Dashboard 渲染逻辑（~120 行）
- 改 `assets/ui/styles.css`：Dashboard 样式（~80 行）

**依赖**：Upgrade 2（Lint 的健康分）。可以先不接 Lint，用 placeholder。

**预计**：~340 LOC

**风险**：中。Growth trend 需要扫全量 entries 按时间分桶，大库可能慢。缓存 60s 缓解。

---

### Upgrade 4: HTML 知识图谱

**做什么**：把记忆导出为一个交互式 HTML 文件，浏览器打开即可看到力导向图。

**节点/边设计**：
- 节点 = 每条记忆，颜色按 category（profile=金, preferences=蓝, entities=绿, events=灰, cases=红, patterns=紫）
- 边 = scope 关系 + consolidation 链 + supersede 链 + cluster 关系
- 支持缩放、拖拽、点击查看详情

**改动**：
- 新建 `src/graph-export.ts`（~250 行）
  - `buildMemoryGraph()`：从 store 构建节点/边
  - `renderGraphHTML()`：生成自包含 HTML（D3.js via CDN，或 `--offline` 内嵌）
  - `exportMemoryGraph()`：写文件到 `data/exports/`
- 新建 `src/__tests__/graph-export.test.ts`（~100 行）
- 改 `src/mcp-server.ts`：注册 `export_graph` tool（~25 行）
- 改 `src/cli.ts`：增加 `graph` 命令（~25 行）
- 改 `src/ui-server.ts`：增加 `/api/graph` endpoint（~20 行）

**默认上限**：200 节点（按 importance 降序），避免图谱变成乱麻。

**预计**：~420 LOC

**风险**：中高。>100 节点时力导向布局可能卡顿。限制节点数+scope 过滤。

---

## 实施顺序

```
Phase 1（可独立合并）
  ├── 1.1 SKILL.md（无代码依赖）
  └── 1.2 memory-lint.ts + tests

Phase 2（依赖 1.2）
  ├── 2.1 Lint MCP tool + CLI
  └── 2.2 Lint API endpoint

Phase 3（依赖 Phase 2）
  └── 3.1 Dashboard 首页

Phase 4（独立，可与 1-3 并行）
  └── 4.1 HTML 知识图谱
```

**可并行**：SKILL.md 和 Graph Export 不依赖其他升级。

## 总改动量

| 升级 | 新文件 | 改动文件 | 新增 LOC |
|------|--------|---------|---------|
| SKILL.md | 1 | 0 | ~250 (markdown) |
| Memory Lint | 2 | 4 | ~405 |
| Dashboard | 0 | 4 | ~340 |
| Knowledge Graph | 2 | 3 | ~420 |
| **总计** | **5** | **~8** | **~1,415** |

## 成功标准

- [ ] SKILL.md 覆盖 5 个核心场景
- [ ] `memory_lint` MCP tool 返回矛盾/重复/陈旧/孤儿数量 + 0-100 健康分
- [ ] `bun run src/cli.ts lint` CLI 输出相同报告
- [ ] Dashboard tab 展示总记忆数、分类分布、健康分、沉睡记忆
- [ ] `bun run src/cli.ts graph` 生成有效 HTML，浏览器打开有交互图谱
- [ ] 现有 1168 个测试全部通过
- [ ] 新增测试 > 20 个
- [ ] 不引入新 npm 依赖
