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

/** Extended dedup decision with optional secondary actions on other existing memories. */
export interface DedupDecisionMulti extends DedupDecision {
  actions?: Array<{ match_index: number; action: "delete"; reason: string }>;
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
        "用于快速检索。只输出摘要本身，不加任何前缀。\n" +
        "保真规则：端口号/IP/URL/文件路径/API名称 → 原样保留；" +
        "函数名/事件名/配置项 → 逐项保留不概括。",
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
   * B-3: Assess the long-term importance of a memory (0–1).
   * Called when store_memory importance is at the default value, to let LLM refine it.
   * Returns null on failure (caller should keep the default).
   */
  async assessImportance(text: string, category: string): Promise<number | null> {
    try {
      const response = await this.chat(
        "你是记忆重要性评估助手。评估以下记忆的长期重要性（0.0-1.0）。\n\n" +
        "锚定标准（每级附具体示例，严格对标）：\n" +
        "- 0.85-1.0：用户明确纠正行为（如'不要这样做'）、身份声明（职业/角色）、" +
          "情感/行为变化、核心偏好（写作风格/沟通方式）、反复强调的规则\n" +
        "- 0.70-0.84：关键决策（架构选型/技术路线）、项目承诺（deadline/里程碑）、" +
          "可复用案例（踩坑→修复→教训）、持久偏好（喜欢X不喜欢Y）\n" +
        "- 0.55-0.69：实体信息（项目名/工具名/人名）、新学到的背景知识、" +
          "配置参数（API key位置/环境变量）\n" +
        "- 0.40-0.54：普通事件（今天部署了X）、一次性操作步骤、" +
          "已解决的 bug 细节（修完即过时）\n" +
        "- 0.10-0.30：日常寒暄、重复信息（已有更完整版本）、" +
          "临时调试输出、短期上下文（如'刚才那个文件'）\n\n" +
        "常见误判提醒：\n" +
        "- 用户说'记住'/'永远不要' → 至少 0.85\n" +
        "- 看起来是小事但反复出现 → 至少 0.70（重复=重要）\n" +
        "- 纯技术细节但没有复用价值 → 不超过 0.50\n\n" +
        "只输出一行 JSON：{\"importance\":0.7,\"reason\":\"简短原因\"}",
        `[类别] ${category}\n[内容] ${text.slice(0, 1000)}`,
      );
      if (!response) return null;
      const parsed = parseJSON<{ importance: number; reason?: string }>(response);
      if (parsed && typeof parsed.importance === "number") {
        return Math.max(0, Math.min(1, parsed.importance));
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * HP-4: Batch re-assess importance for existing memories during distill.
   * Returns a map of id → new importance (only for entries that changed).
   */
  async reassessImportanceBatch(
    entries: Array<{ id: string; text: string; category: string; currentImportance: number }>,
  ): Promise<Map<string, number>> {
    const results = new Map<string, number>();
    if (entries.length === 0) return results;

    const batch = entries
      .map((e, i) => `[${i}] category=${e.category} importance=${e.currentImportance}\n${e.text.slice(0, 300)}`)
      .join("\n---\n");

    try {
      const response = await this.chat(
        "批量重评记忆重要性。使用同一套锚定标准（0.85+ 身份/纠正/核心偏好，" +
        "0.70-0.84 决策/案例/偏好，0.55-0.69 实体/背景，0.40-0.54 事件/操作，" +
        "0.10-0.30 寒暄/重复/临时）。\n" +
        "只输出 JSON 数组，每项 {\"idx\":0,\"importance\":0.7}，" +
        "只包含需要调整的项（与当前分数差 ≥ 0.1 才输出）。",
        batch,
      );
      if (!response) return results;
      const parsed = parseJSON<Array<{ idx: number; importance: number }>>(response);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (
            typeof item.idx === "number" &&
            typeof item.importance === "number" &&
            item.idx >= 0 &&
            item.idx < entries.length
          ) {
            results.set(entries[item.idx].id, Math.max(0, Math.min(1, item.importance)));
          }
        }
      }
    } catch {
      // Batch re-assessment failure is non-fatal
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
        "额外规则：如果两条都是偏好陈述，并且是同品牌/同主题下的不同具体对象或条目（例如不同食物、商品、菜单项），必须返回 CREATE。聚合摘要也不能吞掉新的原子偏好。\n\n" +
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
   * Multi-candidate dedup decision: compare a new chunk against multiple existing
   * memories and optionally return secondary delete actions on outdated entries.
   */
  async dedupDecisionMulti(
    newText: string,
    existingEntries: Array<{ id: string; text: string }>,
  ): Promise<DedupDecisionMulti> {
    if (existingEntries.length === 0) {
      return { action: "CREATE", reason: "无候选" };
    }
    // Fallback to simple 1:1 dedup for single candidate
    if (existingEntries.length === 1) {
      return this.dedupDecision(newText, existingEntries[0].text);
    }

    try {
      const existingBlock = existingEntries
        .map((e, i) => `[已有记忆 ${i + 1}] (${e.id.slice(0, 8)})\n${e.text.slice(0, 500)}`)
        .join("\n\n");

      const response = await this.chat(
        "你是记忆去重助手。比较新记忆和多条已有记忆，决定新记忆应该如何处理。\n\n" +
        "规则：\n" +
        "- SKIP：新记忆跟某条已有记忆说的是同一件事，没有新信息\n" +
        "- MERGE：新记忆有补充信息，应该合并到已有记忆\n" +
        "- CREATE：新记忆是不同的事，应该独立存储\n" +
        "- 如果两条都是偏好陈述，同品牌/同主题下的不同条目，必须返回 CREATE\n\n" +
        "额外能力：如果发现某些已有记忆已经过时（被新记忆或其他已有记忆完全取代），可以在 actions 里标记删除。\n\n" +
        "只输出一行 JSON：\n" +
        '{"action":"CREATE|MERGE|SKIP","match_index":1,"reason":"简短原因","actions":[{"match_index":2,"action":"delete","reason":"被新记忆取代"}]}' + "\n\n" +
        "- match_index 是 1-based 索引，指向你要操作的已有记忆\n" +
        "- actions 是可选的，只在确实有过时记忆需要清理时才填\n" +
        "- actions 里只支持 delete",
        `${existingBlock}\n\n[新记忆]\n${newText.slice(0, 1000)}`,
      );

      if (!response) return { action: "CREATE", reason: "LLM 无响应" };

      const parsed = parseJSON<DedupDecisionMulti>(response);
      if (parsed && (parsed.action === "CREATE" || parsed.action === "MERGE" || parsed.action === "SKIP")) {
        // Validate secondary actions
        const validActions = Array.isArray(parsed.actions)
          ? parsed.actions.filter(
              (a) =>
                typeof a === "object" && a !== null &&
                typeof a.match_index === "number" &&
                a.match_index >= 1 && a.match_index <= existingEntries.length &&
                a.action === "delete",
            )
          : [];
        return {
          action: parsed.action,
          reason: parsed.reason ?? "",
          actions: validActions.length > 0 ? validActions : undefined,
        };
      }

      return { action: "CREATE", reason: "JSON 解析失败" };
    } catch {
      return { action: "CREATE", reason: "LLM 调用失败" };
    }
  }

  /**
   * Generate a core summary (≤200 chars) for a memory chunk.
   * More detailed than L0 (~80 chars), more concise than L1 (~500 chars).
   * Used by Tier 3.1 to produce token-efficient context output.
   *
   * @returns Core summary string, or null on failure
   */
  async generateCoreSummary(text: string): Promise<string | null> {
    try {
      return await this.chat(
        "你是记忆精炼助手。把以下内容提炼为一段核心摘要（不超过200字）。\n" +
        "要求：保留关键事实、人名、数字、时间等；去除冗余修辞；直接输出摘要，不加前缀。\n" +
        "保真规则：端口号/IP/URL/文件路径 → 原样保留；" +
        "命名列表（函数名/事件名/配置项）→ 逐项保留不概括；" +
        "规则表/状态转移 → 完整保留；对比/排序 → 保留顺序和理由。",
        text.slice(0, 2000),
      );
    } catch {
      return null;
    }
  }

  /**
   * Batch generate core summaries for multiple texts.
   * Packs up to 3 texts per request for efficiency.
   */
  async generateCoreSummaryBatch(texts: string[]): Promise<(string | null)[]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await this.generateCoreSummary(texts[0])];

    const results: (string | null)[] = new Array(texts.length).fill(null);
    const batchSize = 3;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const numbered = batch.map((t, idx) => `[${idx + 1}] ${t.slice(0, 800)}`).join("\n---\n");

      try {
        const raw = await this.chat(
          "你是记忆精炼助手。为每段内容生成核心摘要（每条不超过200字）。\n" +
          "输出 JSON 数组：[\"摘要1\", \"摘要2\", ...]",
          numbered,
        );
        if (raw) {
          const parsed = JSON.parse(
            raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, ""),
          );
          if (Array.isArray(parsed)) {
            for (let j = 0; j < Math.min(parsed.length, batch.length); j++) {
              results[i + j] = typeof parsed[j] === "string" ? parsed[j] : null;
            }
          }
        }
      } catch {
        // Individual fallback
        for (let j = 0; j < batch.length; j++) {
          results[i + j] = await this.generateCoreSummary(batch[j]);
        }
      }
    }

