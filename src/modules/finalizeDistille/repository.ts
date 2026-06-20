import { and, eq, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { knowledgeItems, sourceFragments, sources } from "../../db/schema.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

export async function selectKnowledgeByFinalizeSourceUri(
  sourceUri: string,
): Promise<{ id: string } | null> {
  const normalized = sourceUri.trim();
  if (!normalized) return null;
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = sqlite.db
      .query<{ id: string; metadata: string }, []>("select id, metadata from knowledge_items")
      .all();
    return (
      rows.find((row) => {
        try {
          const metadata = JSON.parse(row.metadata) as { sourceUri?: unknown };
          return metadata.sourceUri === normalized;
        } catch {
          return false;
        }
      }) ?? null
    );
  }
  const [row] = await db
    .select({ id: knowledgeItems.id })
    .from(knowledgeItems)
    .where(sql`${knowledgeItems.metadata} ->> 'sourceUri' = ${normalized}`)
    .limit(1);
  return row ?? null;
}

export async function listKnowledgeIdsByTargetStateId(targetStateId: string): Promise<string[]> {
  const normalized = targetStateId.trim();
  if (!normalized) return [];
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = sqlite.db
      .query<{ id: string; metadata: string }, []>("select id, metadata from knowledge_items")
      .all();
    return rows
      .filter((row) => {
        try {
          const metadata = JSON.parse(row.metadata) as { targetStateId?: unknown };
          return metadata.targetStateId === normalized;
        } catch {
          return false;
        }
      })
      .map((row) => row.id);
  }
  const rows = await db
    .select({ id: knowledgeItems.id })
    .from(knowledgeItems)
    .where(sql`${knowledgeItems.metadata} ->> 'targetStateId' = ${normalized}`);
  return rows.map((row) => row.id);
}

export async function findSourceFragmentByReference(params: {
  uri: string;
  locator?: string;
}): Promise<{ sourceFragmentId: string } | null> {
  const uri = params.uri.trim();
  const locator = params.locator?.trim();
  if (!uri || !locator) return null;

  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query<{ sourceFragmentId: string }, [string, string]>(
        `
        select sf.id as sourceFragmentId
        from source_fragments sf
        inner join sources s on s.id = sf.source_id
        where s.uri = ?
          and sf.locator = ?
        limit 1
      `,
      )
      .get(uri, locator);
    return row ?? null;
  }

  const [row] = await db
    .select({ sourceFragmentId: sourceFragments.id })
    .from(sourceFragments)
    .innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
    .where(and(eq(sources.uri, uri), eq(sourceFragments.locator, locator)))
    .limit(1);
  return row ?? null;
}
