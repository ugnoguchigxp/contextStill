import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { knowledgeItems } from "../../../src/db/schema.js";
import { embedOne } from "../../../src/modules/embedding/embedding.service.js";
import { normalizeKnowledgeScore } from "../../../src/lib/score-scale.js";

export type KnowledgeWriteInput = {
  type: string;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  metadata?: Record<string, unknown>;
};

export async function listKnowledgeItems(params: {
  limit: number;
  status?: string;
  type?: string;
  query?: string;
}) {
  const conditions = [];
  if (params.status) {
    conditions.push(eq(knowledgeItems.status, params.status));
  }
  if (params.type) {
    conditions.push(eq(knowledgeItems.type, params.type));
  }
  if (params.query?.trim()) {
    const query = `%${params.query.trim()}%`;
    conditions.push(ilike(knowledgeItems.title, query));
  }

  const rows = await db
    .select({
      id: knowledgeItems.id,
      type: knowledgeItems.type,
      status: knowledgeItems.status,
      scope: knowledgeItems.scope,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      confidence: knowledgeItems.confidence,
      importance: knowledgeItems.importance,
      metadata: knowledgeItems.metadata,
      createdAt: knowledgeItems.createdAt,
      updatedAt: knowledgeItems.updatedAt,
    })
    .from(knowledgeItems)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(knowledgeItems.updatedAt))
    .limit(params.limit);

  return rows.map((row) => ({
    ...row,
    confidence: normalizeKnowledgeScore(row.confidence, 70),
    importance: normalizeKnowledgeScore(row.importance, 70),
  }));
}

async function tryEmbedKnowledge(input: KnowledgeWriteInput): Promise<number[] | undefined> {
  try {
    return await embedOne(`${input.title}\n${input.body}`, "passage");
  } catch {
    return undefined;
  }
}

export async function createKnowledgeItem(input: KnowledgeWriteInput) {
  const confidence = normalizeKnowledgeScore(input.confidence, 70);
  const importance = normalizeKnowledgeScore(input.importance, 70);
  const embedding = await tryEmbedKnowledge(input);
  const [inserted] = await db
    .insert(knowledgeItems)
    .values({
      type: input.type,
      status: input.status,
      scope: input.scope,
      title: input.title,
      body: input.body,
      confidence,
      importance,
      metadata: input.metadata ?? {},
      embedding,
    })
    .returning({ id: knowledgeItems.id });
  return inserted;
}

export async function updateKnowledgeItem(id: string, input: KnowledgeWriteInput) {
  const confidence = normalizeKnowledgeScore(input.confidence, 70);
  const importance = normalizeKnowledgeScore(input.importance, 70);
  const embedding = await tryEmbedKnowledge(input);
  const [updated] = await db
    .update(knowledgeItems)
    .set({
      type: input.type,
      status: input.status,
      scope: input.scope,
      title: input.title,
      body: input.body,
      confidence,
      importance,
      metadata: input.metadata ?? {},
      embedding,
      updatedAt: new Date(),
    })
    .where(eq(knowledgeItems.id, id))
    .returning({ id: knowledgeItems.id });
  return updated ?? null;
}

export async function deleteKnowledgeItem(id: string) {
  const [deleted] = await db
    .delete(knowledgeItems)
    .where(eq(knowledgeItems.id, id))
    .returning({ id: knowledgeItems.id });
  return deleted ?? null;
}
