import { describe, expect, test, beforeAll } from "bun:test";
import {
  detectLanguage,
  tokenizeForFts,
  initTokenizer,
  getKgPrompt,
  getSessionPrompt,
} from "babel-memory";

beforeAll(async () => {
  await initTokenizer();
});

describe("babel-memory integration", () => {
  test("Chinese memory: language detected + fts_text tokenized", () => {
    const text = "RecallNest 是一个基于 LanceDB 的 AI 记忆系统";
    const language = detectLanguage(text);
    const fts_text = tokenizeForFts(text, language);

    expect(language).toBe("zh");
    expect(fts_text).toContain("RecallNest");
    expect(fts_text.includes(" ")).toBe(true);
  });

  test("English memory: language detected + fts_text unchanged", () => {
    const text = "RecallNest is an AI memory system built on LanceDB";
    const language = detectLanguage(text);
    const fts_text = tokenizeForFts(text, language);

    expect(language).toBe("en");
    expect(fts_text).toBe(text);
  });

  test("BM25 query symmetry: tokenized query matches tokenized stored text", () => {
    const storedText = "机器学习在自然语言处理中的应用";
    const storedLang = detectLanguage(storedText);
    const storedFts = tokenizeForFts(storedText, storedLang);

    const query = "机器学习";
    const queryLang = detectLanguage(query);
    const queryFts = tokenizeForFts(query, queryLang);

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
    const lang = detectLanguage(text);
    const { system } = getKgPrompt(lang);
    expect(system).toContain("知识图谱");
  });

  test("Session prompt routes correctly for Chinese input", () => {
    const text = "用户今天讨论了多语言支持方案";
    const lang = detectLanguage(text);
    const { dimensionLabels } = getSessionPrompt(lang);
    expect(dimensionLabels.user_intent).toContain("用户意图");
  });

  test("backward compat: missing language defaults to en", () => {
    const entry = { text: "some old text", language: undefined };
    const lang = entry.language || "en";
    const fts = tokenizeForFts(entry.text, lang);
    expect(lang).toBe("en");
    expect(fts).toBe(entry.text);
  });
});
