import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runDream } from "../dream-pipeline.js";
import { maybeRunGc, resetGcTimestamp, type AutoGcConfig, DEFAULT_AUTO_GC_CONFIG } from "../auto-gc.js";
import { lockPathForKey } from "../distill-lock.js";
import { incrementWriteCount, getWriteCount } from "../activity-counter.js";

// Isolate dream's activity-counter reads/writes to a temp file so tests never touch the
// repo's data/activity-stats.json (which the production dream scheduler reads).
const DREAM_STATS = join(mkdtempSync(join(tmpdir(), "rn-dream-stats-")), "activity-stats.json");

/**
 * P0-1 接线回归：dream/gc 维护入口接了跨进程锁。用「预写一个当前进程 PID 的锁文件」
 * 模拟「另一进程持有锁」（同进程 PID 恒活，acquireLock 判定为被占）。
 */

const createdLocks: string[] = [];
function holdLock(key: string): string {
  const p = lockPathForKey(key);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, String(process.pid), "utf-8"); // current pid ⇒ acquireLock sees it as a live holder
  createdLocks.push(p);
  return p;
}

afterEach(() => {
  while (createdLocks.length > 0) {
    try {
      rmSync(createdLocks.pop()!, { force: true });
    } catch {
      /* ignore */
    }
  }
  resetGcTimestamp();
});

