import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  SUPERVISED_TASKS,
  tasksForMode,
  type SupervisorMode,
} from "../../scripts/pivot-distill-supervisor.js";

const BUN = Bun.which("bun")!;
const REPO_ROOT = resolve(import.meta.dir, "../..");
const SUPERVISOR = join(REPO_ROOT, "scripts", "pivot-distill-supervisor.ts");
// Independent mirror of the supervisor rule: user-level labels are
// `com.<current user>.<task>` unless PIVOT_DISTILL_LAUNCHD_PREFIX overrides it.
const USER_PREFIX = process.env.PIVOT_DISTILL_LAUNCHD_PREFIX || `com.${userInfo().username}`;
const LOADED_LABELS = [
  "com.recallnest.incremental-ingest",
  "com.recallnest.pull-from-macbook",
] as const;
const PRIOR_ABSENT_LABEL = `${USER_PREFIX}.agy-conversations-sync`;

interface FakeHarness {
  root: string;
  stateDir: string;
  launchState: string;
  launchLog: string;
  probeLog: string;
  childMarker: string;
  launchctl: string;
  pgrep: string;
  childScript: string;
  env: NodeJS.ProcessEnv;
}

function executable(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fakeHarness(loaded: readonly string[] = LOADED_LABELS): FakeHarness {
  const root = mkdtempSync(join(tmpdir(), "pivot-supervisor-"));
  const stateDir = join(root, "controller");
  const launchState = join(root, "launch-state.json");
  const launchLog = join(root, "launchctl.log");
  const probeLog = join(root, "pgrep.log");
  const childMarker = join(root, "child-started");
  const launchctl = join(root, "fake-launchctl.ts");
  const pgrep = join(root, "fake-pgrep.ts");
  const childScript = join(root, "fake-child.ts");
  writeFileSync(launchState, JSON.stringify([...loaded]));

  executable(launchctl, `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const statePath = process.env.FAKE_LAUNCH_STATE!;
const logPath = process.env.FAKE_LAUNCH_LOG!;
const [operation, ...args] = process.argv.slice(2);
let loaded = JSON.parse(readFileSync(statePath, "utf8")) as string[];
const targetLabel = (target: string | undefined): string => (target || "").split("/").at(-1) || "";
let label = operation === "bootstrap"
  ? basename(args[1] || "", ".plist")
  : targetLabel(args[0]);
appendFileSync(logPath, operation + "\\t" + label + "\\n");
if (operation === "print") {
  if (process.env.FAKE_PRINT_ERROR_LABEL === label) process.exit(64);
  if (
    process.env.FAKE_PRINT_ERROR_AFTER_BOOTSTRAP_LABEL === label &&
    readFileSync(logPath, "utf8").includes("bootstrap\\t" + label + "\\n")
  ) process.exit(65);
  if (loaded.includes(label)) process.exit(0);
  console.error('Could not find service "' + label + '" in domain for user gui: 501');
  process.exit(113);
}
if (operation === "bootout") {
  if (!loaded.includes(label)) process.exit(3);
  loaded = loaded.filter((entry) => entry !== label);
  writeFileSync(statePath, JSON.stringify(loaded));
  process.exit(0);
}
if (operation === "bootstrap") {
  if (!loaded.includes(label)) loaded.push(label);
  writeFileSync(statePath, JSON.stringify(loaded));
  process.exit(0);
}
process.exit(64);
`);

  executable(pgrep, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "-f") process.exit(64);
const pattern = args[1] || "";
appendFileSync(process.env.FAKE_PROBE_LOG!, args.join("\\t") + "\\n");
if (process.env.FAKE_ORPHAN === "1") {
  console.log("4321 orphan-for-" + pattern);
  process.exit(0);
}
process.exit(1);
`);

  executable(childScript, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const [behavior, argument] = process.argv.slice(2);
writeFileSync(process.env.FAKE_CHILD_MARKER!, behavior || "unknown");
if (behavior === "estimate") {
  const fakeHash = process.env.FAKE_EMPTY_HASHES === "1" ? "" : "b".repeat(64);
  const summary = {
    failedSessions: Number(process.env.FAKE_FAILED_SESSIONS || 0),
    changedSessions: Number(process.env.FAKE_CHANGED_SESSIONS || 0),
    frozenBundle: { bundleHash: fakeHash, requestProfileHash: fakeHash },
  };
  writeFileSync(argument, JSON.stringify({ summary }));
  console.log(JSON.stringify(summary));
  process.exit(0);
}
if (behavior === "fail") process.exit(Number(argument || 7));
if (behavior === "wait") setInterval(() => {}, 1_000);
console.log(JSON.stringify({ ok: true }));
`);

  const home = join(root, "home");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIVOT_SUPERVISOR_HOME: home,
    PIVOT_SUPERVISOR_LAUNCHCTL: launchctl,
    PIVOT_SUPERVISOR_PGREP: pgrep,
    FAKE_LAUNCH_STATE: launchState,
    FAKE_LAUNCH_LOG: launchLog,
    FAKE_PROBE_LOG: probeLog,
    FAKE_CHILD_MARKER: childMarker,
  };
  return {
    root,
    stateDir,
    launchState,
    launchLog,
    probeLog,
    childMarker,
    launchctl,
    pgrep,
    childScript,
    env,
  };
}

