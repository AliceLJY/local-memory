/**
 * Adaptive Retrieval — skip trivial queries to save embedding API calls.
 * Backported from memory-lancedb-pro v1.0.28+.
 */

const SKIP_PATTERNS = [
  // Greetings / acks
  /^(hi|hello|hey|ok|好的|收到|嗯|谢谢|thanks|thx|got it|sure|yes|no|yep|nope|bye|再见)[\s!.。！]*$/i,
  // Session boilerplate
  /^(fresh session|new session|\/new|\/compact|\/restart|HEARTBEAT)/i,
  // Single emoji or punctuation
  /^[\p{Emoji}\s.,!?。！？，、]+$/u,
  // OpenClaw slash commands
  /^\/[a-z]+(\s|$)/i,
];

const MIN_QUERY_LENGTH = 4;

/**
 * Returns true if the query is too trivial to warrant an embedding API call.
 */
export function shouldSkipRetrieval(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return true;
  return SKIP_PATTERNS.some(p => p.test(trimmed));
}