describe("runDream cross-process lock", () => {
  it("skips (ran:false, locked) and does not run the body when the scope lock is held", async () => {
    const scope = "project:dream-lock-test";
    holdLock(`dream-${scope}`);

    let bodyRan = false;
    const store = {
      stats: async () => {
        bodyRan = true;
        return { totalCount: 100, scopeCounts: {}, categoryCounts: {} };
      },
      list: async () => [],
      listPage: async () => [],
      update: async () => null,
      patchMetadata: async () => null,
    };

    const result = await runDream({
      store: store as any,
      llm: null,
      embedder: { embedPassage: async () => [0, 0, 0] },
      scope,
      force: true,
      activityStatsPath: DREAM_STATS,
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toBe("locked_by_another_process");
    expect(bodyRan).toBe(false); // runDreamInner never entered
  });

  it("skips its consolidation phase when the scope's consolidate lock is held", async () => {
    const scope = "project:dream-consolidate-test";
    holdLock(`consolidate-${scope}`); // simulate a standalone consolidate_memories running
    // 2026-08-12：预置写计数，用于在末尾断言「锁被占 = 没真正处理 = 计数必须留着」。
    incrementWriteCount(scope, 15, { statsPath: DREAM_STATS });

    const activeMeta = JSON.stringify({
      evolution: { status: "active", version: 1, accessCount: 0, lastAccessedAt: null, validFrom: Date.now(), validUntil: null },
    });
    const entries = [1, 2, 3].map((i) => ({
      id: `dc-e${i}`, text: `t${i}`, vector: [1, 0, 0], category: "events", scope,
      importance: 0.5, timestamp: Date.now(), metadata: activeMeta, language: "en", fts_text: `t${i}`,
    }));
    const store = {
      stats: async () => ({ totalCount: 100, scopeCounts: {}, categoryCounts: {} }),
      list: async () => entries,
      listPage: async () => [],
      update: async () => null,
      patchMetadata: async () => null,
      getById: async () => null,
      vectorSearch: async () => [],
    };

    const result = await runDream({
      store: store as any,
      llm: null,
      embedder: { embedPassage: async () => [0, 0, 0] },
      scope,
      force: true,
      activityStatsPath: DREAM_STATS,
    });

    // Dream itself ran (its own dream lock was free), but the consolidation phase saw the
    // held consolidate lock and skipped rather than running concurrently.
    expect(result.ran).toBe(true);
    const consolidatePhase = result.phases.find((p) => p.phase === "consolidate");
    expect(consolidatePhase?.detail).toContain("skipped");

    // 2026-08-12 防「修过头」：末尾的 reset 必须是 `if (consolidateOutcome.ran)` 条件式。
    // 锁被占时这个 scope 并没有被真正处理完，若无条件清计数，它会被当成「已处理」而
    // 丢掉本轮积累的写入，下次要重新攒够阈值才轮得到 —— 是比原 bug 更隐蔽的数据损失。
    // 注意本条不是必红测试：修复前的无参 resetWriteCount() 什么也不清，同样是绿。
    // 它守的是修复的形状，不是修复的存在（存在性由 dream-pipeline.test.ts 那条守）。
    expect(getWriteCount(scope, { statsPath: DREAM_STATS })).toBe(15);
  });

  it("resets the scope's write counter after a run (no perpetual self-triggering)", async () => {
    const scope = "project:dream-reset-test";
    const statsPath = join(mkdtempSync(join(tmpdir(), "rn-reset-")), "activity-stats.json");
    // Pre-load above threshold, standing in for accumulated writes (incl. any dream self-writes).
    incrementWriteCount(scope, 15, { statsPath });
    expect(getWriteCount(scope, { statsPath })).toBe(15);

    const store = {
      stats: async () => ({ totalCount: 5, scopeCounts: {}, categoryCounts: {} }),
      // ⚠️ 2026-08-12 标注：这里 list 返回空数组，走的是 **completed_early 早退路径**，
      // 而早退路径 (dream-pipeline.ts:226) 的 resetWriteCount(scope, statsCfg) 一直是对的。
      // 本条测试因此从未覆盖「完整跑完」那条路径 —— 而 bug 恰恰在那条路径上（:301 漏传 scope）。
      // 测试名 "resets the scope's write counter after a run" 读起来像覆盖了 reset 全部行为，
      // 实际只覆盖了两条路径中正确的那一条，于是 bug 在有测试的情况下活了 41 天。
      // 完整路径的覆盖已补在 dream-pipeline.test.ts「清空已处理 scope 的写计数」一条。
      list: async () => [], // no active entries → completed_early path (still resets)
      listPage: async () => [],
      update: async () => null,
      patchMetadata: async () => null,
      getById: async () => null,
      vectorSearch: async () => [],
    };
    const result = await runDream({
      store: store as any,
      llm: null,
      embedder: { embedPassage: async () => [0, 0, 0] },
      scope,
      force: true,
      activityStatsPath: statsPath,
    });

    expect(result.ran).toBe(true);
    // Reset at dream's end clears the counter, so dream won't immediately self-retrigger —
    // fresh external writes must accumulate past the threshold again.
    expect(getWriteCount(scope, { statsPath })).toBe(0);
  });
});

describe("maybeRunGc cross-process lock + throttle", () => {
  function makeStore(totalCount: number) {
    return {
      stats: async () => ({ totalCount, scopeCounts: {}, categoryCounts: {} }),
      listPage: async () => [] as unknown[],
      update: async () => null,
      list: async () => [],
    } as any;
  }

  it("skips (locked) when another process holds the gc run lock", async () => {
    resetGcTimestamp();
    holdLock("gc-run");
    const config: AutoGcConfig = { ...DEFAULT_AUTO_GC_CONFIG, minMemoryCount: 1, minHoursSinceLastGc: 24 };
    const result = await maybeRunGc(makeStore(10), config);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("locked_by_another_process");
  });

  it("throttles a second run within the window, then runs again after reset", async () => {
    resetGcTimestamp();
    const config: AutoGcConfig = { ...DEFAULT_AUTO_GC_CONFIG, minMemoryCount: 1, minHoursSinceLastGc: 24 };

    const first = await maybeRunGc(makeStore(10), config);
    expect(first.triggered).toBe(true);

    const second = await maybeRunGc(makeStore(10), config);
    expect(second.triggered).toBe(false);
    expect(second.reason).toBe("too_soon");

    resetGcTimestamp();
    const third = await maybeRunGc(makeStore(10), config);
    expect(third.triggered).toBe(true);
  });
});
