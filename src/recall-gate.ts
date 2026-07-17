/**
 * Recall gate — pre-retrieval triage for auto-recall traffic.
 *
 * Borrowed from memory-lancedb-pro's adaptive-retrieval, reshaped per Codex
 * review (2026-07-17) into a three-way verdict instead of a binary SKIP/FORCE:
 *
 *   - "full-recall":  message explicitly reaches for memory ("记得/上次/my
 *                     preference") — always run resume + focused search.
 *   - "resume-only":  bare continuity nudges ("继续", "下一步", "开始吧") —
 *                     they need checkpoint/continuity, not an embedding search
 *                     over their own two characters.
 *   - "skip-all":     greetings, slash commands, heartbeats, whole-message
 *                     acks, pure emoji, bare CLI invocations — no memory value.
 *   - "pass":         no rule matched — default full pipeline.
 *
 * Rollout is governed by RECALLNEST_RECALL_GATE (observe-before-enforce,
 * shared-behaviors §5): "observe" (default) computes the verdict and appends a
 * shadow-log line but never changes behavior; "enforce" acts on the verdict;
 * "off" disables even the shadow logging. Shadow entries carry rule id,
 * message length, and decision — never the message text itself.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./env-config.js";

export type RecallGateDecision = "full-recall" | "resume-only" | "skip-all" | "pass";

export interface RecallGateResult {
  decision: RecallGateDecision;
  /** Stable rule identifier, e.g. "force:memory-cue", "skip:ack", "pass:long". */
  ruleId: string;
}

export type RecallGateMode = "observe" | "enforce" | "off";

/** RECALLNEST_RECALL_GATE: unset/invalid → "observe" (shadow-only default). */
export function resolveRecallGateMode(env: NodeJS.ProcessEnv = process.env): RecallGateMode {
  const raw = (env.RECALLNEST_RECALL_GATE || "").trim().toLowerCase();
  if (raw === "enforce") return "enforce";
  if (raw === "off") return "off";
  return "observe";
}

// Short-text rules below only ever fire on messages up to this length; longer
// messages carry enough content to always deserve the full pipeline.
const SHORT_TEXT_MAX_CHARS = 80;

// --- full-recall cues (substring, any position, force-first per review) ---

const FORCE_CUES_ZH = [
  "记得",
  "回忆",
  "想起",
  "上次",
  "上回",
  "之前讨论",
  "之前说",
  "之前聊",
  "之前提",
  "我的偏好",
  "我说过",
  "你说过",
  "说过吗",
  "存过",
  "记过",
  "提醒过",
];

// Word-bounded and hyphen/underscore-guarded: "recall" must not fire on
// "auto-recall" or "recall-gate.test.ts" (identifiers, not memory intent).
const FORCE_CUES_EN = [
  /(?<![\w-])remember(?![\w-])/,
  /(?<![\w-])recall(?![\w-])/,
  /(?<![\w-])last time(?![\w-])/,
  /(?<![\w-])previously(?![\w-])/,
  /(?<![\w-])we discussed(?![\w-])/,
  /(?<![\w-])my preferences?(?![\w-])/,
  /(?<![\w-])you said(?![\w-])/,
  /(?<![\w-])i told you(?![\w-])/,
];

// --- resume-only: whole-message continuity nudges ---

// Matched against the whole message after trailing particles/punctuation are
// stripped, so "继续吧" hits but "继续讨论刚才的方案" (real content) passes.
const RESUME_PHRASES = new Set([
  "继续",
  "接着",
  "接着来",
  "接着做",
  "接着干",
  "接着说",
  "继续做",
  "继续干",
  "下一步",
  "开始",
  "开工",
  "走起",
  "往下",
  "往下走",
  "continue",
  "go on",
  "next",
  "next step",
  "resume",
  "keep going",
  "carry on",
  "proceed",
  "pick up where we left off",
]);

// --- skip-all: whole-message greetings & acks ---

const GREETINGS = new Set([
  "你好",
  "您好",
  "哈喽",
  "嗨",
  "早",
  "早上好",
  "早安",
  "中午好",
  "下午好",
  "晚上好",
  "晚安",
  "在吗",
  "在不在",
  "在么",
  "hi",
  "hello",
  "hey",
  "yo",
  "good morning",
  "good night",
  "good evening",
  "morning",
  "gm",
  "gn",
]);

const ACK_WORDS = new Set([
  "好的",
  "好",
  "好嘞",
  "好滴",
  "好呀",
  "嗯",
  "嗯嗯",
  "哦",
  "噢",
  "喔",
  "行",
  "可以",
  "可",
  "没问题",
  "没事",
  "收到",
  "明白",
  "了解",
  "知道了",
  "懂了",
  "对",
  "对的",
  "是",
  "是的",
  "不用",
  "不用了",
  "谢谢",
  "谢了",
  "多谢",
  "辛苦了",
  "辛苦",
  "牛",
  "赞",
  "棒",
  "妙",
  "ok",
  "okay",
  "k",
  "kk",
  "yes",
  "yep",
  "yeah",
  "no",
  "nope",
  "sure",
  "thanks",
  "thank you",
  "thx",
  "ty",
  "cool",
  "nice",
  "great",
  "done",
  "got it",
  "will do",
]);

