import { describe, expect, it } from "bun:test";

import { redactSecrets, redactForLog, scanForPII } from "../pii-detector.js";
import { persistMemory } from "../capture-engine.js";
import type { AuditEntry } from "../audit-log.js";

const TEST_SCOPE = "project:test";

// ============================================================================
// redactSecrets — rule coverage
// ============================================================================

describe("redactSecrets", () => {
  it("scrubs Anthropic API keys with the specific type", () => {
    const r = redactSecrets("my key is sk-ant-api03-AbCdEf12345678 ok");
    expect(r.text).toBe("my key is [REDACTED:anthropic_key] ok");
    expect(r.redacted).toBe(1);
  });

  it("scrubs GitHub tokens", () => {
    const r = redactSecrets("push with ghp_ABCDEFGHIJKLMNOPQRSTUV1234567890");
    expect(r.text).toContain("[REDACTED:github_token]");
    expect(r.text).not.toContain("ghp_");
  });

  it("scrubs Slack tokens", () => {
    const r = redactSecrets("xoxb-123456789-abcdefghij is the bot token");
    expect(r.text).toContain("[REDACTED:slack_token]");
  });

  it("scrubs AWS access key IDs", () => {
    const r = redactSecrets("aws AKIAIOSFODNN7EXAMPLE used");
    expect(r.text).toContain("[REDACTED:aws_access_key]");
    expect(r.text).not.toContain("AKIA");
  });

  it("scrubs Google API keys", () => {
    // Real Google API keys are exactly "AIza" + 35 chars
    const r = redactSecrets(`key ${"AIzaSyB" + "x".repeat(32)} in config`);
    expect(r.text).toContain("[REDACTED:google_api_key]");
  });

  it("scrubs JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const r = redactSecrets(`token: bearer-less ${jwt} end`);
    expect(r.text).toContain("[REDACTED:jwt]");
    expect(r.text).not.toContain("eyJhbGci");
  });

  it("scrubs Bearer headers", () => {
    const r = redactSecrets("Authorization: Bearer abcdef1234567890XYZ_token");
    expect(r.text).toContain("[REDACTED:bearer_token]");
  });

  it("scrubs PEM private key blocks including the body", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nsecretbody\n-----END RSA PRIVATE KEY-----";
    const r = redactSecrets(`config:\n${pem}\ndone`);
    expect(r.text).toContain("[REDACTED:pem_private_key]");
    expect(r.text).not.toContain("MIIEowIBAAKCAQEA");
    expect(r.text).not.toContain("secretbody");
  });

  it("keeps the key name for password assignments, scrubs only the value", () => {
    const r = redactSecrets("db config password=SuperSecret99 in env");
    expect(r.text).toContain("password=[REDACTED:password]");
    expect(r.text).not.toContain("SuperSecret99");
  });

  it("keeps the key name for api_key/token/secret assignments", () => {
    const r = redactSecrets("set api_key=abcdefghij1234567890XYZAB then restart");
    expect(r.text).toContain("api_key=[REDACTED:api_key]");
    expect(r.text).not.toContain("abcdefghij1234567890XYZAB");
  });

  it("scrubs Chinese national ID numbers", () => {
    const r = redactSecrets("身份证 11010519491231002X 登记");
    expect(r.text).toContain("[REDACTED:id_number]");
    expect(r.text).not.toContain("11010519491231002X");
  });

  it("scrubs credit card numbers", () => {
    const r = redactSecrets("card 4111 1111 1111 1111 charged");
    expect(r.text).toContain("[REDACTED:credit_card]");
  });
});

// ============================================================================
// redactSecrets — false-positive guards
// ============================================================================

describe("redactSecrets false-positive guards", () => {
  it("does NOT scrub git commit hashes (40-char hex)", () => {
    const sha = "699bea8f3d2c1a0b9e8d7c6b5a4f3e2d1c0b9a87";
    const r = redactSecrets(`fixed in commit ${sha} on main`);
    expect(r.text).toContain(sha);
    expect(r.redacted).toBe(0);
  });

  it("does NOT scrub phone numbers or emails (detection-only)", () => {
    const r = redactSecrets("联系 13812345678 或 alice@example.com");
    expect(r.text).toContain("13812345678");
    expect(r.text).toContain("alice@example.com");
    expect(r.redacted).toBe(0);
  });

  it("leaves ordinary Chinese engineering notes untouched", () => {
    const text = "修复 admission 门控：noise-filter 英文 greeting 加词边界 + rejection reason 透传";
    const r = redactSecrets(text);
    expect(r.text).toBe(text);
    expect(r.redacted).toBe(0);
  });

  it("leaves ordinary English text untouched", () => {
    const text = "The dream pipeline gathers active memories and consolidates clusters.";
    const r = redactSecrets(text);
    expect(r.text).toBe(text);
    expect(r.redacted).toBe(0);
  });
});

