import { describe, expect, it } from "bun:test";

import {
  inferPreferenceSlot,
  inferAtomicBrandItemPreferenceSlot,
  parseBrandItemPreference,
  inferReplyStylePreferenceSlot,
  inferToolChoicePreferenceSlot,
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
});
