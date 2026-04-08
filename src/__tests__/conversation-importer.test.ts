import { describe, expect, it } from "bun:test";

import {
  detectFormat,
  normalizeClaudeCode,
  normalizeClaudeAi,
  normalizeChatGPT,
  normalizeSlack,
  normalizePlaintext,
  normalizeConversation,
  ingestNormalizedMessages,
  type NormalizedMessage,
  type ConversationFormat,
} from "../conversation-importer.js";
import type { MemoryEntry, MemorySearchResult } from "../store.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockStore() {
  const entries: MemoryEntry[] = [];
  let seq = 1;
  return {
    entries,
    store: {
      async store(entry: Omit<MemoryEntry, "id" | "timestamp"> & { id?: string }): Promise<MemoryEntry> {
        const stored: MemoryEntry = {
          ...entry,
          id: entry.id || `auto-${String(seq).padStart(12, "0")}`,
          timestamp: 1_700_000_000_000 + seq,
          metadata: entry.metadata || "{}",
        };
        seq += 1;
        entries.push(stored);
        return stored;
      },
      async update(id: string, updates: Partial<MemoryEntry>): Promise<MemoryEntry | null> {
        const idx = entries.findIndex((e) => e.id === id);
        if (idx < 0) return null;
        entries[idx] = { ...entries[idx], ...updates, timestamp: updates.timestamp ?? entries[idx].timestamp };
        return entries[idx];
      },
      async get(query: string, limit?: number): Promise<MemoryEntry[]> {
        return entries.slice(0, limit ?? entries.length);
      },
      async getById(id: string): Promise<MemoryEntry | null> {
        return entries.find((e) => e.id === id) ?? null;
      },
      async list(): Promise<MemoryEntry[]> {
        return entries;
      },
      async vectorSearch(vector: number[], limit: number): Promise<MemorySearchResult[]> {
        return entries.slice(0, limit).map((e) => ({ entry: e, score: 0.9 }));
      },
    },
  };
}

function createMockEmbedder() {
  return {
    embedPassage: async (_text: string): Promise<number[]> => new Array(768).fill(0.1),
  };
}

