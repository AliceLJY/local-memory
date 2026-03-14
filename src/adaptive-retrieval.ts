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

  // Very short = skip
  if (trimmed.length < 4) return true;

  // Pattern-based skip
  if (SKIP_PATTERNS.some(p => p.test(trimmed))) return true;

  // CJK-aware minimum length: Chinese chars carry more semantic density
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(trimmed);
  const effectiveMinLength = minLength ?? (hasCJK ? 6 : 15);

  // Short non-question messages are skipped; questions (? ？) are always worth checking
  if (trimmed.length < effectiveMinLength &&
      !trimmed.includes('?') && !trimmed.includes('？')) {
    return true;
  }

  return false;
}
