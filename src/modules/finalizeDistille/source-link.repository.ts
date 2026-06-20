import { and, eq } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { knowledgeSourceLinks } from "../../db/schema.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

export async function linkKnowledgeToSourceFragment(params: {
  knowledgeId: string;
  sourceFragmentId: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await getSqliteCoreDatabase();
    const existing = sqlite.db
      .query<{ id: string }, [string, string]>(
        `
        select id
        from knowledge_source_links
        where knowledge_id = ?
          and source_fragment_id = ?
        limit 1
      `,
      )
      .get(params.knowledgeId, params.sourceFragmentId);
    if (existing) return;
    sqlite.db
      .query(
        `
        insert into knowledge_source_links (
          id, knowledge_id, source_fragment_id, link_type, confidence, metadata, created_at
        ) values (?, ?, ?, 'derived_from', ?, ?, ?)
      `,
      )
      .run(
        crypto.randomUUID(),
        params.knowledgeId,
        params.sourceFragmentId,
        params.confidence,
        JSON.stringify(params.metadata ?? {}),
        new Date().toISOString(),
      );
    return;
  }

  const existing = await db.query.knowledgeSourceLinks.findFirst({
    where: and(
      eq(knowledgeSourceLinks.knowledgeId, params.knowledgeId),
      eq(knowledgeSourceLinks.sourceFragmentId, params.sourceFragmentId),
    ),
  });
  if (existing) return;
  await db.insert(knowledgeSourceLinks).values({
    knowledgeId: params.knowledgeId,
    sourceFragmentId: params.sourceFragmentId,
    linkType: "derived_from",
    confidence: params.confidence,
    metadata: params.metadata ?? {},
  });
}
