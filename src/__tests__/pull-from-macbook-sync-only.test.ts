import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SCRIPT = join(REPO_ROOT, "scripts", "pull-from-macbook.sh");
const TEST_TIMEOUT_MS = 30_000;

interface Harness {
  root: string;
  home: string;
  remoteHome: string;
  report: string;
  rsyncLog: string;
  sshLog: string;
  registrarMarker: string;
  ingestMarker: string;
  env: NodeJS.ProcessEnv;
}

interface RsyncCall {
  args: string[];
  sourceArg: string;
  targetArg: string;
  dryRun: boolean;
  ignoreTimes: boolean;
}

function executable(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixture(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fakeRsyncSource(): string {
  return [
    "#!/usr/bin/env bun",
    'import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";',
    'import { basename, dirname, extname, join, relative, sep } from "node:path";',
    'const args = process.argv.slice(2);',
    'const sourceArg = args.at(-2) || "";',
    'const targetArg = args.at(-1) || "";',
    'const dryRun = args.includes("--dry-run");',
    'const ignoreTimes = args.includes("--ignore-times");',
    'const optionValues = new Set(["-e", "--exclude", "--include", "--out-format", "--rsync-path", "--timeout"]);',
    'for (let index = 0; index < args.length - 2; index += 1) {',
    '  const arg = args[index];',
    '  if (optionValues.has(arg)) { if (index + 1 >= args.length - 2) process.exit(64); index += 1; continue; }',
    '  if (!arg.startsWith("-")) process.exit(64);',
    '}',
    'appendFileSync(process.env.FAKE_RSYNC_LOG, JSON.stringify({ args: args.slice(0, -2), sourceArg, targetArg, dryRun, ignoreTimes }) + "\\n");',
    'if (!dryRun && process.env.FAKE_CREATE_REPORT_DURING_SYNC && !existsSync(process.env.FAKE_CREATE_REPORT_DURING_SYNC)) writeFileSync(process.env.FAKE_CREATE_REPORT_DURING_SYNC, "racing-writer");',
    'if (!dryRun && process.env.FAKE_BREAK_MAPPING_TMP) {',
    '  const report = process.env.FAKE_BREAK_MAPPING_TMP;',
    '  const prefix = basename(report) + ".tmp.";',
    '  const temporary = readdirSync(dirname(report))',
    '    .filter((name) => name.startsWith(prefix) && !name.endsWith(".saved"))',
    '    .map((name) => join(dirname(report), name))',
    '    .find((path) => statSync(path).isFile());',
    '  if (temporary) { renameSync(temporary, temporary + ".saved"); mkdirSync(temporary); }',
    '}',
    'if (!sourceArg.startsWith("mac:")) process.exit(64);',
    'const remoteHome = process.env.FAKE_REMOTE_HOME;',
    'let remoteRaw = sourceArg.slice(4);',
    'let sourcePath = remoteRaw;',
    'if (remoteRaw === "~") sourcePath = remoteHome;',
    'else if (remoteRaw.startsWith("~/")) sourcePath = join(remoteHome, remoteRaw.slice(2));',
    'else if (!remoteRaw.startsWith("/")) sourcePath = join(remoteHome, remoteRaw);',
    'if (!existsSync(sourcePath)) process.exit(23);',
    'function walk(root) {',
    '  const files = [];',
    '  for (const entry of readdirSync(root, { withFileTypes: true })) {',
    '    const path = join(root, entry.name);',
    '    if (entry.isDirectory()) files.push(...walk(path));',
    '    else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);',
    '  }',
    '  return files.sort();',
    '}',
    'function included(path) {',
    '  const normalizedSource = sourcePath.split(sep).join("/");',
    '  const name = basename(path);',
    '  if (statSync(sourcePath).isFile()) return true;',
    '  if (normalizedSource.includes("/.gemini/tmp")) return name.startsWith("session-") && extname(name) === ".json";',
    '  if (normalizedSource.includes("/local-agent-mode-sessions")) return extname(name) === ".jsonl" && name !== "audit.jsonl";',
    '  if (normalizedSource.includes("/antigravity-cli/brain")) return name === "transcript_full.jsonl";',
    '  if (normalizedSource.includes("/antigravity-rescue/conversations")) return extname(name) === ".pb";',
    '  return extname(name) === ".jsonl";',
    '}',
    'const sourceIsDirectory = statSync(sourcePath).isDirectory();',
    'const files = (sourceIsDirectory ? walk(sourcePath) : [sourcePath]).filter(included);',
    'if (dryRun && !ignoreTimes && process.env.FAKE_RSYNC_MUTATE_ON_VERIFY_SOURCE && sourceArg.includes(process.env.FAKE_RSYNC_MUTATE_ON_VERIFY_SOURCE) && files.length > 0) appendFileSync(files[0], "late-change");',
    'const prefix = args.some((arg) => arg.includes("__RN_MAP__")) ? "__RN_MAP__" : "__RN_CHANGE__";',
    'function copySource(source, destination) {',
    '  mkdirSync(dirname(destination), { recursive: true });',
    '  if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), destination);',
    '  else copyFileSync(source, destination);',
    '}',
    'const forcedFailure = Boolean(process.env.FAKE_RSYNC_FAIL_SOURCE && sourceArg.includes(process.env.FAKE_RSYNC_FAIL_SOURCE));',
    'if (!dryRun && forcedFailure && files.length > 0) {',
    '  const source = files[0];',
    '  const rel = sourceIsDirectory ? relative(sourcePath, source).split(sep).join("/") : basename(source);',
    '  const destination = sourceIsDirectory ? join(targetArg, rel) : targetArg;',
    '  copySource(source, destination);',
    '  process.exit(23);',
    '}',
    'for (const source of files) {',
    '  const rel = sourceIsDirectory ? relative(sourcePath, source).split(sep).join("/") : basename(source);',
    '  const destination = sourceIsDirectory ? join(targetArg, rel) : targetArg;',
    '  if (dryRun) {',
    '    const changed = !existsSync(destination) || !readFileSync(source).equals(readFileSync(destination));',
    '    const item = lstatSync(source).isSymbolicLink() ? "cL+++++++++" : ">f+++++++++";',
    '    if (ignoreTimes || changed) process.stdout.write(prefix + item + "|" + rel + "\\n");',
    '    continue;',
    '  }',
    '  copySource(source, destination);',
    '}',
  ].join("\n") + "\n";
}

function fakeSshSource(): string {
  return [
    "#!/usr/bin/env bun",
    'import { appendFileSync, existsSync, statSync } from "node:fs";',
    'import { join } from "node:path";',
    'const args = process.argv.slice(2);',
    'const command = args.join(" ");',
    'appendFileSync(process.env.FAKE_SSH_LOG, command + "\\n");',
    'if (process.env.FAKE_SSH_ONLINE !== "1") process.exit(255);',
    'if (command.includes("echo online")) { console.log("online"); process.exit(0); }',
    'if (process.env.FAKE_SSH_FAIL_PROBE && command.includes(process.env.FAKE_SSH_FAIL_PROBE)) process.exit(255);',
    'if (command.includes("$HOME/.codex") && command.includes("session_index.jsonl")) { const path = join(process.env.FAKE_REMOTE_HOME, ".codex/session_index.jsonl"); process.exit(!existsSync(path) ? 2 : statSync(path).isFile() ? 0 : 3); }',
    'if (command.includes("$HOME/.kimi-code") && command.includes("session_index.jsonl")) { const path = join(process.env.FAKE_REMOTE_HOME, ".kimi-code/session_index.jsonl"); process.exit(!existsSync(path) ? 2 : statSync(path).isFile() ? 0 : 3); }',
    'if (command.includes("antigravity-rescue")) { const path = join(process.env.FAKE_REMOTE_HOME, "Downloads/antigravity-rescue/conversations"); process.exit(!existsSync(path) ? 2 : statSync(path).isDirectory() ? 0 : 3); }',
    'process.exit(0);',
  ].join("\n") + "\n";
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "pull-sync-only-"));
  const home = join(root, "home");
  const remoteHome = join(root, "remote-home");
  const fakeBin = join(root, "bin");
  const report = join(root, "mapping.tsv");
  const rsyncLog = join(root, "rsync.jsonl");
  const sshLog = join(root, "ssh.log");
  const registrarMarker = join(root, "registrar-called");
  const ingestMarker = join(root, "ingest-called");

  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(home, "recallnest", "scripts"), { recursive: true });
  executable(join(fakeBin, "rsync"), fakeRsyncSource());
  executable(join(fakeBin, "ssh"), fakeSshSource());
  executable(
    join(home, "recallnest", "scripts", "codex-projectless-register.py"),
    [
      "#!/bin/bash",
      'printf "called\\n" > "$FAKE_REGISTRAR_MARKER"',
    ].join("\n") + "\n",
  );
  executable(
    join(home, "recallnest", "scripts", "incremental-ingest.sh"),
    [
      "#!/bin/bash",
      'printf "called\\n" > "$FAKE_INGEST_MARKER"',
    ].join("\n") + "\n",
  );

  fixture(join(remoteHome, ".claude", "projects", "p", "cc.jsonl"), "{\"source\":\"cc\"}\n");
  fixture(join(remoteHome, ".codex", "sessions", "2026", "codex.jsonl"), "{\"source\":\"codex\"}\n");
  fixture(join(remoteHome, ".codex", "archived_sessions", "archived.jsonl"), "{\"source\":\"archive\"}\n");
  fixture(
    join(remoteHome, ".codex", "session_index.jsonl"),
    "{\"id\":\"mac-codex\",\"updated_at\":\"2026-08-03T00:00:00Z\"}\n",
  );
  fixture(join(remoteHome, ".kimi-code", "sessions", "k1", "wire.jsonl"), "{\"source\":\"kimi\"}\n");
  fixture(join(remoteHome, ".kimi-code", "session_index.jsonl"), "{\"sessionId\":\"mac-kimi\"}\n");
  fixture(join(remoteHome, ".gemini", "tmp", "g1", "chats", "session-g.json"), "{\"source\":\"gemini\"}\n");
  fixture(
    join(
      remoteHome,
      "Library",
      "Application Support",
      "Claude",
      "local-agent-mode-sessions",
      "d1",
      ".claude",
      "projects",
      "p",
      "desktop-one.jsonl",
    ),
    "{\"source\":\"desktop\"}\n",
  );
  fixture(
    join(remoteHome, ".gemini", "antigravity-cli", "brain", "b1", "transcript_full.jsonl"),
    "{\"source\":\"agy-brain\"}\n",
  );
  fixture(
    join(remoteHome, "Downloads", "antigravity-rescue", "conversations", "legacy.pb"),
    "legacy-original",
  );
  fixture(
    join(remoteHome, ".gemini", "antigravity-cli", "conversations", "remote-cli.db"),
    "remote-cli-original",
  );
  fixture(
    join(remoteHome, ".gemini", "antigravity", "conversations", "remote-app.db"),
    "remote-app-original",
  );

  for (let index = 1; index <= 24; index += 1) {
    fixture(
      join(home, "machine-data", "macbook-agy", "conversations", "existing-" + index + ".db"),
      "mini-existing-" + index,
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: "C",
    PULL_FROM_MACBOOK_HOME: home,
    PULL_FROM_MACBOOK_RSYNC: join(fakeBin, "rsync"),
    PULL_FROM_MACBOOK_SSH: join(fakeBin, "ssh"),
    FAKE_REMOTE_HOME: remoteHome,
    FAKE_RSYNC_LOG: rsyncLog,
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_ONLINE: "1",
    FAKE_REGISTRAR_MARKER: registrarMarker,
    FAKE_INGEST_MARKER: ingestMarker,
    PULL_FROM_MACBOOK_LOG: join(root, "pull.log"),
    PULL_FROM_MACBOOK_LOG_DIR: join(root, "logs"),
  };

  return {
    root,
    home,
    remoteHome,
    report,
    rsyncLog,
    sshLog,
    registrarMarker,
    ingestMarker,
    env,
  };
}

