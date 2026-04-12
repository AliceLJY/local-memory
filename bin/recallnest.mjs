#!/usr/bin/env node
/**
 * RecallNest CLI launcher — cross-runtime compatible
 *
 * Priority: bun (native TS, fastest) → node + tsx (fallback)
 */
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, "..", "src", "cli.ts");
const args = process.argv.slice(2);

function hasBun() {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(command, commandArgs) {
  const child = spawn(command, commandArgs, { stdio: "inherit" });
  child.on("close", (code) => process.exit(code || 0));
  child.on("error", (err) => {
    console.error(`Failed to start ${command}: ${err.message}`);
    process.exit(1);
  });
}

if (hasBun()) {
  // Native bun — fastest path
  run("bun", ["run", cli, ...args]);
} else {
  // Fallback: node + tsx
  const tsxBin = join(__dirname, "..", "node_modules", ".bin", "tsx");
  if (existsSync(tsxBin)) {
    run(tsxBin, [cli, ...args]);
  } else {
    // tsx not found in local node_modules, try global
    try {
      execFileSync("tsx", ["--version"], { stdio: "ignore" });
      run("tsx", [cli, ...args]);
    } catch {
      console.error(`
  RecallNest requires either Bun or tsx to run TypeScript.

  Option A (recommended):
    curl -fsSL https://bun.sh/install | bash

  Option B:
    npm install -g tsx

  Then retry your command.
`);
      process.exit(1);
    }
  }
}
