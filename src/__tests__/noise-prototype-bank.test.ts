import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { persistMemory } from "../capture-engine.js";
import {
  NoisePrototypeBank,
  isProtectedContent,
  resetSharedNoisePrototypeBank,
  resolveNoisePrototypeBank,
  resolveNoisePrototypeMode,
} from "../noise-prototype-bank.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  resetSharedNoisePrototypeBank();
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recallnest-npb-"));
  cleanupPaths.push(dir);
  return dir;
}

function makeBank(overrides: Partial<ConstructorParameters<typeof NoisePrototypeBank>[0]> = {}) {
  const dir = tempDir();
  const bank = new NoisePrototypeBank({
    filePath: join(dir, "bank.json"),
    shadowLogPath: join(dir, "shadow.jsonl"),
    ...overrides,
  });
  return { bank, dir };
}

// Deterministic fake embedder: unit vectors along an axis picked by seed.
function axisVector(axis: number, dim = 8): number[] {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

const embedAxis0 = async () => axisVector(0);

describe("NoisePrototypeBank — learning discipline", () => {
  it("first rejection is only a pending candidate; the repeat sighting learns", async () => {
    const { bank } = makeBank();
    expect(await bank.learnFromRejection("嗯嗯嗯嗯好的好的", embedAxis0)).toBe("candidate_seen");
    expect(bank.list().length).toBe(0);
    expect(bank.pendingCount()).toBe(1);

    expect(await bank.learnFromRejection("嗯嗯嗯嗯好的好的", embedAxis0)).toBe("learned");
    expect(bank.list().length).toBe(1);
    expect(bank.pendingCount()).toBe(0);
    expect(bank.list()[0]?.seenCount).toBe(2);
  });

  it("normalization dedupes near-identical rejections into one candidate", async () => {
    const { bank } = makeBank();
    await bank.learnFromRejection("嗯嗯嗯嗯好的好的", embedAxis0);
    // Same content modulo whitespace/punctuation/case → same candidate.
    expect(await bank.learnFromRejection("嗯嗯嗯嗯,好的 好的!!", embedAxis0)).toBe("learned");
  });

  it("already-learned content reports skipped_duplicate without re-embedding", async () => {
    const { bank } = makeBank();
    let embeds = 0;
    const countingEmbed = async () => {
      embeds += 1;
      return axisVector(0);
    };
    await bank.learnFromRejection("嗯嗯嗯嗯好的好的", countingEmbed);
    await bank.learnFromRejection("嗯嗯嗯嗯好的好的", countingEmbed);
    expect(embeds).toBe(1);
    expect(await bank.learnFromRejection("嗯嗯嗯嗯好的好的", countingEmbed)).toBe("skipped_duplicate");
    expect(embeds).toBe(1);
  });

  it("protected content is never learned, even when the noise filter rejected it", async () => {
    const { bank } = makeBank();
    expect(await bank.learnFromRejection("记住我喜欢的部署方式", embedAxis0)).toBe("skipped_protected");
    expect(await bank.learnFromRejection("记住我喜欢的部署方式", embedAxis0)).toBe("skipped_protected");
    expect(bank.list().length).toBe(0);
    expect(bank.pendingCount()).toBe(0);
  });

  it("the cap stops learning at maxPrototypes", async () => {
    const { bank } = makeBank({ maxPrototypes: 1, minSeenCount: 1 });
    expect(await bank.learnFromRejection("噪声内容甲甲甲甲", embedAxis0)).toBe("learned");
    expect(await bank.learnFromRejection("噪声内容乙乙乙乙", embedAxis0)).toBe("skipped_full");
    expect(bank.list().length).toBe(1);
  });
});

describe("NoisePrototypeBank — shadow matching", () => {
  async function seededBank() {
    const made = makeBank({ minSeenCount: 1 });
    await made.bank.learnFromRejection("嗯嗯嗯嗯好的好的", embedAxis0);
    return made;
  }

  it("similarity at/above threshold suggests rejection and logs, but only logs", async () => {
    const { bank, dir } = await seededBank();
    const match = bank.matchShadow("嗯嗯好的收到啦", axisVector(0), "mem-123");
    expect(match.matched).toBe(true);
    expect(match.similarity).toBeCloseTo(1, 5);
    expect(bank.list()[0]?.hitCount).toBe(1);

    const log = readFileSync(join(dir, "shadow.jsonl"), "utf8").trim().split("\n");
    const suggest = log.map((l) => JSON.parse(l)).find((e) => e.event === "suggest_reject");
    expect(suggest?.memoryId).toBe("mem-123");
    expect(suggest?.prototypeId).toBe(bank.list()[0]?.id);
    expect(JSON.stringify(suggest)).not.toContain("嗯嗯好的收到啦");
  });

  it("below-threshold similarity does not match", async () => {
    const { bank } = await seededBank();
    const match = bank.matchShadow("完全不同的正交内容", axisVector(1));
    expect(match.matched).toBe(false);
    expect(bank.list()[0]?.hitCount).toBe(0);
  });

  it("protected content is never flagged regardless of similarity", async () => {
    const { bank } = await seededBank();
    const match = bank.matchShadow("记住我喜欢的部署方式", axisVector(0));
    expect(match.matched).toBe(false);
    expect(match.protected).toBe(true);
  });

  it("dimension mismatch degrades to no match instead of throwing", async () => {
    const { bank } = await seededBank();
    const match = bank.matchShadow("维度不齐的向量", [1, 0]);
    expect(match.matched).toBe(false);
  });
});

describe("NoisePrototypeBank — correction & lifecycle", () => {
  it("removePrototype surgically deletes one false positive", async () => {
    const { bank } = makeBank({ minSeenCount: 1 });
    await bank.learnFromRejection("噪声内容甲甲甲甲", embedAxis0);
    const id = bank.list()[0]?.id ?? "";
    expect(bank.removePrototype(id)).toBe(true);
    expect(bank.list().length).toBe(0);
    expect(bank.removePrototype(id)).toBe(false);
  });

  it("clear resets everything", async () => {
    const { bank } = makeBank({ minSeenCount: 1 });
    await bank.learnFromRejection("噪声内容甲甲甲甲", embedAxis0);
    bank.clear();
    expect(bank.list().length).toBe(0);
  });

  it("state survives reconstruction from disk; expired prototypes are swept", async () => {
    const { bank, dir } = makeBank({ minSeenCount: 1 });
    await bank.learnFromRejection("噪声内容甲甲甲甲", embedAxis0);

    const reloaded = new NoisePrototypeBank({
      filePath: join(dir, "bank.json"),
      shadowLogPath: join(dir, "shadow.jsonl"),
    });
    expect(reloaded.list().length).toBe(1);

    // Age the stored prototype past the TTL, then reload.
    const raw = JSON.parse(readFileSync(join(dir, "bank.json"), "utf8"));
    raw.prototypes[0].learnedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(join(dir, "bank.json"), JSON.stringify(raw), "utf8");
    const expiring = new NoisePrototypeBank({
      filePath: join(dir, "bank.json"),
      shadowLogPath: join(dir, "shadow.jsonl"),
    });
    expect(expiring.list().length).toBe(0);
  });
});

describe("isProtectedContent", () => {
  it("covers memory verbs, corrections, decisions, identity, preferences", () => {
    for (const text of ["记住这个", "帮我记一下", "纠正一下,不对", "我决定用方案B", "我是安闲静雅", "我喜欢深色主题", "i prefer dark mode", "remember this setup"]) {
      expect(`${text}:${isProtectedContent(text)}`).toBe(`${text}:true`);
    }
    for (const text of ["嗯嗯好的", "git push", "今天天气不错"]) {
      expect(`${text}:${isProtectedContent(text)}`).toBe(`${text}:false`);
    }
  });
});

describe("resolveNoisePrototypeMode / shared bank resolution", () => {
  it("defaults to shadow in production, off under NODE_ENV=test unless explicit", () => {
    expect(resolveNoisePrototypeMode({} as NodeJS.ProcessEnv)).toBe("shadow");
    expect(resolveNoisePrototypeMode({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe("off");
    expect(resolveNoisePrototypeMode({ NODE_ENV: "test", RECALLNEST_NOISE_PROTOTYPE: "shadow" } as NodeJS.ProcessEnv)).toBe("shadow");
    expect(resolveNoisePrototypeMode({ RECALLNEST_NOISE_PROTOTYPE: "off" } as NodeJS.ProcessEnv)).toBe("off");
    expect(resolveNoisePrototypeMode({ RECALLNEST_NOISE_PROTOTYPE: "banana" } as NodeJS.ProcessEnv)).toBe("shadow");
  });

  it("explicit deps win over the env-governed shared instance", () => {
    const { bank } = makeBank();
    expect(resolveNoisePrototypeBank(bank)).toBe(bank);
    expect(resolveNoisePrototypeBank(null)).toBeNull();
    // Under bun test (NODE_ENV=test, no explicit env) the shared bank is off.
    expect(resolveNoisePrototypeBank(undefined)).toBeNull();
  });
});

// --- integration through persistMemory ---

function makePersistDeps(bank: NoisePrototypeBank | null) {
  const storeCalls: unknown[] = [];
  return {
    storeCalls,
    deps: {
      embedder: {
        async embedPassage() {
          return axisVector(0);
        },
      },
      store: {
        async store(entry: Record<string, unknown>) {
          storeCalls.push(entry);
          return { ...entry, id: `mem-${storeCalls.length}`, timestamp: Date.now() };
        },
      },
      noisePrototypeBank: bank,
    },
  };
}

describe("persistMemory × noise-prototype shadow", () => {
  it("noise_detected rejection feeds the bank; the write is still rejected", async () => {
    const { bank } = makeBank({ minSeenCount: 1 });
    const { deps } = makePersistDeps(bank);

    const result = await persistMemory(deps as never, {
      text: "hello world, how are you today?",
      category: "events",
      importance: 0.7,
      scope: "project:npb-test",
      source: "manual",
    });

    expect(result.disposition).toBe("rejected");
    expect(result.rejectionReason).toBe("noise_detected");
    expect(bank.list().length).toBe(1); // minSeenCount 1 → learned immediately
  });

  it("accepted writes run the shadow match against the write-path vector", async () => {
    const { bank, dir } = makeBank({ minSeenCount: 1 });
    await bank.learnFromRejection("噪声原型种子内容", embedAxis0);
    const { deps } = makePersistDeps(bank);

    const result = await persistMemory(deps as never, {
      text: "RecallNest 的 readConsistencyInterval 已经默认为 0",
      category: "events",
      importance: 0.7,
      scope: "project:npb-test",
      source: "manual",
    });

    expect(result.disposition).not.toBe("rejected");
    const log = readFileSync(join(dir, "shadow.jsonl"), "utf8");
    expect(log).toContain("suggest_reject"); // axis-0 fake vectors always collide
  });

  it("bank=null disables both sides completely", async () => {
    const { deps } = makePersistDeps(null);
    const result = await persistMemory(deps as never, {
      text: "hello world, how are you today?",
      category: "events",
      importance: 0.7,
      scope: "project:npb-test",
      source: "manual",
    });
    expect(result.disposition).toBe("rejected"); // admission unchanged
  });
});
