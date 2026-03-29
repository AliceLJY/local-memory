import { describe, expect, it } from "bun:test";
import {
  parseTemporalQuery,
  matchesTemporalConstraint,
  temporalWhereClause,
  type TemporalConstraint,
} from "../temporal-parser.js";

// ============================================================================
// parseTemporalQuery
// ============================================================================

describe("parseTemporalQuery", () => {
  // --- Absolute year (ZH) ---
  it("parses '2023年的记忆'", () => {
    const result = parseTemporalQuery("2023年的记忆里有什么");
    expect(result.constraint).not.toBeNull();
    expect(result.constraint!.type).toBe("range");
    expect(result.constraint!.startMs).toBe(new Date(2023, 0, 1).getTime());
    expect(result.constraint!.endMs).toBe(new Date(2024, 0, 1).getTime() - 1);
    // Time expression removed from cleaned query
    expect(result.cleanedQuery).not.toContain("2023年");
    expect(result.cleanedQuery).toContain("里有什么");
  });

  it("parses standalone '2024年'", () => {
    const result = parseTemporalQuery("关于 2024年 的项目");
    expect(result.constraint).not.toBeNull();
    expect(result.constraint!.type).toBe("range");
  });

  // --- Absolute year+month (ZH) ---
  it("parses '2023年3月'", () => {
    const result = parseTemporalQuery("2023年3月我们讨论了什么");
    expect(result.constraint).not.toBeNull();
    expect(result.constraint!.startMs).toBe(new Date(2023, 2, 1).getTime());
    expect(result.constraint!.endMs).toBe(new Date(2023, 3, 1).getTime() - 1);
  });

  it("parses '2023年三月'", () => {
    const result = parseTemporalQuery("2023年三月的对话");
    expect(result.constraint).not.toBeNull();
    expect(result.constraint!.startMs).toBe(new Date(2023, 2, 1).getTime());
  });

  // --- Absolute year+month (EN) ---
  it("parses 'March 2023'", () => {
    const result = parseTemporalQuery("What did we discuss in March 2023");
    expect(result.constraint).not.toBeNull();
    expect(result.constraint!.startMs).toBe(new Date(2023, 2, 1).getTime());
    expect(result.constraint!.endMs).toBe(new Date(2023, 3, 1).getTime() - 1);
  });

  // --- "in YYYY" ---
  it("parses 'in 2022'", () => {
    const result = parseTemporalQuery("Projects discussed in 2022");
    expect(result.constraint).not.toBeNull();
    expect(result.constraint!.type).toBe("range");
    expect(result.constraint!.startMs).toBe(new Date(2022, 0, 1).getTime());
  });

  // --- Relative: 最近N天/周/月 ---
  it("parses '最近7天'", () => {
    const result = parseTemporalQuery("最近7天的记忆");
    expect(result.constraint).not.toBeNull();
    expect(result.constraint!.type).toBe("range");
    const now = Date.now();
    expect(result.constraint!.startMs).toBeGreaterThan(now - 8 * 86_400_000);
    expect(result.constraint!.endMs).toBeLessThanOrEqual(now + 1000);
  });

  it("parses '最近2周'", () => {
    const result = parseTemporalQuery("最近2周讨论过什么");
    expect(result.constraint).not.toBeNull();
    const now = Date.now();
    expect(result.constraint!.startMs).toBeGreaterThan(now - 15 * 86_400_000);
  });

  it("parses '最近3个月'", () => {
    const result = parseTemporalQuery("最近3个月的项目进展");
    expect(result.constraint).not.toBeNull();
    const now = Date.now();
    expect(result.constraint!.startMs).toBeGreaterThan(now - 100 * 86_400_000);
  });

  // --- Relative: last N days/weeks/months ---
  it("parses 'last 30 days'", () => {
    const result = parseTemporalQuery("What happened in the last 30 days");
    expect(result.constraint).not.toBeNull();
    expect(result.constraint!.type).toBe("range");
    const now = Date.now();
    expect(result.constraint!.startMs).toBeGreaterThan(now - 31 * 86_400_000);
  });

  it("parses 'last 2 weeks'", () => {
    const result = parseTemporalQuery("Changes in the last 2 weeks");
    expect(result.constraint).not.toBeNull();
  });

  // --- Relative: 上周/上个月/去年 ---
  it("parses '去年'", () => {
    const result = parseTemporalQuery("去年我们做了什么项目");
    expect(result.constraint).not.toBeNull();
    const lastYear = new Date().getFullYear() - 1;
    expect(result.constraint!.startMs).toBe(new Date(lastYear, 0, 1).getTime());
    expect(result.constraint!.endMs).toBe(new Date(lastYear + 1, 0, 1).getTime() - 1);
  });

  it("parses 'last year'", () => {
    const result = parseTemporalQuery("Projects from last year");
    expect(result.constraint).not.toBeNull();
    expect(result.constraint!.type).toBe("range");
  });

  it("parses '上个月'", () => {
    const result = parseTemporalQuery("上个月的讨论");
    expect(result.constraint).not.toBeNull();
  });

  it("parses '去年3月'", () => {
    const result = parseTemporalQuery("去年3月的事情");
    expect(result.constraint).not.toBeNull();
    const lastYear = new Date().getFullYear() - 1;
    expect(result.constraint!.startMs).toBe(new Date(lastYear, 2, 1).getTime());
  });

  // --- Operator syntax ---
  it("parses 'after:2024-01'", () => {
    const result = parseTemporalQuery("TypeScript projects after:2024-01");
    expect(result.constraint).not.toBeNull();
    expect(result.constraint!.type).toBe("after");
    expect(result.constraint!.startMs).toBe(new Date(2024, 0, 1).getTime());
    expect(result.cleanedQuery).toContain("TypeScript projects");
  });

  it("parses 'before:2025-06'", () => {
    const result = parseTemporalQuery("memory entries before:2025-06");
    expect(result.constraint).not.toBeNull();
    expect(result.constraint!.type).toBe("before");
  });

  // --- No temporal expression ---
  it("returns null for non-temporal queries", () => {
    const result = parseTemporalQuery("How to configure TypeScript");
    expect(result.constraint).toBeNull();
    expect(result.cleanedQuery).toBe("How to configure TypeScript");
  });

  it("returns null for empty query", () => {
    const result = parseTemporalQuery("");
    expect(result.constraint).toBeNull();
  });

  // --- Cleaned query ---
  it("removes temporal expression and preserves the rest", () => {
    const result = parseTemporalQuery("2023年我们讨论了 Docker 配置");
    expect(result.cleanedQuery).toContain("Docker");
    expect(result.cleanedQuery).not.toContain("2023年");
  });
});

