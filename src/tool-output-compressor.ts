/**
 * Tool Output Compressor
 *
 * Pre-processes conversation text before chunking/embedding to compress
 * tool output noise (git boilerplate, passing test logs, base64 images, etc.).
 * Reduces embedding token costs and improves extraction quality.
 *
 * Design principles:
 * - Zero LLM overhead: pure regex/pattern matching
 * - Never modifies user dialog or AI reasoning
 * - Sits before chunking in the ingest pipeline
 * - Inspired by CortexReach/memory-lancedb-pro PR #308
 */

// ============================================================================
// Types
// ============================================================================

interface CompressionRule {
  /** Human-readable name for logging */
  name: string;
  /** Match the tool output block content */
  match: RegExp;
  /** Return compressed replacement. Receives the full matched block. */
  compress: (block: string) => string;
}

// ============================================================================
// Compression Rules
// ============================================================================

const RULES: CompressionRule[] = [
  // Git push/pull/fetch boilerplate → one-liner
  {
    name: "git-push-pull",
    match: /Enumerating objects:.*?(?:-> |Branch ')[^\n]*/s,
    compress: (block) => {
      const branch = block.match(/-> (\S+)/)?.[1]
        || block.match(/Branch '([^']+)'/)?.[1]
        || "";
      const failed = /error|rejected|fatal/i.test(block);
      return failed ? block : `[git: ok${branch ? " " + branch : ""}]`;
    },
  },

  // Test results: all-pass → one-liner, failures preserved
  {
    name: "test-summary",
    match: /(?:running \d+ tests?|test result:|Tests?:.*(?:pass|fail)|PASS|FAIL|✓|✕)/,
    compress: (block) => {
      if (/fail|error|FAIL|✕/i.test(block)) return block; // Keep failures
      const summary = block.match(
        /test result:.*|Tests?:\s*\d+.*|(\d+)\s*(?:pass(?:ed)?|✓)/im,
      )?.[0];
      return summary ? `[test: ${summary.trim()}]` : block;
    },
  },
];

// Patterns that identify tool output blocks in conversation text.
// Claude Code / Codex format: command on one line, output follows.
// 末项用 (?![\s\S]) 表示「字符串绝对结尾」。不能用 \z（JS 无此锚点，会被当字面字符 z →
// 在输出里第一个 z 处误截断），也不能用 $（gm 模式下匹配每行尾，惰性 [\s\S]*? 会在第一行就停）。
const TOOL_OUTPUT_BLOCK = /^(?:\$\s+|❯\s+|>\s+)(.+)\n([\s\S]*?)(?=\n(?:\$\s+|❯\s+|>\s+)|\n\n[A-Z]|\n##|(?![\s\S]))/gm;

// Base64 image data (screenshots, etc.)
const BASE64_BLOCK = /(?:data:image\/[^;]+;base64,)?[A-Za-z0-9+/]{500,}={0,2}/g;

// ============================================================================
// Main compressor
// ============================================================================

/**
 * Compress tool output noise in conversation text.
 * Call before chunking/embedding in the ingest pipeline.
 *
 * @param text - Raw conversation text
 * @returns Compressed text with tool output noise reduced
 */
export function compressToolOutput(text: string): string {
  if (!text || text.length < 100) return text;

  let result = text;

  // 1. Replace base64 image data with placeholder
  result = result.replace(BASE64_BLOCK, (match) => {
    if (match.length < 500) return match; // Short strings might be legit
    return `[image: ~${Math.round(match.length / 1024)}KB base64]`;
  });

  // 2. Apply compression rules to tool output blocks
  result = result.replace(TOOL_OUTPUT_BLOCK, (fullMatch, command: string, output: string) => {
    const cmd = command.trim();
    for (const rule of RULES) {
      if (rule.match.test(output) || rule.match.test(cmd)) {
        const compressed = rule.compress(output);
        if (compressed !== output) {
          return `$ ${cmd}\n${compressed}`;
        }
      }
    }

    // 3. Truncate large unmatched outputs (>2000 chars)
    if (output.length > 2000) {
      const head = output.slice(0, 1000);
      const tail = output.slice(-300);
      return `$ ${cmd}\n${head}\n[...${output.length - 1300} chars truncated...]\n${tail}`;
    }

    return fullMatch;
  });

  // 4. Collapse multiple blank lines left by removals
  result = result.replace(/\n{4,}/g, "\n\n\n");

  return result;
}
