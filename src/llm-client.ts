/**
 * LLM Client — OpenAI-compatible wrapper for Qwen / other providers.
 *
 * Used for:
 * - Smart 6-category extraction (profile/preferences/entities/events/cases/patterns)
 * - L0/L1 summary generation (L0 = one-liner, L1 = structured markdown)
 * - Semantic dedup decisions (CREATE / MERGE / SKIP)
 *
 * Design references:
 * - 6-category system: ByteDance OpenViking memory architecture
 * - Weibull decay + tier: hippocampal memory consolidation model
 *
 * Zero new dependencies: reuses the OpenAI SDK already in tree.
 */

import OpenAI from "openai";

// ============================================================================
// Types
// ============================================================================

export interface LLMConfig {
  apiKey: string;
  model: string;
  baseURL: string;
  /** Request timeout in ms (default: 15000) */
  timeoutMs?: number;
  /** Temperature (default: 0.1 for consistency) */
  temperature?: number;
}

export interface DedupDecision {
  action: "CREATE" | "MERGE" | "SKIP";
  reason: string;
}

/** Six memory categories (OpenViking-inspired) */
export type SmartCategory =
  | "profile" | "preferences" | "entities" | "events" | "cases" | "patterns";

/** Result of LLM smart extraction */
export interface SmartExtraction {
  /** One of 6 categories */
  category: SmartCategory;
  /** L0: one-line index summary (≤80 chars) */
  l0: string;
  /** L1: structured markdown overview (2-5 lines) */
  l1: string;
  /** Importance score 0-1 (LLM's estimate) */
  importance: number;
}

/** Category-specific merge strategies */
export const CATEGORY_MERGE_STRATEGY: Record<SmartCategory, "merge" | "append"> = {
  profile: "merge",       // 身份信息：永远合并
  preferences: "merge",   // 偏好：合并更新
  entities: "merge",      // 实体：合并补充
  events: "append",       // 事件：追加，不覆盖
  cases: "append",        // 案例：追加，不覆盖
  patterns: "merge",      // 模式：合并优化
};

/** Default importance by category */
export const CATEGORY_DEFAULT_IMPORTANCE: Record<SmartCategory, number> = {
  profile: 0.85,      // 身份信息很重要
  preferences: 0.7,   // 偏好中等
  entities: 0.65,     // 实体中等
  events: 0.5,        // 事件一般
  cases: 0.75,        // 问题解决方案较重要
  patterns: 0.8,      // 可复用模式很重要
};

// ============================================================================
// Default Config
// ============================================================================

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  apiKey: "${QWEN_API_KEY}",
  model: "qwen-turbo",
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  timeoutMs: 15000,
  temperature: 0.1,
};