// Bare CLI invocations ("git push", "npm test"). A leading tool name alone is
// not enough — the rest must look like arguments, not prose: any CJK character
// or question mark ("git 为什么失败", "why does npm test hang?") disqualifies.
const CLI_SHAPE =
  /^(git|npm|npx|bun|bunx|yarn|pnpm|node|python3?|pip3?|cargo|make|docker|kubectl|brew|ssh|ls|cd|cat|grep|curl)(\s+[^㐀-鿿?？]*)?$/i;

// Emoji message test: strip whitespace, then require every remaining unit to
// be pictographic or an emoji modifier. \p{Extended_Pictographic} deliberately
// excludes bare digits/#/* (they only render as emoji inside keycap sequences
// with U+FE0F+U+20E3), so "42" and "#1" fall through to "pass".
const EMOJI_UNIT =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}])+$/u;

// Trailing tone particles + punctuation tolerated on whole-message matches
// ("好的吧。", "继续吧!", "开始咯~").
const TRAILING_FLUFF = /[吧呗啊呀哦嘛喽咯哈嘞捏诶欸了]*[\s。，,.!！?？~〜…‥·、;；:：'"'"()（）]*$/u;

function stripTrailingFluff(text: string): string {
  return text.replace(TRAILING_FLUFF, "");
}

function normalize(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function isAckMessage(lower: string): boolean {
  const stripped = stripTrailingFluff(lower);
  if (!stripped) return false;
  if (ACK_WORDS.has(stripped)) return true;
  // Multi-token acks ("好的 谢谢", "ok thanks"): every token must be an ack word.
  const tokens = stripped.split(/[\s,，。!！~]+/).filter(Boolean);
  return tokens.length > 1 && tokens.every((t) => ACK_WORDS.has(stripTrailingFluff(t)));
}

/**
 * Classify one auto-recall message. Pure and deterministic — call order is
 * force cues → length guard → structural skips → whole-message skips →
 * resume nudges → default pass.
 */
export function classifyRecallGate(message: string): RecallGateResult {
  const text = normalize(message);
  if (!text) return { decision: "skip-all", ruleId: "skip:empty" };
  const lower = text.toLowerCase();

  // 1. Force cues outrank every short-text rule ("可以按上次方案做" must not
  //    be swallowed by the ack rule).
  for (const cue of FORCE_CUES_ZH) {
    if (text.includes(cue)) return { decision: "full-recall", ruleId: "force:memory-cue-zh" };
  }
  for (const cue of FORCE_CUES_EN) {
    if (cue.test(lower)) return { decision: "full-recall", ruleId: "force:memory-cue-en" };
  }

  // 2. Long messages always deserve the full pipeline.
  if (text.length > SHORT_TEXT_MAX_CHARS) return { decision: "pass", ruleId: "pass:long" };

  // 3. Structural skips.
  if (/^\/\S+/.test(text)) return { decision: "skip-all", ruleId: "skip:slash" };
  if (/^HEARTBEAT/i.test(text)) return { decision: "skip-all", ruleId: "skip:heartbeat" };
  if (EMOJI_UNIT.test(text.replace(/\s+/g, ""))) {
    return { decision: "skip-all", ruleId: "skip:emoji" };
  }
  if (text.length <= 60 && CLI_SHAPE.test(text)) {
    return { decision: "skip-all", ruleId: "skip:cli" };
  }

  // 4. Whole-message conversational skips.
  const strippedLower = stripTrailingFluff(lower);
  if (GREETINGS.has(strippedLower)) return { decision: "skip-all", ruleId: "skip:greeting" };
  if (isAckMessage(lower)) return { decision: "skip-all", ruleId: "skip:ack" };

  // 5. Continuity nudges → resume context without a focused search.
  if (RESUME_PHRASES.has(strippedLower)) {
    return { decision: "resume-only", ruleId: "resume:continuity" };
  }

  return { decision: "pass", ruleId: "pass:default" };
}

// --- shadow log (observe-before-enforce evidence trail) ---

export interface RecallGateShadowEntry {
  ts: string;
  decision: RecallGateDecision;
  ruleId: string;
  msgLen: number;
  mode: Exclude<RecallGateMode, "off">;
  /** Caller-provided origin, e.g. "api:/v1/auto-recall". Never message text. */
  source?: string;
}

export const RECALL_GATE_SHADOW_FILE = "recall-gate-shadow.jsonl";

/**
 * Append one shadow-log line under dataDir(). Must never block or throw —
 * gate telemetry failing is strictly better than recall failing.
 */
export function logRecallGateShadow(entry: RecallGateShadowEntry): void {
  try {
    const dir = dataDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, RECALL_GATE_SHADOW_FILE), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Shadow logging is best-effort by design.
  }
}
