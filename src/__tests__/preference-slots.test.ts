import { describe, expect, it } from "bun:test";

import {
  inferPreferenceSlot,
  inferReplyStylePreferenceSlot,
  inferToolChoicePreferenceSlot,
  samePreferenceSlot,
} from "../preference-slots.js";

describe("preference slots", () => {
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
