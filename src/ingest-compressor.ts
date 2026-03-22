/**
 * Ingest Compressor — JSONL 预处理层
 *
 * 在 parseCCTranscript 之前对原始 JSONL 做两件事：
 * 1. 跳过噪声条目（bash_progress 等），减少无效 JSON.parse
 * 2. 从 tool_result 中提取一行摘要注入对话上下文，增强记忆质量
 *
 * 设计原则：
 * - 零 LLM 开销，纯规则引擎（受 RTK 启发）
 * - 用户对话和 AI 推理绝不修改
 * - 可配置开关，默认开启
 * - 失败时静默 fallback，不影响 ingest 主流程
 */

// ============================================================================
// Types
// ============================================================================

export interface CompressorConfig {
  /** 总开关，默认 true */
  enabled: boolean;
  /** 跳过 bash_progress / bash_status 等流式条目，默认 true */
  skipStreamingEntries: boolean;
  /** 从 tool_result 提取摘要注入上下文，默认 true */
  summarizeToolResults: boolean;
  /** 截图/图片 base64 替换为元数据，默认 true */
  replaceBase64: boolean;
  /** 大输出截断阈值（字符），默认 4000 */
  truncateThreshold: number;
}

export interface CompressorStats {
  totalLines: number;
  skippedStreaming: number;
  toolResultsSummarized: number;
  base64Replaced: number;
  largeTruncated: number;
  bytesIn: number;
  bytesOut: number;
}

export const DEFAULT_COMPRESSOR_CONFIG: CompressorConfig = {
  enabled: true,
  skipStreamingEntries: true,
  summarizeToolResults: true,
  replaceBase64: true,
  truncateThreshold: 4000,
};

// ============================================================================
// Noise entry types to skip entirely
// ============================================================================

/** JSONL entry types that are streaming duplicates or metadata noise */
const SKIP_ENTRY_TYPES = new Set([
  "bash_progress",
  "bash_status",
  "tool_streaming",
  "progress",
]);

// ============================================================================
// Tool result summarization rules (RTK-inspired)
// ============================================================================

interface SummaryRule {
  name: string;
  match: RegExp;
  summarize: (command: string, output: string, exitCode?: number) => string;
}

const SUMMARY_RULES: SummaryRule[] = [
  // git confirmations: push/pull/add/commit/fetch → one-liner
  {
    name: "git-confirmations",
    match: /^(?:rtk\s+)?git\s+(push|pull|add|commit|fetch)\b/,
    summarize: (cmd, output, exitCode) => {
      if (exitCode && exitCode !== 0) return truncateKeepEnds(output, 500);
      const sub = cmd.match(/git\s+(\w+)/)?.[1] || "git";
      const branch = output.match(/-> (\S+)/)?.[1]
        || output.match(/branch '([^']+)'/)?.[1]
        || "";
      return `[${sub}: ok${branch ? " " + branch : ""}]`;
    },
  },

  // git status → keep modified/untracked lines only
  {
    name: "git-status",
    match: /^(?:rtk\s+)?git\s+status\b/,
    summarize: (_cmd, output) => {
      const lines = output.split("\n");
      const meaningful = lines.filter(
        (l) =>
          l.includes("modified:") ||
          l.includes("new file:") ||
          l.includes("deleted:") ||
          l.includes("Untracked") ||
          l.includes("nothing to commit") ||
          /^\s+\S/.test(l) && !l.includes("(use ")
      );
      return meaningful.length > 0
        ? `[git status: ${meaningful.length} items]\n${meaningful.slice(0, 10).join("\n")}`
        : "[git status: clean]";
    },
  },

  // test results: pass → one-liner, fail → keep failures
  {
    name: "test-results",
    match: /^(?:rtk\s+)?(?:cargo test|npm test|bun test|pytest|vitest|jest|go test)\b/,
    summarize: (_cmd, output, exitCode) => {
      if (exitCode && exitCode !== 0) {
        // Keep failure details, truncate rest
        const lines = output.split("\n");
        const failLines = lines.filter(
          (l) =>
            /fail|error|assert|panic|FAIL/i.test(l) ||
            l.includes("at ") ||
            l.includes("-->")
        );
        const summary = lines.find((l) => /\d+\s*(pass|fail|test)/i.test(l)) || "";
        return `[test FAILED]\n${summary}\n${failLines.slice(0, 15).join("\n")}`;
      }
      // Extract summary line
      const summary = output.split("\n").find(
        (l) => /\d+\s*(pass|test|ok)/i.test(l) || l.includes("test result:")
      );
      return summary ? `[test: ${summary.trim()}]` : "[test: passed]";
    },
  },

  // grep/rg → count + first few matches
  {
    name: "grep-results",
    match: /^(?:rtk\s+)?(?:rg|grep)\s/,
    summarize: (_cmd, output) => {
      const lines = output.split("\n").filter((l) => l.trim());
      if (lines.length === 0) return "[grep: 0 matches]";
      return `[grep: ${lines.length} matches]\n${lines.slice(0, 5).join("\n")}${
        lines.length > 5 ? `\n... +${lines.length - 5} more` : ""
      }`;
    },
  },

  // ls/find/tree → count only
  {
    name: "directory-listing",
    match: /^(?:rtk\s+)?(?:ls|find|tree)\s/,
    summarize: (_cmd, output) => {
      const lines = output.split("\n").filter((l) => l.trim());
      return `[listing: ${lines.length} items]`;
    },
  },
];

