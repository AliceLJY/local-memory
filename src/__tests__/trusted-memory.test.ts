import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createAuditLogger } from "../audit-log.js";
import type { AuditEntry } from "../audit-log.js";
import {
  DEFAULT_RETENTION_POLICY,
  loadRetentionPolicy,
  saveRetentionPolicy,
  shouldArchiveByPolicy,
} from "../retention-policy.js";
import type { RetentionPolicy } from "../retention-policy.js";
import { scanForPII } from "../pii-detector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `recallnest-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// F-1: Audit Log
// ---------------------------------------------------------------------------

describe("F-1: audit log", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("log writes an entry and count returns 1", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    logger.log({ operation: "store", actor: "manual", scope: "test" });

    expect(logger.count()).toBe(1);
  });

  it("log writes multiple entries", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    logger.log({ operation: "store", actor: "manual" });
    logger.log({ operation: "retrieve", actor: "agent" });
    logger.log({ operation: "delete", actor: "system" });

    expect(logger.count()).toBe(3);
  });

  it("getRecent returns newest first", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    logger.log({ operation: "store", actor: "manual", details: "first" });
    logger.log({ operation: "update", actor: "agent", details: "second" });
    logger.log({ operation: "delete", actor: "system", details: "third" });

    const recent = logger.getRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].details).toBe("third");
    expect(recent[1].details).toBe("second");
  });

  it("getRecent defaults to 20", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    for (let i = 0; i < 25; i++) {
      logger.log({ operation: "store", actor: "manual", details: `entry-${i}` });
    }

    const recent = logger.getRecent();
    expect(recent).toHaveLength(20);
    expect(recent[0].details).toBe("entry-24");
  });

  it("exportAll returns all entries in order", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    logger.log({ operation: "store", actor: "manual", details: "a" });
    logger.log({ operation: "update", actor: "agent", details: "b" });

    const all = logger.exportAll();
    expect(all).toHaveLength(2);
    expect(all[0].details).toBe("a");
    expect(all[1].details).toBe("b");
  });

  it("entries have ISO timestamps", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    logger.log({ operation: "store", actor: "manual" });

    const entries = logger.exportAll();
    expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("entries preserve scope and memoryId", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    logger.log({
      operation: "store",
      actor: "api",
      scope: "project:x",
      memoryId: "mem-123",
    });

    const entries = logger.exportAll();
    expect(entries[0].scope).toBe("project:x");
    expect(entries[0].memoryId).toBe("mem-123");
  });

  it("truncates details to 200 chars", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    const longDetails = "x".repeat(300);
    logger.log({ operation: "store", actor: "manual", details: longDetails });

    const entries = logger.exportAll();
    expect(entries[0].details!.length).toBe(200);
  });

  it("returns empty arrays / 0 count when file does not exist", () => {
    const logPath = join(tmpDir, "nonexistent.jsonl");
    const logger = createAuditLogger(logPath);

    expect(logger.getRecent()).toEqual([]);
    expect(logger.exportAll()).toEqual([]);
    expect(logger.count()).toBe(0);
  });

  it("silently handles write to read-only path", () => {
    // Use a path that cannot be written to (deep nested under /dev/null)
    const logger = createAuditLogger("/dev/null/impossible/audit.jsonl");

    // Should not throw
    expect(() => {
      logger.log({ operation: "store", actor: "manual" });
    }).not.toThrow();
  });

  it("creates parent directory if missing", () => {
    const nestedPath = join(tmpDir, "sub", "deep", "audit.jsonl");
    const logger = createAuditLogger(nestedPath);

    logger.log({ operation: "store", actor: "manual" });

    expect(existsSync(nestedPath)).toBe(true);
    expect(logger.count()).toBe(1);
  });

  it("skips malformed lines gracefully", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    // Write some valid and invalid lines
    writeFileSync(
      logPath,
      '{"timestamp":"2026-01-01T00:00:00Z","operation":"store","actor":"manual"}\nBAD LINE\n{"timestamp":"2026-01-02T00:00:00Z","operation":"update","actor":"agent"}\n',
    );

    const logger = createAuditLogger(logPath);
    expect(logger.count()).toBe(2);
    expect(logger.exportAll()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// F-2: Retention Policy
// ---------------------------------------------------------------------------

describe("F-2: retention policy", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("DEFAULT_RETENTION_POLICY has safe defaults", () => {
    expect(DEFAULT_RETENTION_POLICY.autoArchiveAfterDays).toBe(0);
    expect(DEFAULT_RETENTION_POLICY.maxMemories).toBe(0);
    expect(DEFAULT_RETENTION_POLICY.allowHardDelete).toBe(false);
  });

  it("loadRetentionPolicy returns defaults for unconfigured scope", () => {
    const policy = loadRetentionPolicy("unknown-scope", tmpDir);
    expect(policy).toEqual(DEFAULT_RETENTION_POLICY);
  });

  it("save and load round-trips correctly", () => {
    const custom: Partial<RetentionPolicy> = {
      autoArchiveAfterDays: 30,
      maxMemories: 100,
    };

    saveRetentionPolicy("my-scope", custom, tmpDir);
    const loaded = loadRetentionPolicy("my-scope", tmpDir);

    expect(loaded.autoArchiveAfterDays).toBe(30);
    expect(loaded.maxMemories).toBe(100);
    expect(loaded.allowHardDelete).toBe(false); // default preserved
  });

  it("partial save merges with defaults", () => {
    saveRetentionPolicy("scope-a", { allowHardDelete: true }, tmpDir);
    const loaded = loadRetentionPolicy("scope-a", tmpDir);

    expect(loaded.allowHardDelete).toBe(true);
    expect(loaded.autoArchiveAfterDays).toBe(0);
    expect(loaded.maxMemories).toBe(0);
  });

  it("different scopes have independent policies", () => {
    saveRetentionPolicy("scope-x", { maxMemories: 50 }, tmpDir);
    saveRetentionPolicy("scope-y", { maxMemories: 200 }, tmpDir);

    expect(loadRetentionPolicy("scope-x", tmpDir).maxMemories).toBe(50);
    expect(loadRetentionPolicy("scope-y", tmpDir).maxMemories).toBe(200);
  });

  it("shouldArchiveByPolicy: default policy never archives", () => {
    const result = shouldArchiveByPolicy(DEFAULT_RETENTION_POLICY, 365, 9999);
    expect(result.archive).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("shouldArchiveByPolicy: archives when age exceeds limit", () => {
    const policy: RetentionPolicy = {
      autoArchiveAfterDays: 30,
      maxMemories: 0,
      allowHardDelete: false,
    };

    const result = shouldArchiveByPolicy(policy, 31, 10);
    expect(result.archive).toBe(true);
    expect(result.reason).toContain("31d");
    expect(result.reason).toContain("30d");
  });

  it("shouldArchiveByPolicy: does not archive when age is within limit", () => {
    const policy: RetentionPolicy = {
      autoArchiveAfterDays: 30,
      maxMemories: 0,
      allowHardDelete: false,
    };

    expect(shouldArchiveByPolicy(policy, 29, 10).archive).toBe(false);
    expect(shouldArchiveByPolicy(policy, 30, 10).archive).toBe(false);
  });

  it("shouldArchiveByPolicy: archives when count exceeds limit", () => {
    const policy: RetentionPolicy = {
      autoArchiveAfterDays: 0,
      maxMemories: 100,
      allowHardDelete: false,
    };

    const result = shouldArchiveByPolicy(policy, 5, 101);
    expect(result.archive).toBe(true);
    expect(result.reason).toContain("101");
    expect(result.reason).toContain("100");
  });

  it("shouldArchiveByPolicy: does not archive when count is within limit", () => {
    const policy: RetentionPolicy = {
      autoArchiveAfterDays: 0,
      maxMemories: 100,
      allowHardDelete: false,
    };

    expect(shouldArchiveByPolicy(policy, 5, 99).archive).toBe(false);
    expect(shouldArchiveByPolicy(policy, 5, 100).archive).toBe(false);
  });

  it("allowHardDelete defaults to false", () => {
    saveRetentionPolicy("scope-del", {}, tmpDir);
    const loaded = loadRetentionPolicy("scope-del", tmpDir);
    expect(loaded.allowHardDelete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-3: PII Detector
// ---------------------------------------------------------------------------

describe("F-3: PII detector", () => {
  it("returns clean result for text without PII", () => {
    const result = scanForPII("This is a normal sentence about programming.");
    expect(result.hasPII).toBe(false);
    expect(result.detections).toHaveLength(0);
    expect(result.summary).toBe("No PII detected");
  });

  it("returns clean result for pure Chinese text without PII", () => {
    const result = scanForPII("今天天气不错，我们去公园散步吧。");
    expect(result.hasPII).toBe(false);
    expect(result.detections).toHaveLength(0);
  });

  it("detects API keys (high severity)", () => {
    const result = scanForPII("My key is sk-1234567890abcdefghijklmnop");
    expect(result.hasPII).toBe(true);
    const apiKey = result.detections.find((d) => d.type === "api_key");
    expect(apiKey).toBeDefined();
    expect(apiKey!.severity).toBe("high");
  });

  it("detects token patterns (high severity)", () => {
    const result = scanForPII("token=abcdefghij1234567890abcdefghij");
    expect(result.hasPII).toBe(true);
    const detection = result.detections.find((d) => d.type === "api_key");
    expect(detection).toBeDefined();
    expect(detection!.severity).toBe("high");
  });

  it("detects passwords (high severity)", () => {
    const result = scanForPII('password="MyS3cretP@ss!"');
    expect(result.hasPII).toBe(true);
    const pwd = result.detections.find((d) => d.type === "password");
    expect(pwd).toBeDefined();
    expect(pwd!.severity).toBe("high");
  });

  it("detects Chinese ID numbers (high severity)", () => {
    const result = scanForPII("身份证号: 110101199003077891");
    expect(result.hasPII).toBe(true);
    const id = result.detections.find((d) => d.type === "id_number");
    expect(id).toBeDefined();
    expect(id!.severity).toBe("high");
  });

  it("detects email addresses (low severity)", () => {
    const result = scanForPII("Contact me at alice@example.com");
    expect(result.hasPII).toBe(true);
    const email = result.detections.find((d) => d.type === "email");
    expect(email).toBeDefined();
    expect(email!.severity).toBe("low");
  });

  it("detects phone numbers (medium severity)", () => {
    const result = scanForPII("我的手机号是 13812345678");
    expect(result.hasPII).toBe(true);
    const phone = result.detections.find((d) => d.type === "phone");
    expect(phone).toBeDefined();
    expect(phone!.severity).toBe("medium");
  });

  it("detects credit card numbers (high severity)", () => {
    const result = scanForPII("Card: 4111-1111-1111-1111");
    expect(result.hasPII).toBe(true);
    const cc = result.detections.find((d) => d.type === "credit_card");
    expect(cc).toBeDefined();
    expect(cc!.severity).toBe("high");
  });

  it("detects credit card without separators", () => {
    const result = scanForPII("Card: 4111111111111111");
    expect(result.hasPII).toBe(true);
    const cc = result.detections.find((d) => d.type === "credit_card");
    expect(cc).toBeDefined();
  });

  it("detects multiple PII types in mixed text", () => {
    const text =
      "User alice@test.com has password=SuperSecret123 and phone 13900001234. " +
      "API key: sk-abcdefghijklmnopqrstuvwxyz";
    const result = scanForPII(text);

    expect(result.hasPII).toBe(true);
    const types = new Set(result.detections.map((d) => d.type));
    expect(types.has("email")).toBe(true);
    expect(types.has("password")).toBe(true);
    expect(types.has("phone")).toBe(true);
    expect(types.has("api_key")).toBe(true);
    expect(result.detections.length).toBeGreaterThanOrEqual(4);
  });

  it("masks sensitive matches (preserves head/tail, masks middle)", () => {
    const result = scanForPII("token=abcdefghijklmnopqrstuvwxyz1234");
    expect(result.hasPII).toBe(true);
    const detection = result.detections[0];
    // Masked value should contain ***
    expect(detection.match).toContain("***");
    // Should not contain the full original value
    expect(detection.match.length).toBeLessThan(
      "token=abcdefghijklmnopqrstuvwxyz1234".length,
    );
  });

  it("mask preserves first 4 and last 4 chars for long values", () => {
    // Email is a good test case: alice@example.com (17 chars, > 8)
    const result = scanForPII("email: alice@example.com");
    const email = result.detections.find((d) => d.type === "email");
    expect(email).toBeDefined();
    // "alice@example.com" -> "alic***e.com"
    expect(email!.match.startsWith("alic")).toBe(true);
    expect(email!.match.endsWith(".com")).toBe(true);
    expect(email!.match).toContain("***");
  });

  it("provides accurate summary counts", () => {
    const text =
      "password=MySecret123 alice@test.com 13812345678";
    const result = scanForPII(text);

    // Should mention total count and severity breakdown
    expect(result.summary).toContain("Found");
    expect(result.summary).toMatch(/\d+ high/);
    expect(result.summary).toMatch(/\d+ medium/);
    expect(result.summary).toMatch(/\d+ low/);
  });

  it("records position (char offset) of matches", () => {
    const text = "prefix alice@example.com suffix";
    const result = scanForPII(text);
    const email = result.detections.find((d) => d.type === "email");
    expect(email).toBeDefined();
    expect(email!.position).toBe(text.indexOf("alice@example.com"));
  });

  it("handles empty string", () => {
    const result = scanForPII("");
    expect(result.hasPII).toBe(false);
    expect(result.detections).toHaveLength(0);
  });

  it("can be called multiple times (regex state reset)", () => {
    // Ensures global regex lastIndex is properly reset between calls
    const text = "sk-abcdefghijklmnopqrstuvwxyz";
    const r1 = scanForPII(text);
    const r2 = scanForPII(text);
    expect(r1.detections.length).toBe(r2.detections.length);
    expect(r1.hasPII).toBe(r2.hasPII);
  });
});
