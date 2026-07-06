import { describe, test, expect } from "bun:test";
import { extractEventTimeFromText } from "../temporal-parser.js";

/**
 * F3 writer side: extract an ABSOLUTE event time from memory text.
 * Relative anchors ("上周" / "last month") are deliberately skipped because
 * temporal-parser resolves them against Date.now(), which mis-anchors when
 * applied to historical memory text. This suite pins that contract.
 */
describe("F3 writer: extractEventTimeFromText (absolute anchors only)", () => {
  test("ZH year+month → start of that month", () => {
    const r = extractEventTimeFromText("我们在2023年三月发布了第一版");
    expect(r).not.toBeNull();
    const d = new Date(r!.eventTime);
    expect(d.getFullYear()).toBe(2023);
    expect(d.getMonth()).toBe(2); // March = index 2
  });

  test("ZH numeric year+month → start of that month", () => {
    const r = extractEventTimeFromText("2024年7月那次迁移");
    expect(r).not.toBeNull();
    const d = new Date(r!.eventTime);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(6); // July = index 6
  });

  test("EN month+year", () => {
    const r = extractEventTimeFromText("the incident happened in March 2023 during rollout");
    expect(r).not.toBeNull();
    const d = new Date(r!.eventTime);
    expect(d.getFullYear()).toBe(2023);
    expect(d.getMonth()).toBe(2);
  });

  test("ZH standalone year → start of year", () => {
    const r = extractEventTimeFromText("这是2021年的一个老项目");
    expect(r).not.toBeNull();
    expect(new Date(r!.eventTime).getFullYear()).toBe(2021);
  });

  test("relative anchors are skipped (no Date.now mis-anchoring)", () => {
    expect(extractEventTimeFromText("我上周搬到了阿姆斯特丹")).toBeNull();
    expect(extractEventTimeFromText("moved here last month")).toBeNull();
    expect(extractEventTimeFromText("最近3天一直在调这个 bug")).toBeNull();
  });

  test("no temporal expression → null", () => {
    expect(extractEventTimeFromText("just a normal note about typescript strict mode")).toBeNull();
  });

  test("returns the matched anchor string for auditability", () => {
    const r = extractEventTimeFromText("这条经验发布于2023年三月");
    expect(r).not.toBeNull();
    expect(r!.anchor).toContain("2023");
  });
});
