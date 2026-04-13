import { describe, expect, it } from "bun:test";

import {
  detectFormat,
  normalizeConnectorV1,
  normalizeConversation,
} from "../conversation-importer.js";
import { isConnectorOutputV1, type ConnectorOutputV1 } from "../connector-types.js";

// ---------------------------------------------------------------------------
// isConnectorOutputV1 validator
// ---------------------------------------------------------------------------

describe("isConnectorOutputV1", () => {
  it("validates a correct connector-v1 payload", () => {
    const valid: ConnectorOutputV1 = {
      version: "connector-v1",
      source: "obsidian",
      scope: "vault:notes",
      producedAt: "2026-04-13T00:00:00Z",
      records: [{ id: "r1", text: "hello" }],
    };
    expect(isConnectorOutputV1(valid)).toBe(true);
  });

  it("rejects null / undefined / non-objects", () => {
    expect(isConnectorOutputV1(null)).toBe(false);
    expect(isConnectorOutputV1(undefined)).toBe(false);
    expect(isConnectorOutputV1("string")).toBe(false);
    expect(isConnectorOutputV1(42)).toBe(false);
  });

  it("rejects objects with wrong version", () => {
    expect(isConnectorOutputV1({ version: "v2", source: "x", scope: "y", producedAt: "z", records: [] })).toBe(false);
  });

  it("rejects objects missing required fields", () => {
    expect(isConnectorOutputV1({ version: "connector-v1" })).toBe(false);
    expect(isConnectorOutputV1({ version: "connector-v1", source: "x" })).toBe(false);
    expect(isConnectorOutputV1({ version: "connector-v1", source: "x", scope: "y", producedAt: "z" })).toBe(false);
  });

  it("accepts empty records array", () => {
    expect(isConnectorOutputV1({
      version: "connector-v1",
      source: "test",
      scope: "test:scope",
      producedAt: "2026-04-13T00:00:00Z",
      records: [],
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectFormat — connector-v1
// ---------------------------------------------------------------------------

describe("detectFormat — connector-v1", () => {
  it("detects connector-v1 JSON", () => {
    const payload = JSON.stringify({
      version: "connector-v1",
      source: "obsidian",
      scope: "vault:my-notes",
      producedAt: "2026-04-13T12:00:00Z",
      records: [{ id: "r1", text: "test" }],
    });
    expect(detectFormat(payload)).toBe("connector-v1");
  });

  it("detects connector-v1 with optional fields", () => {
    const payload = JSON.stringify({
      version: "connector-v1",
      source: "email",
      scope: "inbox:main",
      batchId: "batch-001",
      producedAt: "2026-04-13T12:00:00Z",
      records: [],
    });
    expect(detectFormat(payload)).toBe("connector-v1");
  });

  it("does not misidentify non-connector JSON as connector-v1", () => {
    // claude-ai format
    const claudeAi = JSON.stringify({ chat_conversations: [{ chat_messages: [] }] });
    expect(detectFormat(claudeAi)).toBe("claude-ai");

    // chatgpt format
    const chatgpt = JSON.stringify({ mapping: {} });
    expect(detectFormat(chatgpt)).toBe("chatgpt");
  });

  it("connector-v1 takes priority over other single-object formats", () => {
    // An object that has both connector-v1 fields AND a mapping field
    const hybrid = JSON.stringify({
      version: "connector-v1",
      source: "test",
      scope: "test:s",
      producedAt: "2026-04-13T12:00:00Z",
      records: [],
      mapping: {},  // chatgpt field — should not override
    });
    expect(detectFormat(hybrid)).toBe("connector-v1");
  });
});

// ---------------------------------------------------------------------------
// normalizeConnectorV1
// ---------------------------------------------------------------------------

describe("normalizeConnectorV1", () => {
  it("normalizes records with title and text", () => {
    const payload: ConnectorOutputV1 = {
      version: "connector-v1",
      source: "obsidian",
      scope: "vault:notes",
      producedAt: "2026-04-13T12:00:00Z",
      records: [
        { id: "r1", text: "Some content", title: "My Note" },
        { id: "r2", text: "Another note" },
      ],
    };
    const messages = normalizeConnectorV1(JSON.stringify(payload));
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("[My Note] Some content");
    expect(messages[0].role).toBe("user");
    expect(messages[1].content).toBe("Another note");
  });

  it("preserves timestamps", () => {
    const payload: ConnectorOutputV1 = {
      version: "connector-v1",
      source: "test",
      scope: "test:s",
      producedAt: "2026-04-13T12:00:00Z",
      records: [
        { id: "r1", text: "hello", timestamp: "2026-04-12T10:00:00Z" },
        { id: "r2", text: "world" },
      ],
    };
    const messages = normalizeConnectorV1(JSON.stringify(payload));
    expect(messages[0].timestamp).toBe("2026-04-12T10:00:00Z");
    expect(messages[1].timestamp).toBeUndefined();
  });

  it("returns empty array for empty records", () => {
    const payload: ConnectorOutputV1 = {
      version: "connector-v1",
      source: "test",
      scope: "test:s",
      producedAt: "2026-04-13T12:00:00Z",
      records: [],
    };
    const messages = normalizeConnectorV1(JSON.stringify(payload));
    expect(messages).toHaveLength(0);
  });

  it("throws on invalid connector-v1 JSON", () => {
    expect(() => normalizeConnectorV1(JSON.stringify({ version: "v2" }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// normalizeConversation dispatch
// ---------------------------------------------------------------------------

describe("normalizeConversation — connector-v1 dispatch", () => {
  it("dispatches connector-v1 through normalizeConversation", () => {
    const payload: ConnectorOutputV1 = {
      version: "connector-v1",
      source: "rss",
      scope: "feed:tech",
      producedAt: "2026-04-13T12:00:00Z",
      records: [
        { id: "r1", text: "Article body", title: "Cool Article" },
      ],
    };
    const messages = normalizeConversation(JSON.stringify(payload), "connector-v1");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("[Cool Article] Article body");
  });
});
