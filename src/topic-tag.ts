/**
 * MP-1: Topic Tag — scope 内主题分区
 *
 * Keyword-based topic detection for memory entries.
 * Tags are stored in metadata and used as a pre-filter during retrieval.
 */

const TOPIC_PATTERNS: Array<{ tag: string; patterns: RegExp[] }> = [
  { tag: "auth", patterns: [/\b(auth|login|oauth|jwt|session.?token|credentials?|password|sso|saml)\b/i] },
  { tag: "deploy", patterns: [/\b(deploy|ci[\s/]?cd|pipeline|release|rollout|staging|production|rollback)\b/i] },
  { tag: "infra", patterns: [/\b(docker|kubernetes|k8s|terraform|nginx|server|cluster|load.?balanc|cdn|dns)\b/i] },
  { tag: "testing", patterns: [/\b(test|spec|jest|vitest|bun.?test|coverage|assertion|mock|fixture|e2e)\b/i] },
  { tag: "database", patterns: [/\b(database|sql|postgres|mysql|sqlite|lancedb|mongodb|migration|schema|index)\b/i] },
  { tag: "api", patterns: [/\b(api|endpoint|rest|graphql|grpc|webhook|http|request|response|route)\b/i] },
  { tag: "ui", patterns: [/\b(ui|frontend|react|vue|svelte|css|tailwind|component|layout|responsive)\b/i] },
  { tag: "perf", patterns: [/\b(performance|latency|throughput|cache|optimization|bottleneck|profil|benchmark)\b/i] },
  { tag: "security", patterns: [/\b(security|vulnerability|xss|csrf|injection|encrypt|certificate|tls|ssl)\b/i] },
  { tag: "docs", patterns: [/\b(documentation|readme|changelog|tutorial|guide|specification|api.?doc)\b/i] },
  { tag: "memory", patterns: [/\b(memory|recall|retriev|embed|vector|checkpoint|distill|ingest|lancedb)\b/i] },
  { tag: "mcp", patterns: [/\b(mcp|model.?context.?protocol|tool.?registr|mcp.?server)\b/i] },
  { tag: "llm", patterns: [/\b(llm|language.?model|prompt|token|context.?window|embedding|openai|anthropic|claude)\b/i] },
  { tag: "config", patterns: [/\b(config|settings?|environment|env.?var|dotenv|feature.?flag)\b/i] },
  { tag: "data", patterns: [/\b(data|dataset|csv|json|parsing|transform|etl|pipeline|ingest)\b/i] },
];

const MAX_SCAN_LENGTH = 2000;

export function detectTopicTag(text: string): string | undefined {
  const sample = text.slice(0, MAX_SCAN_LENGTH).toLowerCase();
  let bestTag: string | undefined;
  let bestCount = 0;

  for (const { tag, patterns } of TOPIC_PATTERNS) {
    let count = 0;
    for (const pattern of patterns) {
      const matches = sample.match(new RegExp(pattern.source, "gi"));
      if (matches) count += matches.length;
    }
    if (count > bestCount) {
      bestCount = count;
      bestTag = tag;
    }
  }

  return bestCount >= 1 ? bestTag : undefined;
}

export function extractTopicTag(metadata?: string): string | undefined {
  if (!metadata) return undefined;
  try {
    const parsed = JSON.parse(metadata);
    return typeof parsed.topicTag === "string" ? parsed.topicTag : undefined;
  } catch {
    return undefined;
  }
}

export function injectTopicTag(metadata: string, topicTag: string): string {
  try {
    const parsed = JSON.parse(metadata);
    parsed.topicTag = topicTag;
    return JSON.stringify(parsed);
  } catch {
    return metadata;
  }
}
