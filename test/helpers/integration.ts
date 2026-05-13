import { sql } from "drizzle-orm";
import { closeDbPool, getDb } from "../../src/db/index.js";

const requiredTables = [
  "knowledge_items",
  "evidence_sources",
  "evidence_fragments",
  "relations",
  "context_compile_runs",
  "context_pack_items",
  "code_symbols",
] as const;

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
        'knowledge_items',
        'evidence_sources',
        'evidence_fragments',
        'relations',
        'context_compile_runs',
        'context_pack_items',
        'code_symbols'
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
      relations,
      evidence_fragments,
      evidence_sources,
      knowledge_items,
      code_symbols
    restart identity cascade
  `);
}

export async function closeIntegrationDb(): Promise<void> {
  await closeDbPool();
}
