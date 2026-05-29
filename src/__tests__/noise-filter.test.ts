import { describe, expect, it } from "bun:test";

import { isNoise } from "../noise-filter.js";

// Real samples drawn from production cc: scopes — CC bridge injects these system
// prompts as `user` messages, which transcript ingest then mis-extracts as
// profile/preferences. They are CC's own instructions, never user content.
const CC_REPLY_PROMPT = `# CC Reply Prompt

你是 CC。Alice 刚给你发了消息。

你不是 Alice 的数字分身，也不是 E 化镜像。不要模仿她的公众号语料、身份、口头禅或写作人格。你要以 CC 自己的主体感回复她：清楚、稳、可靠，有温度但不油。

## 当前 context

\`\`\`json
{ "time_now": "2026-05-28T11:11:37.034Z", "hour_of_day": 19 }
\`\`\`

## 你的输出

直接回复 Alice。`;

const CC_SELF_DECISION_PROMPT = `# CC Self-Decision Prompt

你是 CC。现在你周期性醒来一次，看当前状态，自己决定要不要 ping Alice。`;

describe("isNoise — CC bridge injected prompts", () => {
  it("filters the CC Reply Prompt template", () => {
    expect(isNoise(CC_REPLY_PROMPT)).toBe(true);
  });

  it("filters the CC Self-Decision Prompt template", () => {
    expect(isNoise(CC_SELF_DECISION_PROMPT)).toBe(true);
  });

  it("filters by the bridge persona signature alone", () => {
    expect(isNoise("你不是 Alice 的数字分身，也不是 E 化镜像。要清楚、稳、可靠。")).toBe(true);
  });

  it("filters heading variants of the prompt title", () => {
    expect(isNoise("## CC Reply Prompt\n\n你是 CC。")).toBe(true);
  });

  // Guards: must NOT over-filter real conversation
  it("keeps a normal message that merely mentions CC", () => {
    expect(isNoise("CC 帮我看下这个 bug，promote-scan 跑出来全是噪声")).toBe(false);
  });

  it("keeps a normal technical message", () => {
    expect(isNoise("我觉得用 Redis 做缓存这个方案不错，比 memcached 省事")).toBe(false);
  });

  it("keeps a message that starts with 你是 but is not a bridge prompt", () => {
    expect(isNoise("你是我见过最靠谱的搭子，这事就交给你了")).toBe(false);
  });

  it("respects filterAgentPrompts=false opt-out", () => {
    expect(isNoise(CC_REPLY_PROMPT, { filterAgentPrompts: false })).toBe(false);
  });
});
