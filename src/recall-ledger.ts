/**
 * Recall Ledger — 进程内的「这次会话读到过哪些记忆」账本。
 *
 * 存在的理由（P0 join key）：价值回溯要的是 `(memory_id, outcome)` 配对，而库里
 * 一边有结果没参与者（workflow observation 不记 memory），一边有参与者没结果
 * （access-tracker 记命中不记任务成败）。这个模块补的就是中间那一段：
 * 检索命中时记一笔，`workflow_observe` 上报时把窗口内命中的 id 一起写进 observation。
 *
 * 为什么是**进程级**而不是挂在 AccessTracker 实例上：
 *   `createComponentResolver`（runtime-config.ts:226）按 profileName 缓存 components，
 *   每个 profile 各有一个 AccessTracker → 各自随机一个 readerId。检索走 profile A、
 *   上报走 default 时，两边 readerId 对不上，join 直接失效。而 access-tracker.ts:63
 *   的注释本来就写着「one stdio MCP server process ≈ one CC session」——那句话描述的
 *   语义单位是**进程**，实现却落在实例上。这里把它扶正，顺带修掉多 profile 时
 *   readerIds/distinctReaderCount 被同一个会话灌进多个假 reader 的虚高。
 */

/** 本进程（≈ 本次 CC 会话）的读者身份。所有 AccessTracker 默认共享它。 */
export const PROCESS_READER_ID = `r-${crypto.randomUUID().slice(0, 8)}`;

/** 默认回看窗口：一次任务从检索到上报 outcome 的常见跨度。 */
export const DEFAULT_RECALL_WINDOW_MS = 30 * 60_000;

/** 一条 observation 最多带多少个 memory id。防止长会话把整个 top-k 历史灌进 observation。 */
export const RECALLED_IDS_CAP = 64;

/** 账本自身的常驻上限；超出时按最后命中时间淘汰最老的。 */
const LEDGER_CAP = 512;

/** memoryId → 最后一次被检索返回的时间戳(ms)。 */
const hits = new Map<string, number>();

/**
 * 记录这批 id 在本进程被检索返回过。
 *
 * 注意调用点在 novelty/cooldown gate **之前**：那两道闸问的是「值不值得强化衰减半衰期」，
 * 这里问的是「agent 有没有真的看到这条」。同一批 id 两个问题的答案可以不同，
 * 用强化闸去过滤 join 参与者会系统性漏掉最常被读到的那些条目。
 */
export function recordRecallHits(ids: readonly string[], now = Date.now()): void {
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) hits.set(id, now);
  }
  if (hits.size > LEDGER_CAP) {
    const sorted = [...hits.entries()].sort((a, b) => b[1] - a[1]);
    hits.clear();
    for (const [id, ts] of sorted.slice(0, LEDGER_CAP)) hits.set(id, ts);
  }
}

/**
 * 取窗口内被命中过的 memory id，最近命中的排前面。
 * windowMs <= 0 表示不限时间（仍受 cap 约束）。
 */
export function recentRecallHits(
  windowMs = DEFAULT_RECALL_WINDOW_MS,
  cap = RECALLED_IDS_CAP,
  now = Date.now(),
): string[] {
  const cutoff = windowMs > 0 ? now - windowMs : Number.NEGATIVE_INFINITY;
  return [...hits.entries()]
    .filter(([, ts]) => ts >= cutoff)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, cap))
    .map(([id]) => id);
}

/** 当前账本条目数（诊断/测试用）。 */
export function recallLedgerSize(): number {
  return hits.size;
}

/** 清空账本。测试隔离用；生产路径不调用。 */
export function resetRecallLedger(): void {
  hits.clear();
}
