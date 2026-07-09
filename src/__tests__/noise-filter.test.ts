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

  it("filters the bridge prompt output-section fragment", () => {
    expect(isNoise("## 你的输出\n\n直接回复 Alice。用双换行把回复切成自然段落。")).toBe(true);
  });

  it("filters the bridge prompt rhythm-section fragment", () => {
    expect(isNoise("节奏要求：\n\n- 短话题 1-2 条；\n- 长话题 3-5 条；\n- 每条一两句话；")).toBe(true);
  });

  // Guards: must NOT over-filter real conversation
  it("keeps a real message that happens to use the words 节奏要求", () => {
    expect(isNoise("这周节奏要求挺紧的，周五前要交稿，你帮我盯一下进度")).toBe(false);
  });

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

// Real samples drawn from the promote-scan --min-occurrences 2 candidate dump:
// long bridge self-decision / distill payloads embed structured JSON (decision
// logs, conversation history, stats). Transcript chunking splits them, so a
// JSON field-line survives as a standalone chunk after losing its { } wrapper —
// it then looks like a preference. The defining trait is an orphaned field-line
// (starts as "key":, no brace) or a severed structural token (leading , } ]).
describe("isNoise — bridge/distill context JSON fragments", () => {
  it("filters an orphan self-decision action field-line", () => {
    expect(isNoise(`"action": "silent",`)).toBe(true);
  });
  it("filters an orphan reasoning field-line", () => {
    expect(isNoise(`"reasoning": "现在是凌晨4点，在静默窗口内。她应该在睡觉。",`)).toBe(true);
  });
  it("filters an orphan conversation-history role field-line", () => {
    expect(isNoise(`"role": "assistant",`)).toBe(true);
  });
  it("filters a field-line whose leading quote was severed by chunking", () => {
    expect(isNoise(`content": "头发乱一点，比我那张更随意，有点文艺感。",`)).toBe(true);
  });
  it("filters an isolated ISO-timestamp field-line", () => {
    expect(isNoise(`"time": "2026-05-21T15:42:03.796Z"`)).toBe(true);
  });
  it("filters the bridge proprietary next_check_hint key", () => {
    expect(isNoise(`"next_check_hint": "tomorrow_morning"`)).toBe(true);
  });
  it("filters the distill proprietary distilled_at key", () => {
    expect(isNoise(`"distilled_at": "2026-05-22T05:12:13.309Z"`)).toBe(true);
  });
  it("filters the bridge proprietary alice_interaction_stats key", () => {
    expect(isNoise(`"alice_interaction_stats_7d": {`)).toBe(true);
  });
  it("filters a fragment that starts with a dangling comma (severed mid-object)", () => {
    expect(
      isNoise(`,\n  {\n    "role": "user",\n    "content": "对，就是看这个",\n    "time": "2026-05-22T12:46:19.937Z"`),
    ).toBe(true);
  });
  it("filters a multi-line self-decision JSON block", () => {
    expect(
      isNoise(`"action": "silent",\n    "message": "",\n    "reasoning": "凌晨2点，静默窗口，她在睡觉。",\n    "next_check_hint": "tomorrow_morning"`),
    ).toBe(true);
  });

  // Guards: must NOT over-filter real conversation or legitimate JSON discussion
  it("keeps a real message discussing JSON inline", () => {
    expect(isNoise(`这个配置 {"action": "silent"} 你看对不对？`)).toBe(false);
  });
  it("keeps a complete brace-wrapped JSON object as possible real discussion", () => {
    expect(isNoise(`{"action": "silent", "reasoning": "test"}`)).toBe(false);
  });
  it("keeps natural language that merely mentions a json-ish word", () => {
    expect(isNoise(`我觉得 time 管理这块你得帮我盯紧一点`)).toBe(false);
  });
  it("keeps a message that opens with an English quoted phrase", () => {
    expect(isNoise(`"hello world" 是我们的开场白，你记一下`)).toBe(false);
  });
  it("keeps a real reply that opens with a Chinese quote", () => {
    expect(isNoise(`"去上班，乖" 这句你昨天说过，我记得`)).toBe(false);
  });

  // Guards against over-filtering real code discussion — the cc bot reviews
  // code, so split chunks routinely open with closing braces/brackets.
  it("keeps a code fragment opening with a closing brace", () => {
    expect(isNoise(`} catch (e) {\n  console.error(e);\n}`)).toBe(false);
  });
  it("keeps a code fragment opening with });", () => {
    expect(isNoise(`});\n\nfunction next() { return 1; }`)).toBe(false);
  });
  it("keeps a code fragment opening with a closing bracket", () => {
    expect(isNoise(`]\n  return result;`)).toBe(false);
  });
  it("keeps an unquoted-key object/type line (no JSON string key)", () => {
    expect(isNoise(`name: string; // 字段定义`)).toBe(false);
  });
  it("keeps a diff hunk that opens with a closing brace", () => {
    expect(isNoise(`}\n\n=== DIFF: src/cli.ts ===\n@@ -1361,8 +1361,10 @@`)).toBe(false);
  });

  // Guards from Codex review: real memories that DISCUSS RecallNest's own JSON
  // schema fields inline, or paste config with object-valued keys, must survive.
  it("keeps a real memory that mentions a proprietary field name inline", () => {
    expect(isNoise(`我们刚才讨论 "distilled_at": 这个字段要不要保留`)).toBe(false);
  });
  it("keeps a config chunk opening with an object-valued key", () => {
    expect(isNoise(`"scripts": {`)).toBe(false);
  });
  it("still filters an orphan line that LEADS with a proprietary key", () => {
    expect(isNoise(`"next_check_hint": "tomorrow_morning"`)).toBe(true);
  });
});

// Regression (2026-07-10): the English greeting pattern lacked a word boundary,
// so `^hi` matched any text starting with "hi…" — hippo-wiki, history, highlight,
// hidden state, Hippocampus. Alice's core project is named hippo; every memory
// opening with it was silently rejected. Fixed by anchoring with \b.
describe("isNoise — greeting word boundary regression", () => {
  it("keeps text starting with hippo-wiki", () => {
    expect(isNoise("hippo-wiki 的索引层已清零，8 个现役工具正文补齐")).toBe(false);
  });
  it("keeps text starting with history", () => {
    expect(isNoise("history 记录显示这个 commit 有问题，需要 revert")).toBe(false);
  });
  it("keeps text starting with highlight", () => {
    expect(isNoise("highlight 一下：这里有个 bug，修复方案是加词边界")).toBe(false);
  });
  it("keeps text starting with hidden state", () => {
    expect(isNoise("hidden state 是 agent 的核心，不能只看输出")).toBe(false);
  });
  it("keeps text starting with Hippocampus", () => {
    expect(isNoise("Hippocampus 海马体的记忆巩固机制值得借鉴")).toBe(false);
  });
  it("keeps text starting with heyday", () => {
    expect(isNoise("heyday 时期的架构决策现在看仍然成立")).toBe(false);
  });

  // Real greetings must still be filtered after the fix
  it("still filters hey there", () => {
    expect(isNoise("hey there")).toBe(true);
  });
  it("still filters hello world", () => {
    expect(isNoise("hello world")).toBe(true);
  });
  it("still filters greetings from mini", () => {
    expect(isNoise("greetings from mini")).toBe(true);
  });
  it("still filters hi followed by a comma", () => {
    expect(isNoise("hi, 能帮我看下吗")).toBe(true);
  });
  it("still filters good morning with trailing words", () => {
    expect(isNoise("good morning everyone")).toBe(true);
  });
});
