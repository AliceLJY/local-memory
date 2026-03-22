export const CONTINUITY_TASK_TERMS = [
  "新窗口",
  "fresh window",
  "new window",
  "cross window",
  "跨窗口",
  "上个窗口",
  "之前讨论过",
  "刚才",
  "不要让我重复前情",
  "重复前情",
  "接力",
  "handoff",
  "resume",
  "session",
  "checkpoint",
  "continuity",
  "terminal",
];

const CONTINUATION_VERB_TERMS = [
  "continue",
  "继续",
  "接着",
  "接上",
  "续上",
  "回到",
  "捡起来",
  "做到哪",
  "之前",
  "上次",
];

const CONTINUATION_CONTEXT_TERMS = [
  "recallnest",
  "project",
  "项目",
  "window",
  "窗口",
  "terminal",
  "终端",
  "前情",
  "session",
  "checkpoint",
  "handoff",
  "接力",
  "同一个",
  "memory layer",
  "shared memory layer",
  "shared memory",
  "memory system",
  "cross-window memory",
  "multi-window memory",
  "记忆层",
  "记忆系统",
  "跨窗口记忆",
  "多窗口记忆",
  "recall pipeline",
  "recall 管线",
  "same project",
  "记忆项目",
  "记忆功能",
  "记忆服务",
  "跨终端记忆",
  "cross-terminal memory",
  "memory service",
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
  {
    resultTerms: ["doctor baseline", "doctor --ci", "baseline check", "baseline hardening"],
    taskTerms: ["doctor", "baseline", "基线", "coverage", "ci", "doctor --ci", "验证"],
  },
  {
    resultTerms: ["seed:continuity", "seed continuity", "seed refresh", "reseed continuity"],
    taskTerms: ["seed", "seed:continuity", "种子", "reseed", "refresh", "回填", "补种"],
  },
  {
    resultTerms: [
      "continuity eval checkpoint isolation",
      "continuity eval regression",
      "continuity eval fixture",
      "checkpoint fixture",
    ],
    taskTerms: ["eval", "evaluation", "regression", "fixture", "评估", "回归", "用例", "case"],
  },
  {
    resultTerms: [
      "continuity eval profile forwarding gap",
      "profile forwarding gap",
      "profile: writing",
      "sparse writing prompts",
      "sparse-style fallback",
    ],
    taskTerms: [
      "eval profile",
      "profile regression",
      "profile forwarding",
      "profile forwarding gap",
      "profile: writing",
      "writing prompt",
      "writing prompts",
      "sparse writing prompt",
      "sparse writing prompts",
      "sparse-style fallback",
      "style fallback",
      "写作提示",
      "写作评估",
      "写作回归",
      "写作 prompt",
      "profile 转发",
      "profile 转发缺口",
    ],
  },
  {
    resultTerms: [
      "eval runner shared components skewed later continuity previews",
      "shared components skewed later continuity previews",
      "single-case replay",
      "per-case fresh components",
      "fresh-window replay",
      "eval runner isolation",
    ],
    taskTerms: [
      "eval runner",
      "eval runner isolation",
      "runner isolation",
      "single-case replay",
      "fresh-window replay",
      "per-case fresh components",
      "shared eval components",
      "shared component state",
      "runner replay",
      "runner 隔离",
      "单 case 回放",
      "单用例回放",
      "共享组件状态",
      "fresh-window 回放",
    ],
  },
  {
    resultTerms: [
      "workflow_observe",
      "workflow_health",
      "workflow_evidence",
      "workflow observation",
    ],
    taskTerms: [
      "workflow_observe",
      "workflow_health",
      "workflow_evidence",
      "workflow observation",
      "observation",
      "governance",
      "health",
      "evidence",
      "自进化",
      "观测",
    ],
  },
  {
    resultTerms: [
      "three-terminal continuity trigger validation",
      "continue-style prompts triggered recall reliably",
      "managed continuity rules",
      "global instruction file",
    ],
    taskTerms: [
      "claude code",
      "codex",
      "gemini cli",
      "three-terminal",
      "三终端",
      "trigger",
      "触发",
      "setup",
      "install",
      "安装",
      "接入",
      "instruction",
      "规则",
      "managed continuity",
    ],
  },
  {
    resultTerms: [
      "missed continuity guidance",
      "cue coverage",
      "conversational named recallnest continue prompts",
      "named recallnest continue without project nouns",
      "without project nouns",
    ],
    taskTerms: [
      "guidance",
      "cue",
      "coverage",
      "prompt",
      "prompts",
      "phrasing",
      "wording",
      "trigger",
      "话术",
      "提示词",
    ],
  },
  {
    resultTerms: [
      "broad case fallback query",
      "query-analysis assistant notes",
      "fallback query",
      "fallback-query",
      "fallback-query meta case",
      "structured case detection",
    ],
    taskTerms: [
      "fallback query",
      "fallback-query",
      "query-analysis",
      "ranking",
      "task-ranking",
      "排序",
      "structured case",
      "assistant note",
      "noise filter",
      "recentcases",
    ],
  },
  {
    resultTerms: [
      "transcript-style pattern fragment",
      "generic continuity preview",
      "relevantpatterns",
      "non-durable transcript fragments",
    ],
    taskTerms: [
      "pattern",
      "patterns",
      "transcript",
      "fragment",
      "preview",
      "previews",
      "relevantpatterns",
      "workflow cue",
      "task result",
      "task-result",
      "selection",
    ],
  },
  {
    resultTerms: [
      "bulk fact distillation",
      "distill-facts.ts",
      "smartextractbatch",
      "health-check.ts",
      "qwen-turbo",
      "distillation authority",
      "archived metadata",
    ],
    taskTerms: [
      "distill",
      "distillation",
      "fact distillation",
      "distill-facts",
      "smartextract",
      "smartextractbatch",
      "health-check",
      "qwen",
      "archived",
      "archive",
      "worker pool",
      "duplicate rate",
      "dedupcheck",
    ],
  },
  {
    resultTerms: [
      "promote recurring continuity workflow",
      "store_workflow_pattern",
      "/v1/pattern",
    ],
    taskTerms: [
      "pattern",
      "patterns",
      "workflow",
      "workflow pattern",
      "store_workflow_pattern",
      "/v1/pattern",
      "promote",
      "沉淀",
      "复用模式",
      "pattern seed",
    ],
  },
  {
    resultTerms: [
      "scoped recall leaked conversational durable pins",
      "conversational durable pins",
      "scoped mixed-project pin collision leaked foreign project summaries",
      "foreign project summaries",
      "telegram-cli-bridge",
    ],
    taskTerms: [
      "pin",
      "pins",
      "pinned",
      "bridge",
      "telegram",
      "telegram-cli-bridge",
      "transcript",
      "readme",
      "mixed-project",
      "collision",
      "durable pin",
    ],
  },
  {
    resultTerms: [
      "scoped entity recall leaked foreign project entities via shared tool nouns",
      "scoped task results leaked foreign project patterns and cases",
      "shared tool nouns",
    ],
    taskTerms: [
      "scope",
      "scoped",
      "mixed-project",
      "foreign project",
      "collision",
      "entity collision",
      "task result collision",
      "shared tool nouns",
    ],
  },
  {
    resultTerms: [
      "borderline transcript dedup swallowed incremental a2a details",
      "incremental a2a details",
      "same-topic a2a upgrade",
      "transcript dedup",
    ],
    taskTerms: [
      "a2a",
      "claude sdk",
      "agent sdk",
      "gateway",
      "dedup",
      "ingest",
      "transcript",
      "permissionmode",
      "allowedtools",
      "launchagent",
      "debugging",
      "调试",
      "去重",
    ],
  },
];