// ============================================================================
// LLM Client
// ============================================================================

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private timeoutMs: number;

  constructor(config: LLMConfig) {
    const apiKey = resolveEnvVars(config.apiKey);
    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model;
    this.temperature = config.temperature ?? 0.1;
    this.timeoutMs = config.timeoutMs ?? 15000;
  }

  /**
   * Generate a one-line L0 summary for a memory chunk.
   * Returns null on failure (caller should use extractive fallback).
   */
  async generateL0(text: string): Promise<string | null> {
    try {
      const response = await this.chat(
        "你是记忆索引助手。给以下对话片段写一句话摘要（不超过80字），" +
        "用于快速检索。只输出摘要本身，不加任何前缀。",
        text.slice(0, 2000), // Cap input to avoid token overflow
      );
      if (!response || response.length < 5) return null;
      return response.slice(0, 150);
    } catch {
      return null;
    }
  }

  /**
   * Smart extraction: classify a chunk into 6 categories and generate L0/L1.
   * This is the core of the OpenViking-inspired memory architecture.
   *
   * Returns null on failure (caller should use fallback classification).
   */
  async smartExtract(text: string): Promise<SmartExtraction | null> {
    try {
      const response = await this.chat(SMART_EXTRACT_SYSTEM_PROMPT, text.slice(0, 2000));
      if (!response) return null;

      const parsed = parseJSON<SmartExtraction>(response);
      if (!parsed) return null;

      // Validate category
      const validCategories: SmartCategory[] = ["profile", "preferences", "entities", "events", "cases", "patterns"];
      if (!validCategories.includes(parsed.category)) return null;

      return {
        category: parsed.category,
        l0: (parsed.l0 || "").slice(0, 150),
        l1: (parsed.l1 || "").slice(0, 500),
        importance: typeof parsed.importance === "number"
          ? Math.max(0, Math.min(1, parsed.importance))
          : CATEGORY_DEFAULT_IMPORTANCE[parsed.category],
      };
    } catch {
      return null;
    }
  }

  /**
   * Batch smart extraction: process multiple chunks efficiently.
   * Packs up to 3 chunks per request to reduce API calls.
   */
  async smartExtractBatch(texts: string[]): Promise<(SmartExtraction | null)[]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await this.smartExtract(texts[0])];

    const batchSize = 3; // Smaller batches for structured output reliability
    const results: (SmartExtraction | null)[] = new Array(texts.length).fill(null);

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const numbered = batch
        .map((t, idx) => `[${idx + 1}]\n${t.slice(0, 800)}`)
        .join("\n===\n");

      try {
        const response = await this.chat(
          SMART_EXTRACT_BATCH_PROMPT,
          numbered,
        );

        if (response) {
          // Parse array of extractions
          const parsed = parseJSON<SmartExtraction[]>(response);
          if (Array.isArray(parsed)) {
            for (let j = 0; j < parsed.length && j < batch.length; j++) {
              const item = parsed[j];
              if (item && item.category && item.l0) {
                results[i + j] = {
                  category: item.category,
                  l0: (item.l0 || "").slice(0, 150),
                  l1: (item.l1 || "").slice(0, 500),
                  importance: typeof item.importance === "number"
                    ? Math.max(0, Math.min(1, item.importance))
                    : CATEGORY_DEFAULT_IMPORTANCE[item.category] ?? 0.6,
                };
              }
            }
          }
        }
      } catch {
        // Fall through — individual nulls remain
      }
    }

    return results;
  }

  /**
   * Batch generate L0 summaries for multiple chunks.
   * More efficient than individual calls — packs up to 5 chunks per request.
   */
  async generateL0Batch(texts: string[]): Promise<(string | null)[]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) {
      const result = await this.generateL0(texts[0]);
      return [result];
    }

    // Pack multiple chunks into one request (up to 5)
    const batchSize = 5;
    const results: (string | null)[] = new Array(texts.length).fill(null);

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const numbered = batch
        .map((t, idx) => `[${idx + 1}] ${t.slice(0, 800)}`)
        .join("\n---\n");

      try {
        const response = await this.chat(
          "你是记忆索引助手。给以下每段对话写一句话摘要（不超过80字）。\n" +
          "输出格式：每行一条，以 [序号] 开头。只输出摘要，不加多余文字。",
          numbered,
        );

        if (response) {
          const lines = response.split("\n").filter(l => l.trim());
          for (const line of lines) {
            const match = line.match(/^\[(\d+)\]\s*(.+)/);
            if (match) {
              const idx = parseInt(match[1]) - 1;
              if (idx >= 0 && idx < batch.length) {
                results[i + idx] = match[2].trim().slice(0, 150);
              }
            }
          }
        }
      } catch {
        // Fall through — individual nulls remain
      }
    }

    return results;
  }

  /**
   * Semantic dedup decision: given a new chunk and an existing similar chunk,
   * decide whether to CREATE (store new), MERGE (combine), or SKIP (discard).
   */
  async dedupDecision(
    newText: string,
    existingText: string,
  ): Promise<DedupDecision> {
    try {
      const response = await this.chat(
        "你是记忆去重助手。比较以下两段记忆，决定新记忆应该如何处理。\n\n" +
        "规则：\n" +
        "- SKIP：新记忆跟已有记忆说的是同一件事，没有新信息\n" +
        "- MERGE：新记忆有补充信息，应该合并到已有记忆\n" +
        "- CREATE：新记忆是不同的事，应该独立存储\n\n" +
        "只输出一行 JSON：{\"action\":\"CREATE|MERGE|SKIP\",\"reason\":\"简短原因\"}",
        `[已有记忆]\n${existingText.slice(0, 1000)}\n\n[新记忆]\n${newText.slice(0, 1000)}`,
      );

      if (!response) return { action: "CREATE", reason: "LLM 无响应" };

      const parsed = parseJSON<DedupDecision>(response);
      if (parsed && (parsed.action === "CREATE" || parsed.action === "MERGE" || parsed.action === "SKIP")) {
        return parsed;
      }

      return { action: "CREATE", reason: "JSON 解析失败" };
    } catch {
      return { action: "CREATE", reason: "LLM 调用失败" };
    }
  }

  /**
   * Test LLM connectivity.
   */
  async test(): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.chat("回复 OK", "测试");
      return { success: !!response };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async chat(system: string, user: string): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: this.temperature,
          max_tokens: 500,
        },
        { signal: controller.signal },
      );

      return response.choices[0]?.message?.content?.trim() || null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ============================================================================
