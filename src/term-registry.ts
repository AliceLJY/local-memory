export const CONTINUITY_TASK_TERMS = [
  "新窗口",
  "fresh window",
  "new window",
  "cross window",
  "跨窗口",
  "接力",
  "handoff",
  "resume",
  "session",
  "checkpoint",
  "continuity",
  "terminal",
];

export const WORKFLOW_CUE_TERMS = [
  "search_memory",
  "resume_context",
  "checkpoint_session",
  "checkpoint",
  "autorecall",
  "sessionstrategy",
  "workflow",
  "pattern",
  "流程",
  "步骤",
  "模板",
];

export const STRONG_WORKFLOW_CUE_TERMS = [
  "search_memory",
  "resume_context",
  "checkpoint_session",
  "checkpoint",
  "autorecall",
  "sessionstrategy",
];

export const CONTINUITY_WORKFLOW_CUE_GROUPS = [
  { key: "search_memory", terms: ["search_memory"] },
  { key: "resume_context", terms: ["resume_context"] },
  { key: "checkpoint", terms: ["checkpoint_session", "latest_checkpoint", "checkpoint"] },
];

export const STABLE_INSTRUCTION_PREFIXES = [
  "再看看",
  "看看",
  "查看",
  "让我",
  "帮我",
  "继续",
  "接着",
  "排查",
  "处理",
  "同步",
  "确认",
  "检查",
  "测试",
  "review",
  "inspect",
  "check",
  "look at",
  "continue",
  "help me",
  "let me",
];

export const STABLE_LOW_SIGNAL_TERMS = [
  "本地没 clone",
  "远程最新状态",
  "setup 脚本和项目结构",
  "setup script and project structure",
  "继续讨论",
  "读完了",
  "整理一下关键发现",
  "github.com/",
  "https://",
  "http://",
];

export const TASK_RESULT_LOW_SIGNAL_TERMS = [
  "https://",
  "http://",
  "github.com/",
  "笑不活了",
  "open issues",
  "issue 还在",
  "issue still",
  "关闭啊",
  "让我看看",
  "看一下",
  "没问题？",
];

export const TASK_RESULT_PLANISH_TERMS = [
  "我先",
  "先看",
  "先查",
  "先补",
  "先改",
  "先确认",
  "我要",
  "准备",
  "接下来",
  "会先",
  "i'll",
  "i will",
  "let me",
  "going to",
  "next i",
];

export const TASK_RESULT_SPECIFICITY_GROUPS = [
  {
    resultTerms: ["mcp transport", "transport rollout", "transport regression"],
    taskTerms: ["mcp transport", "transport", "mcp", "rollout", "relay", "adapter", "传输"],
  },
  {
    resultTerms: ["smoke:claude-continuity", "headless claude code continuity smoke", "continuity smoke"],
    taskTerms: ["smoke", "claude-continuity", "acceptance", "验收", "headless"],
  },
];

export const GENERIC_SCOPE_TERMS = new Set([
  "project",
  "session",
  "memory",
  "asset",
  "scope",
  "项目",
  "会话",
  "记忆",
]);

export const CASE_CUE_TERMS = [
  "问题",
  "解决",
  "修复",
  "排查",
  "原因",
  "导致",
  "改成",
  "改为",
  "回退",
  "恢复",
  "workaround",
  "root cause",
  "resolved",
  "solution",
  "fixed",
  "debug",
  "error",
  "failure",
];

export const CASE_FALLBACK_TASK_TERMS = [
  "recallnest",
  "continuity",
  "checkpoint",
  "resume_context",
  "排查",
  "调试",
  "debug",
  "fix",
  "root cause",
  "workaround",
  "issue",
  "项目",
  "terminal",
  "window",
  "跨窗口",
  "新窗口",
];

export const TASK_HINT_GROUPS = [
  {
    cues: ["写文章", "文章", "写作", "公众号", "draft", "article", "post", "writing"],
    hints: ["写作", "文章", "语气", "风格", "口语化", "不端着", "AI", "公众号"],
  },
  {
    cues: ["配图", "封面", "图片", "插图", "视觉", "image", "cover", "illustration"],
    hints: ["配图", "封面", "视觉", "图片", "插图", "审美", "手绘", "撞色"],
  },
];

export const STYLE_TASK_TERMS = [
  "语气",
  "风格",
  "偏好",
  "写作风格",
  "回复风格",
  "tone",
  "voice",
  "style",
  "preference",
];

export const RECALL_ONLY_TERMS = [
  "回忆",
  "记得",
  "想起",
  "remember",
  "recall",
  "what do you remember",
  "不要让我重复",
];

export const WRITING_ACTION_TERMS = [
  "写一篇",
  "起草",
  "草稿",
  "改稿",
  "润色",
  "research",
  "调研",
  "选题",
  "继续写",
  "写公众号",
  "draft",
  "revise",
  "edit",
  "article",
];

