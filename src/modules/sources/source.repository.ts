import { createHash } from "node:crypto";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { sourceFragments, sources } from "../../db/schema.js";
import { embedOne } from "../embedding/embedding.service.js";

export type SourceKind = "markdown" | "session" | "tool_output" | "git" | "web" | "manual";

type UpsertSourceParams = {
  sourceKind: SourceKind;
  uri: string;
  title?: string;
  body: string;
  contentHash?: string;
  metadata?: Record<string, unknown>;
};

export type SourceSearchResult = {
  id: string;
  sourceId: string;
  sourceUri: string;
  locator: string;
  heading: string | null;
  content: string;
  score: number;
};

function defaultHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function finiteOrZero(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

async function tryEmbedSourceFragment(content: string): Promise<number[] | undefined> {
  try {
    return await embedOne(content, "passage");
  } catch {
    return undefined;
  }
}

async function replaceFullSourceFragment(params: {
  sourceId: string;
  title?: string | null;
  body: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db
    .delete(sourceFragments)
    .where(and(eq(sourceFragments.sourceId, params.sourceId), eq(sourceFragments.locator, "full")));

  const content = params.body.trim();
  if (!content) return;

  const embedding = await tryEmbedSourceFragment(content);
  await db.insert(sourceFragments).values({
    sourceId: params.sourceId,
    locator: "full",
    heading: params.title ?? null,
    content,
    metadata: params.metadata ?? {},
    embedding,
  });
}

export async function upsertSourceDocument(params: UpsertSourceParams): Promise<string> {
  const contentHash =
    params.contentHash ?? defaultHash(`${params.sourceKind}\n${params.uri}\n${params.body}`);
  const existing = await db.query.sources.findFirst({
    where: and(eq(sources.uri, params.uri), eq(sources.contentHash, contentHash)),
    columns: { id: true },
  });

  if (existing) {
    await db
      .update(sources)
      .set({
        sourceKind: params.sourceKind,
        uri: params.uri,
        title: params.title ?? null,
        body: params.body,
        metadata: params.metadata ?? {},
        updatedAt: new Date(),
      })
      .where(eq(sources.id, existing.id));
    await replaceFullSourceFragment({
      sourceId: existing.id,
      title: params.title,
      body: params.body,
      metadata: params.metadata,
    });
    return existing.id;
  }

  const [inserted] = await db
    .insert(sources)
    .values({
      sourceKind: params.sourceKind,
      uri: params.uri,
      title: params.title ?? null,
      body: params.body,
      contentHash,
      metadata: params.metadata ?? {},
    })
    .returning({ id: sources.id });
  await replaceFullSourceFragment({
    sourceId: inserted.id,
    title: params.title,
    body: params.body,
    metadata: params.metadata,
  });
  return inserted.id;
}

export async function vectorSearchSourceContent(
  embedding: number[],
  limit: number,
  sourceKinds?: SourceKind[],
): Promise<SourceSearchResult[]> {
  const embeddingStr = JSON.stringify(embedding);
  const similarity = sql<number>`1 - (${sourceFragments.embedding} <=> ${embeddingStr}::vector)`;
  const conditions = [sql`${sourceFragments.embedding} IS NOT NULL`];
  if (sourceKinds && sourceKinds.length > 0) {
    conditions.push(inArray(sources.sourceKind, sourceKinds));
  }

  const rows = await db
    .select({
      id: sourceFragments.id,
      sourceId: sourceFragments.sourceId,
      sourceUri: sources.uri,
      locator: sourceFragments.locator,
      heading: sourceFragments.heading,
      content: sourceFragments.content,
      score: similarity,
    })
    .from(sourceFragments)
    .innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
    .where(and(...conditions))
    .orderBy(desc(similarity), desc(sourceFragments.createdAt))
    .limit(limit);

  return rows.map((row) => ({ ...row, score: finiteOrZero(row.score) }));
}

export async function searchSourceContent(
  query: string,
  limit: number,
  sourceKinds?: SourceKind[],
): Promise<SourceSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const fragmentRankExpr = sql<number>`
    ts_rank_cd(
      to_tsvector('simple', concat_ws(' ', ${sourceFragments.heading}, ${sourceFragments.content})),
      plainto_tsquery('simple', ${trimmedQuery})
    )
  `;
  const fragmentTextMatchExpr = sql<boolean>`
    to_tsvector('simple', concat_ws(' ', ${sourceFragments.heading}, ${sourceFragments.content}))
    @@ plainto_tsquery('simple', ${trimmedQuery})
  `;
  const fragmentConditions = [
    or(
      ilike(sourceFragments.content, `%${trimmedQuery}%`),
      ilike(sourceFragments.heading, `%${trimmedQuery}%`),
      fragmentTextMatchExpr,
    ),
  ];
  if (sourceKinds && sourceKinds.length > 0) {
    fragmentConditions.push(inArray(sources.sourceKind, sourceKinds));
  }

  const fragmentRows = await db
    .select({
      id: sourceFragments.id,
      sourceId: sourceFragments.sourceId,
      sourceUri: sources.uri,
      locator: sourceFragments.locator,
      heading: sourceFragments.heading,
      content: sourceFragments.content,
      score: fragmentRankExpr,
    })
    .from(sourceFragments)
    .innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
    .where(and(...fragmentConditions))
    .orderBy(desc(fragmentRankExpr), desc(sourceFragments.createdAt))
    .limit(limit);

  const sourceRankExpr = sql<number>`
    ts_rank_cd(
      to_tsvector('simple', concat_ws(' ', ${sources.title}, ${sources.uri}, ${sources.body})),
      plainto_tsquery('simple', ${trimmedQuery})
    )
  `;
  const sourceTextMatchExpr = sql<boolean>`
    to_tsvector('simple', concat_ws(' ', ${sources.title}, ${sources.uri}, ${sources.body}))
    @@ plainto_tsquery('simple', ${trimmedQuery})
  `;
  const sourceConditions = [
    or(
      ilike(sources.title, `%${trimmedQuery}%`),
      ilike(sources.uri, `%${trimmedQuery}%`),
      ilike(sources.body, `%${trimmedQuery}%`),
      sourceTextMatchExpr,
    ),
  ];
  if (sourceKinds && sourceKinds.length > 0) {
    sourceConditions.push(inArray(sources.sourceKind, sourceKinds));
  }

  const sourceRows = await db
    .select({
      id: sources.id,
      sourceUri: sources.uri,
      title: sources.title,
      body: sources.body,
      score: sourceRankExpr,
    })
    .from(sources)
    .where(and(...sourceConditions))
    .orderBy(desc(sourceRankExpr), desc(sources.updatedAt))
    .limit(limit);

  const rows = [
    ...fragmentRows.map((row) => ({
      ...row,
      score: finiteOrZero(row.score),
    })),
    ...sourceRows.map((row) => ({
      id: `source:${row.id}:full`,
      sourceId: row.id,
      sourceUri: row.sourceUri,
      locator: "full",
      heading: row.title,
      content: row.body,
      score: finiteOrZero(row.score),
    })),
  ];

  const byKey = new Map<string, SourceSearchResult>();
  for (const row of rows) {
    const key = `${row.sourceId}:${row.locator}`;
    const current = byKey.get(key);
    if (!current || row.score > current.score) {
      byKey.set(key, row);
    }
  }

  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
