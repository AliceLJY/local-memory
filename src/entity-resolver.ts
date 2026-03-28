/**
 * Entity Resolver — normalize tech entity aliases to canonical names.
 *
 * Borrowed from UltraMemory's entity-resolver.ts, adapted for RecallNest:
 * - Extended with Chinese aliases (RecallNest users are bilingual)
 * - Hooked into query-expander as a pre-normalization step
 * - Also usable at capture time to normalize entities before canonical key generation
 *
 * Pure mapping logic, zero API calls.
 */

// ---------------------------------------------------------------------------
// Built-in aliases (lowercase key → canonical name)
// ---------------------------------------------------------------------------

export const BUILTIN_ALIASES: Record<string, string> = {
  // Programming languages
  "ts": "typescript", "typescript": "typescript",
  "js": "javascript", "javascript": "javascript",
  "py": "python", "python": "python",
  "rb": "ruby", "ruby": "ruby",
  "rs": "rust", "rust": "rust",
  "go": "golang", "golang": "golang",
  "cs": "csharp", "c#": "csharp",

  // Runtimes
  "node.js": "nodejs", "node": "nodejs", "nodejs": "nodejs",
  "bun": "bun", "deno": "deno",

  // Frameworks
  "react.js": "react", "reactjs": "react", "react": "react",
  "vue.js": "vue", "vuejs": "vue", "vue": "vue",
  "next.js": "nextjs", "next": "nextjs", "nextjs": "nextjs",
  "express.js": "express", "express": "express",
  "angular.js": "angular", "angularjs": "angular", "angular": "angular",
  "svelte": "svelte", "sveltekit": "sveltekit",

  // Infrastructure
  "k8s": "kubernetes", "kubernetes": "kubernetes",
  "pg": "postgresql", "postgres": "postgresql", "postgresql": "postgresql",
  "mongo": "mongodb", "mongodb": "mongodb",
  "redis": "redis",
  "docker": "docker",
  "docker-compose": "docker compose", "docker compose": "docker compose",
  "tf": "terraform", "terraform": "terraform",
  "gcp": "google cloud platform",
  "aws": "amazon web services",

  // AI/ML
  "gpt": "openai gpt", "chatgpt": "openai gpt",
  "claude": "anthropic claude", "anthropic": "anthropic claude",
  "gemini": "google gemini",
  "llm": "large language model",
  "rag": "retrieval augmented generation",
  "lancedb": "lancedb",
  "pt": "pytorch", "pytorch": "pytorch",
  "tf.js": "tensorflow", "tensorflow": "tensorflow",
  "hf": "hugging face", "huggingface": "hugging face",

  // Project-specific
  "recallnest": "recallnest", "recall nest": "recallnest", "recall-nest": "recallnest",
  "openclaw": "openclaw", "open claw": "openclaw",
  "ultramemory": "ultramemory", "ultra memory": "ultramemory",
  "cc": "claude code", "claude code": "claude code",
  "mcp": "model context protocol",
};

// ---------------------------------------------------------------------------
// Resolver class
// ---------------------------------------------------------------------------

export class EntityResolver {
  private aliases: Map<string, string>;

  constructor(
    builtinAliases: Record<string, string> = BUILTIN_ALIASES,
    userAliases?: Record<string, string>,
  ) {
    this.aliases = new Map();
    for (const [k, v] of Object.entries(builtinAliases)) {
      this.aliases.set(k.toLowerCase(), v);
    }
    if (userAliases) {
      for (const [k, v] of Object.entries(userAliases)) {
        this.aliases.set(k.toLowerCase(), v);
      }
    }
  }

  /** Resolve a single term to its canonical form. Returns the term as-is if no alias found. */
  resolve(term: string): string {
    return this.aliases.get(term.toLowerCase().trim()) ?? term;
  }

  /** Resolve all recognizable entities in a text string. Returns text with aliases replaced. */
  resolveText(text: string): string {
    let result = text;
    // Sort aliases by length descending to match longer aliases first
    const sorted = [...this.aliases.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [alias, canonical] of sorted) {
      if (alias === canonical) continue; // skip identity mappings
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Always use word boundary to prevent matching inside other words
      // (e.g. "pt" inside "typescript")
      const re = new RegExp(`\\b${escaped}\\b`, "gi");
      result = result.replace(re, canonical);
    }
    return result;
  }

  /** Check if a term has a known alias. */
  hasAlias(term: string): boolean {
    return this.aliases.has(term.toLowerCase().trim());
  }

  /** Get all known aliases. */
  get size(): number {
    return this.aliases.size;
  }
}

/** Default singleton resolver with built-in aliases. */
export const defaultResolver = new EntityResolver();

/**
 * Resolve entities in a query string using the default resolver.
 * Intended to be called before query expansion in the search pipeline.
 */
export function resolveQueryEntities(query: string): string {
  return defaultResolver.resolveText(query);
}
