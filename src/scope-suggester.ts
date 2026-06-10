/**
 * P1-A: scope 拼写漂移提示(FAILURES.md 5-13 retrieval gap)。
 *
 * matchesScopeFilter 走精确/前缀匹配,拼错或惯例不一致的 scope(`recallnst`、
 * `cc_55bcbfb3`)会静默返回 0 hits,使用者无从知道是"真没有"还是"scope 写错"。
 * 本模块在 0-hit 且显式传了 scope 时给出相近 scope 提示。
 *
 * 只提示、不自动 fallback 重查——自动改写会静默改变查询语义,agent/用户
 * 看到提示后自行决定。
 */

// ---------------------------------------------------------------------------
// Pure matching
// ---------------------------------------------------------------------------

/** 归一化:小写 + 吃掉 -/_/空格(惯例差异:`cc-foo` vs `cc_foo` vs `ccfoo`)。 */
export function normalizeScope(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, "");
}

/** Two-row Levenshtein with early exit — 距离超过 max 直接返回 max+1。 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * 对输入 scope 给出相近的已知 scope。
 * 两级:① normalize 后精确相等 ② 前缀包含(双向)或编辑距离 ≤ 2。
 * 候选应同时包含完整 scope 与其 prefix 家族(`cc:55bc...` 的 `cc`)——
 * 拼错的通常是短 prefix,对长 session scope 做编辑距离没有意义。
 */
export function suggestScopes(input: string, knownScopes: string[], maxSuggestions = 3): string[] {
  const norm = normalizeScope(input);
  if (norm.length === 0) return [];

  const exact: string[] = [];
  const close: Array<{ scope: string; rank: number }> = [];

  for (const known of knownScopes) {
    const kn = normalizeScope(known);
    if (kn === norm) {
      exact.push(known);
      continue;
    }
    if (kn.startsWith(norm) || norm.startsWith(kn)) {
      close.push({ scope: known, rank: 0.5 });
      continue;
    }
    const d = boundedLevenshtein(norm, kn, 2);
    if (d <= 2) close.push({ scope: known, rank: d });
  }

  if (exact.length > 0) return exact.slice(0, maxSuggestions);
  return close
    .sort((a, b) => a.rank - b.rank || a.scope.length - b.scope.length)
    .map(c => c.scope)
    .slice(0, maxSuggestions);
}

// ---------------------------------------------------------------------------
// Cached provider
// ---------------------------------------------------------------------------

/**
 * 带 60s 缓存的建议器工厂——known scopes 来自 store.stats().scopeCounts,
 * 全表聚合不便宜,0-hit 提示是低频路径,短缓存足够新鲜。
 * 候选 = prefix 家族(冒号前段,去重) + 完整 scope 串。
 */
export function createScopeSuggester(
  getScopeCounts: () => Promise<Record<string, number>>,
  ttlMs = 60_000,
): (input: string) => Promise<string[]> {
  let cache: { at: number; candidates: string[] } | null = null;

  return async function suggest(input: string): Promise<string[]> {
    const now = Date.now();
    if (!cache || now - cache.at > ttlMs) {
      const counts = await getScopeCounts();
      const keys = Object.keys(counts);
      const prefixes = new Set<string>();
      for (const k of keys) {
        const i = k.indexOf(":");
        if (i > 0) prefixes.add(k.slice(0, i));
      }
      // prefix 家族在前:作为查询 scope 它们最常被手敲、也最常被拼错
      cache = { at: now, candidates: [...prefixes, ...keys] };
    }
    return suggestScopes(input, cache.candidates);
  };
}

/** 0-hit 提示行(空建议返回空串,caller 原样拼接即可)。 */
export function formatScopeSuggestion(inputScope: string, suggestions: string[]): string {
  if (suggestions.length === 0) return "";
  return `⚠️ scope '${inputScope}' 命中 0 条,相近 scope: [${suggestions.join(", ")}]`;
}
