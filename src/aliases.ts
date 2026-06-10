/**
 * Alias dictionary for query rewriting.
 *
 * Manually maintained — do NOT use LLM expansion (risks precision pollution).
 * Each rule appends entity tokens to the query when the pattern matches,
 * giving BM25/vector search more anchor points without losing the original wording.
 *
 * Why expand (append) rather than replace:
 * - Preserves the user's exact wording for vector embedding fidelity.
 * - BM25 gets extra keyword anchors to find the right entity.
 * - Reversible via inspecting the expanded vs. original query.
 *
 * Add new rules sparingly. Each entry should solve a real failure
 * documented in FAILURES.md, not a hypothetical.
 */

export interface AliasRule {
  pattern: RegExp;
  expansion: string;
  comment?: string;
}

export const ALIAS_RULES: AliasRule[] = [
  // Entity aliases — colloquial → canonical name
  {
    pattern: /(?:我的)?记忆项目/,
    expansion: "recallnest",
    comment: "FAILURES 2026-04-25: '我的记忆项目' → recallnest",
  },
  {
    pattern: /我的桥/,
    expansion: "telegram-ai-bridge",
    comment: "Alice 用'我的桥'指 telegram-ai-bridge",
  },

  // Operations vocabulary — operator wording → canonical entities
  {
    pattern: /aws\s*(?:bot|ssh|podcast)/i,
    expansion: "aws-bot hermes-aws aws-podcast-daily",
    comment: "FAILURES 2026-03-06: aws bot/ssh/podcast → aws-bot hermes-aws entities",
  },
  {
    pattern: /bot\s*(?:挂|崩|不能用|跑不起|失联|down)/i,
    expansion: "bot-doctor hermes docker launchd 排查 重启",
    comment: "Operator bot-crash debugging vocabulary",
  },

  // Cross-window / continuity hints — these strengthen recall of session state.
  // Pattern 必须明确出现"隔壁/另一窗口/session"才扩；纯"之前说过"太宽会污染
  // 普通话题（如 fuzzy_ai_feelings 的 "之前聊过 AI 感受" 被错误归类成 cross-window）。
  {
    pattern: /(?:刚刚|刚才|之前)(?:.{0,10})(?:隔壁|另一个|其他)(?:.{0,10})(?:窗口|session)/,
    expansion: "checkpoint session resume_context 跨窗口",
    comment: "FAILURES 2026-05-10: cross-window real-time sync hint",
  },

  // Tool provenance — common ambiguous tool references
  {
    pattern: /taobao.{0,5}(?:mcp|官方)/i,
    expansion: "MCP server provenance source",
    comment: "FAILURES 2026-05-01: taobao MCP official-vs-third-party",
  },

  // RecallNest self-introspection — capability queries
  {
    pattern: /recallnest.{0,15}(?:有哪些|工具|能做|功能|tool)/i,
    expansion: "search_memory store_memory resume_context checkpoint_session MCP",
    comment: "FAILURES 2026-04-20: RN self-introspection capability digest",
  },
  {
    pattern: /recallnest.{0,10}(?:ingest|跑了|跑过|状态|telemetry)/i,
    expansion: "import_conversations weekly-distill ingest telemetry 成功 失败",
    comment: "FAILURES 2026-04-20: RN ingest telemetry queries",
  },

  // Personal-life recall — subscription / friends provenance
  {
    pattern: /(?:chatgpt|订阅).{0,10}(?:谁|怎么|哪里|帮|顶)/i,
    expansion: "ChatGPT Plus 群友 加拿大 堂姐 澳洲 代订 aliceljyalice",
    comment: "FAILURES 2026-05-12: ChatGPT subscription provenance chain",
  },
];

/** 超过此长度的 query 不做别名扩展——长 query 是粘贴文档场景,扩展只添噪声 (P1-B)。 */
export const ALIAS_QUERY_MAX_LENGTH = 100;

/**
 * Expand a query by appending alias tokens for matching patterns.
 * Returns the original query unchanged if no rules match.
 *
 * 注意分工:本模块只承载**静态 builtin 规则**,作用于 retrieve() 全通道
 * (vector + BM25)。**用户级** alias(data/alias-map.json)由
 * query-expander.ts 加载,只作用于 BM25 通道(hybridRetrieval 内部)——
 * 用户别名不进 vector embedding,避免随手加的别名造成语义向量漂移。
 *
 * Example:
 *   expandQueryWithAliases("帮我看我的记忆项目")
 *     → "帮我看我的记忆项目 recallnest"
 *   expandQueryWithAliases("aws ssh 怎么连")
 *     → "aws ssh 怎么连 aws-bot hermes-aws aws-podcast-daily"
 */
export function expandQueryWithAliases(query: string): string {
  if (!query || typeof query !== "string") return query;
  if (query.length > ALIAS_QUERY_MAX_LENGTH) return query;

  const additions: string[] = [];
  const seen = new Set<string>();

  for (const rule of ALIAS_RULES) {
    if (rule.pattern.test(query)) {
      for (const token of rule.expansion.split(/\s+/)) {
        if (token && !seen.has(token) && !query.includes(token)) {
          additions.push(token);
          seen.add(token);
        }
      }
    }
  }

  return additions.length > 0 ? `${query} ${additions.join(" ")}` : query;
}

/**
 * Inspection helper — return which builtin rules matched a query, for debugging.
 * 用户级规则(BM25-only)的检视走 query-expander.ts 的 explainUserAliases。
 */
export function explainAliasExpansion(query: string): Array<{ pattern: string; expansion: string; comment?: string }> {
  return ALIAS_RULES.filter((rule) => rule.pattern.test(query)).map((rule) => ({
    pattern: rule.pattern.source,
    expansion: rule.expansion,
    comment: rule.comment,
  }));
}
