/**
 * tier 分布 + decay 豁免集合快照（只读）。
 *
 * 用途：任何声称「不动 tier / 不动 decay 豁免」的改动，跑前跑后各来一次，
 * 对 tierCounts 与 exemptHash（排序后的豁免 id 列表 sha256 前 16 位）。
 * 数字相同 = 集合逐条相同，不是「总数碰巧一样」。
 *
 * 用法：bun run scripts/tier-exemption-snapshot.ts [scope] [输出路径]
 * 首次用于 2026-08-23 的 metadata.utility 落地验收（见 CHANGELOG Unreleased）。
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadConfig, createStoreOnly } from "../src/runtime-config.js";
import { isDecayExempt, resolveTier } from "../src/decay-engine.js";
import { readUtility } from "../src/memory-utility.js";

const SCOPE = process.argv[2] ?? "memory:pivot";
const OUT = process.argv[3] ?? `logs/tier-snapshot-${Date.now()}.json`;
const store = createStoreOnly(loadConfig());

const tierCounts: Record<string, number> = { core: 0, working: 0, peripheral: 0 };
const exemptIds: string[] = [];
const utilityIds: Array<{ id: string; utility: number }> = [];
let total = 0;
const pageSize = 1000;

for (let offset = 0; ; offset += pageSize) {
  const page = await store.listPage({ scopeFilter: [SCOPE], limit: pageSize, offset });
  if (page.length === 0) break;
  for (const e of page) {
    total++;
    tierCounts[resolveTier(e.metadata, e.importance)]++;
    if (isDecayExempt(e.metadata, e.importance, e.category)) exemptIds.push(e.id);
    const u = readUtility(e.metadata);
    if (u !== null) utilityIds.push({ id: e.id, utility: u });
  }
  if (page.length < pageSize) break;
}

exemptIds.sort();
utilityIds.sort((a, b) => a.id.localeCompare(b.id));
const snapshot = {
  scope: SCOPE,
  total,
  tierCounts,
  exemptCount: exemptIds.length,
  exemptHash: createHash("sha256").update(exemptIds.join("\n")).digest("hex").slice(0, 16),
  utilityCount: utilityIds.length,
  utilityNegative: utilityIds.filter(u => u.utility < 0).length,
  utilities: utilityIds,
};
writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
console.log(JSON.stringify({ ...snapshot, utilities: `${utilityIds.length} entries → ${OUT}` }, null, 2));
