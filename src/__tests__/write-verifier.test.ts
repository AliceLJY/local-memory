import { describe, it, expect } from "bun:test";
import { verifyWrite } from "../write-verifier.js";
import type { MemoryEntry } from "../store.js";

function mockStore(entry: MemoryEntry | null) {
  return {
    async get(_id: string) {
      return entry;
    },
  };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "test-id",
    text: "User prefers dark mode",
    vector: [0.1, 0.2, 0.3],
    category: "preferences",
    importance: 0.75,
    timestamp: Date.now(),
    metadata: JSON.stringify({ scope: "project:test", importance: 0.75 }),
    ...overrides,
  };
}

describe("HP-2: write-verifier", () => {
  it("passes for a complete entry", async () => {
    const result = await verifyWrite(mockStore(makeEntry()), "test-id");
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("detects missing entry", async () => {
    const result = await verifyWrite(mockStore(null), "missing-id");
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("missing_entry");
  });

  it("detects empty vector", async () => {
    const result = await verifyWrite(
      mockStore(makeEntry({ vector: [] })),
      "test-id",
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("missing_vector");
  });

  it("detects empty text", async () => {
    const result = await verifyWrite(
      mockStore(makeEntry({ text: "  " })),
      "test-id",
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("empty_text");
  });

  it("detects missing scope in metadata", async () => {
    const result = await verifyWrite(
      mockStore(makeEntry({ metadata: JSON.stringify({ importance: 0.7 }) })),
      "test-id",
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("missing_scope");
  });

  it("detects missing importance in metadata", async () => {
    const result = await verifyWrite(
      mockStore(makeEntry({ metadata: JSON.stringify({ scope: "test" }) })),
      "test-id",
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("missing_importance");
  });

  it("detects corrupt metadata", async () => {
    const result = await verifyWrite(
      mockStore(makeEntry({ metadata: "not-json" })),
      "test-id",
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("missing_scope");
  });

  it("respects enabled=false config", async () => {
    const result = await verifyWrite(mockStore(null), "any", { enabled: false });
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBe(0);
  });

  it("handles store.get timeout gracefully", async () => {
    const slowStore = {
      async get() {
        await new Promise(r => setTimeout(r, 5000));
        return null;
      },
    };
    const result = await verifyWrite(slowStore, "slow-id", { timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("missing_entry");
  });

  it("handles store.get throwing", async () => {
    const errStore = {
      async get() {
        throw new Error("db error");
      },
    };
    const result = await verifyWrite(errStore, "err-id");
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("missing_entry");
  });

  it("reports multiple issues at once", async () => {
    const result = await verifyWrite(
      mockStore(makeEntry({ text: "", vector: [], metadata: "{}" })),
      "test-id",
    );
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});
