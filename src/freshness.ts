/**
 * Freshness — 记忆新鲜度四态判定
 *
 * 出处：通用Wiki上下文记忆Agent方案借鉴审计（2026-07-21，Alice 拍板落地）。
 *
 * 召回的记忆按"依赖状态"判定有效性，四个离散档：
 *   - exact       依赖原封未动，可直接复用
 *   - compatible  依赖变了，但落在声明的兼容集内，不影响结论
 *   - uncertain   依赖变了且无法判定是否影响结论，复用前需验证
 *   - invalid     依赖对象已失效（文件删了 / 仓库没了）
 *
 * 判据是"依赖状态"不是"时间"：依赖对象在不在 / revision 变没变。
 * 失效颗粒度是结论级：每条记忆绑自己的 dependsOn，某个来源变了只降那一条。
 *
 * 硬边界（承重约束）：
 *   1. 判定必须廉价 —— 单条依赖 = 一次 existsSync/statSync（O(1) syscall）
 *      或一次 `git rev-parse`（单进程、无网络、按 repo 目录 memoize）。
 *      绝不全量扫描、绝不调模型、绝不网络请求。
 *   2. opt-in —— 只对显式声明了 dependsOn 的记忆生效。无声明的记忆
 *      evaluateEntryFreshness 返回 null，零开销、行为与之前完全一致。
 *   3. 向后兼容 —— dependsOn 存活在既有 metadata JSON 列里（照 emotion /
 *      privacyTier 惯例），不新增数据库字段、不改破坏性 schema。
 */

import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const FRESHNESS_STATES = ["exact", "compatible", "uncertain", "invalid"] as const;
export type Freshness = (typeof FRESHNESS_STATES)[number];
export const FreshnessSchema = z.enum(FRESHNESS_STATES);

export const DEPENDENCY_KINDS = ["file", "git-rev"] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/**
 * 一条依赖声明。首版只支持 file / git-rev（不支持任意 cmd 执行，安全优先）。
 *   kind='file'    ref = 文件路径；expected = 文件 mtime（毫秒时间戳的整数字符串）
 *                  作为廉价变更指纹，缺省时只做存在性检查。内容级精确请用 git-rev。
 *   kind='git-rev' ref = git 仓库内的路径（文件或目录，取其所在仓库 HEAD）；
 *                  expected = 期望 commit hash（支持短 hash 前缀），缺省时只做仓库存在性检查。
 * expected 单值或数组：数组首值匹配 = exact，其余值匹配 = compatible（= 声明的兼容集）。
 */
export const DependencySchema = z.object({
  kind: z.enum(DEPENDENCY_KINDS),
  ref: z.string().min(1).max(500),
  expected: z
    .union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(8)])
    .optional(),
});
export type Dependency = z.infer<typeof DependencySchema>;

export const DependsOnSchema = z.array(DependencySchema).min(1).max(8);

/** 判定结果按严重度排序，聚合时取最差。 */
const SEVERITY: Record<Freshness, number> = { exact: 0, compatible: 1, uncertain: 2, invalid: 3 };

/** git rev-parse 结果按 repo 目录缓存：一次判定批次内同一仓库只 spawn 一次 git。 */
export type FreshnessCache = Map<string, string | null>;

export function createFreshnessCache(): FreshnessCache {
  return new Map();
}

/** 从记忆 metadata JSON 解析 dependsOn 声明；缺失或非法返回 null（照 parseEmotion 惯例）。 */
export function parseDependsOn(metadata?: string): Dependency[] | null {
  if (!metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const raw = (parsed as Record<string, unknown>).dependsOn;
  if (raw == null) return null;
  const result = DependsOnSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** 校验来自 store 输入侧的 dependsOn（unknown → Dependency[] | null）。 */
export function parseDependsOnInput(raw: unknown): Dependency[] | null {
  if (raw == null) return null;
  const result = DependsOnSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function toExpectedList(expected: Dependency["expected"]): string[] {
  if (expected == null) return [];
  return Array.isArray(expected) ? expected : [expected];
}

/**
 * 把"当前值"归类到 exact / compatible / uncertain。
 *   - 无 expected：只做存在性检查，存在即 exact。
 *   - 匹配 expected[0]（首选/最新）→ exact
 *   - 匹配 expected[1..]（声明的其他兼容值）→ compatible
 *   - 都不匹配 → uncertain（变了，且无法判定是否影响结论）
 */
function classifyAgainstExpected(
  current: string,
  expected: string[],
  matches: (current: string, candidate: string) => boolean,
): Freshness {
  if (expected.length === 0) return "exact";
  if (matches(current, expected[0])) return "exact";
  for (let i = 1; i < expected.length; i++) {
    if (matches(current, expected[i])) return "compatible";
  }
  return "uncertain";
}

function exactMatch(current: string, candidate: string): boolean {
  return current === candidate;
}

/** 短 hash 友好：current 是完整 HEAD（40 hex），candidate 可为完整或短前缀。 */
function gitRevMatch(current: string, candidate: string): boolean {
  if (!candidate) return false;
  const a = current.toLowerCase();
  const b = candidate.toLowerCase();
  return a === b || a.startsWith(b);
}

function resolveHeadRev(ref: string, cache: FreshnessCache): string | null {
  let dir: string;
  try {
    dir = existsSync(ref) && statSync(ref).isDirectory() ? ref : dirname(ref);
  } catch {
    dir = dirname(ref);
  }
  const cached = cache.get(dir);
  if (cached !== undefined) return cached;
  let rev: string | null = null;
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    rev = out.length > 0 ? out : null;
  } catch {
    rev = null; // 非 git 仓库 / git 不可用 / 超时 → 依赖失效
  }
  cache.set(dir, rev);
  return rev;
}

/** 单条依赖的廉价判定。 */
export function evaluateDependency(dep: Dependency, cache: FreshnessCache): Freshness {
  const expected = toExpectedList(dep.expected);
  if (dep.kind === "file") {
    if (!existsSync(dep.ref)) return "invalid";
    if (expected.length === 0) return "exact";
    let mtime: string;
    try {
      mtime = String(Math.floor(statSync(dep.ref).mtimeMs));
    } catch {
      return "invalid"; // 存在性检查与 stat 之间被删
    }
    return classifyAgainstExpected(mtime, expected, exactMatch);
  }
  // git-rev
  const head = resolveHeadRev(dep.ref, cache);
  if (head === null) return "invalid";
  return classifyAgainstExpected(head, expected, gitRevMatch);
}

/** 多条依赖聚合：取最差（worst-case）——任一依赖失效，整条记忆就不可全信。 */
export function evaluateFreshness(deps: Dependency[], cache?: FreshnessCache): Freshness {
  if (deps.length === 0) return "exact";
  const revCache = cache ?? createFreshnessCache();
  let worst: Freshness = "exact";
  for (const dep of deps) {
    const f = evaluateDependency(dep, revCache);
    if (SEVERITY[f] > SEVERITY[worst]) worst = f;
    if (worst === "invalid") break; // 已是最差档，无需继续
  }
  return worst;
}

/**
 * 便捷入口：从记忆 metadata 判定新鲜度。
 * opt-in —— 无 dependsOn 声明返回 null（调用方据此跳过展示，零开销）。
 * @param cache 可选的跨条目共享缓存（渲染一批结果时传入，令同仓库只 spawn 一次 git）。
 */
export function evaluateEntryFreshness(metadata?: string, cache?: FreshnessCache): Freshness | null {
  const deps = parseDependsOn(metadata);
  if (!deps) return null;
  return evaluateFreshness(deps, cache);
}
