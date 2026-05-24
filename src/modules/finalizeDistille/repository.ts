import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { knowledgeItems, sourceFragments, sources } from "../../db/schema.js";

export async function selectKnowledgeByFinalizeSourceUri(
  sourceUri: string,
): Promise<{ id: string } | null> {
  const normalized = sourceUri.trim();
  if (!normalized) return null;
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

  const [row] = await db
    .select({ sourceFragmentId: sourceFragments.id })
    .from(sourceFragments)
    .innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
    .where(and(eq(sources.uri, uri), eq(sourceFragments.locator, locator)))
    .limit(1);
  return row ?? null;
}