// ============================================================================
// redactForLog — redact-then-truncate ordering
// ============================================================================

describe("redactForLog", () => {
  it("redacts before truncating so a cut cannot leak a secret prefix", () => {
    // Secret starts inside the 60-char window; naive slice-then-redact would leak its head
    const text = "x".repeat(50) + " sk-ant-api03-SECRETSECRETSECRET tail";
    const logged = redactForLog(text, 60);
    expect(logged).not.toContain("sk-ant");
    expect(logged.length).toBeLessThanOrEqual(60);
  });

  it("keeps clean text as-is within the limit", () => {
    expect(redactForLog("short clean text", 60)).toBe("short clean text");
  });
});

// ============================================================================
// scanForPII — backward compatibility
// ============================================================================

describe("scanForPII backward compatibility", () => {
  it("still detects and masks without altering behavior", () => {
    const result = scanForPII("password=SuperSecret99");
    expect(result.hasPII).toBe(true);
    expect(result.detections[0].type).toBe("password");
    // masked match must not contain the full secret
    expect(result.detections[0].match).not.toBe("password=SuperSecret99");
  });

  it("reports new vendor token types", () => {
    const result = scanForPII("sk-ant-api03-AbCdEf12345678");
    expect(result.hasPII).toBe(true);
    expect(result.detections.some((d) => d.type === "anthropic_key")).toBe(true);
  });
});

// ============================================================================
// persistMemory integration — redaction reaches every surface
// ============================================================================

function createDeps() {
  const storedEntries: any[] = [];
  const embeddedTexts: string[] = [];
  const auditEntries: Array<Omit<AuditEntry, "timestamp">> = [];
  let seq = 1;

  return {
    storedEntries,
    embeddedTexts,
    auditEntries,
    deps: {
      embedder: {
        async embedPassage(text: string) {
          embeddedTexts.push(text);
          return [text.length, 1, 0];
        },
      },
      store: {
        async store(entry: any) {
          const stored = {
            ...entry,
            id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
            timestamp: 1_700_000_000_000 + seq,
          };
          seq += 1;
          storedEntries.push(stored);
          return stored;
        },
        async list() {
          return [];
        },
        async update() {
          return null;
        },
        async getById() {
          return null;
        },
        async get() {
          return null;
        },
      },
      auditLogger: {
        log(entry: Omit<AuditEntry, "timestamp">) {
          auditEntries.push(entry);
        },
        getRecent: () => [],
        exportAll: () => [],
        count: () => 0,
      },
    },
  };
}

describe("persistMemory redaction integration", () => {
  it("embeds, stores, and audit-logs the scrubbed text, never the raw secret", async () => {
    const h = createDeps();
    const result = await persistMemory(h.deps as any, {
      text: "部署踩坑：用了 password=SuperSecret99 连测试库，改环境变量后修复，教训是配置不进代码",
      category: "cases",
      importance: 0.9,
      scope: TEST_SCOPE,
      source: "manual",
    });

    expect(result.disposition).not.toBe("rejected");
    // Embedding API never saw the secret
    expect(h.embeddedTexts.length).toBeGreaterThan(0);
    for (const t of h.embeddedTexts) {
      expect(t).not.toContain("SuperSecret99");
    }
    // Stored text is scrubbed but keeps the key name for readability
    expect(h.storedEntries[0].text).toContain("password=[REDACTED:password]");
    expect(h.storedEntries[0].text).not.toContain("SuperSecret99");
    // Audit log details are scrubbed too
    for (const e of h.auditEntries) {
      expect(e.details ?? "").not.toContain("SuperSecret99");
    }
  });

  it("records piiWarning with redacted count in metadata", async () => {
    const h = createDeps();
    await persistMemory(h.deps as any, {
      text: "记录一下：测试环境 token=abcdefghij1234567890XYZAB 已经轮换过了，流程要固化下来",
      category: "cases",
      importance: 0.9,
      scope: TEST_SCOPE,
      source: "manual",
    });

    const meta = JSON.parse(h.storedEntries[0].metadata ?? "{}");
    expect(meta.piiWarning).toBeDefined();
    expect(meta.piiWarning.redacted).toBeGreaterThan(0);
  });

  it("writes a reject entry to the audit log when admission rejects", async () => {
    const h = createDeps();
    const result = await persistMemory(h.deps as any, {
      text: "ok", // below minTextLength → admission reject
      category: "cases",
      importance: 0.9,
      scope: TEST_SCOPE,
      source: "manual",
    });

    expect(result.disposition).toBe("rejected");
    const rejects = h.auditEntries.filter((e) => e.operation === "reject");
    expect(rejects.length).toBe(1);
    expect(rejects[0].scope).toBe(TEST_SCOPE);
    expect(rejects[0].details ?? "").toContain("ok");
  });
});
