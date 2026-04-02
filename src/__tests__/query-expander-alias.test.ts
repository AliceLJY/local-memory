import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { expandQuery, setAliasMapPath, resetAliasMapCache } from "../query-expander.js";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, "../../.test-data");
const TEST_ALIAS = join(TEST_DIR, "test-alias-map.json");

function cleanup() {
  try { if (existsSync(TEST_ALIAS)) unlinkSync(TEST_ALIAS); } catch {}
}

describe("expandQuery with alias-map", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    cleanup();
    resetAliasMapCache();
  });
  afterEach(() => {
    cleanup();
    resetAliasMapCache();
  });

  it("expands short query using alias-map", () => {
    writeFileSync(TEST_ALIAS, JSON.stringify([
      { trigger: "轮巡", expansions: ["仓库", "patrol", "repo", "每日检查"] },
    ]));
    setAliasMapPath(TEST_ALIAS);

    const expanded = expandQuery("轮巡");
    expect(expanded).toContain("轮巡");
    expect(expanded).toContain("仓库");
    expect(expanded).toContain("patrol");
  });

  it("does not expand when trigger not matched", () => {
    writeFileSync(TEST_ALIAS, JSON.stringify([
      { trigger: "轮巡", expansions: ["仓库", "patrol"] },
    ]));
    setAliasMapPath(TEST_ALIAS);

    const expanded = expandQuery("部署");
    // "部署" matches built-in synonym map, but should NOT match alias "轮巡"
    expect(expanded).not.toContain("patrol");
  });

  it("works with empty alias-map file", () => {
    writeFileSync(TEST_ALIAS, "[]");
    setAliasMapPath(TEST_ALIAS);

    const result = expandQuery("轮巡");
    // Should still work (only built-in synonyms)
    expect(result).toContain("轮巡");
  });

  it("works with missing alias-map file", () => {
    setAliasMapPath(join(TEST_DIR, "nonexistent.json"));

    const result = expandQuery("轮巡");
    expect(result).toContain("轮巡");
  });

  it("skips expansion terms already in query", () => {
    writeFileSync(TEST_ALIAS, JSON.stringify([
      { trigger: "轮巡", expansions: ["轮巡", "仓库", "patrol"] },
    ]));
    setAliasMapPath(TEST_ALIAS);

    const expanded = expandQuery("轮巡仓库");
    // "仓库" already in query, should not be duplicated
    const occurrences = expanded.split("仓库").length - 1;
    expect(occurrences).toBe(1);
  });

  it("respects MAX_EXPANSION_TERMS cap", () => {
    writeFileSync(TEST_ALIAS, JSON.stringify([
      {
        trigger: "测试",
        expansions: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      },
    ]));
    setAliasMapPath(TEST_ALIAS);

    const expanded = expandQuery("测试");
    // Built-in synonyms + alias expansions, but capped at MAX_EXPANSION_TERMS (5)
    const addedTerms = expanded.replace("测试", "").trim().split(/\s+/);
    expect(addedTerms.length).toBeLessThanOrEqual(5);
  });
});