export const PREFERENCE_SPECIFICITY_GROUPS = [
  {
    resultTerms: [
      "claude code",
      "codex",
      "gemini cli",
      "smoke",
      "integration",
      "验收",
      "验证视角",
      "独立验证",
      "sidecar",
      "cc 介入",
    ],
    taskTerms: [
      "claude code",
      "codex",
      "gemini cli",
      "smoke",
      "integration",
      "验收",
      "验证",
      "独立验证",
      "sidecar",
      "cc",
    ],
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

export const ASSOCIATIVE_RECALL_CUE_TERMS = [
  "memory layer",
  "shared memory layer",
  "shared memory",
  "memory system",
  "memory service",
  "cross-window memory",
  "cross-terminal memory",
  "multi-window memory",
  "memory project",
  "记忆层",
  "记忆系统",
  "记忆服务",
  "记忆功能",
  "跨窗口记忆系统",
  "跨窗口记忆",
  "跨终端记忆",
  "多窗口记忆",
  "记忆项目",
  "recall pipeline",
  "recall 管线",
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
  {
    cues: ASSOCIATIVE_RECALL_CUE_TERMS,
    hints: ["recallnest", "记忆层", "memory layer", "continuity", "checkpoint_session", "resume_context", "store_memory"],
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

export const DEFAULT_EXTRACT_TERM_LIMIT = 12;
export const TASK_CUE_EXTRACTION_LIMIT = 32;

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function dedupeTerms(items: string[], limit: number): string[] {
  return Array.from(new Set(items)).slice(0, limit);
}

export function extractTerms(text?: string, limit = DEFAULT_EXTRACT_TERM_LIMIT): string[] {
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

  return dedupeTerms(expanded, limit);
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
  const normalized = normalizeText(taskSeed);
  return (
    containsAnyTerm(taskSeed, CONTINUITY_TASK_TERMS) ||
    (
      CONTINUATION_VERB_TERMS.some((term) => normalized.includes(term)) &&
      CONTINUATION_CONTEXT_TERMS.some((term) => normalized.includes(term))
    )
  );
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
