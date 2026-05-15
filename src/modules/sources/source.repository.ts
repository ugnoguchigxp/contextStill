import { createHash } from "node:crypto";
import { and, desc, eq, ilike, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { sourceFragments, sources } from "../../db/schema.js";
import { embedOne } from "../embedding/embedding.service.js";
import { normalizeRepoKey, normalizeRepoPath } from "../context-compiler/query-context.js";

export type SourceKind = "wiki";

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

export type SourceSearchOptions = {
  repoPath?: string;
  repoKey?: string;
};

function defaultHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function finiteOrZero(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function buildRepoPathBoundaryClauses(repoPath: string): SQL[] {
  const normalized = normalizeRepoPath(repoPath) ?? repoPath;
  const fileUriPrefix = `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`;
  return [
    ilike(sources.uri, `${normalized}/%`),
    ilike(sources.uri, `${fileUriPrefix}/%`),
    sql`${sources.metadata} ->> 'repoPath' = ${normalized}`,
    sql`${sources.metadata} ->> 'sourceRootPath' = ${normalized}`,
  ];
}

function buildSourceRepoScopedCondition(options?: SourceSearchOptions): SQL | undefined {
  const repoPath = normalizeRepoPath(options?.repoPath);
  const repoKey = (options?.repoKey ?? normalizeRepoKey(options?.repoPath))?.trim().toLowerCase();
  if (!repoPath && !repoKey) return undefined;

  const clauses: SQL[] = [];
  if (repoPath) {
    clauses.push(...buildRepoPathBoundaryClauses(repoPath));
  }
  if (repoKey) {
    clauses.push(sql`${sources.metadata} ->> 'repoKey' = ${repoKey}`);
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

async function tryEmbedSourceFragment(content: string): Promise<number[] | undefined> {
  try {
    return await embedOne(content, "passage");
  } catch {
    return undefined;
  }
}

function chunkSourceDocument(params: {
  title?: string | null;
  body: string;
  maxChars?: number;
}): Array<{ locator: string; heading: string | null; content: string }> {
  const maxChars = params.maxChars ?? 2500;
  const lines = params.body.split("\n");
  const chunks: Array<{ locator: string; heading: string | null; content: string }> = [];
  let heading = params.title ?? null;
  let buffer: string[] = [];
  let index = 1;

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (!content) return;
    chunks.push({
      locator: `chunk:${String(index).padStart(4, "0")}`,
      heading,
      content,
    });
    index += 1;
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch && buffer.join("\n").trim().length > 0) {
      flush();
      heading = headingMatch[2]?.trim() || heading;
    }
    buffer.push(line);
    if (buffer.join("\n").length >= maxChars) {
      flush();
    }
  }
  flush();

  if (chunks.length === 0) {
    const content = params.body.trim();
    return content ? [{ locator: "full", heading: params.title ?? null, content }] : [];
  }
  return chunks;
}

async function replaceSourceFragments(params: {
  sourceId: string;
  title?: string | null;
  body: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.delete(sourceFragments).where(eq(sourceFragments.sourceId, params.sourceId));

  const chunks = chunkSourceDocument({
    title: params.title,
    body: params.body,
  });
  if (chunks.length === 0) return;

  await db.insert(sourceFragments).values(
    await Promise.all(
      chunks.map(async (chunk) => ({
        sourceId: params.sourceId,
        locator: chunk.locator,
        heading: chunk.heading,
        content: chunk.content,
        metadata: params.metadata ?? {},
        embedding: await tryEmbedSourceFragment(chunk.content),
      })),
    ),
  );
}

export async function upsertSourceDocument(params: UpsertSourceParams): Promise<string> {
  const contentHash =
    params.contentHash ?? defaultHash(`${params.sourceKind}\n${params.uri}\n${params.body}`);
  const existing = await db.query.sources.findFirst({
    where: eq(sources.uri, params.uri),
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
        contentHash,
        metadata: params.metadata ?? {},
        updatedAt: new Date(),
      })
      .where(eq(sources.id, existing.id));
    await replaceSourceFragments({
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
  await replaceSourceFragments({
    sourceId: inserted.id,
    title: params.title,
    body: params.body,
    metadata: params.metadata,
  });
  return inserted.id;
}

export async function deleteStaleSourcesForRoot(params: {
  rootPath: string;
  keepUris: string[];
}): Promise<number> {
  const normalizedRootPath = normalizeRepoPath(params.rootPath) ?? params.rootPath;
  const normalizedKeepUris = [...new Set(params.keepUris.map((uri) => uri.trim()).filter(Boolean))];
  const fileUriKeepUris = normalizedKeepUris.map(
    (uri) => `file://${uri.startsWith("/") ? "" : "/"}${uri}`,
  );
  const keepSet = [...new Set([...normalizedKeepUris, ...fileUriKeepUris])];

  const conditions: SQL[] = [or(...buildRepoPathBoundaryClauses(normalizedRootPath)) as SQL];
  if (keepSet.length > 0) {
    conditions.push(notInArray(sources.uri, keepSet));
  }
  const deleted = await db
    .delete(sources)
    .where(and(...conditions))
    .returning({ id: sources.id });
  return deleted.length;
}

export async function vectorSearchSourceContent(
  embedding: number[],
  limit: number,
  sourceKinds?: SourceKind[],
  options?: SourceSearchOptions,
): Promise<SourceSearchResult[]> {
  const embeddingStr = JSON.stringify(embedding);
  const similarity = sql<number>`1 - (${sourceFragments.embedding} <=> ${embeddingStr}::vector)`;
  const conditions: SQL[] = [sql`${sourceFragments.embedding} IS NOT NULL`];
  if (sourceKinds && sourceKinds.length > 0) {
    conditions.push(inArray(sources.sourceKind, sourceKinds));
  }
  const repoScopedCondition = buildSourceRepoScopedCondition(options);
  if (repoScopedCondition) {
    conditions.push(repoScopedCondition);
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
  options?: SourceSearchOptions,
): Promise<SourceSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const fragmentRankExpr = sql<number>`
    ts_rank_cd(
      to_tsvector('simple', concat_ws(' ', ${sourceFragments.heading}, ${sourceFragments.content}, ${sourceFragments.metadata}::text)),
      plainto_tsquery('simple', ${trimmedQuery})
    )
  `;
  const fragmentTextMatchExpr = sql<boolean>`
    to_tsvector('simple', concat_ws(' ', ${sourceFragments.heading}, ${sourceFragments.content}, ${sourceFragments.metadata}::text))
    @@ plainto_tsquery('simple', ${trimmedQuery})
  `;
  const fragmentConditions = [
    or(
      ilike(sourceFragments.content, `%${trimmedQuery}%`),
      ilike(sourceFragments.heading, `%${trimmedQuery}%`),
      sql`${sourceFragments.metadata}::text ilike ${`%${trimmedQuery}%`}`,
      fragmentTextMatchExpr,
    ),
  ];
  if (sourceKinds && sourceKinds.length > 0) {
    fragmentConditions.push(inArray(sources.sourceKind, sourceKinds));
  }
  const repoScopedCondition = buildSourceRepoScopedCondition(options);
  if (repoScopedCondition) {
    fragmentConditions.push(repoScopedCondition);
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
      to_tsvector('simple', concat_ws(' ', ${sources.title}, ${sources.uri}, ${sources.body}, ${sources.metadata}::text)),
      plainto_tsquery('simple', ${trimmedQuery})
    )
  `;
  const sourceTextMatchExpr = sql<boolean>`
    to_tsvector('simple', concat_ws(' ', ${sources.title}, ${sources.uri}, ${sources.body}, ${sources.metadata}::text))
    @@ plainto_tsquery('simple', ${trimmedQuery})
  `;
  const sourceConditions = [
    or(
      ilike(sources.title, `%${trimmedQuery}%`),
      ilike(sources.uri, `%${trimmedQuery}%`),
      ilike(sources.body, `%${trimmedQuery}%`),
      sql`${sources.metadata}::text ilike ${`%${trimmedQuery}%`}`,
      sourceTextMatchExpr,
    ),
  ];
  if (sourceKinds && sourceKinds.length > 0) {
    sourceConditions.push(inArray(sources.sourceKind, sourceKinds));
  }
  if (repoScopedCondition) {
    sourceConditions.push(repoScopedCondition);
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