    return results;
  }

  /**
   * Synthesize multiple memory fragments into a coherent narrative.
   * Used by Tier 3.5 result-synthesizer to produce readable context.
   *
   * @param fragments Array of memory text snippets
   * @param query     The original query for context
   * @param maxLen    Max output length in chars (default: 500)
   * @returns Synthesized text, or null on failure
   */
  async synthesizeFragments(
    fragments: string[],
    query: string,
    maxLen = 500,
  ): Promise<string | null> {
    if (fragments.length === 0) return null;
    if (fragments.length === 1) return fragments[0];

    const numbered = fragments.map((f, i) => `[${i + 1}] ${f}`).join("\n");
    return this.chat(
      `你是记忆整合助手。把多条碎片记忆整合成一段连贯的叙述。\n` +
      `要求：\n` +
      `- 不超过${maxLen}字\n` +
      `- 去除重复信息，保留所有不同的事实\n` +
      `- 保持客观，不添加原文没有的信息\n` +
      `- 直接输出整合后的文本，不加前缀或解释`,
      `查询：${query}\n\n记忆碎片：\n${numbered}`,
    );
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

  /**
   * Chat + JSON parse helper for structured extraction.
   * Returns null on failure (LLM error or invalid JSON).
   */
  async chatJson<T>(system: string, user: string): Promise<T | null> {
    const raw = await this.chat(system, user);
    if (!raw) return null;
    try {
      // Extract JSON from markdown fences if present
      const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw;
      return JSON.parse(jsonStr) as T;
    } catch {
      // Try to find JSON object in the response
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(raw.slice(start, end + 1)) as T;
        } catch {
          return null;
        }
      }
      return null;
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

## 保真规则（l0/l1 必须遵守）
- 端口号/IP/URL/文件路径/API endpoint → 原样保留
- 命名列表（函数名/事件名/配置项）→ 逐项保留，不概括为"等"
- 规则表/状态转移 → 完整保留
- 对比/排序 → 保留顺序和理由

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
