import { detectLanguage, tokenizeForFts, initTokenizer } from "babel-memory";

/**
 * Backfill language + fts_text for existing memories.
 * Idempotent: skips records that already have language set.
 *
 * Usage: bun scripts/migrate-language.ts <lance-db-path>
 */
async function migrate(dbPath: string) {
  await initTokenizer();

  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(dbPath);
  const tableNames = await db.tableNames();

  for (const name of tableNames) {
    if (!name.startsWith("memories_")) continue;

    const table = await db.openTable(name);
    const rows = await table.query()
      .select(["id", "text", "language"])
      .toArray();

    const toUpdate: Array<{
      id: string;
      language: string;
      fts_text: string;
    }> = [];

    for (const row of rows) {
      if (row.language && row.language !== "") continue;
      const text = row.text as string;
      const language = detectLanguage(text);
      const fts_text = tokenizeForFts(text, language);
      toUpdate.push({ id: row.id as string, language, fts_text });
    }

    if (toUpdate.length === 0) {
      console.log(`[${name}] No records to migrate`);
      continue;
    }

    for (let i = 0; i < toUpdate.length; i += 100) {
      const batch = toUpdate.slice(i, i + 100);
      for (const item of batch) {
        await table.update({
          where: `id = '${item.id}'`,
          values: {
            language: item.language,
            fts_text: item.fts_text,
          },
        });
      }
      console.log(
        `[${name}] Migrated ${Math.min(i + 100, toUpdate.length)}/${toUpdate.length}`,
      );
    }

    console.log(`[${name}] Rebuilding FTS index on fts_text...`);
    const lancedbMod = await import("@lancedb/lancedb");
    await table.createIndex("fts_text", {
      config: (lancedbMod as any).Index.fts(),
      replace: true,
    });

    console.log(`[${name}] Done`);
  }
}

const dbPath = process.argv[2] || process.env.RECALLNEST_DB_PATH;
if (!dbPath) {
  console.error("Usage: bun scripts/migrate-language.ts <lance-db-path>");
  process.exit(1);
}
migrate(dbPath).catch(console.error);
