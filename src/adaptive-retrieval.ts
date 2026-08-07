/**
 * Adaptive Retrieval — skip trivial queries to save embedding API calls.
 * Synced from memory-lancedb-pro upstream with CJK-aware length + force-retrieve.
 */

// Force-retrieve: queries with memory-related intent should ALWAYS trigger retrieval
// even if they are short (e.g. "你记得吗" = 4 chars, would otherwise be skipped)
const FORCE_RETRIEVE_PATTERNS = [
  /\b(remember|recall|forgot|memory|memories)\b/i,
  /\b(last time|before|previously|earlier|yesterday|ago)\b/i,
  /\b(my (name|email|phone|address|birthday|preference))\b/i,
  /\b(what did (i|we)|did i (tell|say|mention))\b/i,
  /(你记得|记不记得|之前|上次|以前|还记得|提到过|说过)/,
  /(我叫|我的名字|我是谁)/,
];

const SKIP_PATTERNS = [
  // Greetings / acks
  /^(hi|hello|hey|good\s*(morning|afternoon|evening|night)|greetings|yo|sup|howdy)\b/i,
  // System / bot commands
  /^\//,
  /^(run|build|test|ls|cd|git|npm|pip|docker|curl|cat|grep|find|make|sudo)\b/i,
  // Short acks (end-anchored to avoid matching real content)
  /^(yes|no|yep|nope|ok|okay|sure|fine|thanks|thank you|thx|ty|got it|understood|cool|nice|great|good|perfect|awesome)\s*[.!]?$/i,
  // Continuations
  /^(go ahead|continue|proceed|do it|start|begin|next|开始|继续|好的|可以|行)\s*[.!]?$/i,
  // Session boilerplate
  /^(fresh session|new session|\/new|\/compact|\/restart)/i,
  /HEARTBEAT/i,
  /^\[System/i,
  // Single emoji or punctuation
  /^[\p{Emoji}\s.,!?。！？，、]+$/u,
  // Single-word pings
  /^(ping|pong|test|debug)\s*[.!?]?$/i,
];

/**
 * Returns true if the query is too trivial to warrant an embedding API call.
 * CJK-aware: uses lower length threshold for Chinese/Japanese/Korean text.
 */
export function shouldSkipRetrieval(query: string, minLength?: number): boolean {
  const trimmed = query.trim();

  // Force retrieve if query has memory-related intent (BEFORE length check)
  if (FORCE_RETRIEVE_PATTERNS.some(p => p.test(trimmed))) return false;

  // CJK-aware: Chinese chars carry much more semantic density than ASCII.
  // 2 Chinese chars ("轮巡") is a meaningful query equivalent to "daily patrol".
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(trimmed);
  const absoluteMin = hasCJK ? 2 : 4;
  if (trimmed.length < absoluteMin) return true;

  // Pattern-based skip
  if (SKIP_PATTERNS.some(p => p.test(trimmed))) return true;

  const effectiveMinLength = minLength ?? (hasCJK ? 2 : 15);

  // 【本地分叉点 · 2026-08-08 · 勿在同步上游时覆盖回去】
  // 单 token（不含空格）= 实体查找意图，与问号一样豁免长度闸。
  // 上游的 ASCII 阈值 15 是按「英文自然语句」定的（挡 "hello there" 这类闲聊），
  // 但项目名/工具名几乎都短于 15：cobbler=7 / slidesmith=10 / hippo-wiki=10 / recallnest=10，
  // 于是「甩一个名字过去」这种最自然的查法一律返回空——库里明明有。
  // 红绿实测：`cobbler` → No results；`cobbler?` → 100% 命中 12 条，只差一个问号豁免。
  // 中文不受影响（阈值 2），所以该缺陷只在英文实体名上暴露，一直没被发现。
  // 安全性：本条排在 SKIP_PATTERNS 之后，hi / ok / ping / test / ls / git 等单词仍被挡住。
  const isSingleToken = !/\s/.test(trimmed);

  // Short non-question messages are skipped; questions (? ？) are always worth checking
  if (trimmed.length < effectiveMinLength &&
      !isSingleToken &&
      !trimmed.includes('?') && !trimmed.includes('？')) {
    return true;
  }

  return false;
}
