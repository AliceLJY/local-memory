/**
 * Language processing hook interface.
 * Allows RecallNest to use any language processor (babel-memory or custom).
 * If no processor is registered, all functions return safe defaults.
 */
export interface LanguageProcessor {
  detectLanguage(text: string): string;
  tokenizeForFts(text: string, lang: string): string;
}

interface PromptProvider {
  getKgPrompt(lang: string): { system: string; userTemplate: string };
  getSessionPrompt(lang: string): { system: string; dimensionLabels: Record<string, string> };
}

let processor: LanguageProcessor | null = null;
let promptProvider: PromptProvider | null = null;

export function registerLanguageProcessor(p: LanguageProcessor): void {
  processor = p;
}

export function registerPromptProvider(p: PromptProvider): void {
  promptProvider = p;
}

export function detectLang(text: string): string {
  return processor?.detectLanguage(text) ?? "en";
}

export function tokenizeFts(text: string, lang: string): string {
  return processor?.tokenizeForFts(text, lang) ?? text;
}

export function getKgPromptHook(lang: string): { system: string; userTemplate: string } | null {
  return promptProvider?.getKgPrompt(lang) ?? null;
}

export function getSessionPromptHook(lang: string): { system: string; dimensionLabels: Record<string, string> } | null {
  return promptProvider?.getSessionPrompt(lang) ?? null;
}

/**
 * Auto-detect and register babel-memory if installed.
 * Call once at server startup. Non-blocking.
 */
export async function autoRegisterBabelMemory(): Promise<boolean> {
  try {
    const bm = await import("babel-memory");
    if (typeof bm.initTokenizer === "function") {
      await bm.initTokenizer();
    }
    registerLanguageProcessor({
      detectLanguage: bm.detectLanguage,
      tokenizeForFts: bm.tokenizeForFts,
    });
    if (bm.getKgPrompt && bm.getSessionPrompt) {
      registerPromptProvider({
        getKgPrompt: bm.getKgPrompt,
        getSessionPrompt: bm.getSessionPrompt,
      });
    }
    return true;
  } catch {
    return false;
  }
}