// Smart Extraction Prompts (OpenViking-inspired 6-category system)
// ============================================================================

const SMART_EXTRACT_SYSTEM_PROMPT = `你是 AI 记忆分类助手。把对话片段分类到 6 种记忆类型之一，并生成摘要。

## 6 种记忆类型

用户记忆（4 类）：
- profile：用户身份、背景、职业、技能（长期稳定）
- preferences：偏好、习惯、喜好（会变但较稳定）
- entities：项目、工具、人物等持续存在的名词
- events：发生过的具体事件（一次性）

智能体记忆（2 类）：
- cases：具体的问题→解决方案对（踩坑记录、bug 修复）
- patterns：可复用的流程、规律、最佳实践

## 分类决策表
| 关键词线索 | 类别 |
|-----------|------|
| "我是…"、身份、背景 | profile |
| "我喜欢…"、"我习惯…"、偏好 | preferences |
| 项目名、工具名、人名 | entities |
| "今天…"、"刚才…"、具体操作 | events |
| 报错→修复、问题→方案 | cases |
| "每次…"、"一般…"、规律总结 | patterns |

## 输出格式
只输出一个 JSON 对象：
{"category":"类别","l0":"一句话摘要(≤80字)","l1":"结构化概述(2-5行markdown)","importance":0.7}

importance 评分标准：身份/模式 0.8+、偏好/案例 0.7、实体 0.65、普通事件 0.5`;

const SMART_EXTRACT_BATCH_PROMPT = `你是 AI 记忆分类助手。把每段对话分类到 6 种记忆类型之一。

类型：profile(身份) | preferences(偏好) | entities(实体) | events(事件) | cases(问题方案) | patterns(模式规律)

对每段输出 JSON 对象，最终输出一个 JSON 数组：
[{"category":"类别","l0":"一句话摘要","l1":"结构化概述","importance":0.7}, ...]

importance：身份/模式 0.8+、偏好/案例 0.7、实体 0.65、事件 0.5`;

// ============================================================================
// Helpers
// ============================================================================

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

/**
 * Robust JSON parsing: handles markdown code blocks, unbalanced braces/brackets.
 * Supports both objects and arrays.
 */
function parseJSON<T>(text: string): T | null {
  // Strip markdown code block wrapping
  const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");

  // Try direct parse
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Try extracting JSON object or array from balanced delimiters
    // Check for array first (batch results)
    const arrStart = cleaned.indexOf("[");
    const arrEnd = cleaned.lastIndexOf("]");
    if (arrStart >= 0 && arrEnd > arrStart) {
      try {
        return JSON.parse(cleaned.slice(arrStart, arrEnd + 1)) as T;
      } catch { /* fall through to object attempt */ }
    }

    // Try object
    const objStart = cleaned.indexOf("{");
    const objEnd = cleaned.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) {
      try {
        return JSON.parse(cleaned.slice(objStart, objEnd + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an LLM client from config. Returns null if API key is not available.
 */
export function createLLMClient(config?: Partial<LLMConfig>): LLMClient | null {
  const merged = { ...DEFAULT_LLM_CONFIG, ...config };

  // Check if API key is available
  try {
    const resolved = resolveEnvVars(merged.apiKey);
    if (!resolved || resolved.startsWith("$")) return null;
  } catch {
    return null;
  }

  try {
    return new LLMClient(merged);
  } catch {
    return null;
  }
}
