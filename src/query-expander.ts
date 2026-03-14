/**
 * Lightweight Chinese query expansion via static synonym dictionary.
 * Expands colloquial/fuzzy terms into technical equivalents for BM25 boost.
 * No API calls — pure local dictionary lookup.
 *
 * v1.1: Word-boundary matching for English triggers (prevents "download" matching "down").
 *       MAX_EXPANSION_TERMS cap to prevent query bloat hurting BM25 precision.
 *       Structured synonym entries separating CN (substring) from EN (word-boundary).
 */

interface SynonymEntry {
  /** Chinese triggers: matched by substring (CJK has no word boundaries) */
  cn: string[];
  /** English triggers: matched by word boundary (\b) to prevent false positives */
  en: string[];
  /** Terms to append when triggered */
  expansions: string[];
}

const SYNONYM_MAP: SynonymEntry[] = [
  // --- Status / Failure ---
  { cn: ["挂了", "挂掉", "宕机"], en: ["shutdown", "crashed"], expansions: ["崩溃", "crash", "error", "报错", "挂了", "宕机", "失败"] },
  { cn: ["卡住", "卡死", "没反应"], en: ["hang", "stuck"], expansions: ["hang", "timeout", "超时", "卡住", "无响应", "stuck"] },
  { cn: ["炸了", "爆了"], en: ["OOM"], expansions: ["崩溃", "crash", "OOM", "内存溢出", "error"] },

  // --- AI / Consciousness ---
  { cn: ["感受", "感觉", "情感"], en: ["feeling", "emotion"], expansions: ["意识", "consciousness", "experiencing", "感受", "情感", "qualia"] },
  { cn: ["有没有意识", "是否有意识"], en: ["consciousness", "sentience"], expansions: ["consciousness", "意识", "sentience", "感知", "自我意识"] },
  { cn: ["自由意志"], en: ["free will"], expansions: ["free will", "自由意志", "决定论", "determinism"] },

  // --- Config / Deploy ---
  { cn: ["配置", "设置"], en: ["config", "configuration", "settings"], expansions: ["配置", "config", "configuration", "settings", "设置"] },
  { cn: ["部署", "上线"], en: ["deploy"], expansions: ["deploy", "部署", "上线", "发布", "release"] },
  { cn: ["容器"], en: ["docker", "container"], expansions: ["Docker", "容器", "container", "docker-compose"] },

  // --- Code / Debug ---
  { cn: ["报错", "出错", "错误"], en: ["error", "exception"], expansions: ["error", "报错", "exception", "错误", "失败", "bug"] },
  { cn: ["修复", "修了", "修好"], en: ["fix", "patch"], expansions: ["fix", "修复", "patch", "修了", "解决"] },
  { cn: ["踩坑", "坑"], en: ["troubleshoot"], expansions: ["踩坑", "bug", "问题", "教训", "排查", "troubleshoot"] },
  { cn: ["日志"], en: ["log", "logging"], expansions: ["日志", "log", "logging", "输出", "stdout", "stderr"] },
  { cn: ["权限"], en: ["permission", "access"], expansions: ["权限", "permission", "access", "授权", "认证"] },

  // --- Writing / Content ---
  { cn: ["配图", "插图"], en: [], expansions: ["配图", "封面", "style-catalog", "风格", "图片", "image"] },
  { cn: ["排版", "版式"], en: ["layout"], expansions: ["排版", "layout", "主题", "theme", "样式"] },
  { cn: ["风格"], en: ["style"], expansions: ["风格", "style", "轮换", "catalog"] },
  { cn: ["写作", "写文章"], en: ["writing"], expansions: ["写作", "writing", "文章", "公众号", "content-alchemy"] },

  // --- Infrastructure ---
  { cn: ["机器人"], en: ["bot", "agent"], expansions: ["bot", "机器人", "OpenClaw", "agent", "gateway"] },
  { cn: ["推送"], en: ["push"], expansions: ["push", "推送", "git push", "commit"] },
  { cn: ["记忆"], en: ["memory"], expansions: ["记忆", "memory", "记忆系统", "LanceDB", "索引"] },
  { cn: ["搜索", "查找", "找"], en: ["search", "retrieval"], expansions: ["搜索", "search", "retrieval", "检索", "查找"] },
];

/** Maximum expansion terms to prevent query bloat hurting BM25 precision */
const MAX_EXPANSION_TERMS = 5;

/**
 * Expand a query by appending synonym terms from the dictionary.
 * Returns the original query with additional terms appended.
 * Idempotent — already-precise queries pass through unchanged.
 */
export function expandQuery(query: string): string {
  if (!query || query.trim().length < 2) return query;

  const lower = query.toLowerCase();
  const additions = new Set<string>();

  for (const entry of SYNONYM_MAP) {
    // Chinese triggers: substring match (CJK has no word boundaries)
    const cnMatch = entry.cn.some(t => lower.includes(t.toLowerCase()));
    // English triggers: word-boundary match to prevent false positives
    const enMatch = entry.en.length > 0 && entry.en.some(t => {
      const regex = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      return regex.test(lower);
    });

    if (cnMatch || enMatch) {
      for (const exp of entry.expansions) {
        if (!lower.includes(exp.toLowerCase())) {
          additions.add(exp);
        }
      }
    }
  }

  if (additions.size === 0) return query;

  // Cap expansion terms to prevent query bloat
  const limited = [...additions].slice(0, MAX_EXPANSION_TERMS);
  return `${query} ${limited.join(" ")}`;
}