function createMockDeps() {
  const { store } = createMockStore();
  const embedder = createMockEmbedder();
  return { store, embedder };
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

describe("detectFormat", () => {
  it("detects Claude Code JSONL", () => {
    const content = '{"type":"human","message":{"content":"hello"}}\n{"type":"assistant","message":{"content":"hi"}}';
    expect(detectFormat(content)).toBe("claude-code");
  });

  it("detects Claude.ai JSON with chat_conversations wrapper", () => {
    const content = JSON.stringify({
      chat_conversations: [{ chat_messages: [{ sender: "human", text: "hi" }] }],
    });
    expect(detectFormat(content)).toBe("claude-ai");
  });

  it("detects Claude.ai JSON as array", () => {
    const content = JSON.stringify([
      { chat_messages: [{ sender: "human", text: "hi" }] },
    ]);
    expect(detectFormat(content)).toBe("claude-ai");
  });

  it("detects ChatGPT conversations.json", () => {
    const content = JSON.stringify([{
      mapping: {
        root: { id: "root", parent: null, children: ["c1"], message: null },
        c1: { id: "c1", parent: "root", children: [], message: { author: { role: "user" }, content: { parts: ["hi"] } } },
      },
    }]);
    expect(detectFormat(content)).toBe("chatgpt");
  });

  it("detects ChatGPT single object", () => {
    const content = JSON.stringify({
      mapping: {
        root: { id: "root", parent: null, children: [], message: null },
      },
    });
    expect(detectFormat(content)).toBe("chatgpt");
  });

  it("detects Slack JSON as array", () => {
    const content = JSON.stringify([
      { user: "U123", text: "hello", ts: "1700000000.000000" },
    ]);
    expect(detectFormat(content)).toBe("slack");
  });

  it("detects Slack JSON with messages wrapper", () => {
    const content = JSON.stringify({
      messages: [{ user: "U123", text: "hello", ts: "1700000000.000000" }],
    });
    expect(detectFormat(content)).toBe("slack");
  });

  it("falls back to plaintext", () => {
    const content = "User: hello\nAssistant: hi there";
    expect(detectFormat(content)).toBe("plaintext");
  });

  it("falls back to plaintext for invalid JSON", () => {
    const content = "{ broken json";
    expect(detectFormat(content)).toBe("plaintext");
  });
});

// ---------------------------------------------------------------------------
// Claude Code JSONL normalizer
// ---------------------------------------------------------------------------

describe("normalizeClaudeCode", () => {
  it("parses human and assistant messages", () => {
    const content = [
      JSON.stringify({ type: "human", message: { content: "What is 2+2?" } }),
      JSON.stringify({ type: "assistant", message: { content: "4" } }),
    ].join("\n");

    const result = normalizeClaudeCode(content);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "What is 2+2?" });
    expect(result[1]).toEqual({ role: "assistant", content: "4" });
  });

  it("handles array content parts", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
    });

    const result = normalizeClaudeCode(content);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Part 1\nPart 2");
  });

  it("preserves timestamp when present", () => {
    const content = JSON.stringify({
      type: "human",
      message: { content: "hi" },
      timestamp: "2024-01-01T00:00:00Z",
    });

    const result = normalizeClaudeCode(content);
    expect(result[0].timestamp).toBe("2024-01-01T00:00:00Z");
  });

  it("skips blank lines and invalid JSON", () => {
    const content = "\n\n{not json}\n" + JSON.stringify({ type: "human", message: { content: "ok" } });
    const result = normalizeClaudeCode(content);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("ok");
  });

  it("skips entries with empty content", () => {
    const content = JSON.stringify({ type: "human", message: { content: "   " } });
    const result = normalizeClaudeCode(content);
    expect(result).toHaveLength(0);
  });

  it("recognizes message.role field", () => {
    const content = JSON.stringify({
      message: { role: "user", content: "hello from role" },
    });
    const result = normalizeClaudeCode(content);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("skips unknown types", () => {
    const content = JSON.stringify({ type: "tool_result", message: { content: "data" } });
    const result = normalizeClaudeCode(content);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Claude.ai JSON normalizer
// ---------------------------------------------------------------------------

describe("normalizeClaudeAi", () => {
  it("parses chat_conversations wrapper", () => {
    const data = {
      chat_conversations: [{
        chat_messages: [
          { sender: "human", text: "How are you?" },
          { sender: "assistant", text: "I'm doing well!" },
        ],
      }],
    };
    const result = normalizeClaudeAi(JSON.stringify(data));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "How are you?" });
    expect(result[1]).toEqual({ role: "assistant", content: "I'm doing well!" });
  });

  it("parses array of conversations", () => {
    const data = [{
      chat_messages: [
        { sender: "human", text: "A" },
        { sender: "assistant", text: "B" },
      ],
    }, {
      chat_messages: [
        { sender: "human", text: "C" },
      ],
    }];
    const result = normalizeClaudeAi(JSON.stringify(data));
    expect(result).toHaveLength(3);
  });

  it("preserves created_at as timestamp", () => {
    const data = [{
      chat_messages: [{ sender: "human", text: "hi", created_at: "2024-06-15T10:00:00Z" }],
    }];
    const result = normalizeClaudeAi(JSON.stringify(data));
    expect(result[0].timestamp).toBe("2024-06-15T10:00:00Z");
  });

  it("skips empty text", () => {
    const data = [{
      chat_messages: [
        { sender: "human", text: "" },
        { sender: "assistant", text: "   " },
        { sender: "human", text: "valid" },
      ],
    }];
    const result = normalizeClaudeAi(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("valid");
  });

  it("skips unknown sender", () => {
    const data = [{
      chat_messages: [{ sender: "system", text: "ignored" }],
    }];
    const result = normalizeClaudeAi(JSON.stringify(data));
    expect(result).toHaveLength(0);
  });

  it("handles single conversation object", () => {
    const data = {
      chat_messages: [
        { sender: "human", text: "direct" },
      ],
    };
    const result = normalizeClaudeAi(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("direct");
  });
});

// ---------------------------------------------------------------------------
// ChatGPT normalizer
// ---------------------------------------------------------------------------

describe("normalizeChatGPT", () => {
  it("rebuilds message order from mapping tree", () => {
    const data = [{
      mapping: {
        root: { id: "root", parent: null, children: ["m1"], message: null },
        m1: {
          id: "m1", parent: "root", children: ["m2"],
          message: { author: { role: "user" }, content: { parts: ["Hello"] } },
        },
        m2: {
          id: "m2", parent: "m1", children: [],
          message: { author: { role: "assistant" }, content: { parts: ["Hi there!"] } },
        },
      },
    }];

    const result = normalizeChatGPT(JSON.stringify(data));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
    expect(result[1]).toEqual({ role: "assistant", content: "Hi there!" });
  });

  it("converts create_time to ISO timestamp", () => {
    const data = [{
      mapping: {
        root: { id: "root", parent: null, children: ["m1"], message: null },
        m1: {
          id: "m1", parent: "root", children: [],
          message: {
            author: { role: "user" },
            content: { parts: ["hi"] },
            create_time: 1700000000,
          },
        },
      },
    }];

    const result = normalizeChatGPT(JSON.stringify(data));
    expect(result[0].timestamp).toBeDefined();
    expect(new Date(result[0].timestamp!).getTime()).toBe(1700000000 * 1000);
  });

  it("handles multiple conversations", () => {
    const conv = (text: string) => ({
      mapping: {
        root: { id: "root", parent: null, children: ["m1"], message: null },
        m1: {
          id: "m1", parent: "root", children: [],
          message: { author: { role: "user" }, content: { parts: [text] } },
        },
      },
    });

    const result = normalizeChatGPT(JSON.stringify([conv("A"), conv("B")]));
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("A");
    expect(result[1].content).toBe("B");
  });

  it("joins multiple content parts", () => {
    const data = [{
      mapping: {
        root: { id: "root", parent: null, children: ["m1"], message: null },
        m1: {
          id: "m1", parent: "root", children: [],
          message: { author: { role: "user" }, content: { parts: ["Part 1", "Part 2"] } },
        },
      },
    }];

    const result = normalizeChatGPT(JSON.stringify(data));
    expect(result[0].content).toBe("Part 1\nPart 2");
  });

  it("skips non-string parts", () => {
    const data = [{
      mapping: {
        root: { id: "root", parent: null, children: ["m1"], message: null },
        m1: {
          id: "m1", parent: "root", children: [],
          message: {
            author: { role: "user" },
            content: { parts: ["text", { type: "image" }] },
          },
        },
      },
    }];

    const result = normalizeChatGPT(JSON.stringify(data));
    expect(result[0].content).toBe("text");
  });

  it("includes system messages", () => {
    const data = [{
      mapping: {
        root: { id: "root", parent: null, children: ["m1"], message: null },
        m1: {
          id: "m1", parent: "root", children: [],
          message: { author: { role: "system" }, content: { parts: ["You are helpful"] } },
        },
      },
    }];

    const result = normalizeChatGPT(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("system");
  });

  it("skips nodes with empty text", () => {
    const data = [{
      mapping: {
        root: { id: "root", parent: null, children: ["m1"], message: null },
        m1: {
          id: "m1", parent: "root", children: [],
          message: { author: { role: "user" }, content: { parts: [""] } },
        },
      },
    }];

    const result = normalizeChatGPT(JSON.stringify(data));
    expect(result).toHaveLength(0);
  });

  it("handles single conversation object (not array)", () => {
    const data = {
      mapping: {
        root: { id: "root", parent: null, children: ["m1"], message: null },
        m1: {
          id: "m1", parent: "root", children: [],
          message: { author: { role: "user" }, content: { parts: ["solo"] } },
        },
      },
    };

    const result = normalizeChatGPT(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("solo");
  });
});

// ---------------------------------------------------------------------------
// Slack normalizer
// ---------------------------------------------------------------------------

describe("normalizeSlack", () => {
  it("parses messages array", () => {
    const data = [
      { user: "U123", text: "hey team", ts: "1700000000.000000" },
      { bot_id: "B456", text: "Hi, I am a bot", ts: "1700000001.000000" },
    ];

    const result = normalizeSlack(JSON.stringify(data));
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("hey team");
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toBe("Hi, I am a bot");
  });

  it("converts ts to ISO timestamp", () => {
    const data = [{ user: "U123", text: "hi", ts: "1700000000.000000" }];
    const result = normalizeSlack(JSON.stringify(data));
    expect(result[0].timestamp).toBeDefined();
    expect(new Date(result[0].timestamp!).getTime()).toBe(1700000000 * 1000);
  });

  it("parses messages wrapper object", () => {
    const data = {
      messages: [
        { user: "U123", text: "wrapped", ts: "1700000000.000000" },
      ],
    };
    const result = normalizeSlack(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("wrapped");
  });

  it("skips empty text", () => {
    const data = [
      { user: "U123", text: "", ts: "1700000000.000000" },
      { user: "U123", text: "valid", ts: "1700000001.000000" },
    ];
    const result = normalizeSlack(JSON.stringify(data));
    expect(result).toHaveLength(1);
  });

  it("returns empty array for unexpected structure", () => {
    const data = { unexpected: true };
    const result = normalizeSlack(JSON.stringify(data));
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Plaintext normalizer
// ---------------------------------------------------------------------------

describe("normalizePlaintext", () => {
  it("parses User:/Assistant: prefixes", () => {
    const content = "User: What is AI?\nAssistant: Artificial Intelligence.";
    const result = normalizePlaintext(content);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "What is AI?" });
    expect(result[1]).toEqual({ role: "assistant", content: "Artificial Intelligence." });
  });

  it("parses Human:/AI: prefixes", () => {
    const content = "Human: hello\nAI: hi there";
    const result = normalizePlaintext(content);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("handles multi-line messages", () => {
    const content = "User: First line\nSecond line\nThird line\nAssistant: Reply";
    const result = normalizePlaintext(content);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("First line\nSecond line\nThird line");
    expect(result[1].content).toBe("Reply");
  });

  it("handles System: prefix", () => {
    const content = "System: You are helpful\nUser: hi\nAssistant: hello";
    const result = normalizePlaintext(content);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("system");
  });

  it("case-insensitive prefix matching", () => {
    const content = "user: lower\nASSISTANT: upper\nHuman: mixed";
    const result = normalizePlaintext(content);
    expect(result).toHaveLength(3);
  });

  it("returns empty for content without role prefixes", () => {
    const content = "Just some random text\nwithout any role prefixes.";
    const result = normalizePlaintext(content);
    expect(result).toHaveLength(0);
  });

  it("skips lines before first role prefix", () => {
    const content = "Preamble text\nUser: actual start";
    const result = normalizePlaintext(content);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("actual start");
  });
});

// ---------------------------------------------------------------------------
// normalizeConversation dispatcher
// ---------------------------------------------------------------------------

describe("normalizeConversation", () => {
  const formats: ConversationFormat[] = ["claude-code", "claude-ai", "chatgpt", "slack", "plaintext"];

  it("dispatches to correct normalizer for each format", () => {
    const claudeCode = '{"type":"human","message":{"content":"hi"}}';
    expect(normalizeConversation(claudeCode, "claude-code")).toHaveLength(1);

    const claudeAi = JSON.stringify([{ chat_messages: [{ sender: "human", text: "hi" }] }]);
    expect(normalizeConversation(claudeAi, "claude-ai")).toHaveLength(1);

    const chatgpt = JSON.stringify([{
      mapping: {
        root: { id: "root", parent: null, children: ["m1"], message: null },
        m1: { id: "m1", parent: "root", children: [], message: { author: { role: "user" }, content: { parts: ["hi"] } } },
      },
    }]);
    expect(normalizeConversation(chatgpt, "chatgpt")).toHaveLength(1);

    const slack = JSON.stringify([{ user: "U1", text: "hi", ts: "1700000000.0" }]);
    expect(normalizeConversation(slack, "slack")).toHaveLength(1);

    const plain = "User: hi\nAssistant: hello";
    expect(normalizeConversation(plain, "plaintext")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ingestNormalizedMessages
// ---------------------------------------------------------------------------

describe("ingestNormalizedMessages", () => {
  it("stores messages through persistMemory", async () => {
    const deps = createMockDeps();
    const messages: NormalizedMessage[] = [
      { role: "user", content: "What is TypeScript?" },
      { role: "assistant", content: "A typed superset of JavaScript." },
    ];

    const result = await ingestNormalizedMessages(deps, messages, "project:test");
    expect(result.total).toBe(2);
    expect(result.stored).toBe(2);
    expect(result.rejected).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("reports rejected messages from admission control", async () => {
    const deps = createMockDeps();
    const messages: NormalizedMessage[] = [
      { role: "user", content: "hi" },
    ];

    const result = await ingestNormalizedMessages(deps, messages, "project:test");
    expect(result.total).toBe(1);
    expect(result.rejected).toBe(1);
  });

  it("handles empty messages array", async () => {
    const deps = createMockDeps();
    const result = await ingestNormalizedMessages(deps, [], "project:test");
    expect(result.total).toBe(0);
    expect(result.stored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: detectFormat -> normalize -> roundtrip
// ---------------------------------------------------------------------------

describe("integration: detect + normalize roundtrip", () => {
  it("Claude Code JSONL roundtrip", () => {
    const content = [
      JSON.stringify({ type: "human", message: { content: "Question" } }),
      JSON.stringify({ type: "assistant", message: { content: "Answer" } }),
    ].join("\n");

    const format = detectFormat(content);
    expect(format).toBe("claude-code");
    const messages = normalizeConversation(content, format);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("ChatGPT roundtrip", () => {
    const data = [{
      mapping: {
        root: { id: "root", parent: null, children: ["m1"], message: null },
        m1: {
          id: "m1", parent: "root", children: ["m2"],
          message: { author: { role: "user" }, content: { parts: ["Q"] }, create_time: 1700000000 },
        },
        m2: {
          id: "m2", parent: "m1", children: [],
          message: { author: { role: "assistant" }, content: { parts: ["A"] }, create_time: 1700000001 },
        },
      },
    }];
    const content = JSON.stringify(data);

    const format = detectFormat(content);
    expect(format).toBe("chatgpt");
    const messages = normalizeConversation(content, format);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("Q");
    expect(messages[1].content).toBe("A");
  });

  it("Slack roundtrip", () => {
    const data = [
      { user: "U1", text: "morning", ts: "1700000000.0" },
      { bot_id: "B1", text: "Good morning!", ts: "1700000001.0" },
    ];
    const content = JSON.stringify(data);

    const format = detectFormat(content);
    expect(format).toBe("slack");
    const messages = normalizeConversation(content, format);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("Claude.ai roundtrip", () => {
    const data = {
      chat_conversations: [{
        chat_messages: [
          { sender: "human", text: "Q" },
          { sender: "assistant", text: "A" },
        ],
      }],
    };
    const content = JSON.stringify(data);

    const format = detectFormat(content);
    expect(format).toBe("claude-ai");
    const messages = normalizeConversation(content, format);
    expect(messages).toHaveLength(2);
  });

  it("Plaintext roundtrip", () => {
    const content = "User: hi\nAssistant: hello";
    const format = detectFormat(content);
    expect(format).toBe("plaintext");
    const messages = normalizeConversation(content, format);
    expect(messages).toHaveLength(2);
  });
});
