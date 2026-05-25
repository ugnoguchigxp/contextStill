import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { agentDiffEntries, vibeMemories } from "../../db/schema.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";

export type VibeMemorySeed = {
  sessionId: string;
  content: string;
  memoryType?: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
};

export async function insertVibeMemory(seed: VibeMemorySeed) {
  const [inserted] = await db
    .insert(vibeMemories)
    .values({
      sessionId: seed.sessionId,
      content: redactSecrets(seed.content),
      memoryType: seed.memoryType ?? "chat",
      embedding: seed.embedding,
      metadata: redactSecretRecord(seed.metadata ?? {}),
    })
    .returning();
  return inserted;
}

export async function searchVibeMemories(params: {
  query: string;
  limit: number;
  sessionId?: string;
}) {
  const query = params.query.trim();
  if (!query) {
    return [];
  }
  const filters = [];

  if (params.sessionId) {
    filters.push(eq(vibeMemories.sessionId, params.sessionId));
  }

  // Full-text search and LIKE search
  const searchFilters = [
    sql`to_tsvector('simple', ${vibeMemories.content}) @@ plainto_tsquery('simple', ${query})`,
    ilike(vibeMemories.content, `%${query}%`),
    sql`exists (
      select 1
      from ${agentDiffEntries}
      where ${agentDiffEntries.vibeMemoryId} = ${vibeMemories.id}
        and (
          ${agentDiffEntries.filePath} ilike ${`%${query}%`}
          or ${agentDiffEntries.diffHunk} ilike ${`%${query}%`}
          or coalesce(${agentDiffEntries.symbolName}, '') ilike ${`%${query}%`}
          or coalesce(${agentDiffEntries.symbolKind}, '') ilike ${`%${query}%`}
          or coalesce(${agentDiffEntries.signature}, '') ilike ${`%${query}%`}
        )
    )`,
  ];

  const results = await db
    .select({
      id: vibeMemories.id,
      sessionId: vibeMemories.sessionId,
      content: vibeMemories.content,
      memoryType: vibeMemories.memoryType,
      metadata: vibeMemories.metadata,
      createdAt: vibeMemories.createdAt,
      score: sql<number>`ts_rank_cd(to_tsvector('simple', ${vibeMemories.content}), plainto_tsquery('simple', ${query}))`,
    })
    .from(vibeMemories)
    .where(and(...filters, or(...searchFilters)))
    .orderBy(
      desc(
        sql`ts_rank_cd(to_tsvector('simple', ${vibeMemories.content}), plainto_tsquery('simple', ${query}))`,
      ),
    )
    .limit(params.limit);

  return results;
}
