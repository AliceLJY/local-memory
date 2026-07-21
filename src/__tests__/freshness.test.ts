/**
 * Freshness 四态判定测试 —— 通用Wiki上下文记忆Agent方案借鉴落地（2026-07-21）。
 * 覆盖 file / git-rev 两类依赖的 exact/compatible/uncertain/invalid 四态，
 * 以及 opt-in 零回退（无 dependsOn → null）与共享缓存的 memoize。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFreshnessCache,
  evaluateDependency,
  evaluateEntryFreshness,
  evaluateFreshness,
  parseDependsOn,
  parseDependsOnInput,
  type Dependency,
} from "../freshness.js";

let tmp: string;
let filePath: string;
let fileMtime: string;
let notGitDir: string;
let gitRepo: string;
let gitHead: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rn-freshness-"));

  // 真实文件，供 kind='file' 用例
  filePath = join(tmp, "dep.txt");
  writeFileSync(filePath, "hello");
  fileMtime = String(Math.floor(statSync(filePath).mtimeMs));

  // 明确的非 git 目录（父级 tmpdir 也非 git），供 invalid 用例
  notGitDir = join(tmp, "notgit");
  mkdirSync(notGitDir, { recursive: true });

  // 真实 git 仓库，供 kind='git-rev' 用例
  gitRepo = join(tmp, "repo");
  mkdirSync(gitRepo, { recursive: true });
  const git = (args: string[]): void => {
    execFileSync("git", ["-C", gitRepo, ...args], { stdio: ["ignore", "pipe", "ignore"] });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(gitRepo, "f.txt"), "x");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  gitHead = execFileSync("git", ["-C", gitRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("parseDependsOn / parseDependsOnInput", () => {
  test("无 dependsOn 的 metadata → null（opt-in 零回退）", () => {
    expect(parseDependsOn(undefined)).toBeNull();
    expect(parseDependsOn("{}")).toBeNull();
    expect(parseDependsOn(JSON.stringify({ emotion: { valence: 0, arousal: 0 } }))).toBeNull();
  });

  test("非法 JSON / 非法结构 → null", () => {
    expect(parseDependsOn("{not json")).toBeNull();
    expect(parseDependsOn(JSON.stringify({ dependsOn: "nope" }))).toBeNull();
    expect(parseDependsOn(JSON.stringify({ dependsOn: [{ kind: "bogus", ref: "x" }] }))).toBeNull();
  });

  test("合法 dependsOn → 解析出数组", () => {
    const md = JSON.stringify({ dependsOn: [{ kind: "file", ref: "/a" }] });
    const deps = parseDependsOn(md);
    expect(deps).not.toBeNull();
    expect(deps?.length).toBe(1);
    expect(deps?.[0].kind).toBe("file");
  });

  test("parseDependsOnInput 校验原始输入", () => {
    expect(parseDependsOnInput(null)).toBeNull();
    expect(parseDependsOnInput([{ kind: "file", ref: "/a" }])?.length).toBe(1);
    expect(parseDependsOnInput([{ kind: "x", ref: "/a" }])).toBeNull();
    expect(parseDependsOnInput([])).toBeNull(); // min(1)
  });
});

describe("file 依赖四态", () => {
  const cache = createFreshnessCache();

  test("存在 + 无 expected → exact", () => {
    expect(evaluateDependency({ kind: "file", ref: filePath }, cache)).toBe("exact");
  });

  test("存在 + mtime 匹配 → exact", () => {
    expect(evaluateDependency({ kind: "file", ref: filePath, expected: fileMtime }, cache)).toBe("exact");
  });

  test("存在 + mtime 落在兼容集次值 → compatible", () => {
    expect(
      evaluateDependency({ kind: "file", ref: filePath, expected: ["9999999999999", fileMtime] }, cache),
    ).toBe("compatible");
  });

  test("存在 + mtime 不匹配 → uncertain", () => {
    expect(evaluateDependency({ kind: "file", ref: filePath, expected: "1" }, cache)).toBe("uncertain");
  });

  test("文件不存在 → invalid", () => {
    expect(evaluateDependency({ kind: "file", ref: join(tmp, "nope.txt") }, cache)).toBe("invalid");
  });
});

describe("git-rev 依赖四态", () => {
  const cache = createFreshnessCache();

  test("HEAD 匹配（完整 hash）→ exact", () => {
    expect(evaluateDependency({ kind: "git-rev", ref: gitRepo, expected: gitHead }, cache)).toBe("exact");
  });

  test("HEAD 匹配（短 hash 前缀）→ exact", () => {
    expect(evaluateDependency({ kind: "git-rev", ref: gitRepo, expected: gitHead.slice(0, 8) }, cache)).toBe("exact");
  });

  test("HEAD 落在兼容集次值 → compatible", () => {
    expect(
      evaluateDependency({ kind: "git-rev", ref: gitRepo, expected: ["deadbeefcafe1234", gitHead] }, cache),
    ).toBe("compatible");
  });

  test("HEAD 不匹配 → uncertain", () => {
    expect(evaluateDependency({ kind: "git-rev", ref: gitRepo, expected: "deadbeefcafe1234" }, cache)).toBe("uncertain");
  });

  test("仓库内文件 + 无 expected → exact（仅存在性）", () => {
    expect(evaluateDependency({ kind: "git-rev", ref: join(gitRepo, "f.txt") }, cache)).toBe("exact");
  });

  test("非 git 目录 → invalid", () => {
    expect(evaluateDependency({ kind: "git-rev", ref: notGitDir, expected: gitHead }, cache)).toBe("invalid");
  });
});

describe("evaluateFreshness 聚合 + evaluateEntryFreshness 入口", () => {
  test("多依赖取最差：exact + invalid → invalid", () => {
    const deps: Dependency[] = [
      { kind: "file", ref: filePath },
      { kind: "file", ref: join(tmp, "gone.txt") },
    ];
    expect(evaluateFreshness(deps)).toBe("invalid");
  });

  test("多依赖取最差：exact + compatible → compatible", () => {
    const deps: Dependency[] = [
      { kind: "file", ref: filePath },
      { kind: "git-rev", ref: gitRepo, expected: ["deadbeefcafe1234", gitHead] },
    ];
    expect(evaluateFreshness(deps)).toBe("compatible");
  });

  test("空依赖 → exact", () => {
    expect(evaluateFreshness([])).toBe("exact");
  });

  test("evaluateEntryFreshness: 无 dependsOn → null（零回退）", () => {
    expect(evaluateEntryFreshness(undefined)).toBeNull();
    expect(evaluateEntryFreshness("{}")).toBeNull();
  });

  test("evaluateEntryFreshness: 有 dependsOn → 对应四态", () => {
    const exactMd = JSON.stringify({ dependsOn: [{ kind: "file", ref: filePath, expected: fileMtime }] });
    expect(evaluateEntryFreshness(exactMd)).toBe("exact");
    const invalidMd = JSON.stringify({ dependsOn: [{ kind: "file", ref: join(tmp, "gone.txt") }] });
    expect(evaluateEntryFreshness(invalidMd)).toBe("invalid");
  });

  test("共享缓存 memoize：同一仓库多依赖只查一次 git", () => {
    const cache = createFreshnessCache();
    evaluateDependency({ kind: "git-rev", ref: gitRepo, expected: gitHead }, cache);
    expect(cache.size).toBe(1);
    // f.txt 位于 gitRepo 内，dirname=gitRepo，命中同一缓存键
    evaluateDependency({ kind: "git-rev", ref: join(gitRepo, "f.txt"), expected: gitHead }, cache);
    expect(cache.size).toBe(1);
  });
});