function run(harness: Harness, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [SCRIPT, ...args], {
    env: { ...harness.env, ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function syncOnly(harness: Harness) {
  return run(harness, ["--sync-only", "--mapping-report", harness.report]);
}

function rsyncCalls(harness: Harness): RsyncCall[] {
  if (!existsSync(harness.rsyncLog)) return [];
  return readFileSync(harness.rsyncLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RsyncCall);
}

function normalizedRsyncArgs(args: string[]): string[] {
  return args.filter(
    (arg) =>
      arg !== "--dry-run"
      && arg !== "--ignore-times"
      && arg !== "--itemize-changes"
      && !arg.startsWith("--out-format="),
  );
}

function unexpectedPositionalArgs(args: string[]): string[] {
  const valueOptions = new Set(["-e", "--exclude", "--include", "--out-format", "--rsync-path", "--timeout"]);
  const unexpected: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) unexpected.push(arg);
  }
  return unexpected;
}

function dbContents(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 1; index <= 24; index += 1) {
    const name = "existing-" + index + ".db";
    result[name] = readFileSync(join(directory, name), "utf8");
  }
  return result;
}

describe("pull-from-macbook --sync-only", () => {
  it("syncs allowed sources, verifies identical rsync arguments, and emits per-file mappings without ingest", () => {
    const harness = makeHarness();
    expect(harness.env.HOME).toBe(process.env.HOME);
    const localDbDir = join(harness.home, "machine-data", "macbook-agy", "conversations");
    const localDbBefore = dbContents(localDbDir);
    const remoteCliDb = join(harness.remoteHome, ".gemini", "antigravity-cli", "conversations", "remote-cli.db");
    const remoteAppDb = join(harness.remoteHome, ".gemini", "antigravity", "conversations", "remote-app.db");
    const remoteCliBefore = readFileSync(remoteCliDb, "utf8");
    const remoteAppBefore = readFileSync(remoteAppDb, "utf8");

    const result = syncOnly(harness);

    expect(result.status).toBe(0);
    expect(existsSync(harness.ingestMarker)).toBe(false);
    expect(existsSync(harness.registrarMarker)).toBe(false);
    expect(readFileSync(join(harness.home, ".claude", "projects", "p", "cc.jsonl"), "utf8")).toContain("cc");
    expect(
      readFileSync(
        join(harness.home, "recallnest", "data", "desktop-import", "desktop-one.jsonl"),
        "utf8",
      ),
    ).toContain("desktop");
    expect(readFileSync(join(harness.home, ".codex", "session_index.jsonl"), "utf8")).toContain("mac-codex");
    expect(readFileSync(join(harness.home, ".kimi-code", "session_index.jsonl"), "utf8")).toContain("mac-kimi");

    const mapping = readFileSync(harness.report, "utf8");
    expect(mapping.split("\n")[0]).toBe(
      "source_kind\tsource_file\tlocal_target\tderived_target\tstatus",
    );
    expect(mapping).toContain("claude-code\tmac:~/.claude/projects/p/cc.jsonl");
    expect(mapping).toContain(
      join(harness.home, "recallnest", "data", "desktop-import", "desktop-one.jsonl"),
    );
    expect(mapping).toContain("desktop-flat\t");
    expect(mapping).toContain("codex-index-merge\t");
    for (const line of mapping.trim().split("\n").slice(1)) {
      expect(line.split("\t")).toHaveLength(5);
    }
    const desktopTransportRows = mapping
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split("\t"))
      .filter(([sourceKind]) => sourceKind === "claude-desktop");
    expect(desktopTransportRows.length).toBeGreaterThan(0);
    expect(
      desktopTransportRows.every((fields) => fields[4] === "local-verified:derived-pending"),
    ).toBe(true);
    expect(statSync(harness.report).mode & 0o777).toBe(0o600);
    expect(existsSync(join(harness.home, ".codex", ".codex-global-state.json"))).toBe(false);

    const calls = rsyncCalls(harness);
    const grouped = new Map<string, RsyncCall[]>();
    for (const call of calls) {
      grouped.set(call.sourceArg, [...(grouped.get(call.sourceArg) || []), call]);
    }
    expect(grouped.size).toBe(10);
    for (const sourceCalls of grouped.values()) {
      expect(sourceCalls).toHaveLength(3);
      const real = sourceCalls.find((call) => !call.dryRun);
      const verify = sourceCalls.find((call) => call.dryRun && !call.ignoreTimes);
      const inventory = sourceCalls.find((call) => call.dryRun && call.ignoreTimes);
      expect(real).toBeDefined();
      expect(verify).toBeDefined();
      expect(inventory).toBeDefined();
      expect(normalizedRsyncArgs(verify!.args)).toEqual(real!.args);
      expect(normalizedRsyncArgs(inventory!.args)).toEqual(real!.args);
      expect(verify!.targetArg).toBe(real!.targetArg);
      expect(inventory!.targetArg).toBe(real!.targetArg);
      expect(unexpectedPositionalArgs(real!.args)).toEqual([]);
    }
    const desktopSource = "mac:Library/Application Support/Claude/local-agent-mode-sessions/";
    const desktopCalls = grouped.get(desktopSource);
    expect(desktopCalls).toHaveLength(3);
    expect(desktopCalls!.every((call) => call.args.includes("-s"))).toBe(true);
    expect(
      calls.some((call) =>
        call.sourceArg.includes("/.gemini/antigravity-cli/conversations/")
        || call.sourceArg.includes("/.gemini/antigravity/conversations/")
      ),
    ).toBe(false);
    const wrapperSource = readFileSync(SCRIPT, "utf8");
    expect(wrapperSource).not.toContain("mac:~/.gemini/antigravity-cli/conversations/");
    expect(wrapperSource).not.toContain("mac:~/.gemini/antigravity/conversations/");

    expect(dbContents(localDbDir)).toEqual(localDbBefore);
    expect(readFileSync(remoteCliDb, "utf8")).toBe(remoteCliBefore);
    expect(readFileSync(remoteAppDb, "utf8")).toBe(remoteAppBefore);
    const sshCalls = readFileSync(harness.sshLog, "utf8");
    expect(sshCalls).toContain("echo online");
    expect(sshCalls).toContain("$HOME/.codex");
    expect(sshCalls).toContain("$HOME/.kimi-code");
    expect(sshCalls).toContain("antigravity-rescue");
  }, TEST_TIMEOUT_MS);

  it("fails offline in sync-only mode but keeps the routine offline run successful", () => {
    const syncHarness = makeHarness();
    const syncResult = run(
      syncHarness,
      ["--sync-only", "--mapping-report", syncHarness.report],
      { FAKE_SSH_ONLINE: "0" },
    );
    expect(syncResult.status).not.toBe(0);
    expect(readFileSync(syncHarness.report, "utf8")).toContain("transport\tmac\t-\t-\toffline");
    expect(existsSync(syncHarness.registrarMarker)).toBe(false);
    expect(existsSync(syncHarness.ingestMarker)).toBe(false);
    expect(rsyncCalls(syncHarness)).toHaveLength(0);

    const routineHarness = makeHarness();
    const routineResult = run(routineHarness, [], { FAKE_SSH_ONLINE: "0" });
    expect(routineResult.status).toBe(0);
    expect(existsSync(routineHarness.registrarMarker)).toBe(true);
    expect(existsSync(routineHarness.ingestMarker)).toBe(false);

    const existingReportHarness = makeHarness();
    fixture(existingReportHarness.report, "keep-existing-report");
    const existingReportResult = syncOnly(existingReportHarness);
    expect(existingReportResult.status).not.toBe(0);
    expect(readFileSync(existingReportHarness.report, "utf8")).toBe("keep-existing-report");
    expect(existsSync(existingReportHarness.sshLog)).toBe(false);

    const racingReportHarness = makeHarness();
    const racingReportResult = run(
      racingReportHarness,
      ["--sync-only", "--mapping-report", racingReportHarness.report],
      { FAKE_CREATE_REPORT_DURING_SYNC: racingReportHarness.report },
    );
    expect(racingReportResult.status).not.toBe(0);
    expect(readFileSync(racingReportHarness.report, "utf8")).toBe("racing-writer");
  }, TEST_TIMEOUT_MS);

  it("fails before flattening when Desktop basenames collide", () => {
    const harness = makeHarness();
    fixture(
      join(
        harness.remoteHome,
        "Library",
        "Application Support",
        "Claude",
        "local-agent-mode-sessions",
        "d2",
        ".claude",
        "projects",
        "other",
        "Desktop-One.jsonl",
      ),
      "{\"source\":\"collision\"}\n",
    );

    const result = syncOnly(harness);

    expect(result.status).not.toBe(0);
    expect(readFileSync(harness.report, "utf8")).toContain("basename-collision");
    expect(
      existsSync(join(harness.home, "recallnest", "data", "desktop-import", "desktop-one.jsonl")),
    ).toBe(false);
    expect(existsSync(harness.ingestMarker)).toBe(false);

    const symlinkHarness = makeHarness();
    const linkedContent = join(symlinkHarness.remoteHome, "linked-content.jsonl");
    fixture(linkedContent, "{\"source\":\"must-not-follow\"}\n");
    const linkedSession = join(
      symlinkHarness.remoteHome,
      "Library",
      "Application Support",
      "Claude",
      "local-agent-mode-sessions",
      "d2",
      ".claude",
      "projects",
      "other",
      "linked.jsonl",
    );
    mkdirSync(dirname(linkedSession), { recursive: true });
    symlinkSync(linkedContent, linkedSession);

    const symlinkResult = syncOnly(symlinkHarness);

    expect(symlinkResult.status).not.toBe(0);
    expect(readFileSync(symlinkHarness.report, "utf8")).toContain("unsafe-symlink");
    expect(
      existsSync(join(symlinkHarness.home, "recallnest", "data", "desktop-import", "linked.jsonl")),
    ).toBe(false);

    const destinationHarness = makeHarness();
    const outsideTarget = join(destinationHarness.root, "outside-target.jsonl");
    fixture(outsideTarget, "outside-must-not-be-ingested");
    const destinationLink = join(
      destinationHarness.home,
      "recallnest",
      "data",
      "desktop-import",
      "desktop-one.jsonl",
    );
    mkdirSync(dirname(destinationLink), { recursive: true });
    symlinkSync(outsideTarget, destinationLink);

    const destinationResult = syncOnly(destinationHarness);

    expect(destinationResult.status).not.toBe(0);
    expect(readFileSync(destinationHarness.report, "utf8")).toContain(
      "unsafe-destination-symlink",
    );
    expect(readFileSync(outsideTarget, "utf8")).toBe("outside-must-not-be-ingested");
  }, TEST_TIMEOUT_MS);

  it("surfaces a Desktop copy failure and does not ingest", () => {
    const harness = makeHarness();
    mkdirSync(
      join(harness.home, "recallnest", "data", "desktop-import", "desktop-one.jsonl"),
      { recursive: true },
    );

    const result = syncOnly(harness);

    expect(result.status).not.toBe(0);
    expect(readFileSync(harness.report, "utf8")).toContain("copy-failed:IsADirectoryError");
    expect(existsSync(harness.ingestMarker)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("does not derive from a failed or partial source sync", () => {
    const desktopHarness = makeHarness();
    const desktopImport = join(
      desktopHarness.home,
      "recallnest",
      "data",
      "desktop-import",
      "desktop-one.jsonl",
    );
    fixture(desktopImport, "known-good-desktop");

    const desktopResult = run(
      desktopHarness,
      ["--sync-only", "--mapping-report", desktopHarness.report],
      { FAKE_RSYNC_FAIL_SOURCE: "local-agent-mode-sessions" },
    );

    expect(desktopResult.status).not.toBe(0);
    expect(readFileSync(desktopImport, "utf8")).toBe("known-good-desktop");
    expect(readFileSync(desktopHarness.report, "utf8")).toContain(
      "derived-skipped:source-sync-failed",
    );

    const indexHarness = makeHarness();
    const kimiIndex = join(indexHarness.home, ".kimi-code", "session_index.jsonl");
    fixture(kimiIndex, "{\"sessionId\":\"mini-only\"}\n");

    const indexResult = run(
      indexHarness,
      ["--sync-only", "--mapping-report", indexHarness.report],
      { FAKE_RSYNC_FAIL_SOURCE: ".kimi-code/session_index.jsonl" },
    );

    expect(indexResult.status).not.toBe(0);
    expect(readFileSync(kimiIndex, "utf8")).toContain("mini-only");
    expect(readFileSync(kimiIndex, "utf8")).not.toContain("mac-kimi");
    expect(readFileSync(indexHarness.report, "utf8")).toContain(
      "kimi-index-merge\t" + join(indexHarness.home, ".kimi-code", "session_index.macbook.jsonl"),
    );
    expect(readFileSync(indexHarness.report, "utf8")).toContain(
      "derived-skipped:source-sync-failed",
    );
  }, TEST_TIMEOUT_MS);

  it("distinguishes absent probes from partial, transport, and wrong-type failures", () => {
    const legacyHarness = makeHarness();
    const legacyResult = run(
      legacyHarness,
      ["--sync-only", "--mapping-report", legacyHarness.report],
      { FAKE_RSYNC_FAIL_SOURCE: "antigravity-rescue/conversations" },
    );
    const legacyMapping = readFileSync(legacyHarness.report, "utf8");
    expect(legacyResult.status).not.toBe(0);
    expect(legacyMapping).toContain("agy-legacy-pb\t");
    expect(legacyMapping).toContain("sync-failed:23");
    expect(legacyMapping).not.toContain(
      "agy-legacy-pb\tmac:~/Downloads/antigravity-rescue/conversations/\t"
      + join(legacyHarness.home, "machine-data", "macbook-agy", "legacy-pb")
      + "/\t"
      + join(legacyHarness.home, "machine-data", "macbook-agy", "legacy-pb")
      + "/\tsource-absent",
    );

    const probeHarness = makeHarness();
    const probeResult = run(
      probeHarness,
      ["--sync-only", "--mapping-report", probeHarness.report],
      { FAKE_SSH_FAIL_PROBE: "$HOME/.codex" },
    );
    expect(probeResult.status).not.toBe(0);
    expect(readFileSync(probeHarness.report, "utf8")).toContain("probe-failed:255");
    expect(
      rsyncCalls(probeHarness).some((call) =>
        call.sourceArg === "mac:~/.codex/session_index.jsonl"
      ),
    ).toBe(false);

    const wrongTypeHarness = makeHarness();
    const wrongTypeIndex = join(
      wrongTypeHarness.remoteHome,
      ".codex",
      "session_index.jsonl",
    );
    renameSync(wrongTypeIndex, wrongTypeIndex + ".saved");
    mkdirSync(wrongTypeIndex);
    const wrongTypeResult = syncOnly(wrongTypeHarness);
    const wrongTypeMapping = readFileSync(wrongTypeHarness.report, "utf8");
    expect(wrongTypeResult.status).not.toBe(0);
    expect(wrongTypeMapping).toContain("probe-failed:3");
    expect(wrongTypeMapping).not.toContain(
      "codex-session-index\tmac:~/.codex/session_index.jsonl\t"
      + join(wrongTypeHarness.home, ".codex", "session_index.macbook.jsonl")
      + "\t"
      + join(wrongTypeHarness.home, ".codex", "session_index.jsonl")
      + "\tsource-absent",
    );

    const absentHarness = makeHarness();
    const absentIndex = join(absentHarness.remoteHome, ".codex", "session_index.jsonl");
    renameSync(absentIndex, absentIndex + ".saved");
    const absentResult = syncOnly(absentHarness);
    expect(absentResult.status).toBe(0);
    expect(readFileSync(absentHarness.report, "utf8")).toContain(
      "codex-session-index\tmac:~/.codex/session_index.jsonl\t"
      + join(absentHarness.home, ".codex", "session_index.macbook.jsonl")
      + "\t"
      + join(absentHarness.home, ".codex", "session_index.jsonl")
      + "\tsource-absent",
    );
  }, TEST_TIMEOUT_MS);

  it("surfaces mapping append failures without installing a report or ingesting", () => {
    const harness = makeHarness();
    const result = run(
      harness,
      ["--sync-only", "--mapping-report", harness.report],
      { FAKE_BREAK_MAPPING_TMP: harness.report },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("sync-only 映射报告追加失败");
    expect(existsSync(harness.report)).toBe(false);
    expect(existsSync(harness.ingestMarker)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("marks files pending when a live source changes after inventory", () => {
    const liveSourceHarness = makeHarness();
    const liveSourceResult = run(
      liveSourceHarness,
      ["--sync-only", "--mapping-report", liveSourceHarness.report],
      { FAKE_RSYNC_MUTATE_ON_VERIFY_SOURCE: ".claude/projects/" },
    );
    const liveSourceRows = readFileSync(liveSourceHarness.report, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split("\t"))
      .filter(([sourceKind]) => sourceKind === "claude-code");
    expect(liveSourceResult.status).not.toBe(0);
    expect(liveSourceRows.some((fields) => fields[4] === "pending:1")).toBe(true);
    expect(liveSourceRows.some((fields) => fields[4] === "verified")).toBe(false);
  }, TEST_TIMEOUT_MS);
});
