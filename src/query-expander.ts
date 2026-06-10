/**
 * Lightweight Chinese query expansion via static synonym dictionary.
 * Expands colloquial/fuzzy terms into technical equivalents for BM25 boost.
 * No API calls — pure local dictionary lookup.
 *
 * v1.1: Word-boundary matching for English triggers (prevents "download" matching "down").
 *       MAX_EXPANSION_TERMS cap to prevent query bloat hurting BM25 precision.
 *       Structured synonym entries separating CN (substring) from EN (word-boundary).
 * v1.2: Entity resolution pre-pass normalizes aliases before synonym expansion.
 * v1.3: P0.3 — User-level alias-map (data/alias-map.json) for short query expansion.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { resolveQueryEntities } from "./entity-resolver.js";

interface SynonymEntry {
  /** Chinese triggers: matched by substring (CJK has no word boundaries) */
  cn: string[];
  /** English triggers: matched by word boundary (\b) to prevent false positives */
  en: string[];
  /** Terms to append when triggered */
  expansions: string[];
}

const SYNONYM_MAP: SynonymEntry[] = [
  // --- Status / Failure ---
  { cn: ["挂了", "挂掉", "宕机"], en: ["shutdown", "crashed"], expansions: ["崩溃", "crash", "error", "报错", "挂了", "宕机", "失败"] },
  { cn: ["卡住", "卡死", "没反应"], en: ["hang", "stuck"], expansions: ["hang", "timeout", "超时", "卡住", "无响应", "stuck"] },
  { cn: ["炸了", "爆了"], en: ["OOM"], expansions: ["崩溃", "crash", "OOM", "内存溢出", "error"] },

  // --- AI / Consciousness ---
  { cn: ["感受", "感觉", "情感"], en: ["feeling", "emotion"], expansions: ["意识", "consciousness", "experiencing", "感受", "情感", "qualia"] },
  { cn: ["有没有意识", "是否有意识"], en: ["consciousness", "sentience"], expansions: ["consciousness", "意识", "sentience", "感知", "自我意识"] },
  { cn: ["自由意志"], en: ["free will"], expansions: ["free will", "自由意志", "决定论", "determinism"] },

  // --- Config / Deploy ---
  { cn: ["配置", "设置"], en: ["config", "configuration", "settings"], expansions: ["配置", "config", "configuration", "settings", "设置"] },
  { cn: ["部署", "上线"], en: ["deploy"], expansions: ["deploy", "部署", "上线", "发布", "release"] },
  { cn: ["容器"], en: ["docker", "container"], expansions: ["Docker", "容器", "container", "docker-compose"] },

  // --- Code / Debug ---
  { cn: ["报错", "出错", "错误"], en: ["error", "exception"], expansions: ["error", "报错", "exception", "错误", "失败", "bug"] },
  { cn: ["修复", "修了", "修好"], en: ["fix", "patch"], expansions: ["fix", "修复", "patch", "修了", "解决"] },
  { cn: ["踩坑", "坑"], en: ["troubleshoot"], expansions: ["踩坑", "bug", "问题", "教训", "排查", "troubleshoot"] },
  { cn: ["日志"], en: ["log", "logging"], expansions: ["日志", "log", "logging", "输出", "stdout", "stderr"] },
  { cn: ["权限"], en: ["permission", "access"], expansions: ["权限", "permission", "access", "授权", "认证"] },

  // --- Writing / Content ---
  { cn: ["配图", "插图"], en: [], expansions: ["配图", "封面", "style-catalog", "风格", "图片", "image"] },
  { cn: ["排版", "版式"], en: ["layout"], expansions: ["排版", "layout", "主题", "theme", "样式"] },
  { cn: ["风格"], en: ["style"], expansions: ["风格", "style", "轮换", "catalog"] },
  { cn: ["写作", "写文章"], en: ["writing"], expansions: ["写作", "writing", "文章", "公众号", "content-alchemy"] },

  // --- Infrastructure ---
  { cn: ["机器人"], en: ["bot", "agent"], expansions: ["bot", "机器人", "OpenClaw", "agent", "gateway"] },
  { cn: ["推送"], en: ["push"], expansions: ["push", "推送", "git push", "commit"] },
  { cn: ["记忆"], en: ["memory"], expansions: ["记忆", "memory", "记忆系统", "LanceDB", "索引"] },
  { cn: ["搜索", "查找", "找"], en: ["search", "retrieval"], expansions: ["搜索", "search", "retrieval", "检索", "查找"] },
];

/** Maximum expansion terms to prevent query bloat hurting BM25 precision */
const MAX_EXPANSION_TERMS = 5;

// ============================================================================
// P0.3: User-level alias-map for short query expansion
// ============================================================================

/**
 * Alias map entry: a short trigger → expansion terms.
 * Loaded from data/alias-map.json on first use (lazy, cached).
 */
export interface AliasEntry {
  trigger: string;
  expansions: string[];
}

let aliasMapCache: AliasEntry[] | null = null;
let aliasMapPath: string | null = null;

/** Override the alias-map file path (for testing). */
export function setAliasMapPath(path: string): void {
  aliasMapPath = path;
  aliasMapCache = null; // force reload
}

/** Reset alias-map cache (for testing). */
export function resetAliasMapCache(): void {
  aliasMapCache = null;
}

/** Resolve the alias-map file path currently in effect. */
export function aliasMapFilePath(): string {
  return aliasMapPath ?? join(process.cwd(), "data", "alias-map.json");
}

