const ROLE_PREFIX_RE = /^\[(用户|助手)\]\s*/gm;
const PREFERENCE_SPLIT_RE = /(?:、|,|，|\/|以及|及|与|和| and | & )/iu;
const PREFERENCE_CLAUSE_STOP_RE = /(?:因为|所以|但是|不过|if |when |because |but )/iu;
const REPLY_STYLE_CONTEXT_RE = /(?:\brepl(?:y|ies)\b|\bresponse(?:s)?\b|\brespond(?:ing)?\b|\bwriting\b|\btone\b|\bvoice\b|\bstyle\b|回复|回答|语气|文案|写作|表达|风格|措辞|说话)/iu;
const BRAND_ITEM_PREFERENCE_PATTERNS = [
  /(?:^|[\s，,。；;！!？?])(?:我|用户)?(?:很|更|还)?(?:喜欢|爱吃|偏爱|常吃|想吃|喜欢喝|喜欢用|喜欢买)(?:吃|喝|用|买)?(?<brand>[\p{Script=Han}A-Za-z0-9&·'\-]{1,24})的(?<items>[\p{Script=Han}A-Za-z0-9&·'\-\s、,，和及与/]{1,80})/u,
  /\b(?:i|user)?\s*(?:really\s+|still\s+|also\s+)?(?:like|love|prefer|enjoy)\s+(?<items>[a-z0-9'&\-\s]{1,80})\s+from\s+(?<brand>[a-z0-9'&\-\s]{1,40})/iu,
] as const;
const TOOL_CHOICE_PREFERENCE_PATTERNS = [
  /\b(?:use|uses|using|prefer|prefers|preferred|pick|picks|picked)\s+(?<preferred>[a-z0-9.+#/_\-\s]{1,24})\s+(?:over|instead of|rather than)\s+(?<avoided>[a-z0-9.+#/_\-\s]{1,24})/iu,
  /(?:更喜欢|喜欢|偏好|倾向|优先)(?:使用|用)?(?<preferred>[A-Za-z0-9.+#/_\-\s]{1,24})(?:\s*)(?:而不是|而非|不用|不选|代替|替代|优先于|胜过)(?:\s*)(?<avoided>[A-Za-z0-9.+#/_\-\s]{1,24})/u,
  /(?:使用|用)(?<preferred>[A-Za-z0-9.+#/_\-\s]{1,24})(?:\s*)(?:不用|代替|替代)(?<avoided>[A-Za-z0-9.+#/_\-\s]{1,24})/u,
] as const;
const REPLY_STYLE_TRAIT_PATTERNS = [
  {
    key: "concise",
    pattern: /(?:\bconcise\b|\bbrief\b|\bshort\b|简洁|简短|短句|少废话|少空话|精炼)/iu,
  },
  {
    key: "direct",
    pattern: /(?:\bdirect\b|\bstraight(?:forward)?\b|to the point|直说|直接|不绕弯|别绕弯|开门见山)/iu,
  },
  {
    key: "colloquial",
    pattern: /(?:\bcolloquial\b|\bconversational\b|\bcasual\b|口语化|像聊天|像朋友聊天)/iu,
  },
  {
    key: "grounded",
    pattern: /(?:\bgrounded\b|non[-\s]?salesy|non[-\s]?hype|avoid sales language|avoid hype|不浮夸|不鸡血|不说教|不营销(?:腔)?|别太飘|不端着|别太端着)/iu,
  },
  {
    key: "technical",
    pattern: /(?:\btechnical\b|逻辑清晰|讲清楚|讲明白|技术向)/iu,
  },
] as const;
const TOOL_ALIAS_MAP: Record<string, string> = {
  bun: "bun",
  bunjs: "bun",
  bunx: "bunx",
  node: "node",
  "node.js": "node",
  nodejs: "node",
  npm: "npm",
  pnpm: "pnpm",
  yarn: "yarn",
  npx: "npx",
  uv: "uv",
  pip: "pip",
  python: "python",
  docker: "docker",
  podman: "podman",
  rg: "rg",
  ripgrep: "rg",
  grep: "grep",
  git: "git",
  claude: "claude-code",
  claudecode: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  gemini: "gemini",
  cursor: "cursor",
  vscode: "vscode",
  "vs-code": "vscode",
  vscodeinsiders: "vscode",
  vim: "vim",
  neovim: "neovim",
  nvim: "neovim",
} as const;

export interface ParsedBrandItemPreference {
  brand: string;
  items: string[];
  aggregate: boolean;
}

export interface AtomicBrandItemPreferenceSlot {
  type: "brand-item";
  brand: string;
  item: string;
}

export interface ReplyStylePreferenceSlot {
  type: "reply-style";
  traits: string[];
}

export interface ToolChoicePreferenceSlot {
  type: "tool-choice";
  preferredTool: string;
  avoidedTool: string;
}

export type PreferenceSlot =
  | AtomicBrandItemPreferenceSlot
  | ReplyStylePreferenceSlot
  | ToolChoicePreferenceSlot;

function normalizePreferenceText(value: string): string {
  return value
    .replace(ROLE_PREFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePreferenceToken(value: string): string {
  return normalizePreferenceText(value)
    .replace(/^[“"'`‘’.]+|[”"'`‘’.。！!？?，,；;:：]+$/gu, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function splitPreferenceItems(rawItems: string): string[] {
  const trimmed = rawItems.split(PREFERENCE_CLAUSE_STOP_RE)[0] || rawItems;
  return trimmed
    .split(PREFERENCE_SPLIT_RE)
    .map((item) => normalizePreferenceToken(item))
    .filter((item) => item.length > 0);
}

export function parseBrandItemPreference(text: string): ParsedBrandItemPreference | null {
  const normalizedText = normalizePreferenceText(text);

  for (const pattern of BRAND_ITEM_PREFERENCE_PATTERNS) {
    const match = normalizedText.match(pattern);
    if (!match?.groups) continue;

    const brand = normalizePreferenceToken(match.groups.brand || "");
    const items = splitPreferenceItems(match.groups.items || "");
    if (!brand || items.length === 0) continue;

    return {
      brand,
      items,
      aggregate: items.length > 1,
    };
  }

  return null;
}

export function inferAtomicBrandItemPreferenceSlot(text: string): AtomicBrandItemPreferenceSlot | null {
  const parsed = parseBrandItemPreference(text);
  if (!parsed || parsed.aggregate || parsed.items.length !== 1) {
    return null;
  }

  return {
    type: "brand-item",
    brand: parsed.brand,
    item: parsed.items[0],
  };
}

export function inferReplyStylePreferenceSlot(text: string): ReplyStylePreferenceSlot | null {
  const normalizedText = normalizePreferenceText(text);
  const traits = REPLY_STYLE_TRAIT_PATTERNS
    .filter(({ pattern }) => pattern.test(normalizedText))
    .map(({ key }) => key);

  if (traits.length === 0) {
    return null;
  }

  const hasContext = REPLY_STYLE_CONTEXT_RE.test(normalizedText);
  if (!hasContext && traits.length < 2) {
    return null;
  }

  return {
    type: "reply-style",
    traits: Array.from(new Set(traits)).sort(),
  };
}

function normalizeToolToken(value: string): string {
  const normalized = normalizePreferenceToken(value);
  return TOOL_ALIAS_MAP[normalized] || normalized;
}

function isKnownToolToken(value: string): boolean {
  return Boolean(value && (TOOL_ALIAS_MAP[value] || Object.values(TOOL_ALIAS_MAP).includes(value as any)));
}

export function inferToolChoicePreferenceSlot(text: string): ToolChoicePreferenceSlot | null {
  const normalizedText = normalizePreferenceText(text);

  for (const pattern of TOOL_CHOICE_PREFERENCE_PATTERNS) {
    const match = normalizedText.match(pattern);
    if (!match?.groups) continue;

    const preferredTool = normalizeToolToken(match.groups.preferred || "");
    const avoidedTool = normalizeToolToken(match.groups.avoided || "");
    if (!preferredTool || !avoidedTool || preferredTool === avoidedTool) continue;
    if (!isKnownToolToken(preferredTool) || !isKnownToolToken(avoidedTool)) continue;

    return {
      type: "tool-choice",
      preferredTool,
      avoidedTool,
    };
  }

  return null;
}

export function inferPreferenceSlot(text: string): PreferenceSlot | null {
  return inferAtomicBrandItemPreferenceSlot(text)
    || inferReplyStylePreferenceSlot(text)
    || inferToolChoicePreferenceSlot(text);
}

export function samePreferenceSlot(
  left: PreferenceSlot | null,
  right: PreferenceSlot | null,
): boolean {
  if (!left || !right || left.type !== right.type) {
    return false;
  }

  if (left.type === "brand-item" && right.type === "brand-item") {
    return left.brand === right.brand && left.item === right.item;
  }

  if (left.type === "reply-style" && right.type === "reply-style") {
    return left.traits.length === right.traits.length &&
      left.traits.every((trait, index) => trait === right.traits[index]);
  }

  if (left.type === "tool-choice" && right.type === "tool-choice") {
    return left.preferredTool === right.preferredTool &&
      left.avoidedTool === right.avoidedTool;
  }

  return false;
}
