import { describe, expect, it } from "bun:test";

import { planDedup, type DedupRow } from "../../scripts/migrate-dedup-ids.js";

/**
 * P0-2 迁移脚本核心逻辑回归。LanceDB I/O 部分（main）由「在备份副本上实跑」做集成验证；
 * 这里只测纯 keeper 选择：同 id 保留最新 timestamp（importance 破平）、每 id 唯一、不丢文本。
 */

function row(id: string, ts: number, importance: number, text: string): DedupRow {
  return { id, timestamp: ts, importance, text, vector: [0, 0, 0], scope: "s", category: "entities", metadata: "{}" };
}

describe("planDedup (dup-id migration keeper selection)", () => {
  it("keeps the latest-timestamp row per dup id and counts extras", () => {
    const rows = [
      row("dup1", 100, 0.5, "A"),
      row("dup1", 300, 0.6, "A"), // latest ts → keeper
      row("dup1", 200, 0.9, "A"),
      row("uniq", 150, 0.5, "B"),
    ];
    const plan = planDedup(rows);
    expect(plan.dupIds).toEqual(["dup1"]);
    expect(plan.extraRows).toBe(2);
    expect(plan.keepers.length).toBe(1);
    expect(Number(plan.keepers[0].timestamp)).toBe(300);
  });

  it("breaks timestamp ties by highest importance", () => {
    const rows = [
      row("d", 500, 0.4, "X"),
      row("d", 500, 0.95, "X"), // same ts, higher importance → keeper
      row("d", 500, 0.7, "X"),
    ];
    const plan = planDedup(rows);
    expect(plan.keepers.length).toBe(1);
    expect(plan.keepers[0].importance).toBe(0.95);
  });

  it("leaves unique ids untouched and preserves every distinct id's text", () => {
    const rows = [
      row("a", 1, 0.5, "textA"),
      row("a", 2, 0.5, "textA"), // dup
      row("b", 1, 0.5, "textB"), // unique
      row("c", 1, 0.5, "textC"),
      row("c", 5, 0.5, "textC"), // dup
    ];
    const plan = planDedup(rows);
    const dupSet = new Set(plan.dupIds);
    // Simulate the migration result: untouched unique-id rows + one keeper per dup id.
    const survivors = [...rows.filter((r) => !dupSet.has(r.id)), ...plan.keepers];
    const ids = survivors.map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b", "c"]); // every distinct id survives
    expect(new Set(ids).size).toBe(ids.length); // each id appears exactly once
    expect(survivors.find((r) => r.id === "a")!.text).toBe("textA");
    expect(survivors.find((r) => r.id === "c")!.text).toBe("textC");
  });

  it("returns an empty plan when there are no duplicates", () => {
    const plan = planDedup([row("x", 1, 0.5, "1"), row("y", 2, 0.5, "2")]);
    expect(plan.dupIds).toEqual([]);
    expect(plan.extraRows).toBe(0);
    expect(plan.keepers).toEqual([]);
  });
});