export const CHINESE_TERM_EDGE_STOP_CHARS = new Set([
  "的",
  "了",
  "和",
  "是",
  "在",
  "给",
  "让",
  "再",
  "先",
  "就",
  "都",
  "很",
  "去",
  "做",
  "写",
  "看",
  "用",
  "要",
  "我",
  "你",
  "他",
  "她",
  "它",
  "们",
  "这",
  "那",
  "请",
]);

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function dedupeTerms(items: string[], limit: number): string[] {
  return Array.from(new Set(items)).slice(0, limit);
}

export function extractTerms(text?: string): string[] {
  if (!text) return [];
  const matches = text.match(/[\p{Script=Han}]{2,}|[a-z0-9._/-]{3,}/giu) || [];
  const expanded: string[] = [];

  for (const match of matches) {
    const lower = match.toLowerCase();
    expanded.push(lower);

    if (!/[\p{Script=Han}]/u.test(match) || match.length <= 4) continue;

    const chars = Array.from(lower);
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index <= chars.length - size; index += 1) {
        const chunk = chars.slice(index, index + size).join("");
        if (
          chunk.length < 2 ||
          CHINESE_TERM_EDGE_STOP_CHARS.has(chunk[0] || "") ||
          CHINESE_TERM_EDGE_STOP_CHARS.has(chunk[chunk.length - 1] || "")
        ) {
          continue;
        }
        expanded.push(chunk);
      }
    }
  }

  return dedupeTerms(expanded, 12);
}

export function buildTaskHintTerms(text?: string): string[] {
  if (!text) return [];
  const normalized = normalizeText(text);
  const hints = TASK_HINT_GROUPS.flatMap((group) =>
    group.cues.some((cue) => normalized.includes(cue.toLowerCase())) ? group.hints : [],
  );
  return dedupeTerms(hints.map((term) => term.toLowerCase()), 32);
}

export function containsAnyTerm(text: string, terms: string[]): boolean {
  const normalized = normalizeText(text);
  return terms.some((term) => normalized.includes(term));
}

export function looksLikeContinuityTask(taskSeed?: string): boolean {
  if (!taskSeed) return false;
  return containsAnyTerm(taskSeed, CONTINUITY_TASK_TERMS);
}

export function looksLikeStyleTask(taskSeed?: string): boolean {
  if (!taskSeed) return false;
  return containsAnyTerm(taskSeed, STYLE_TASK_TERMS);
}

export function looksLikeRecallOnlyTask(taskSeed?: string): boolean {
  if (!taskSeed) return false;
  const normalized = normalizeText(taskSeed);
  return (
    RECALL_ONLY_TERMS.some((term) => normalized.includes(term)) &&
    !WRITING_ACTION_TERMS.some((term) => normalized.includes(term))
  );
}

export function looksLikeCaseFallbackTask(taskSeed?: string): boolean {
  if (!taskSeed) return false;
  return containsAnyTerm(taskSeed, CASE_FALLBACK_TASK_TERMS);
}

export function looksLikeStableInstruction(text: string): boolean {
  const normalized = normalizeText(text);
  return STABLE_INSTRUCTION_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function containsLowSignalStableTerm(text: string): boolean {
  return containsAnyTerm(text, STABLE_LOW_SIGNAL_TERMS);
}

export function looksLikeLowSignalTaskResult(text: string): boolean {
  return containsAnyTerm(text, TASK_RESULT_LOW_SIGNAL_TERMS);
}

export function countTermHits(text: string, terms: string[]): number {
  const normalized = normalizeText(text);
  return terms.reduce((count, term) => count + (normalized.includes(term) ? 1 : 0), 0);
}

export function looksLikePlanishTaskResult(text: string): boolean {
  return containsAnyTerm(text, TASK_RESULT_PLANISH_TERMS);
}

export const GENERIC_ENTITY_TASK_TERMS = new Set([
  ...Array.from(GENERIC_SCOPE_TERMS),
  ...CONTINUITY_TASK_TERMS.map((term) => normalizeText(term)),
  ...WORKFLOW_CUE_TERMS.map((term) => normalizeText(term)),
  ...CASE_FALLBACK_TASK_TERMS.map((term) => normalizeText(term)),
  "continue",
  "继续",
  "接着",
  "项目",
  "问题",
  "error",
  "errors",
  "issue",
  "issues",
  "fix",
  "debug",
  "排查",
  "处理",
  "calling",
  "code",
  "之前",
  "那个",
  "什么",
]);

export function taskCueCoverage(category: "patterns" | "cases", text: string): string[] {
  if (category !== "patterns") return [];
  const normalized = normalizeText(text);
  return CONTINUITY_WORKFLOW_CUE_GROUPS
    .filter((group) => group.terms.some((term) => normalized.includes(term)))
    .map((group) => group.key);
}
