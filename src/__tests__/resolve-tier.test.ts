import { describe, expect, it } from "bun:test";

import { isDecayExempt, resolveTier } from "../decay-engine.js";

/**
 * importance 是 MemoryEntry 的列字段，metadata 里没有它——顶层住着的是
 * accessCount / lastAccessedAt / tier（access-tracker 写的）。所以 heuristic
 * 分支必须由调用方把 entry.importance 传进来。
 * 2026-07 实测：全库 115688 行里 3214 行走这个分支，其中 metadata 顶层有
 * importance 的是 0 行——也就是这些条目当时全部被压成了 peripheral。
 */
function meta(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ source: "cc", evolution: { status: "active" }, ...extra });
}

describe("resolveTier", () => {
  it("拿到 entry.importance 时，高 importance 条目升到对应档位", () => {
    // 真实样本形状：importance 0.9 的 patterns，此前一直被判 peripheral
    expect(resolveTier(meta(), 0.9)).toBe("working");
    expect(resolveTier(meta(), 0.96)).toBe("core");
    expect(resolveTier(meta(), 0.5)).toBe("peripheral");
  });

  it("不传 entry.importance 时退回 0——这正是修复前的行为", () => {
    // 保持向后兼容：老调用方不传就还是老结果，不会炸
    expect(resolveTier(meta(), undefined)).toBe("peripheral");
    expect(resolveTier(meta())).toBe("peripheral");
  });

  it("显式 tier 优先，entry.importance 不能覆盖它", () => {
    // access-tracker 算过一次就会把 tier 写进顶层，那是权威值
    expect(resolveTier(meta({ tier: "peripheral" }), 0.99)).toBe("peripheral");
    expect(resolveTier(meta({ tier: "core" }), 0.1)).toBe("core");
  });

  it("metadata 顶层真有 importance 时以它为准", () => {
    // 顺序：meta.importance > entryImportance > 0
    expect(resolveTier(meta({ importance: 0.85 }), 0.1)).toBe("working");
  });

  it("accessCount 仍走 metadata 顶层——那是 access-tracker 实际写入的位置", () => {
    expect(resolveTier(meta({ accessCount: 10 }), 0.1)).toBe("core");
    expect(resolveTier(meta({ accessCount: 3 }), 0.1)).toBe("working");
  });

  it("没有 metadata 或解析失败时给 peripheral", () => {
    expect(resolveTier(undefined, 0.99)).toBe("peripheral");
    expect(resolveTier("{ 坏掉的 json", 0.99)).toBe("peripheral");
  });
});

describe("isDecayExempt", () => {
  it("core + 高 importance 免衰减——importance 来自入参而非 metadata", () => {
    // 修复前：resolveTierFromMeta 读不到 importance，tier 恒为 peripheral，
    // 于是这条规则对没有显式 tier 的条目从来没生效过。
    const noExplicitTier = JSON.stringify({ source: "cc", lastAccessedAt: 0 });
    expect(isDecayExempt(noExplicitTier, 0.96)).toBe(true);
  });

  it("importance 不够高时不豁免", () => {
    const noExplicitTier = JSON.stringify({ source: "cc", lastAccessedAt: 0 });
    expect(isDecayExempt(noExplicitTier, 0.9)).toBe(false);
  });
});
