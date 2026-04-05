import { describe, expect, it } from "bun:test";

import {
  inferPreferenceSlot,
  inferAtomicBrandItemPreferenceSlot,
  parseBrandItemPreference,
  inferReplyStylePreferenceSlot,
  inferToolChoicePreferenceSlot,
  inferImplicitUsageSlot,
  samePreferenceSlot,
} from "../preference-slots.js";

describe("preference slots", () => {
  it("parses Chinese and English brand-item preferences", () => {
    expect(parseBrandItemPreference("我喜欢喝星巴克的抹茶拿铁")).toEqual({
      brand: "星巴克",
      items: ["抹茶拿铁"],
      aggregate: false,
    });

    expect(parseBrandItemPreference("我喜欢吃麦当劳的麦旋风、板烧鸡腿堡和藤椒鸡派")).toEqual({
      brand: "麦当劳",
      items: ["麦旋风", "板烧鸡腿堡", "藤椒鸡派"],
      aggregate: true,
    });

    expect(parseBrandItemPreference("I like the Big Mac from McDonald's")).toEqual({
      brand: "mcdonald's",
      items: ["bigmac"],
      aggregate: false,
    });

    expect(parseBrandItemPreference("我们刚讨论过星巴克的抹茶拿铁做法")).toBeNull();
  });

  it("infers atomic brand-item slots and skips aggregate preferences", () => {
    expect(inferAtomicBrandItemPreferenceSlot("我喜欢喝星巴克的抹茶拿铁")).toEqual({
      type: "brand-item",
      brand: "星巴克",
      item: "抹茶拿铁",
    });

    expect(inferAtomicBrandItemPreferenceSlot("I like Big Mac from McDonald's")).toEqual({
      type: "brand-item",
      brand: "mcdonald's",
      item: "bigmac",
    });

    expect(samePreferenceSlot(
      inferAtomicBrandItemPreferenceSlot("I like the Big Mac from McDonald's"),
      inferAtomicBrandItemPreferenceSlot("I like Big Mac from McDonald's"),
    )).toBe(true);

    expect(inferAtomicBrandItemPreferenceSlot("我喜欢吃麦当劳的麦旋风、板烧鸡腿堡")).toBeNull();
  });

  it("infers reply-style traits from explicit reply-style preferences", () => {
    expect(inferReplyStylePreferenceSlot("User prefers concise, direct replies.")).toEqual({
      type: "reply-style",
      traits: ["concise", "direct"],
    });

    expect(inferReplyStylePreferenceSlot("用户不接受浮夸/营销腔，语气要口语化、不端着。")).toEqual({
      type: "reply-style",
      traits: ["colloquial", "grounded"],
    });
  });

  it("can infer reply-style slots from compact trait phrases", () => {
    expect(inferPreferenceSlot("用户偏好短句直说。")).toEqual({
      type: "reply-style",
      traits: ["concise", "direct"],
    });
  });

  it("ignores descriptive non-preference text for reply-style and tool-choice parsing", () => {
    expect(inferReplyStylePreferenceSlot("这段文案简洁直接，先别改。")).toBeNull();
    expect(inferReplyStylePreferenceSlot("这段文案挺口语化，先别改。")).toBeNull();
    expect(inferToolChoicePreferenceSlot("文档里写了 uses Bun over Node 的迁移说明。")).toBeNull();
  });

  it("compares reply-style slots by normalized trait sets", () => {
    expect(samePreferenceSlot(
      inferReplyStylePreferenceSlot("User prefers concise, direct replies."),
      inferReplyStylePreferenceSlot("User prefers direct concise responses."),
    )).toBe(true);

    expect(samePreferenceSlot(
      inferReplyStylePreferenceSlot("User prefers concise, direct replies."),
      inferReplyStylePreferenceSlot("User prefers colloquial grounded replies."),
    )).toBe(false);
  });

  it("infers tool-choice slots from explicit comparative preferences", () => {
    expect(inferToolChoicePreferenceSlot("Uses Bun over Node.")).toEqual({
      type: "tool-choice",
      preferredTool: "bun",
      avoidedTool: "node",
    });

    expect(inferToolChoicePreferenceSlot("更喜欢用 rg 而不是 grep")).toEqual({
      type: "tool-choice",
      preferredTool: "rg",
      avoidedTool: "grep",
    });
  });

  it("detects implicit usage preferences from 'I use X' patterns", () => {
    expect(inferImplicitUsageSlot("I use Adobe Premiere Pro for video editing.")).toEqual({
      type: "implicit-usage",
      subject: "adobepremierepro",
    });

    expect(inferImplicitUsageSlot("User uses Python for data analysis.")).toEqual({
      type: "implicit-usage",
      subject: "python",
    });

    expect(inferImplicitUsageSlot("I have been using VS Code.")).toEqual({
      type: "implicit-usage",
      subject: "vscode",
    });
  });

  it("detects implicit ownership preferences from 'I have X' patterns", () => {
    expect(inferImplicitUsageSlot("I have a Sony A7III camera")).toEqual({
      type: "implicit-usage",
      subject: "sonya7iii",
    });

    expect(inferImplicitUsageSlot("User bought a Canon EOS R5 camera")).toEqual({
      type: "implicit-usage",
      subject: "canoneosr5",
    });
  });

  it("detects implicit activity preferences from 'I enjoy X' patterns", () => {
    expect(inferImplicitUsageSlot("I enjoy hiking.")).toEqual({
      type: "implicit-usage",
      subject: "hiking",
    });

    expect(inferImplicitUsageSlot("User loves ocean views.")).toEqual({
      type: "implicit-usage",
      subject: "oceanviews",
    });

    expect(inferImplicitUsageSlot("I really like photography.")).toEqual({
      type: "implicit-usage",
      subject: "photography",
    });
  });

  it("detects implicit interest preferences from 'I'm learning X' patterns", () => {
    expect(inferImplicitUsageSlot("I'm learning Spanish.")).toEqual({
      type: "implicit-usage",
      subject: "spanish",
    });

    expect(inferImplicitUsageSlot("User is interested in machine learning.")).toEqual({
      type: "implicit-usage",
      subject: "machinelearning",
    });
  });

  it("detects Chinese implicit usage preferences", () => {
    expect(inferImplicitUsageSlot("我在用Figma做设计。")).toEqual({
      type: "implicit-usage",
      subject: "figma",
    });

    expect(inferImplicitUsageSlot("我在学西班牙语。")).toEqual({
      type: "implicit-usage",
      subject: "西班牙语",
    });
  });

  it("rejects short/empty implicit usage subjects", () => {
    // "I use it" → subject "it" normalizes to 2 chars — at threshold
    expect(inferImplicitUsageSlot("I use a.")).toBeNull();
  });

  it("explicit patterns take priority over implicit in inferPreferenceSlot", () => {
    // "I like Big Mac from McDonald's" → brand-item, not implicit-usage
    expect(inferPreferenceSlot("I like Big Mac from McDonald's")?.type).toBe("brand-item");

    // "Uses Bun over Node." → tool-choice, not implicit-usage
    expect(inferPreferenceSlot("Uses Bun over Node.")?.type).toBe("tool-choice");

    // "I use Adobe Premiere Pro for video editing." → implicit-usage (no explicit pattern matches)
    expect(inferPreferenceSlot("I use Adobe Premiere Pro for video editing.")?.type).toBe("implicit-usage");
  });

  it("compares implicit-usage slots by normalized subject", () => {
    expect(samePreferenceSlot(
      inferImplicitUsageSlot("I use Adobe Premiere Pro."),
      inferImplicitUsageSlot("User uses Adobe Premiere Pro for editing."),
    )).toBe(true);

    expect(samePreferenceSlot(
      inferImplicitUsageSlot("I use Premiere Pro."),
      inferImplicitUsageSlot("I use DaVinci Resolve."),
    )).toBe(false);
  });
});