// ============================================================================
// Base64 detection
// ============================================================================

const BASE64_PATTERN = /^[A-Za-z0-9+/]{200,}={0,2}$/;
const SCREENSHOT_TOOLS = [
  "browser_take_screenshot",
  "take_screenshot",
  "peekaboo",
  "screenshot",
];

function isBase64Content(text: string): boolean {
  // Check first line for base64-like pattern
  const firstLine = text.split("\n")[0]?.trim() || "";
  return BASE64_PATTERN.test(firstLine) || text.startsWith("data:image/");
}

// ============================================================================
// Core functions
// ============================================================================

/**
 * Truncate text keeping head and tail for context.
 */
function truncateKeepEnds(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const headLen = Math.floor(maxLen * 0.7);
  const tailLen = Math.floor(maxLen * 0.2);
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  return `${head}\n[...truncated ${text.length - headLen - tailLen} chars...]\n${tail}`;
}

/**
 * Summarize a tool_result using RTK-inspired rules.
 * Returns null if no rule matches (output passed through unchanged).
 */
export function summarizeToolResult(
  command: string,
  output: string,
  exitCode?: number,
): string | null {
  if (!command || !output) return null;

  for (const rule of SUMMARY_RULES) {
    if (rule.match.test(command)) {
      try {
        return rule.summarize(command, output, exitCode);
      } catch {
        return null; // Fallback: don't summarize
      }
    }
  }

  return null; // No matching rule
}

/**
 * Pre-process a JSONL line. Returns:
 * - null if the line should be skipped
 * - the original line if no changes needed
 * - a modified line with tool_result summaries injected
 */
