/**
 * Knowledge Graph Triple Extractor
 * Uses LLM few-shot OpenIE to extract (subject, predicate, object) triples from memory text.
 * Gated by RECALLNEST_KG_MODE env var.
 */

import type { LLMClient } from "./llm-client.js";
import type { KGStore } from "./kg-store.js";
import { logInfo, logWarn } from "./stderr-log.js";
import { detectLanguage, getKgPrompt } from "babel-memory";

// ============================================================================
// Types
// ============================================================================

export interface RawTriple {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

export interface KGExtractorConfig {
  /** Minimum confidence to keep a triple (0-1). Default: 0.6 */
  minConfidence?: number;
  /** LLM client for extraction */
  llmClient: LLMClient;
  /** KG store for persisting triples */
  kgStore: KGStore;
}

interface LlmExtractionResponse {
  triples: RawTriple[];
}

// ============================================================================
// Feature Gate
// ============================================================================

/** Check if KG mode is enabled (env var) */
export function isKGModeEnabled(): boolean {
  return process.env.RECALLNEST_KG_MODE === "true";
}

// ============================================================================
// Entity Normalization
// ============================================================================

/**
 * Normalize entity names for consistent matching:
 * - Trim whitespace, collapse internal whitespace
 * - Title case for Latin text, CJK unchanged
 * - Strip surrounding quotes/brackets
 */
export function normalizeEntity(raw: string): string {
  let entity = raw.trim();

  // Strip surrounding quotes and brackets
  entity = entity.replace(/^[\s"'""''「」『』【】\[\]()（）]+/, "");
  entity = entity.replace(/[\s"'""''「」『』【】\[\]()（）]+$/, "");

  // Collapse whitespace
  entity = entity.replace(/\s+/g, " ").trim();

  if (!entity) return "";

  // For CJK text, return as-is
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(entity)) {
    return entity;
  }

  // Title Case for English entities
  return entity
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Normalize predicate to snake_case for consistency.
 */
export function normalizePredicate(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_\u4e00-\u9fff]/g, "");
}

// ============================================================================
// Extraction Prompt
// ============================================================================

// KG extraction prompts are now provided by babel-memory (bilingual)

// ============================================================================
// Extractor
// ============================================================================

export class KGExtractor {
  private readonly minConfidence: number;
  private readonly llm: LLMClient;
  private readonly kgStore: KGStore;

  constructor(config: KGExtractorConfig) {
    this.minConfidence = config.minConfidence ?? 0.6;
    this.llm = config.llmClient;
    this.kgStore = config.kgStore;
  }

  /**
   * Extract triples from text and persist to KG store.
   * Returns the number of triples stored.
   */
  async extractAndStore(
    text: string,
    sourceMemoryId: string,
    scope: string,
  ): Promise<number> {
    const rawTriples = await this.extract(text);
    if (rawTriples.length === 0) return 0;

    const triples = await this.kgStore.createTriples(
      rawTriples.map((t) => ({
        scope,
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
        confidence: t.confidence,
        source_memory_id: sourceMemoryId,
        source_text: text.slice(0, 500), // Cap source text
      })),
    );

    logInfo(`[KG] stored ${triples.length} triples from memory ${sourceMemoryId}`);
    return triples.length;
  }

  /**
   * Extract raw triples from text via LLM. Does not persist.
   */
  async extract(text: string): Promise<RawTriple[]> {
    if (!text || text.length < 10) return [];

    const lang = detectLanguage(text);
    const { system, userTemplate } = getKgPrompt(lang);
    const prompt = userTemplate.replace("{text}", text);

    let response: LlmExtractionResponse | null = null;
    try {
      response = await this.llm.chatJson<LlmExtractionResponse>(
        system,
        prompt,
      );
    } catch (err) {
      logWarn(`[KG] LLM extraction failed: ${String(err)}`);
      return [];
    }

    if (!response?.triples || !Array.isArray(response.triples)) {
      return [];
    }

    // Validate, normalize, filter
    const valid: RawTriple[] = [];
    for (const t of response.triples) {
      if (!t.subject || !t.predicate || !t.object) continue;

      const subject = normalizeEntity(t.subject);
      const predicate = normalizePredicate(t.predicate);
      const object = normalizeEntity(t.object);
      const confidence = Number(t.confidence) || 0;

      if (!subject || !predicate || !object) continue;
      if (confidence < this.minConfidence) continue;
      if (subject === object) continue; // Skip self-referencing

      valid.push({ subject, predicate, object, confidence });
    }

    // Deduplicate within batch
    const seen = new Set<string>();
    return valid.filter((t) => {
      const key = `${t.subject}\x00${t.predicate}\x00${t.object}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createKGExtractor(config: KGExtractorConfig): KGExtractor {
  return new KGExtractor(config);
}
