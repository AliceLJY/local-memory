import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture guard for the invariant env-config.ts declares in its own header:
 * it is the single source of truth for every fixed `RECALLNEST_*` env read, and
 * consumers must call its accessors instead of touching `process.env` directly.
 *
 * That invariant was documented but unenforced, and it had already sprung a leak:
 * `cli.ts` read RECALLNEST_DREAM_BUDGET_MS inline and — precisely because it
 * bypassed the accessor layer — was the one read in the repo with no
 * `Number.isFinite` guard, so `""` silently became a 0ms dream budget and any
 * non-numeric value became a NaN deadline that disabled the guard entirely.
 * Bypassing the chokepoint IS how the guard gets lost; hence a test, not a note.
 *
 * Baseline: 0 violations as of 2026-08-18. If this goes red, the fix is normally
 * to add an accessor to env-config.ts — not to widen EXEMPT.
 *
 * Deliberately NOT matched (these are the exemptions env-config.ts's header
 * already names, and each reads differently so the pattern never sees them):
 *   - scope-policy.ts   → `env.RECALLNEST_*` on an injected env object
 *   - store.ts          → RECALLNEST_NS is a local constant, not an env var
 *   - runtime-config / embedder / llm-client → dynamic `process.env[name]`
 *     config-template expansion, which cannot be statically consolidated
 */

// Add a file here ONLY with a reason, and only when an accessor genuinely can't
// work (e.g. the read must happen before env-config's module-init boundary).
const EXEMPT: ReadonlyArray<{ file: string; why: string }> = [];

const DIRECT_READ = /process\.env\.RECALLNEST_[A-Z_0-9]+/g;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry === "env-config.ts") continue;
    out.push(full);
  }
  return out;
}

describe("env-config is the chokepoint for RECALLNEST_* reads", () => {
  it("no src/ module reads process.env.RECALLNEST_* directly", () => {
    const exemptFiles = new Set(EXEMPT.map((e) => e.file));
    const violations: string[] = [];

    for (const file of collectSourceFiles("src")) {
      if (exemptFiles.has(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const hit of line.match(DIRECT_READ) ?? []) {
          violations.push(`${file}:${i + 1}  ${hit}`);
        }
      });
    }

    expect(
      violations,
      violations.length === 0
        ? ""
        : `Direct RECALLNEST_* env reads bypass env-config.ts's guards:\n  ${violations.join("\n  ")}\n` +
          `Fix: add an accessor to src/env-config.ts (with its parsing + fallback) and call it here.`,
    ).toEqual([]);
  });

  it("guard actually detects a violation (so a green run means something)", () => {
    const synthetic = 'const x = Number(process.env.RECALLNEST_SOMETHING_NEW ?? 1);';
    expect(synthetic.match(DIRECT_READ)).toHaveLength(1);
    // And it must not fire on the exempted read styles:
    expect('env.RECALLNEST_SESSION_ID'.match(DIRECT_READ)).toBeNull();
    expect('process.env[envVar]'.match(DIRECT_READ)).toBeNull();
    expect('const RECALLNEST_NS = "recallnest:v1";'.match(DIRECT_READ)).toBeNull();
  });
});
