#!/usr/bin/env bun
/**
 * 给存量记忆回填 session 级图片标记。
 *
 * 背景：ingest 从此会给每条记忆打上「所在 session 里有几张图」的标（用户亲手贴的
 * 与 AI 自己产的分开计），但已经入库的记忆没有。图本体不进库，标记只是让人和 agent
 * 知道「这附近还有图没看」，再决定要不要回原始 transcript 读。
 *
 * 输入是 `scripts/scan-image-sessions.py` 的产物（补集口径，与 ingest 的
 * countImageSignals 同源；改一边必须改另一边），形如：
 *   { "cc:05a9a168": { "user": 7, "tool": 23 }, "codex:019f710a": { ... } }
 * key 就是库里的 scope，所以这里只做字符串相等匹配，不猜、不模糊匹配。
 *
 * 只改 metadata，不动 vector、不重新 embedding、不调 LLM —— 这是它便宜的原因。
 *
 * Usage:
 *   bun scripts/backfill-session-images.ts --dry-run
 *   bun scripts/backfill-session-images.ts
 *   bun scripts/backfill-session-images.ts --map /tmp/image-sessions-v4.json
 */

import { readFileSync } from "node:fs";

import { loadDotEnv, loadConfig, resolveDbPath } from "../src/runtime-config.js";
import { MemoryStore, loadLanceDB } from "../src/store.js";

loadDotEnv();
const config = loadConfig();

const dryRun = process.argv.includes("--dry-run");
const mapIdx = process.argv.indexOf("--map");
const mapPath = mapIdx >= 0 ? process.argv[mapIdx + 1] : "/tmp/image-sessions-v4.json";

interface Counts {
  user: number;
  tool: number;
}

async function main() {
  console.log(`=== session 图片标记回填${dryRun ? "（dry run）" : ""} ===\n`);

  const raw = JSON.parse(readFileSync(mapPath, "utf8")) as Record<string, Counts>;
  const mapEntries = Object.entries(raw);
  console.log(`  扫描映射   : ${mapEntries.length} 个带图 session（${mapPath}）`);
  console.log(
    `               用户贴图 ${mapEntries.reduce((s, [, c]) => s + (c.user || 0), 0)} 张，` +
      `AI 产图 ${mapEntries.reduce((s, [, c]) => s + (c.tool || 0), 0)} 张`,
  );

  const lancedb = await loadLanceDB();
  const dbPath = resolveDbPath(config);
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable("memories");

  const rows = await table.query().select(["id", "scope", "metadata"]).toArray();
  console.log(`  库中记忆   : ${rows.length} 条\n`);

  const patches: Array<{
    id: string;
    patchFn: (meta: Record<string, unknown>) => Record<string, unknown>;
  }> = [];
  const hitScopes = new Set<string>();
  let alreadyCurrent = 0;
  const samples: string[] = [];

  for (const row of rows) {
    const scope = row.scope as string;
    const counts = raw[scope];
    if (!counts) continue;

    const wantUser = counts.user > 0 ? counts.user : undefined;
    const wantTool = counts.tool > 0 ? counts.tool : undefined;

    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse((row.metadata as string) || "{}");
    } catch {
      meta = {};
    }
    if (meta.sessionImages === wantUser && meta.sessionToolImages === wantTool) {
      alreadyCurrent++;
      continue;
    }

    hitScopes.add(scope);
    patches.push({
      id: row.id as string,
      // ⚠️ patchFn 的返回值会整个替换 metadata（store.ts:1273 处 JSON.stringify(patched)），
      // 所以必须先摊开原有字段，只能加不能覆盖别人。
      patchFn: (m) => {
        const next: Record<string, unknown> = { ...m };
        if (wantUser !== undefined) next.sessionImages = wantUser;
        if (wantTool !== undefined) next.sessionToolImages = wantTool;
        return next;
      },
    });

    if (samples.length < 5) {
      samples.push(`${scope}  用户贴图 ${counts.user} / AI 产图 ${counts.tool}`);
    }
  }

  console.log(`  命中 scope : ${hitScopes.size} 个（映射里其余的 session 在库中没有记忆）`);
  console.log(`  待打标     : ${patches.length} 条`);
  console.log(`  已是最新   : ${alreadyCurrent} 条`);
  if (samples.length) {
    console.log(`\n  样本:`);
    for (const s of samples) console.log(`    ${s}`);
  }

  if (dryRun) {
    console.log(`\n  dry run —— 一条没写。去掉 --dry-run 才真正执行。`);
    return;
  }
  if (patches.length === 0) {
    console.log(`\n  没有需要更新的记忆。`);
    return;
  }

  const store = new MemoryStore({
    dbPath,
    vectorDim: config.embedding.dimensions || 1024,
  });
  const written = await store.patchMetadataBatch(patches);
  console.log(`\n  已写入 ${written} 条（预期 ${patches.length}）`);
  if (written !== patches.length) {
    console.log(
      `  ⚠️ 写入数与预期不符——patchMetadataBatch 会跳过读不到的行（并发删除属正常），` +
        `差额 ${patches.length - written} 条。再跑一次 --dry-run 看是否收敛。`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
