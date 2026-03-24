import { describe, it, expect } from "bun:test";
import type { DedupAction, DedupCheckResult } from "../ingest.js";

describe("DedupAction types", () => {
  it("DedupCheckResult supports secondaryDeletes", () => {
    const result: DedupCheckResult = {
      action: "store",
      reason: "unique",
      secondaryDeletes: [
        { id: "abc12345", action: "delete", reason: "outdated by candidate" },
      ],
    };
    expect(result.secondaryDeletes).toHaveLength(1);
    expect(result.secondaryDeletes![0].action).toBe("delete");
    expect(result.secondaryDeletes![0].id).toBe("abc12345");
  });

  it("DedupCheckResult without secondaryDeletes is backward-compatible", () => {
    const result: DedupCheckResult = {
      action: "skip",
      reason: "hard",
      existingText: "existing memory text",
    };
    expect(result.secondaryDeletes).toBeUndefined();
  });

  it("DedupAction only supports delete", () => {
    const action: DedupAction = {
      id: "test-id",
      action: "delete",
      reason: "superseded by newer info",
    };
    expect(action.action).toBe("delete");
  });

  it("multiple secondary deletes are valid", () => {
    const result: DedupCheckResult = {
      action: "store",
      reason: "llm-merge",
      secondaryDeletes: [
        { id: "id1", action: "delete", reason: "outdated" },
        { id: "id2", action: "delete", reason: "duplicate of id1" },
      ],
    };
    expect(result.secondaryDeletes).toHaveLength(2);
  });

  it("empty secondaryDeletes array treated as no actions", () => {
    const result: DedupCheckResult = {
      action: "store",
      reason: "unique",
      secondaryDeletes: [],
    };
    expect(result.secondaryDeletes).toHaveLength(0);
    // In practice, we check .length before executing
    expect((result.secondaryDeletes?.length ?? 0) > 0).toBe(false);
  });
});
