import { desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { vibeMemories } from "../../db/schema.js";

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
      content: seed.content,
      memoryType: seed.memoryType ?? "chat",
      embedding: seed.embedding,
      metadata: seed.metadata ?? {},
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
  const filters = [];

  if (params.sessionId) {
    filters.push(eq(vibeMemories.sessionId, params.sessionId));
  }

  // Full-text search and LIKE search
  const searchFilters = [
    sql`to_tsvector('simple', ${vibeMemories.content}) @@ plainto_tsquery('simple', ${query})`,
    ilike(vibeMemories.content, `%${query}%`),
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
    .where(or(...searchFilters))
    .orderBy(desc(sql`ts_rank_cd(to_tsvector('simple', ${vibeMemories.content}), plainto_tsquery('simple', ${query}))`))
    .limit(params.limit);

  return results;
}

export async function getVibeMemoriesBySession(sessionId: string, limit = 50) {
  return db
    .select()
    .from(vibeMemories)
    .where(eq(vibeMemories.sessionId, sessionId))
    .orderBy(desc(vibeMemories.createdAt))
    .limit(limit);
}
