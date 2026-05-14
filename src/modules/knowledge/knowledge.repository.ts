import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { knowledgeItems } from "../../db/schema.js";
import type {
  KnowledgeSearchInput,
  KnowledgeStatus,
  KnowledgeItem,
} from "../../shared/schemas/knowledge.schema.js";

export type KnowledgeSearchResult = {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  score: number;
};

export type UpsertKnowledgeFromSourceParams = {
  sourceUri: string;
  contentHash: string;
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  scope: KnowledgeItem["scope"];
  title: string;
  body: string;
  confidence?: number;
  importance?: number;
  metadata?: Record<string, unknown>;
  embedding?: number[];
};

function finiteOrZero(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export async function searchKnowledge(
  input: KnowledgeSearchInput,
): Promise<KnowledgeSearchResult[]> {
  const conditions = [];

  if (input.types && input.types.length > 0) {
    conditions.push(inArray(knowledgeItems.type, input.types));
  }

  if (input.statuses && input.statuses.length > 0) {
    conditions.push(inArray(knowledgeItems.status, input.statuses));
  } else {
    conditions.push(eq(knowledgeItems.status, input.status));
  }

  const query = input.query.trim();
  const rankExpr = sql<number>`
    ts_rank_cd(
      to_tsvector('simple', concat_ws(' ', ${knowledgeItems.title}, ${knowledgeItems.body})),
      plainto_tsquery('simple', ${query})
    )
  `;
  const textMatchExpr = sql<boolean>`
    to_tsvector('simple', concat_ws(' ', ${knowledgeItems.title}, ${knowledgeItems.body}))
    @@ plainto_tsquery('simple', ${query})
  `;
  conditions.push(
    or(
      ilike(knowledgeItems.title, `%${query}%`),
      ilike(knowledgeItems.body, `%${query}%`),
      textMatchExpr,
    ),
  );

  const rows = await db
    .select({
      id: knowledgeItems.id,
      type: knowledgeItems.type,
      status: knowledgeItems.status,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      confidence: knowledgeItems.confidence,
      importance: knowledgeItems.importance,
      score: rankExpr,
    })
    .from(knowledgeItems)
    .where(and(...conditions))
    .orderBy(desc(rankExpr), desc(knowledgeItems.importance), desc(knowledgeItems.updatedAt))
    .limit(input.limit);

  return rows.map((row) => ({
    ...row,
    score: finiteOrZero(row.score),
    confidence: finiteOrZero(row.confidence),
    importance: finiteOrZero(row.importance),
  }));
}

export async function upsertKnowledgeFromSource(
  params: UpsertKnowledgeFromSourceParams,
): Promise<string> {
  const existing = await db.query.knowledgeItems.findFirst({
    where: and(
      sql`${knowledgeItems.metadata} ->> 'sourceUri' = ${params.sourceUri}`,
      sql`${knowledgeItems.metadata} ->> 'contentHash' = ${params.contentHash}`,
    ),
  });

  const metadata = {
    ...(params.metadata ?? {}),
    sourceUri: params.sourceUri,
    contentHash: params.contentHash,
  };

  if (existing) {
    await db
      .update(knowledgeItems)
      .set({
        type: params.type,
        status: params.status,
        scope: params.scope,
        title: params.title,
        body: params.body,
        confidence: params.confidence ?? 0.5,
        importance: params.importance ?? 0.5,
        metadata,
        embedding: params.embedding,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeItems.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db
    .insert(knowledgeItems)
    .values({
      type: params.type,
      status: params.status,
      scope: params.scope,
      title: params.title,
      body: params.body,
      confidence: params.confidence ?? 0.5,
      importance: params.importance ?? 0.5,
      metadata,
      embedding: params.embedding,
    })
    .returning({ id: knowledgeItems.id });

  return inserted.id;
}

export async function vectorSearchKnowledge(
  embedding: number[],
  limit: number,
  statuses: KnowledgeStatus[] = ["active"],
): Promise<KnowledgeSearchResult[]> {
  const embeddingStr = JSON.stringify(embedding);
  const similarity = sql<number>`1 - (${knowledgeItems.embedding} <=> ${embeddingStr}::vector)`;

  const rows = await db
    .select({
      id: knowledgeItems.id,
      type: knowledgeItems.type,
      status: knowledgeItems.status,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      confidence: knowledgeItems.confidence,
      importance: knowledgeItems.importance,
      score: similarity,
    })
    .from(knowledgeItems)
    .where(
      and(inArray(knowledgeItems.status, statuses), sql`${knowledgeItems.embedding} IS NOT NULL`),
    )
    .orderBy(desc(similarity), desc(knowledgeItems.importance))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    score: finiteOrZero(row.score),
    confidence: finiteOrZero(row.confidence),
    importance: finiteOrZero(row.importance),
  }));
}
