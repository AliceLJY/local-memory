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
