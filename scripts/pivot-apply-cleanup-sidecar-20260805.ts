// 二轮收尾连带清理：① 0d60b0ef NaN 脏行删除 ② fabf6b15 悬空 supersededBy 清指针
// 在 supervisor 窗口 + 快照后运行。
import * as lancedb from "@lancedb/lancedb";

const db = await lancedb.connect(process.env.HOME + "/recallnest/data/lancedb");
const t = await db.openTable("memories");

const nan = await t.query().where("id LIKE '0d60b0ef%'").select(["id", "scope"]).toArray();
if (nan.length === 1 && String(nan[0].scope) === "test") {
  await t.delete("id LIKE '0d60b0ef%'");
  console.log("① 0d60b0ef (scope=test, NaN vector) 已删");
} else {
  console.log("① 0d60b0ef 状态异常，跳过:", nan.length, nan[0]?.scope);
}

const rows = await t.query().where("id LIKE 'fabf6b15%'").select(["id", "metadata"]).toArray();
if (rows.length === 1) {
  const md = JSON.parse(String(rows[0].metadata || "{}"));
  const sb = md.evolution?.supersededBy ?? md.supersededBy;
  if (typeof sb === "string" && sb.startsWith("fd4799bc")) {
    if (md.evolution?.supersededBy) delete md.evolution.supersededBy;
    if (md.supersededBy) delete md.supersededBy;
    md.evolutionNote = "dangling supersededBy fd4799bc cleared 2026-08-05 (target never existed)";
    const id = String(rows[0].id).replace(/'/g, "");
    await t.update({ where: "id = '" + id + "'", values: { metadata: JSON.stringify(md) } });
    console.log("② fabf6b15 悬空指针已清");
  } else {
    console.log("② fabf6b15 指针与预期不符，跳过:", JSON.stringify(md.evolution ?? {}).slice(0, 80), String(sb).slice(0, 20));
  }
} else {
  console.log("② fabf6b15 行数异常", rows.length);
}
console.log("final countRows:", await t.countRows());
