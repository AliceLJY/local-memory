import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";

import { resolveDbPath, resolveDataDir, type LocalMemoryConfig } from "../runtime-config.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");

function cfg(dbPath: string): LocalMemoryConfig {
  return {
    dbPath,
    embedding: { provider: "jina", apiKey: "x", model: "m" },
    sources: {},
  };
}

/**
 * Regression guard for the 2026-07-19 audit finding: maintenance scripts each
 * resolved the database on their own — some hardcoded "./data/lancedb", others
 * read `config.database?.path`, a key that does not exist in LocalMemoryConfig
 * and therefore always fell through to the hardcoded default. A health check or
 * cleanup could then report on an empty directory while the server used a
 * different database entirely.
 */
describe("resolveDbPath", () => {
  it("resolves a relative dbPath against the repo root, not process.cwd()", () => {
    expect(resolveDbPath(cfg("./data/lancedb"))).toBe(resolve(REPO_ROOT, "data/lancedb"));
    expect(resolveDbPath(cfg("data/lancedb"))).toBe(resolve(REPO_ROOT, "data/lancedb"));
  });

  it("expands a leading ~/ to the home directory", () => {
    expect(resolveDbPath(cfg("~/.recallnest/data/lancedb"))).toBe(
      resolve(homedir(), ".recallnest/data/lancedb")
    );
  });

  it("keeps an absolute dbPath unchanged", () => {
    expect(resolveDbPath(cfg("/tmp/rn-abs/lancedb"))).toBe("/tmp/rn-abs/lancedb");
  });

  it("always returns an absolute path", () => {
    for (const p of ["./data/lancedb", "data/lancedb", "~/x/lancedb", "/tmp/y"]) {
      expect(resolveDbPath(cfg(p)).startsWith("/")).toBe(true);
    }
  });

  it("puts the sidecar data dir directly beside the database", () => {
    expect(resolveDataDir(cfg("~/.recallnest/data/lancedb"))).toBe(
      resolve(homedir(), ".recallnest/data")
    );
    expect(resolveDataDir(cfg("./data/lancedb"))).toBe(resolve(REPO_ROOT, "data"));
  });
});

describe("scripts resolve the database through runtime-config", () => {
  it("no script hardcodes a lancedb path", () => {
    const dir = resolve(REPO_ROOT, "scripts");
    const offenders: string[] = [];

    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const src = readFileSync(resolve(dir, name), "utf-8");
      for (const [i, line] of src.split("\n").entries()) {
        const code = line.split("//")[0];
        if (/^\s*\*/.test(line)) continue; // block-comment body
        if (/["'`][^"'`]*data\/lancedb[^"'`]*["'`]/.test(code)) {
          offenders.push(`${name}:${i + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("no src file re-implements dbPath resolution instead of calling resolveDbPath", () => {
    // cli.ts once duplicated the resolve() expression for its destructive
    // "clear index" path, and doctor.ts resolved against process.cwd() — so the
    // health check could report on a different directory than the server used.
    const dir = resolve(REPO_ROOT, "src");
    const offenders: string[] = [];

    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        const full = resolve(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name === "runtime-config.ts") continue;
        const src = readFileSync(full, "utf-8");
        for (const [i, line] of src.split("\n").entries()) {
          if (/expandHome\(\s*\w+\.dbPath\s*\)/.test(line)) {
            offenders.push(`${entry.name}:${i + 1}`);
          }
        }
      }
    };
    walk(dir);

    expect(offenders).toEqual([]);
  });

  it("no script reads the non-existent config.database key", () => {
    const dir = resolve(REPO_ROOT, "scripts");
    const offenders: string[] = [];

    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const src = readFileSync(resolve(dir, name), "utf-8");
      if (/config\.database\b/.test(src)) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });
});
