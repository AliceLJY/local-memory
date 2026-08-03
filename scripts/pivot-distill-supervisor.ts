#!/usr/bin/env bun

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type SupervisorMode = "sync-only" | "estimate" | "transport" | "full";
export type TaskTier = "required" | "recommended";

export interface SupervisedTask {
  label: string;
  tier: TaskTier;
  reason: string;
  processPatterns: readonly string[];
}

/**
 * The task inventory is the single source for launchctl mutations and orphan
 * probes. Keep policy in this data table; controller flow must not special-case
 * labels.
 */
export const SUPERVISED_TASKS: readonly SupervisedTask[] = [
  {
    label: "com.recallnest.incremental-ingest",
    tier: "required",
    reason: "writes RecallNest and can race the frozen-input window",
    processPatterns: ["[i]ncremental-ingest[.]sh", "[b]un.*src/cli[.]ts ingest"],
  },
  {
    label: "com.recallnest.pull-from-macbook",
    tier: "required",
    reason: "changes source inputs and can trigger ingest",
    processPatterns: ["[p]ull-from-macbook[.]sh"],
  },
  {
    label: "com.anxianjingya.agy-conversations-sync",
    tier: "required",
    reason: "changes derived AGY inputs and writes RecallNest",
    processPatterns: [
      "[a]gy-conversations-sync[.]sh",
      "[a]ntigravity-brain-to-jsonl[.]py",
      "[a]ntigravity-db-to-jsonl[.]py",
      "[c]li[.]ts import",
    ],
  },
  {
    label: "com.anxianjingya.macbook-mirror-pull",
    tier: "required",
    reason: "changes mirrored source inputs",
    processPatterns: ["[m]acbook-mirror-pull"],
  },
  {
    label: "com.anxianjingya.conversation-truth-refresh",
    tier: "required",
    reason: "rebuilds the Deja conversation link tree",
    processPatterns: ["[r]efresh-conversation-truth[.]py"],
  },
  {
    label: "com.recallnest.dream-consolidation",
    tier: "required",
    reason: "writes RecallNest and consumes the shared Qwen endpoint",
    processPatterns: ["[d]ream-consolidation", "[d]ream.*memory"],
  },
  {
    label: "com.recallnest.dream-memory-weekly",
    tier: "required",
    reason: "runs the dream-memory writer periodically",
    processPatterns: ["[d]ream-memory-weekly", "[d]ream.*memory"],
  },
  {
    label: "com.recallnest.weekly-distill",
    tier: "required",
    reason: "writes distilled RecallNest records",
    processPatterns: ["[w]eekly-distill", "[p]ivot-distill[.]ts"],
  },
  {
    label: "com.recallnest.daily-optimize",
    tier: "required",
    reason: "optimizes the live RecallNest database",
    processPatterns: ["[r]ecallnest-optimize[.]js"],
  },
  {
    label: "com.anxianjingya.repos-autopull",
    tier: "recommended",
    reason: "can change the executing checkout during a full run",
    processPatterns: ["[r]epos-autopull"],
  },
] as const;

interface ParsedOptions {
  mode: SupervisorMode | "recover";
  stateDir: string;
  resultJson?: string;
  allowExternalLlm: boolean;
  allowFullRun: boolean;
  command: string[];
}

interface PersistedTaskState {
  label: string;
  tier: TaskTier;
  reason: string;
  plistPath: string;
  wasLoaded: boolean;
  stopped: boolean;
}

interface PriorState {
  version: 1;
  mode: SupervisorMode;
  uid: number;
  pid: number;
  createdAt: string;
  status: "active" | "restored" | "restore-failed";
  tasks: PersistedTaskState[];
  restoredAt?: string;
  outcome?: string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ActiveCommand {
  child: ChildProcess;
  result: Promise<CommandResult>;
}

const STATE_FILE = "prior-state.json";

function usage(): string {
  return [
    "Usage:",
    "  bun scripts/pivot-distill-supervisor.ts --mode sync-only|estimate|transport|full \\",
    "    --state-dir <private-dir> [--result-json <estimate.json>] \\",
    "    [--allow-external-llm] [--allow-full-run] -- <command> [args...]",
    "  bun scripts/pivot-distill-supervisor.ts --recover --state-dir <private-dir>",
  ].join("\n");
}

export function parseSupervisorOptions(argv: string[]): ParsedOptions {
  let mode: ParsedOptions["mode"] | undefined;
  let stateDir: string | undefined;
  let resultJson: string | undefined;
  let allowExternalLlm = false;
  let allowFullRun = false;
  let command: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      command = argv.slice(index + 1);
      break;
    }
    if (arg === "--mode") {
      const value = argv[index + 1];
      if (!value || !["sync-only", "estimate", "transport", "full"].includes(value)) {
        throw new Error("--mode must be sync-only, estimate, transport, or full");
      }
      mode = value as SupervisorMode;
      index += 1;
      continue;
    }
    if (arg === "--recover") {
      mode = "recover";
      continue;
    }
    if (arg === "--state-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--state-dir requires a path");
      stateDir = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--result-json") {
      const value = argv[index + 1];
      if (!value) throw new Error("--result-json requires a path");
      resultJson = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--allow-external-llm") {
      allowExternalLlm = true;
      continue;
    }
    if (arg === "--allow-full-run") {
      allowFullRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    }
    throw new Error(`Unknown supervisor option: ${arg}`);
  }

  if (!mode) throw new Error("--mode or --recover is required");
  if (!stateDir) throw new Error("--state-dir is required");
  if (mode !== "recover" && command.length === 0) {
    throw new Error("A child command is required after --");
  }
  if (mode === "recover" && command.length > 0) {
    throw new Error("--recover does not accept a child command");
  }

  return { mode, stateDir, resultJson, allowExternalLlm, allowFullRun, command };
}

