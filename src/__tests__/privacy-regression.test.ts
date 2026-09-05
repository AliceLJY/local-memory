import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Guards the public repository against machine-local and internal identifiers
// re-entering it (a username, launchd labels, bridge instance names, a retired
// org name, macOS home paths). Needles are assembled from fragments so this file
// never matches itself; the scan covers exactly the tracked files a reader of the
// repository or of the npm tarball can see.
const REPO_ROOT = resolve(import.meta.dir, "../..");
const SCAN_PREFIXES = ["src/", "scripts/", "eval/", "bin/"];
const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|lockb)$/i;

const NEEDLES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "local username", pattern: new RegExp(["anxian", "jingya"].join(""), "i") },
  { name: "personal launchd label", pattern: new RegExp(["com\\.", "anxian", "jingya"].join("")) },
  { name: "bridge instance name", pattern: new RegExp(["mc", "code", "|", "mc", "odex", "|", "ma", "gy"].join("")) },
  { name: "retired org name", pattern: new RegExp(["tri", "hippo"].join(""), "i") },
];

// Any macOS home path is a leak unless the account segment is an obvious placeholder.
const HOME_PATH = new RegExp(["\\/", "Users", "\\/([^\\/\\s\"'`)\\]]*)"].join(""), "g");
const HOME_PLACEHOLDERS = new Set(["x", "xx", "xxx", "you", "user", "username", "<user>", "<username>", "$USER", "${USER}"]);

function trackedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed (exit ${result.status}): ${result.stderr}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

function inScope(path: string): boolean {
  if (BINARY_EXTENSIONS.test(path)) return false;
  if (SCAN_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (!path.includes("/") && path.endsWith(".md")) return true; // root-level docs
  return path.startsWith("data/") && path.includes(".example."); // shipped example data only
}

describe("privacy regression", () => {
  const files = trackedFiles().filter(inScope);

  it("scans the locations that leaked before", () => {
    expect(files.length).toBeGreaterThan(100);
    for (const expected of [
      "eval/ghost-scan.ts",
      "scripts/pivot-distill-supervisor.ts",
      "src/__tests__/pivot-distill-supervisor.test.ts",
      "data/alias-map.example.json",
      "CLAUDE.md",
      "README.md",
    ]) {
      expect(files).toContain(expected);
    }
  });

  it("contains no machine-local or internal identifiers", () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(resolve(REPO_ROOT, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const { name, pattern } of NEEDLES) {
          if (pattern.test(line)) violations.push(`${file}:${index + 1}: ${name}`);
        }
        for (const match of line.matchAll(HOME_PATH)) {
          if (!HOME_PLACEHOLDERS.has(match[1])) violations.push(`${file}:${index + 1}: home path ${match[0]}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
