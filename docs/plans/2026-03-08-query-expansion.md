# Query Expansion for Fuzzy Chinese Search

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a lightweight Chinese synonym/colloquial-to-technical query expansion layer before retrieval, improving fuzzy search hit rate without adding API dependencies.

**Architecture:** New `query-expander.ts` module with a static synonym dictionary. Called in `retriever.ts` before BM25 search — expands the original query into additional BM25 search terms. Vector search stays unchanged (Jina embeddings already handle semantic similarity). The expansion only boosts BM25 recall for terms that the user says differently from how they're stored.

**Tech Stack:** Pure TypeScript, no new dependencies. Static dictionary file.

---

### Task 1: Create synonym dictionary + expander module

**Files:**
- Create: `src/query-expander.ts`
- Test: `src/__tests__/query-expander.test.ts`

**Step 1: Write the failing test**

```typescript
// src/__tests__/query-expander.test.ts
import { describe, it, expect } from "bun:test";
import { expandQuery } from "../query-expander.js";

describe("expandQuery", () => {
  it("expands colloquial Chinese to technical terms", () => {
    const result = expandQuery("bot 突然挂了");
    expect(result).toContain("崩溃");
    expect(result).toContain("crash");
    expect(result).toContain("挂了");
  });

  it("expands fuzzy feeling queries", () => {
    const result = expandQuery("AI 到底有没有感受");
    expect(result).toContain("意识");
    expect(result).toContain("consciousness");
    expect(result).toContain("感受");
  });

  it("preserves original query terms", () => {
    const result = expandQuery("配图风格");
    expect(result).toContain("配图");
    expect(result).toContain("风格");
  });

  it("returns original for already-precise queries", () => {
    const result = expandQuery("JINA_API_KEY");
    expect(result).toBe("JINA_API_KEY");
  });

  it("handles empty/short queries", () => {
    expect(expandQuery("")).toBe("");
    expect(expandQuery("hi")).toBe("hi");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/local-memory && bun test src/__tests__/query-expander.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/query-expander.ts
/**
 * Lightweight Chinese query expansion via static synonym dictionary.
 * Expands colloquial/fuzzy terms into technical equivalents for BM25 boost.
 * No API calls — pure local dictionary lookup.
 */

// Each entry: [trigger patterns, expansion terms]
// Trigger: if any pattern matches (substring), add all expansion terms to query
const SYNONYM_MAP: Array<[string[], string[]]> = [
  // --- Status / Failure ---
  [["挂了", "挂掉", "宕机", "down"], ["崩溃", "crash", "error", "报错", "挂了", "宕机", "失败"]],
  [["卡住", "卡死", "没反应"], ["hang", "timeout", "超时", "卡住", "无响应", "stuck"]],
  [["炸了", "爆了"], ["崩溃", "crash", "OOM", "内存溢出", "error"]],

  // --- AI / Consciousness ---
  [["感受", "感觉", "情感"], ["意识", "consciousness", "experiencing", "感受", "情感", "qualia"]],
  [["有没有意识", "是否有意识"], ["consciousness", "意识", "sentience", "感知", "自我意识"]],
  [["自由意志"], ["free will", "自由意志", "决定论", "determinism"]],

  // --- Config / Deploy ---
  [["配置", "设置", "config"], ["配置", "config", "configuration", "settings", "设置"]],
  [["部署", "上线"], ["deploy", "部署", "上线", "发布", "release"]],
  [["容器", "docker"], ["Docker", "容器", "container", "docker-compose"]],

  // --- Code / Debug ---
  [["报错", "出错", "错误"], ["error", "报错", "exception", "错误", "失败", "bug"]],
  [["修复", "修了", "修好"], ["fix", "修复", "patch", "修了", "解决"]],
  [["踩坑", "坑"], ["踩坑", "bug", "问题", "教训", "排查", "troubleshoot"]],

  // --- Writing / Content ---
  [["配图", "插图"], ["配图", "封面", "style-catalog", "风格", "图片", "image"]],
  [["排版", "版式"], ["排版", "layout", "主题", "theme", "样式"]],
  [["风格"], ["风格", "style", "轮换", "catalog"]],
  [["写作", "写文章"], ["写作", "writing", "文章", "公众号", "content-alchemy"]],

  // --- Infrastructure ---
  [["bot", "机器人"], ["bot", "机器人", "OpenClaw", "agent", "gateway"]],
  [["推送", "push"], ["push", "推送", "git push", "commit"]],
  [["记忆", "memory"], ["记忆", "memory", "记忆系统", "LanceDB", "索引"]],
  [["搜索", "查找", "找"], ["搜索", "search", "retrieval", "检索", "查找"]],
];

/**
 * Expand a query by appending synonym terms from the dictionary.
 * Returns the original query with additional terms appended.
 * Idempotent — already-precise queries pass through unchanged.
 */
export function expandQuery(query: string): string {
  if (!query || query.trim().length < 2) return query;

  const lower = query.toLowerCase();
  const additions = new Set<string>();

  for (const [triggers, expansions] of SYNONYM_MAP) {
    if (triggers.some(t => lower.includes(t.toLowerCase()))) {
      for (const exp of expansions) {
        // Don't add terms already in the query
        if (!lower.includes(exp.toLowerCase())) {
          additions.add(exp);
        }
      }
    }
  }

  if (additions.size === 0) return query;
  return `${query} ${[...additions].join(" ")}`;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/local-memory && bun test src/__tests__/query-expander.test.ts`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