function supervisorArgs(
  harness: FakeHarness,
  mode: SupervisorMode,
  childArgs: string[],
  supervisorFlags: string[] = [],
): string[] {
  return [
    SUPERVISOR,
    "--mode",
    mode,
    "--state-dir",
    harness.stateDir,
    ...supervisorFlags,
    "--",
    BUN,
    harness.childScript,
    ...childArgs,
  ];
}

function run(
  harness: FakeHarness,
  mode: SupervisorMode,
  childArgs: string[],
  supervisorFlags: string[] = [],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync(BUN, supervisorArgs(harness, mode, childArgs, supervisorFlags), {
    env: { ...harness.env, ...extraEnv },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function launchLogLines(harness: FakeHarness): string[] {
  if (!existsSync(harness.launchLog)) return [];
  return readFileSync(harness.launchLog, "utf8").trim().split("\n").filter(Boolean);
}

function loadedAfter(harness: FakeHarness): string[] {
  return JSON.parse(readFileSync(harness.launchState, "utf8")) as string[];
}

function expectRestored(harness: FakeHarness): void {
  const lines = launchLogLines(harness);
  for (const label of LOADED_LABELS) {
    const bootout = lines.indexOf(`bootout\t${label}`);
    const bootstrap = lines.indexOf(`bootstrap\t${label}`);
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeGreaterThan(bootout);
    expect(lines.slice(bootstrap + 1)).toContain(`print\t${label}`);
  }
  expect(lines).not.toContain(`bootstrap\t${PRIOR_ABSENT_LABEL}`);
  expect(loadedAfter(harness).sort()).toEqual([...LOADED_LABELS].sort());
  const statePath = join(harness.stateDir, "prior-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { status: string };
  expect(state.status).toBe("restored");
  expect(statSync(harness.stateDir).mode & 0o777).toBe(0o700);
  expect(statSync(statePath).mode & 0o777).toBe(0o600);
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(20);
  }
}

describe("pivot distill LaunchAgent supervisor policy", () => {
  it("derives all task selection from the exact ten-item inventory", () => {
    expect(SUPERVISED_TASKS.map((task) => [task.label, task.tier])).toEqual([
      ["com.recallnest.incremental-ingest", "required"],
      ["com.recallnest.pull-from-macbook", "required"],
      [`${USER_PREFIX}.agy-conversations-sync`, "required"],
      [`${USER_PREFIX}.macbook-mirror-pull`, "required"],
      [`${USER_PREFIX}.conversation-truth-refresh`, "required"],
      ["com.recallnest.dream-consolidation", "required"],
      ["com.recallnest.dream-memory-weekly", "required"],
      ["com.recallnest.weekly-distill", "required"],
      ["com.recallnest.daily-optimize", "required"],
      [`${USER_PREFIX}.repos-autopull`, "recommended"],
    ]);
    expect(SUPERVISED_TASKS.every((task) => task.reason.length > 0 && task.processPatterns.length > 0)).toBe(true);
    expect(SUPERVISED_TASKS.flatMap((task) => task.processPatterns)).toEqual(expect.arrayContaining([
      "[a]gy-conversations-sync[.]sh",
      "[a]ntigravity-brain-to-jsonl[.]py",
      "[a]ntigravity-db-to-jsonl[.]py",
      "[c]li[.]ts import",
      "[r]efresh-conversation-truth[.]py",
      "[r]ecallnest-optimize[.]js",
    ]));
    expect(tasksForMode("sync-only")).toHaveLength(9);
    expect(tasksForMode("estimate")).toHaveLength(9);
    expect(tasksForMode("transport")).toHaveLength(9);
    expect(tasksForMode("full")).toHaveLength(10);
  });

  it("treats failedSessions in an exit-zero estimate as failure and restores prior state", () => {
    const harness = fakeHarness();
    const resultJson = join(harness.root, "estimate.json");
    const result = run(
      harness,
      "estimate",
      ["estimate", resultJson],
      ["--result-json", resultJson],
      { FAKE_FAILED_SESSIONS: "2" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failedSessions=2");
    expectRestored(harness);
  });

  it("treats changedSessions in an exit-zero estimate as failure and restores prior state", () => {
    const harness = fakeHarness();
    const resultJson = join(harness.root, "estimate.json");
    const result = run(
      harness,
      "estimate",
      ["estimate", resultJson],
      ["--result-json", resultJson],
      { FAKE_CHANGED_SESSIONS: "1" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("changedSessions=1");
    expectRestored(harness);
  });

  it("rejects negative counters and empty hashes in an exit-zero estimate", () => {
    const negative = fakeHarness();
    const negativeJson = join(negative.root, "estimate.json");
    const negativeResult = run(
      negative,
      "estimate",
      ["estimate", negativeJson],
      ["--result-json", negativeJson],
      { FAKE_FAILED_SESSIONS: "-1" },
    );
    expect(negativeResult.status).toBe(1);
    expect(negativeResult.stderr).toContain("failedSessions=-1");
    expectRestored(negative);

    const emptyHash = fakeHarness();
    const emptyHashJson = join(emptyHash.root, "estimate.json");
    const emptyHashResult = run(
      emptyHash,
      "estimate",
      ["estimate", emptyHashJson],
      ["--result-json", emptyHashJson],
      { FAKE_EMPTY_HASHES: "1" },
    );
    expect(emptyHashResult.status).toBe(1);
    expect(emptyHashResult.stderr).toContain("missing bundleHash/requestProfileHash");
    expectRestored(emptyHash);
  });

  it("accepts only a zero-failure estimate with a frozen bundle, then restores prior state", () => {
    const harness = fakeHarness();
    const resultJson = join(harness.root, "estimate.json");
    const result = run(
      harness,
      "estimate",
      ["estimate", resultJson],
      ["--result-json", resultJson],
    );
    expect(result.status).toBe(0);
    expectRestored(harness);
  });

  it("restores after an authorized transport child fails", () => {
    const harness = fakeHarness();
    const result = run(harness, "transport", ["fail", "7"], ["--allow-external-llm"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("child command failed (exit 7)");
    expectRestored(harness);
  });

  it("runs full with both authorizations, includes recommended tasks, and restores", () => {
    const harness = fakeHarness();
    const result = run(
      harness,
      "full",
      ["ok"],
      ["--allow-external-llm", "--allow-full-run"],
    );
    expect(result.status).toBe(0);
    expect(launchLogLines(harness)).toContain(`print\t${USER_PREFIX}.repos-autopull`);
    expect(readFileSync(harness.probeLog, "utf8")).toContain("-f\t[r]epos-autopull");
    expectRestored(harness);
  });

  it("honors PIVOT_DISTILL_LAUNCHD_PREFIX for user-level labels", () => {
    const harness = fakeHarness();
    const result = run(
      harness,
      "full",
      ["ok"],
      ["--allow-external-llm", "--allow-full-run"],
      { PIVOT_DISTILL_LAUNCHD_PREFIX: "com.example" },
    );
    expect(result.status).toBe(0);
    expect(launchLogLines(harness)).toContain("print\tcom.example.repos-autopull");
    expect(launchLogLines(harness)).toContain("print\tcom.example.agy-conversations-sync");
    expectRestored(harness);
  });

  it("terminates the child, restores, and exits 143 on SIGTERM", async () => {
    const harness = fakeHarness();
    const child = spawn(BUN, supervisorArgs(harness, "sync-only", ["wait"]), {
      env: harness.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForFile(harness.childMarker);
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
    expect(exitCode).toBe(143);
    expectRestored(harness);
  });

  it("refuses missing transport authorization before any launchctl call", () => {
    const harness = fakeHarness();
    const result = run(harness, "transport", ["ok"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("transport refused");
    expect(launchLogLines(harness)).toEqual([]);
    expect(existsSync(harness.stateDir)).toBe(false);
  });

  it("fails closed on an operational launchctl print error before any mutation", () => {
    const harness = fakeHarness();
    const result = run(harness, "sync-only", ["ok"], [], {
      FAKE_PRINT_ERROR_LABEL: `${USER_PREFIX}.agy-conversations-sync`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`launchctl print failed for ${USER_PREFIX}.agy-conversations-sync (exit 64)`);
    expect(launchLogLines(harness).some((line) => line.startsWith("bootout\t"))).toBe(false);
    expect(launchLogLines(harness).some((line) => line.startsWith("bootstrap\t"))).toBe(false);
    expect(existsSync(harness.childMarker)).toBe(false);
  });

  it("continues restoring later tasks when one post-bootstrap print fails", () => {
    const harness = fakeHarness();
    const first = LOADED_LABELS[0];
    const result = run(harness, "sync-only", ["ok"], [], {
      FAKE_PRINT_ERROR_AFTER_BOOTSTRAP_LABEL: first,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`launchctl print failed for ${first} (exit 65)`);
    for (const label of LOADED_LABELS.slice(1)) {
      expect(launchLogLines(harness)).toContain(`bootstrap\t${label}`);
    }
    expect(loadedAfter(harness).sort()).toEqual([...LOADED_LABELS].sort());
    const state = JSON.parse(
      readFileSync(join(harness.stateDir, "prior-state.json"), "utf8"),
    ) as { status: string };
    expect(state.status).toBe("restore-failed");
  });

  it("blocks on an orphan process without killing it, then restores", () => {
    const harness = fakeHarness();
    const result = run(harness, "sync-only", ["ok"], [], { FAKE_ORPHAN: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("blocked: orphan process remains");
    expect(existsSync(harness.childMarker)).toBe(false);
    expectRestored(harness);
  });

  it("does not overwrite an unrecovered prior-state record", () => {
    const harness = fakeHarness();
    const first = run(harness, "sync-only", ["fail", "9"]);
    expect(first.status).toBe(1);
    const statePath = join(harness.stateDir, "prior-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    state.status = "active";
    state.outcome = "simulated-crash";
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(harness.launchLog, "");

    const second = run(harness, "sync-only", ["ok"]);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("run --recover first");
    expect(launchLogLines(harness)).toEqual([]);
    const preserved = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    expect(preserved.outcome).toBe("simulated-crash");
  });

  it("--recover restores only prior-loaded tasks and keeps prior-absent tasks absent", () => {
    const harness = fakeHarness();
    const first = run(harness, "sync-only", ["fail", "9"]);
    expect(first.status).toBe(1);
    const statePath = join(harness.stateDir, "prior-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    state.status = "active";
    delete state.restoredAt;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(harness.launchState, "[]");
    writeFileSync(harness.launchLog, "");

    const recovered = spawnSync(BUN, [
      SUPERVISOR,
      "--recover",
      "--state-dir",
      harness.stateDir,
    ], {
      env: harness.env,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(recovered.status).toBe(0);
    const lines = launchLogLines(harness);
    expect(lines.some((line) => line.startsWith("bootout\t"))).toBe(false);
    for (const label of LOADED_LABELS) {
      const bootstrap = lines.indexOf(`bootstrap\t${label}`);
      expect(bootstrap).toBeGreaterThanOrEqual(0);
      expect(lines.slice(bootstrap + 1)).toContain(`print\t${label}`);
    }
    expect(lines).not.toContain(`bootstrap\t${PRIOR_ABSENT_LABEL}`);
    expect(loadedAfter(harness).sort()).toEqual([...LOADED_LABELS].sort());
  });
});