function loadAliasMap(): AliasEntry[] {
  if (aliasMapCache !== null) return aliasMapCache;
  const filePath = aliasMapFilePath();
  try {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      if (Array.isArray(raw)) {
        aliasMapCache = raw.filter(
          (e: unknown): e is AliasEntry =>
            typeof e === "object" && e !== null &&
            typeof (e as AliasEntry).trigger === "string" &&
            Array.isArray((e as AliasEntry).expansions),
        );
        return aliasMapCache;
      }
    }
  } catch {
    // Silent — alias map is optional
  }
  aliasMapCache = [];
  return aliasMapCache;
}

// ---------------------------------------------------------------------------
// User alias management (P1-B manage_alias tool 后端)
//
// 这些别名只作用于 BM25 通道(expandQuery 在 hybridRetrieval 内部被调用),
// 刻意不进 vector embedding——随手加的用户别名若改变语义向量,排查
// retrieval drift 会非常困难。全通道的 builtin 规则在 src/aliases.ts。
// ---------------------------------------------------------------------------

/** 写入校验:trigger 最短 2 字符(防高频泛词),expansions 最多 8 个。 */
export const USER_ALIAS_TRIGGER_MIN = 2;
export const USER_ALIAS_EXPANSIONS_MAX = 8;

export type AliasUpsertResult =
  | { ok: true; action: "added" | "updated"; entry: AliasEntry }
  | { ok: false; reason: string };

/** 新增/更新用户别名(写 alias-map.json;校验后缓存即时失效)。 */
export function upsertUserAlias(trigger: string, expansions: string[]): AliasUpsertResult {
  const t = trigger.trim();
  const exp = [...new Set(expansions.map(e => e.trim()).filter(e => e.length > 0))];

  if (t.length < USER_ALIAS_TRIGGER_MIN) {
    return { ok: false, reason: `trigger 太短(<${USER_ALIAS_TRIGGER_MIN} 字符)——高频泛词会污染所有查询` };
  }
  if (exp.length === 0) {
    return { ok: false, reason: "expansions 为空" };
  }
  if (exp.length > USER_ALIAS_EXPANSIONS_MAX) {
    return { ok: false, reason: `expansions 超过 ${USER_ALIAS_EXPANSIONS_MAX} 个——过长扩展会冲淡 BM25 原查询词权重` };
  }
  if (exp.every(e => e === t)) {
    return { ok: false, reason: "expansions 与 trigger 相同,无扩展意义" };
  }

  const rules = loadAliasMap();
  const idx = rules.findIndex(r => r.trigger === t);
  const entry: AliasEntry = { trigger: t, expansions: exp };
  const next = idx >= 0 ? rules.map((r, i) => (i === idx ? entry : r)) : [...rules, entry];

  const path = aliasMapFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf-8");
  aliasMapCache = null;
  return { ok: true, action: idx >= 0 ? "updated" : "added", entry };
}

/** 删除用户别名;返回是否真的删了。 */
export function removeUserAlias(trigger: string): boolean {
  const rules = loadAliasMap();
  const next = rules.filter(r => r.trigger !== trigger.trim());
  if (next.length === rules.length) return false;
  const path = aliasMapFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf-8");
  aliasMapCache = null;
  return true;
}

/** 列出用户别名规则。 */
export function listUserAliases(): AliasEntry[] {
  return [...loadAliasMap()];
}

/** 检视:query 命中了哪些用户别名(BM25-only 通道)。 */
export function explainUserAliases(query: string): AliasEntry[] {
  const lower = query.toLowerCase();
  return loadAliasMap().filter(e => lower.includes(e.trigger.toLowerCase()));
}

/**
 * Expand a query by appending synonym terms from the dictionary.
 * Returns the original query with additional terms appended.
 * Idempotent — already-precise queries pass through unchanged.
 */
export function expandQuery(query: string): string {
  if (!query || query.trim().length < 2) return query;

  // Entity resolution pre-pass: normalize aliases before synonym expansion
  const resolved = resolveQueryEntities(query);
  const lower = resolved.toLowerCase();
  const synonymAdditions = new Set<string>();
  const aliasAdditions = new Set<string>();

  // Static synonym map (built-in)
  for (const entry of SYNONYM_MAP) {
    // Chinese triggers: substring match (CJK has no word boundaries)
    const cnMatch = entry.cn.some(t => lower.includes(t.toLowerCase()));
    // English triggers: word-boundary match to prevent false positives
    const enMatch = entry.en.length > 0 && entry.en.some(t => {
      const regex = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      return regex.test(lower);
    });

    if (cnMatch || enMatch) {
      for (const exp of entry.expansions) {
        if (!lower.includes(exp.toLowerCase())) {
          synonymAdditions.add(exp);
        }
      }
    }
  }

  // P0.3: User alias-map (data/alias-map.json) — short triggers → expansions
  const aliasMap = loadAliasMap();
  for (const alias of aliasMap) {
    const triggerLower = alias.trigger.toLowerCase();
    if (lower.includes(triggerLower)) {
      for (const exp of alias.expansions) {
        if (!lower.includes(exp.toLowerCase())) {
          aliasAdditions.add(exp);
        }
      }
    }
  }

  if (aliasAdditions.size === 0 && synonymAdditions.size === 0) return resolved;

  // Cap expansion terms to prevent query bloat. User aliases rank first inside
  // the cap — 用户为这个 trigger 显式配置的 canonical 名,不应被泛化同义词
  // 挤出 MAX_EXPANSION_TERMS(P1-B:同义词"挂"曾把 alias 的实体名挤掉)。
  const merged = [
    ...aliasAdditions,
    ...[...synonymAdditions].filter(t => !aliasAdditions.has(t)),
  ];
  const limited = merged.slice(0, MAX_EXPANSION_TERMS);
  return `${resolved} ${limited.join(" ")}`;
}