// ============================================================================
// matchesTemporalConstraint
// ============================================================================

describe("matchesTemporalConstraint", () => {
  it("matches timestamp within range", () => {
    const constraint: TemporalConstraint = {
      type: "range",
      startMs: new Date(2023, 0, 1).getTime(),
      endMs: new Date(2024, 0, 1).getTime() - 1,
      anchor: "2023年",
    };
    const mid2023 = new Date(2023, 6, 1).getTime();
    expect(matchesTemporalConstraint(mid2023, constraint)).toBe(true);
  });

  it("rejects timestamp outside range", () => {
    const constraint: TemporalConstraint = {
      type: "range",
      startMs: new Date(2023, 0, 1).getTime(),
      endMs: new Date(2024, 0, 1).getTime() - 1,
      anchor: "2023年",
    };
    const mid2022 = new Date(2022, 6, 1).getTime();
    expect(matchesTemporalConstraint(mid2022, constraint)).toBe(false);
  });

  it("handles 'after' constraint", () => {
    const constraint: TemporalConstraint = {
      type: "after",
      startMs: new Date(2024, 0, 1).getTime(),
      anchor: "after:2024-01",
    };
    expect(matchesTemporalConstraint(new Date(2024, 6, 1).getTime(), constraint)).toBe(true);
    expect(matchesTemporalConstraint(new Date(2023, 6, 1).getTime(), constraint)).toBe(false);
  });

  it("handles 'before' constraint", () => {
    const constraint: TemporalConstraint = {
      type: "before",
      endMs: new Date(2024, 0, 1).getTime(),
      anchor: "before:2024-01",
    };
    expect(matchesTemporalConstraint(new Date(2023, 6, 1).getTime(), constraint)).toBe(true);
    expect(matchesTemporalConstraint(new Date(2025, 0, 1).getTime(), constraint)).toBe(false);
  });
});

// ============================================================================
// temporalWhereClause
// ============================================================================

describe("temporalWhereClause", () => {
  it("generates range clause", () => {
    const clause = temporalWhereClause({
      type: "range",
      startMs: 1000,
      endMs: 2000,
      anchor: "test",
    });
    expect(clause).toBe("timestamp >= 1000 AND timestamp <= 2000");
  });

  it("generates after-only clause", () => {
    const clause = temporalWhereClause({
      type: "after",
      startMs: 1000,
      anchor: "test",
    });
    expect(clause).toBe("timestamp >= 1000");
  });

  it("returns null for empty constraint", () => {
    const clause = temporalWhereClause({
      type: "range",
      anchor: "test",
    });
    expect(clause).toBeNull();
  });
});
