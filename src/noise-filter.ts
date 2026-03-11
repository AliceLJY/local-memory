/**
 * Noise Filter
 * Filters out low-quality memories (meta-questions, agent denials, session boilerplate)
 * Inspired by openclaw-plugin-continuity's noise filtering approach.
 */

import { logInfo } from "./stderr-log.js";

// Agent-side denial patterns
const DENIAL_PATTERNS = [
  /i don'?t have (any )?(information|data|memory|record)/i,
  /i'?m not sure about/i,
  /i don'?t recall/i,
  /i don'?t remember/i,
  /it looks like i don'?t/i,
  /i wasn'?t able to find/i,
  /no (relevant )?memories found/i,
  /i don'?t have access to/i,
];

// User-side meta-question patterns (about memory itself, not content)
const META_QUESTION_PATTERNS = [
  /\bdo you (remember|recall|know about)\b/i,
  /\bcan you (remember|recall)\b/i,
  /\bdid i (tell|mention|say|share)\b/i,
  /\bhave i (told|mentioned|said)\b/i,
  /\bwhat did i (tell|say|mention)\b/i,
  // Chinese meta-question patterns (synced from upstream v1.1.0-beta.3)
  /你还?记得/,
  /记不记得/,
  /还记得.*吗/,
  /上次.*说/,
  /之前.*提到/,
];

// Session boilerplate
const BOILERPLATE_PATTERNS = [
  /^(hi|hello|hey|good morning|good evening|greetings)/i,
  /^fresh session/i,
  /^new session/i,
  /^HEARTBEAT/i,
];

// OpenClaw v3.2+ injected metadata headers (backport from v1.0.29)
const METADATA_HEADER_PATTERNS = [
  /^Conversation info \(untrusted metadata\)/i,
  /^---\s*\n\s*\{[\s\S]*?\}\s*\n\s*---/m, // YAML-like JSON blocks
  /^\[?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\]]*\]?\s*$/m, // bare timestamps
];

// Diagnostic artifact patterns (synced from upstream v1.1.0-beta.3)
// Extractor validation outputs that leak into memory store
const DIAGNOSTIC_ARTIFACT_PATTERNS = [
  /^query\s*->\s*none$/i,
  /^no explicit solution$/i,
  /^如果你知道.+只回复/i,
  /^如果不知道.+只回复\s*none/i,
  /^只回复精确代号/i,
];

export interface NoiseFilterOptions {
  /** Filter agent denial responses (default: true) */
  filterDenials?: boolean;
  /** Filter meta-questions about memory (default: true) */
  filterMetaQuestions?: boolean;
  /** Filter session boilerplate (default: true) */
  filterBoilerplate?: boolean;
}

const DEFAULT_OPTIONS: Required<NoiseFilterOptions> = {
  filterDenials: true,
  filterMetaQuestions: true,
  filterBoilerplate: true,
};

/**
 * Check if a memory text is noise that should be filtered out.
 * Returns true if the text is noise.
 */
export function isNoise(text: string, options: NoiseFilterOptions = {}): boolean {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const trimmed = text.trim();

  if (trimmed.length < 5) {
    logInfo(`[INFO] noise-filter: skipped short text (${trimmed.length} chars)`);
    return true;
  }

  if (opts.filterDenials && DENIAL_PATTERNS.some(p => p.test(trimmed))) {
    logInfo(`[INFO] noise-filter: denial pattern matched: "${trimmed.slice(0, 60)}..."`);
    return true;
  }
  if (opts.filterMetaQuestions && META_QUESTION_PATTERNS.some(p => p.test(trimmed))) {
    logInfo(`[INFO] noise-filter: meta-question filtered: "${trimmed.slice(0, 60)}..."`);
    return true;
  }
  if (opts.filterBoilerplate && BOILERPLATE_PATTERNS.some(p => p.test(trimmed))) {
    logInfo(`[INFO] noise-filter: boilerplate filtered: "${trimmed.slice(0, 60)}..."`);
    return true;
  }
  // OpenClaw v3.2+ metadata noise (backport from v1.0.29)
  if (METADATA_HEADER_PATTERNS.some(p => p.test(trimmed))) {
    logInfo(`[INFO] noise-filter: metadata header filtered`);
    return true;
  }
  // Diagnostic artifact noise (synced from upstream v1.1.0-beta.3)
  if (DIAGNOSTIC_ARTIFACT_PATTERNS.some(p => p.test(trimmed))) {
    logInfo(`[INFO] noise-filter: diagnostic artifact filtered: "${trimmed.slice(0, 60)}..."`);
    return true;
  }

  return false;
}

/**
 * Filter an array of items, removing noise entries.
 */
export function filterNoise<T>(
  items: T[],
  getText: (item: T) => string,
  options?: NoiseFilterOptions
): T[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return items.filter(item => !isNoise(getText(item), opts));
}
