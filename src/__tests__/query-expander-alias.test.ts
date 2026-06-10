import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { expandQuery, setAliasMapPath, resetAliasMapCache, upsertUserAlias, removeUserAlias, listUserAliases, explainUserAliases } from "../query-expander.js";
import { expandQueryWithAliases, ALIAS_QUERY_MAX_LENGTH } from "../aliases.js";
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

describe("manage_alias backend (P1-B)", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    cleanup();
    setAliasMapPath(TEST_ALIAS);
    resetAliasMapCache();
  });
  afterEach(() => {
    cleanup();
    resetAliasMapCache();
  });

  it("upserts, lists, expands, and removes a user alias", () => {
    const added = upsertUserAlias("我的桥", ["telegram-ai-bridge", "tg-bridge-channel"]);
    expect(added.ok).toBe(true);
    expect(listUserAliases()).toHaveLength(1);

    // 写完即生效(缓存失效),BM25 通道扩展可见
    const expanded = expandQuery("我的桥怎么挂了");
    expect(expanded).toContain("telegram-ai-bridge");

    // update 路径
    const updated = upsertUserAlias("我的桥", ["telegram-ai-bridge"]);
    expect(updated.ok && updated.action === "updated").toBe(true);
    expect(listUserAliases()[0].expansions).toEqual(["telegram-ai-bridge"]);

    expect(explainUserAliases("我的桥呢")).toHaveLength(1);
    expect(removeUserAlias("我的桥")).toBe(true);
    expect(removeUserAlias("我的桥")).toBe(false);
    expect(listUserAliases()).toHaveLength(0);
  });

  it("rejects invalid rules with reasons", () => {
    const tooShort = upsertUserAlias("桥", ["x-bridge"]);
    expect(tooShort.ok).toBe(false);

    const tooMany = upsertUserAlias("我的桥", ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]);
    expect(tooMany.ok).toBe(false);

    const selfRef = upsertUserAlias("我的桥", ["我的桥"]);
    expect(selfRef.ok).toBe(false);

    const empty = upsertUserAlias("我的桥", ["  "]);
    expect(empty.ok).toBe(false);
  });
});

describe("expandQueryWithAliases length gate (P1-B)", () => {
  it("skips expansion for queries beyond ALIAS_QUERY_MAX_LENGTH", () => {
    const longQuery = "我的记忆项目".padEnd(ALIAS_QUERY_MAX_LENGTH + 10, "字");
    expect(expandQueryWithAliases(longQuery)).toBe(longQuery);
    // 短 query 照常扩展
    expect(expandQueryWithAliases("我的记忆项目")).toContain("recallnest");
  });
});