export function processJsonlLine(
  line: string,
  config: CompressorConfig = DEFAULT_COMPRESSOR_CONFIG,
): string | null {
  if (!line.trim()) return null;

  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return line; // Keep malformed lines as-is for parser to handle
  }

  // Skip streaming/progress entries
  if (config.skipStreamingEntries && SKIP_ENTRY_TYPES.has(obj.type)) {
    return null;
  }

  // Process assistant messages: look for tool_use results in content
  if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
    let modified = false;
    const newContent = obj.message.content.map((block: any) => {
      // Replace base64 image data
      if (
        config.replaceBase64 &&
        block.type === "image" &&
        block.source?.type === "base64"
      ) {
        modified = true;
        return {
          type: "text",
          text: `[image: ${block.source.media_type || "image"}, replaced by compressor]`,
        };
      }
      return block;
    });

    if (modified) {
      obj.message.content = newContent;
      return JSON.stringify(obj);
    }
  }

  // Process user messages with tool_result content blocks
  if (obj.type === "user" && Array.isArray(obj.message?.content)) {
    let modified = false;
    const newContent = obj.message.content.map((block: any) => {
      if (block.type !== "tool_result") return block;

      const resultText =
        typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text || "")
                .join("\n")
            : "";

      if (!resultText) return block;

      // Replace base64 screenshots
      if (config.replaceBase64 && isBase64Content(resultText)) {
        modified = true;
        const replacement = `[base64 content: ~${Math.round(resultText.length / 1024)}KB, replaced by compressor]`;
        return { ...block, content: replacement };
      }

      // Summarize tool results if we can identify the command
      // The tool_use_id links to a previous tool_use block with the command
      if (config.summarizeToolResults && resultText.length > 200) {
        // Try to find a matching summary rule by scanning the output itself
        // (we don't always have the command string in the tool_result)
        const inferredSummary = tryInferSummary(resultText, config.truncateThreshold);
        if (inferredSummary) {
          modified = true;
          return { ...block, content: inferredSummary };
        }
      }

      // Truncate large outputs that didn't match any rule
      if (resultText.length > config.truncateThreshold) {
        modified = true;
        return {
          ...block,
          content: truncateKeepEnds(resultText, config.truncateThreshold),
        };
      }

      return block;
    });

    if (modified) {
      obj.message.content = newContent;
      return JSON.stringify(obj);
    }
  }

  return line;
}

/**
 * Try to infer and summarize tool output by content patterns.
 */
function tryInferSummary(output: string, truncateAt: number): string | null {
  // Git push/pull boilerplate
  if (
    output.includes("Enumerating objects:") &&
    output.includes("Total ")
  ) {
    const branch = output.match(/-> (\S+)/)?.[1] || "";
    return `[git push/pull: ok${branch ? " " + branch : ""}]`;
  }

  // Test results with summary line
  const testSummary = output.match(
    /test result: (\d+ passed.*)/i
  )?.[1] || output.match(/(\d+ pass(?:ed)?[^.\n]*)/i)?.[1];
  if (testSummary && output.length > 500) {
    if (/fail|error/i.test(output)) {
      return truncateKeepEnds(output, truncateAt); // Keep failures
    }
    return `[test: ${testSummary.trim()}]`;
  }

  // Screenshot base64
  if (isBase64Content(output)) {
    return `[base64 content: ~${Math.round(output.length / 1024)}KB, replaced by compressor]`;
  }

  return null;
}

/**
 * Pre-process an entire JSONL file content.
 * Returns processed content string + stats.
 */
export function compressTranscript(
  content: string,
  config: CompressorConfig = DEFAULT_COMPRESSOR_CONFIG,
): { content: string; stats: CompressorStats } {
  const stats: CompressorStats = {
    totalLines: 0,
    skippedStreaming: 0,
    toolResultsSummarized: 0,
    base64Replaced: 0,
    largeTruncated: 0,
    bytesIn: content.length,
    bytesOut: 0,
  };

  if (!config.enabled) {
    stats.bytesOut = content.length;
    return { content, stats };
  }

  const lines = content.split("\n");
  const processedLines: string[] = [];

  for (const line of lines) {
    stats.totalLines++;

    const result = processJsonlLine(line, config);

    if (result === null) {
      stats.skippedStreaming++;
      continue;
    }

    if (result !== line) {
      // Line was modified
      if (result.includes("replaced by compressor")) stats.base64Replaced++;
      else if (result.length < line.length * 0.8) stats.toolResultsSummarized++;
      else stats.largeTruncated++;
    }

    processedLines.push(result);
  }

  const output = processedLines.join("\n");
  stats.bytesOut = output.length;

  return { content: output, stats };
}