cd ~/local-memory
git add src/query-expander.ts src/__tests__/query-expander.test.ts
git commit -m "feat: add Chinese synonym query expansion dictionary"
```

---

### Task 2: Wire expander into BM25 search path

**Files:**
- Modify: `src/retriever.ts` (lines 334-349, hybridRetrieval method)

**Step 1: Write the integration**

In `retriever.ts`, import the expander at the top:

```typescript
import { expandQuery } from "./query-expander.js";
```

Then in `hybridRetrieval()` (line 348), change the BM25 call to use expanded query:

```typescript
// Before:
this.runBM25Search(query, candidatePoolSize, scopeFilter, category),

// After:
this.runBM25Search(expandQuery(query), candidatePoolSize, scopeFilter, category),
```

Note: Vector search (line 347) stays unchanged — Jina embeddings handle semantics.
Note: The reranker (line 359) uses the original `query`, not expanded — reranking should judge against user intent.

**Step 2: Run existing cases to verify no regression**

Run: `cd ~/local-memory && bun run src/eval.ts`
Expected: All 6 existing cases still PASS (or same score as before)

**Step 3: Commit**

```bash
cd ~/local-memory
git add src/retriever.ts
git commit -m "feat: wire query expansion into BM25 retrieval path"
```

---

### Task 3: Add fuzzy test cases and run before/after comparison

**Files:**
- Modify: `eval/cases.json`

**Step 1: Add fuzzy test cases**

Append these cases to `eval/cases.json`:

```json
{
  "name": "fuzzy_bot_crash",
  "query": "上次那个 bot 突然挂了是怎么回事来着",
  "profile": "debug",
  "limit": 5,
  "expectAny": ["崩溃", "crash", "error", "报错", "排查", "修复", "docker"],
  "expectScopePrefixes": ["cc"],
  "notes": "Fuzzy colloquial query about bot crash should find debugging conversations."
},
{
  "name": "fuzzy_ai_feelings",
  "query": "之前聊过一个关于 AI 到底有没有感受的话题",
  "profile": "writing",
  "limit": 5,
  "expectAny": ["意识", "consciousness", "experiencing", "感受", "自由意志", "sentience"],
  "expectScopePrefixes": ["cc"],
  "notes": "Vague conversational query about AI consciousness should recall philosophical discussions."
},
{
  "name": "fuzzy_image_style",
  "query": "那个配图风格轮换的逻辑是怎么搞的",
  "profile": "default",
  "limit": 5,
  "expectAny": ["风格", "style", "轮换", "catalog", "配图"],
  "expectScopePrefixes": ["cc"],
  "notes": "Casual question about image style rotation should find implementation discussions."
}
```

**Step 2: Run full suite and save report**

Run: `cd ~/local-memory && bun run src/eval.ts --output eval/reports/query-expansion.md`
Expected: New fuzzy cases should score higher than without expansion

**Step 3: Commit**

```bash
cd ~/local-memory
git add eval/cases.json eval/reports/query-expansion.md
git commit -m "test: add fuzzy Chinese query cases and expansion baseline report"
```

---

### Task 4: Manual smoke test with real queries

**Not code — manual verification via CLI**

Run these and visually check relevance:

```bash
cd ~/local-memory
./lm search "上次那个 bot 突然挂了是怎么回事来着" --profile debug
./lm search "之前聊过一个关于 AI 到底有没有感受的话题" --profile writing
./lm search "那个配图风格轮换的逻辑是怎么搞的"
./lm search "怎么给秦超老师的项目提 PR 来着"
./lm search "公众号发布流程是什么"
```

Compare against the results we got earlier (before expansion) to confirm improvement.

**Commit (if any dictionary tuning needed):**

```bash
cd ~/local-memory
git add src/query-expander.ts
git commit -m "tune: adjust synonym dictionary based on smoke test"
```