export function tasksForMode(mode: SupervisorMode): readonly SupervisedTask[] {
  return mode === "full"
    ? SUPERVISED_TASKS
    : SUPERVISED_TASKS.filter((task) => task.tier === "required");
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function runCaptured(command: string, args: string[]): ActiveCommand {
  const child = spawn(command, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const result = new Promise<CommandResult>((resolveResult) => {
    child.once("error", (error) => {
      stderr.push(Buffer.from(error.message));
    });
    child.once("close", (code, signal) => {
      resolveResult({
        code: signal ? 128 + signalNumber(signal) : (code ?? 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
  return { child, result };
}

function signalNumber(signal: NodeJS.Signals): number {
  if (signal === "SIGTERM") return 15;
  if (signal === "SIGINT") return 2;
  return 1;
}

async function commandResult(command: string, args: string[]): Promise<CommandResult> {
  return runCaptured(command, args).result;
}

function launchctlBinary(): string {
  return process.env.PIVOT_SUPERVISOR_LAUNCHCTL || "/bin/launchctl";
}

function pgrepBinary(): string {
  return process.env.PIVOT_SUPERVISOR_PGREP || "/usr/bin/pgrep";
}

function launchTarget(uid: number, label: string): string {
  return `gui/${uid}/${label}`;
}

function launchDomain(uid: number): string {
  return `gui/${uid}`;
}

function supervisorHome(): string {
  return process.env.PIVOT_SUPERVISOR_HOME || homedir();
}

function plistForTask(task: SupervisedTask): string {
  return join(supervisorHome(), "Library", "LaunchAgents", `${task.label}.plist`);
}

async function isLoaded(uid: number, task: SupervisedTask): Promise<boolean> {
  const result = await commandResult(launchctlBinary(), ["print", launchTarget(uid, task.label)]);
  if (result.code === 0) return true;
  const diagnostic = `${result.stdout}\n${result.stderr}`;
  if (result.code === 113 && /Could not find service/i.test(diagnostic)) return false;
  throw new Error(`launchctl print failed for ${task.label} (exit ${result.code})`);
}

async function savePriorState(
  mode: SupervisorMode,
  uid: number,
  selectedTasks: readonly SupervisedTask[],
  statePath: string,
): Promise<PriorState> {
  const tasks: PersistedTaskState[] = [];
  for (const task of selectedTasks) {
    tasks.push({
      label: task.label,
      tier: task.tier,
      reason: task.reason,
      plistPath: plistForTask(task),
      wasLoaded: await isLoaded(uid, task),
      stopped: false,
    });
  }
  const state: PriorState = {
    version: 1,
    mode,
    uid,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    status: "active",
    tasks,
  };
  // This durable write happens before the first bootout.
  writePrivateJson(statePath, state);
  return state;
}

function canonicalTasksFromState(state: PriorState): SupervisedTask[] {
  const inventory = new Map(SUPERVISED_TASKS.map((task) => [task.label, task]));
  const seen = new Set<string>();
  return state.tasks.map((saved) => {
    const task = inventory.get(saved.label);
    if (!task || seen.has(saved.label)) {
      throw new Error(`Recovery record contains an unknown or duplicate task: ${saved.label}`);
    }
    seen.add(saved.label);
    if (saved.tier !== task.tier || saved.reason !== task.reason || saved.plistPath !== plistForTask(task)) {
      throw new Error(`Recovery record metadata does not match the task inventory: ${saved.label}`);
    }
    return task;
  });
}

async function stopPriorLoaded(
  state: PriorState,
  selectedTasks: readonly SupervisedTask[],
  statePath: string,
  interrupted: () => boolean,
): Promise<void> {
  const byLabel = new Map(state.tasks.map((task) => [task.label, task]));
  for (const task of selectedTasks) {
    if (interrupted()) throw new Error("Controller interrupted while stopping tasks");
    const saved = byLabel.get(task.label);
    if (!saved?.wasLoaded) continue;
    const result = await commandResult(launchctlBinary(), [
      "bootout",
      launchTarget(state.uid, task.label),
    ]);
    if (result.code !== 0) {
      throw new Error(`launchctl bootout failed for ${task.label} (exit ${result.code})`);
    }
    if (await isLoaded(state.uid, task)) {
      throw new Error(`launchctl bootout did not unload ${task.label}`);
    }
    saved.stopped = true;
    writePrivateJson(statePath, state);
  }
}

async function assertNoOrphans(selectedTasks: readonly SupervisedTask[]): Promise<void> {
  const patterns = [...new Set(selectedTasks.flatMap((task) => task.processPatterns))];
  const found: string[] = [];
  for (const pattern of patterns) {
    // macOS pgrep uses -a for "include ancestors" (unlike procps pgrep).
    // The supervisor command line contains its child command, so -a would make
    // every real run match its own ancestor. -f alone is the full-argv match we need.
    const result = await commandResult(pgrepBinary(), ["-f", pattern]);
    if (result.code === 0 && result.stdout.trim()) {
      const matches = result.stdout.split("\n").filter((line) => line.trim().length > 0).length;
      found.push(`${pattern}: matched ${matches} process(es); command lines withheld`);
    } else if (result.code !== 0 && result.code !== 1) {
      throw new Error(`process probe failed for ${pattern} (exit ${result.code})`);
    }
  }
  if (found.length > 0) {
    throw new Error(`blocked: orphan process remains after bootout\n${found.join("\n")}`);
  }
}

function readState(statePath: string): PriorState {
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<PriorState>;
  if (parsed.version !== 1 || !parsed.mode || !Array.isArray(parsed.tasks) || !Number.isInteger(parsed.uid)) {
    throw new Error("Invalid prior-state recovery record");
  }
  const state = parsed as PriorState;
  canonicalTasksFromState(state);
  return state;
}

async function restorePriorState(state: PriorState, statePath: string, outcome: string): Promise<void> {
  const canonical = canonicalTasksFromState(state);
  const byLabel = new Map(state.tasks.map((task) => [task.label, task]));
  const failures: string[] = [];
  for (const task of canonical) {
    try {
      const saved = byLabel.get(task.label)!;
      const loadedNow = await isLoaded(state.uid, task);
      if (saved.wasLoaded) {
        if (!loadedNow) {
          const bootstrap = await commandResult(launchctlBinary(), [
            "bootstrap",
            launchDomain(state.uid),
            plistForTask(task),
          ]);
          if (bootstrap.code !== 0) {
            failures.push(`bootstrap ${task.label} exited ${bootstrap.code}`);
            continue;
          }
        }
        // A successful print is the required post-bootstrap verification.
        if (!await isLoaded(state.uid, task)) {
          failures.push(`print verification failed for ${task.label}`);
        }
      } else if (loadedNow) {
        failures.push(`prior absent task became loaded: ${task.label}`);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  state.outcome = outcome;
  state.restoredAt = new Date().toISOString();
  state.status = failures.length === 0 ? "restored" : "restore-failed";
  writePrivateJson(statePath, state);
  if (failures.length > 0) {
    throw new Error(`LaunchAgent restoration failed: ${failures.join("; ")}`);
  }
}

function nestedNumericField(value: unknown, field: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record[field] === "number" && Number.isFinite(record[field])) {
    return record[field];
  }
  for (const nested of Object.values(record)) {
    const found = nestedNumericField(nested, field);
    if (found !== undefined) return found;
  }
  return undefined;
}

function nestedFieldValue(value: unknown, field: string): unknown | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, field)) return record[field];
  for (const nested of Object.values(record)) {
    const found = nestedFieldValue(nested, field);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parseJsonCandidate(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        // Continue looking for a machine-readable summary line.
      }
    }
    return undefined;
  }
}

function verifyEstimate(resultJson: string | undefined, stdout: string): void {
  let parsed: unknown | undefined;
  if (resultJson) {
    try {
      parsed = JSON.parse(readFileSync(resultJson, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read estimate result JSON: ${(error as Error).message}`);
    }
  } else {
    parsed = parseJsonCandidate(stdout);
  }
  const failedSessions = nestedNumericField(parsed, "failedSessions");
  if (failedSessions === undefined) {
    throw new Error("Estimate result does not contain failedSessions");
  }
  if (failedSessions !== 0) {
    throw new Error(`Estimate reported failedSessions=${failedSessions}`);
  }
  const changedSessions = nestedNumericField(parsed, "changedSessions");
  if (changedSessions === undefined) {
    throw new Error("Estimate result does not contain changedSessions");
  }
  if (changedSessions !== 0) {
    throw new Error(`Estimate reported changedSessions=${changedSessions}`);
  }
  const frozenBundle = nestedFieldValue(parsed, "frozenBundle");
  if (!frozenBundle || typeof frozenBundle !== "object") {
    throw new Error("Estimate did not produce a complete frozenBundle");
  }
  const bundleRecord = frozenBundle as Record<string, unknown>;
  if (
    typeof bundleRecord.bundleHash !== "string" || !/^[0-9a-f]{64}$/.test(bundleRecord.bundleHash) ||
    typeof bundleRecord.requestProfileHash !== "string" || !/^[0-9a-f]{64}$/.test(bundleRecord.requestProfileHash)
  ) {
    throw new Error("Estimate frozenBundle is missing bundleHash/requestProfileHash");
  }
}

function assertAuthorization(options: ParsedOptions): void {
  if (options.mode === "transport" && !options.allowExternalLlm) {
    throw new Error("transport refused: --allow-external-llm is required");
  }
  if (options.mode === "full" && (!options.allowExternalLlm || !options.allowFullRun)) {
    throw new Error("full refused: --allow-external-llm and --allow-full-run are both required");
  }
}

async function executeChild(command: string[]): Promise<ActiveCommand> {
  const [executable, ...args] = command;
  const active = runCaptured(executable, args);
  active.child.stdout?.pipe(process.stdout);
  active.child.stderr?.pipe(process.stderr);
  return active;
}

async function recover(options: ParsedOptions): Promise<number> {
  privateDirectory(options.stateDir);
  const statePath = join(options.stateDir, STATE_FILE);
  const state = readState(statePath);
  await restorePriorState(state, statePath, "manual-recover");
  console.log(`Recovered prior LaunchAgent state from ${statePath}`);
  return 0;
}

export async function runSupervisor(options: ParsedOptions): Promise<number> {
  // Authorization is deliberately checked before state inspection or launchctl.
  assertAuthorization(options);
  if (options.mode === "recover") return recover(options);

  privateDirectory(options.stateDir);
  const statePath = join(options.stateDir, STATE_FILE);
  if (existsSync(statePath)) {
    const previous = readState(statePath);
    if (previous.status !== "restored") {
      throw new Error(`Unrecovered prior-state exists; run --recover first: ${statePath}`);
    }
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : Number(process.env.UID);
  if (!Number.isInteger(uid)) throw new Error("Cannot determine the current user id");
  const selectedTasks = tasksForMode(options.mode);
  let state: PriorState | undefined;
  let restoreStarted = false;
  let interrupted = false;
  let activeChild: ChildProcess | undefined;
  let outcome = "controller-failed";

  const onSigterm = (): void => {
    interrupted = true;
    activeChild?.kill("SIGTERM");
  };
  process.once("SIGTERM", onSigterm);

  const restoreOnce = async (): Promise<void> => {
    if (!state || restoreStarted) return;
    restoreStarted = true;
    await restorePriorState(state, statePath, outcome);
  };

  try {
    state = await savePriorState(options.mode, uid, selectedTasks, statePath);
    await stopPriorLoaded(state, selectedTasks, statePath, () => interrupted);
    if (interrupted) throw new Error("Controller interrupted before orphan probe");
    await assertNoOrphans(selectedTasks);
    if (interrupted) throw new Error("Controller interrupted before child command");

    const command = await executeChild(options.command);
    activeChild = command.child;
    if (interrupted) activeChild.kill("SIGTERM");
    const result = await command.result;
    activeChild = undefined;
    if (interrupted) {
      outcome = "sigterm";
      return 143;
    }
    if (result.code !== 0) {
      outcome = `child-exit-${result.code}`;
      throw new Error(`Controller child command failed (exit ${result.code})`);
    }
    if (options.mode === "estimate") verifyEstimate(options.resultJson, result.stdout);
    outcome = "success";
    return 0;
  } catch (error) {
    if (interrupted) {
      outcome = "sigterm";
      return 143;
    }
    console.error((error as Error).message);
    return 1;
  } finally {
    try {
      await restoreOnce();
    } catch (restoreError) {
      console.error((restoreError as Error).message);
      process.exitCode = 1;
    }
    process.removeListener("SIGTERM", onSigterm);
  }
}

async function main(): Promise<void> {
  try {
    const options = parseSupervisorOptions(process.argv.slice(2));
    const code = await runSupervisor(options);
    if (process.exitCode !== 1) process.exitCode = code;
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
