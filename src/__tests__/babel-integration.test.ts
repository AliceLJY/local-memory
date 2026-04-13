import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { MemoryStore } from "../store.js";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// babel-memory is an optional dependency — skip integration tests if not installed
let babelMemory: typeof import("babel-memory") | null = null;
try {
  babelMemory = await import("babel-memory");
} catch {
  // not installed — tests will be skipped
}

const describeIfBabel = babelMemory ? describe : describe.skip;

beforeAll(async () => {
  if (babelMemory) {
    await babelMemory.initTokenizer();
  }
});

describeIfBabel("babel-memory integration", () => {
  test("Chinese memory: language detected + fts_text tokenized", () => {
    const text = "RecallNest 是一个基于 LanceDB 的 AI 记忆系统";
    const language = babelMemory!.detectLanguage(text);
    const fts_text = babelMemory!.tokenizeForFts(text, language);

    expect(language).toBe("zh");
    expect(fts_text).toContain("RecallNest");
    expect(fts_text.includes(" ")).toBe(true);
  });

  test("English memory: language detected + fts_text unchanged", () => {
    const text = "RecallNest is an AI memory system built on LanceDB";
    const language = babelMemory!.detectLanguage(text);
    const fts_text = babelMemory!.tokenizeForFts(text, language);

    expect(language).toBe("en");
    expect(fts_text).toBe(text);
  });

  test("BM25 query symmetry: tokenized query matches tokenized stored text", () => {
    const storedText = "机器学习在自然语言处理中的应用";
    const storedLang = babelMemory!.detectLanguage(storedText);
    const storedFts = babelMemory!.tokenizeForFts(storedText, storedLang);

    const query = "机器学习";
    const queryLang = babelMemory!.detectLanguage(query);
    const queryFts = babelMemory!.tokenizeForFts(query, queryLang);

    const queryTerms = queryFts
      .split(" ")
      .filter((t) => t.length > 0);
    const matchedTerms = queryTerms.filter((term) =>
      storedFts.includes(term),
    );
    expect(matchedTerms.length).toBeGreaterThan(0);
  });

  test("KG prompt routes correctly for Chinese input", () => {
    const text = "RecallNest 使用 LanceDB 存储记忆";
    const lang = babelMemory!.detectLanguage(text);
    const { system } = babelMemory!.getKgPrompt(lang);
    expect(system).toContain("知识图谱");
  });

  test("Session prompt routes correctly for Chinese input", () => {
    const text = "用户今天讨论了多语言支持方案";
    const lang = babelMemory!.detectLanguage(text);
    const { dimensionLabels } = babelMemory!.getSessionPrompt(lang);
    expect(dimensionLabels.user_intent).toContain("用户意图");
  });

  test("backward compat: missing language defaults to en", () => {
    const entry = { text: "some old text", language: undefined };
    const lang = entry.language || "en";
    const fts = babelMemory!.tokenizeForFts(entry.text, lang);
    expect(lang).toBe("en");
    expect(fts).toBe(entry.text);
  });
});

describe("store.update() preserves language + fts_text", () => {
  const dbPath = join(tmpdir(), `recallnest-update-lang-test-${Date.now()}`);
  let store: MemoryStore;

  beforeAll(async () => {
    mkdirSync(dbPath, { recursive: true });
    store = new MemoryStore({ dbPath, vectorDim: 3 });
    await (store as any).ensureInitialized();
  });

  afterAll(() => {
    try { rmSync(dbPath, { recursive: true, force: true }); } catch {}
  });

  test("update preserves language and fts_text when not in updates", async () => {
    const entry = await store.store({
      text: "这是一条中文记忆",
      vector: [0.1, 0.2, 0.3],
      category: "events",
      scope: "test:lang",
      importance: 0.7,
      metadata: "{}",
      language: "zh",
      fts_text: "这是 一条 中文 记忆",
    });

    // Update only text — language and fts_text should be preserved from old row
    const updated = await store.update(entry.id, {
      importance: 0.9,
    });

    expect(updated).not.toBeNull();
    expect(updated!.language).toBe("zh");
    expect(updated!.fts_text).toBe("这是 一条 中文 记忆");
    expect(updated!.importance).toBe(0.9);
  });

  test("update overwrites language and fts_text when provided", async () => {
    const entry = await store.store({
      text: "old english text",
      vector: [0.4, 0.5, 0.6],
      category: "events",
      scope: "test:lang",
      importance: 0.6,
      metadata: "{}",
      language: "en",
      fts_text: "old english text",
    });

    const updated = await store.update(entry.id, {
      text: "新的中文文本",
      language: "zh",
      fts_text: "新的 中文 文本",
    });

    expect(updated).not.toBeNull();
    expect(updated!.language).toBe("zh");
    expect(updated!.fts_text).toBe("新的 中文 文本");
    expect(updated!.text).toBe("新的中文文本");
  });
});
