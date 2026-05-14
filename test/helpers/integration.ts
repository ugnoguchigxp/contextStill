import { sql } from "drizzle-orm";
import { closeDbPool, getDb } from "../../src/db/index.js";

const requiredTables = [
  "knowledge_items",
  "sources",
  "source_fragments",
  "knowledge_source_links",
  "vibe_memories",
  "agent_diff_entries",
  "relations",
  "context_compile_runs",
  "context_pack_items",
] as const;

const requiredTableSqlList = requiredTables.map((tableName) => `'${tableName}'`).join(", ");

export function isDbIntegrationEnabled(): boolean {
  return process.env.MEMORY_ROUTER_RUN_DB_TESTS === "1";
}

export async function ensureDbIntegrationReady(): Promise<void> {
  const db = getDb();
  await db.execute(sql`select 1 as ok`);

  const result = await db.execute(sql`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in (
        ${sql.raw(requiredTableSqlList)}
      )
  `);
  const existing = (result.rows as Array<{ table_name: string }>).map((row) => row.table_name);
  const missing = requiredTables.filter((name) => !existing.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `DB integration tests require migrated schema. Missing tables: ${missing.join(", ")}`,
    );
  }
}

export async function truncateIntegrationTables(): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    truncate table
      context_pack_items,
      context_compile_runs,
      agent_diff_entries,
      vibe_memories,
      knowledge_source_links,
      source_fragments,
      sources,
      relations,
      knowledge_items
    restart identity cascade
  `);
}

export async function closeIntegrationDb(): Promise<void> {
  await closeDbPool();
}
