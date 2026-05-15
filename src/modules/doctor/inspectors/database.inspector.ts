import { sql } from "drizzle-orm";
import { getDb } from "../../../db/index.js";
import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import { requiredTableSqlList, requiredTables } from "../doctor.constants.js";

type DatabaseInspectorOptions = {
  freshnessThresholdMinutes: number;
};

export type DatabaseInspection = {
  db: DoctorReport["db"];
  reachable: boolean;
  vectorInstalled: boolean;
  existingTables: string[];
  missingTables: string[];
  staleKnowledgeCount: number;
  staleSourceCount: number;
  reasons: string[];
};

export async function inspectDatabase({
  freshnessThresholdMinutes,
}: DatabaseInspectorOptions): Promise<DatabaseInspection> {
  const db = getDb();
  const startedAt = Date.now();

  try {
    await db.execute(sql`select 1 as ok`);
  } catch (error) {
    return {
      db: {
        reachable: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
      reachable: false,
      vectorInstalled: false,
      existingTables: [],
      missingTables: [...requiredTables],
      staleKnowledgeCount: 0,
      staleSourceCount: 0,
      reasons: ["DB_UNREACHABLE"],
    };
  }

  const reasons: string[] = [];

  let vectorInstalled = false;
  try {
    const result = await db.execute(
      sql`select exists(select 1 from pg_extension where extname = 'vector') as installed`,
    );
    vectorInstalled = Boolean((result.rows as Array<{ installed: boolean }>)[0]?.installed);
    if (!vectorInstalled) {
      reasons.push("VECTOR_EXTENSION_MISSING");
    }
  } catch {
    reasons.push("VECTOR_EXTENSION_CHECK_FAILED");
  }

  let existingTables: string[] = [];
  try {
    const result = await db.execute(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          ${sql.raw(requiredTableSqlList)}
        )
    `);
    existingTables = (result.rows as Array<{ table_name: string }>).map((row) => row.table_name);
  } catch {
    reasons.push("REQUIRED_TABLES_CHECK_FAILED");
  }

  const missingTables = requiredTables.filter((tableName) => !existingTables.includes(tableName));
  if (missingTables.length > 0) {
    reasons.push("MISSING_REQUIRED_TABLES");
  }

  let staleKnowledgeCount = 0;
  let staleSourceCount = 0;

  if (!missingTables.includes("knowledge_items")) {
    try {
      const result = await db.execute(sql`
        select count(*)::int as count
        from knowledge_items
        where status = 'deprecated'
      `);
      staleKnowledgeCount = Number((result.rows as Array<{ count?: number }>)[0]?.count ?? 0);
    } catch {
      reasons.push("STALE_KNOWLEDGE_COUNT_QUERY_FAILED");
    }
  }

  if (!missingTables.includes("sources")) {
    try {
      const result = await db.execute(sql`
        select count(*)::int as count
        from sources
        where updated_at < now() - (${freshnessThresholdMinutes} * interval '1 minute')
      `);
      staleSourceCount = Number((result.rows as Array<{ count?: number }>)[0]?.count ?? 0);
    } catch {
      reasons.push("STALE_SOURCE_COUNT_QUERY_FAILED");
    }
  }

  return {
    db: {
      reachable: true,
      durationMs: Date.now() - startedAt,
    },
    reachable: true,
    vectorInstalled,
    existingTables,
    missingTables,
    staleKnowledgeCount,
    staleSourceCount,
    reasons,
  };
}
