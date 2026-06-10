/**
 * P1-C: Seed/refresh RecallNest self-capability digest memories.
 *
 * 解决 FAILURES.md 5-13 批次的 capture gap:"问 RN 自己有什么能力,答不上来"。
 * digest 由脚本从两个事实源生成而非手写,保证与代码同步:
 *   1. src/mcp-server.ts 的 TOOL_TIERS 注册表(每 tier 一条)
 *   2. ROADMAP.md "Already Done" 段(总览一条)
 *
 * 写入走 persistMemory 的 canonicalKey upsert(rn-capability-{tier|overview}),
 * release 重跑即覆盖旧条目——天然去重 + 冲突可审。
 *
 * 用法:
 *   bun run scripts/seed-capability-digest.ts --dry-run   # 预览不写库
 *   bun run scripts/seed-capability-digest.ts             # 写入/刷新
 *
 * Release 流程:version bump 后重跑一次(见 OPERATIONS.md)。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { persistMemory } from "../src/capture-engine.js";
import { createComponents, loadConfig, loadDotEnv } from "../src/runtime-config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = "recallnest:self";

function parseToolTiers(): Map<string, string[]> {
  const src = readFileSync(resolve(ROOT, "src/mcp-server.ts"), "utf8");
  const block = src.match(/const TOOL_TIERS[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!block) throw new Error("TOOL_TIERS block not found in src/mcp-server.ts");
  const tiers = new Map<string, string[]>();
  for (const m of block[1].matchAll(/^\s*(\w+):\s*"(core|advanced|governance)",?\s*$/gm)) {
    const [, tool, tier] = m;
    const list = tiers.get(tier) ?? [];
    list.push(tool);
    tiers.set(tier, list);
  }
  if (tiers.size === 0) throw new Error("No tool tier entries parsed — TOOL_TIERS format changed?");
  return tiers;
}

function parseAlreadyDone(): string[] {
  const md = readFileSync(resolve(ROOT, "ROADMAP.md"), "utf8");
  const section = md.match(/### Already Done\n([\s\S]*?)\n### /);
  if (!section) throw new Error("'Already Done' section not found in ROADMAP.md");
  return section[1]
    .split("\n")
    .filter(l => l.trim().startsWith("- "))
    .map(l => l.trim().slice(2).trim())
    .filter(l => l.length > 0);
}

const TIER_DESC: Record<string, string> = {
  core: "始终注册的核心层(记忆读写与跨窗口连续性)",
  advanced: "进阶层(distill/brief/pin/lint/dream/skill 等记忆治理)",
  governance: "治理层(workflow 观测、冲突裁决、升华扫描,默认 CLI-only)",
};

const tiers = parseToolTiers();
const done = parseAlreadyDone();
const toolTotal = [...tiers.values()].reduce((n, list) => n + list.length, 0);

const digests: Array<{ canonicalKey: string; text: string }> = [];
for (const [tier, tools] of tiers) {
  digests.push({
    canonicalKey: `rn-capability-${tier}`,
    text:
      `RecallNest ${tier} tier MCP 工具清单(${TIER_DESC[tier] ?? tier},共 ${tools.length} 个):` +
      `${tools.join(", ")}。` +
      `当被问"recallnest 有哪些工具/能力/tier"时,本条是 ${tier} tier 的权威出处(脚本自动生成,与 TOOL_TIERS 注册表同步)。`,
  });
}
digests.push({
  canonicalKey: "rn-capability-overview",
  text:
    `RecallNest 已实现能力总览(共 ${toolTotal} 个 MCP 工具/3 tier;来自 ROADMAP "Already Done" ${done.length} 项):` +
    done.map(d => d.split(/[:：(]/)[0].trim()).join("; ") +
    "。当被问 recallnest 整体能力/做过什么时引用本条(脚本自动生成,与 ROADMAP 同步)。",
});

const dryRun = process.argv.includes("--dry-run");

if (dryRun) {
  for (const d of digests) {
    console.log(`--- ${d.canonicalKey} (${d.text.length} chars)`);
    console.log(d.text.slice(0, 400));
    console.log();
  }
  console.log(`[dry-run] ${digests.length} digests, nothing written.`);
  process.exit(0);
}

loadDotEnv();
const config = loadConfig();
const { store, embedder } = createComponents(config);

for (const d of digests) {
  const record = await persistMemory(
    { store, embedder },
    {
      text: d.text,
      category: "entities",
      scope: SCOPE,
      importance: 0.9,
      source: "agent",
      canonicalKey: d.canonicalKey,
      topicTag: "recallnest-self",
    },
  );
  console.log(`${d.canonicalKey}: ${record.disposition} id=${record.id.slice(0, 8)} scope=${record.resolvedScope}`);
}
console.log(`Done: ${digests.length} capability digests seeded/refreshed (scope=${SCOPE}).`);
