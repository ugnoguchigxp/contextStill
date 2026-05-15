import { type SQL, and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { knowledgeItems, knowledgeSourceLinks, sourceFragments, sources } from "../../db/schema.js";
import { normalizeKnowledgeScore } from "../../lib/score-scale.js";
import type {
  KnowledgeItem,
  KnowledgeSearchInput,
  KnowledgeStatus,
} from "../../shared/schemas/knowledge.schema.js";
import { normalizeRepoKey, normalizeRepoPath } from "../context-compiler/query-context.js";

export type KnowledgeSearchResult = {
  id: string;
  type: string;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  score: number;
  metadata: Record<string, unknown>;
  sourceRefs: string[];
  hasSourceLinks: boolean;
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

export type KnowledgeSearchOptions = {
  repoPath?: string;
  repoKey?: string;
  allowGlobalScope?: boolean;
  types?: KnowledgeItem["type"][];
};

function finiteOrZero(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizedImportanceExpr() {
  return sql<number>`
    CASE
      WHEN ${knowledgeItems.importance} >= 0 AND ${knowledgeItems.importance} <= 1
        THEN ${knowledgeItems.importance} * 100
      ELSE ${knowledgeItems.importance}
    END
  `;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueAsString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildKnowledgeScopeMetadata(
  sourceUri: string,
  metadata?: Record<string, unknown>,
): { metadata: Record<string, unknown>; appliesTo: Record<string, unknown> } {
  const sourceMetadata = asRecord(metadata);
  const repoPathCandidate =
    valueAsString(sourceMetadata.repoPath) ??
    valueAsString(sourceMetadata.sourceRepoPath) ??
    valueAsString(sourceMetadata.workspacePath);
  const repoPath = normalizeRepoPath(repoPathCandidate);
  const repoKey = valueAsString(sourceMetadata.repoKey) ?? normalizeRepoKey(repoPathCandidate);

  return {
    metadata: {
      ...sourceMetadata,
      sourceUri,
      ...(repoPath ? { repoPath } : {}),
      ...(repoKey ? { repoKey } : {}),
    },
    appliesTo: {
      ...(repoPath ? { repoPath } : {}),
      ...(repoKey ? { repoKey } : {}),
    },
  };
}

function normalizeRepoScope(
  options: KnowledgeSearchOptions,
): { repoPath: string; repoKey: string; allowGlobalScope: boolean } | undefined {
  const repoPath = normalizeRepoPath(options.repoPath);
  const repoKey = (options.repoKey || normalizeRepoKey(options.repoPath))?.trim();
  if (!repoPath && !repoKey) return undefined;
  return {
    repoPath: repoPath ?? "",
    repoKey: (repoKey ?? "").toLowerCase(),
    allowGlobalScope: options.allowGlobalScope !== false,
  };
}

function buildRepoScopedCondition(options: KnowledgeSearchOptions): SQL | undefined {
  const normalized = normalizeRepoScope(options);
  if (!normalized) return undefined;

  const primaryClauses: SQL[] = [];
  const fallbackClauses: SQL[] = [];
  if (normalized.allowGlobalScope) {
    primaryClauses.push(eq(knowledgeItems.scope, "global"));
  }
  if (normalized.repoKey) {
    primaryClauses.push(sql`${knowledgeItems.appliesTo} ->> 'repoKey' = ${normalized.repoKey}`);
    fallbackClauses.push(sql`${knowledgeItems.metadata} ->> 'repoKey' = ${normalized.repoKey}`);
    fallbackClauses.push(
      sql`${knowledgeItems.metadata} ->> 'sourceProject' = ${normalized.repoKey}`,
    );
  }
  if (normalized.repoPath) {
    primaryClauses.push(sql`${knowledgeItems.appliesTo} ->> 'repoPath' = ${normalized.repoPath}`);
    fallbackClauses.push(sql`${knowledgeItems.metadata} ->> 'repoPath' = ${normalized.repoPath}`);
    fallbackClauses.push(
      sql`${knowledgeItems.metadata} ->> 'sourceUri' ilike ${`${normalized.repoPath}/%`}`,
    );
    fallbackClauses.push(
      sql`${knowledgeItems.metadata} ->> 'sourceDocumentUri' ilike ${`${normalized.repoPath}/%`}`,
    );
    const fileUriPrefix = `file://${normalized.repoPath.startsWith("/") ? "" : "/"}${normalized.repoPath}`;
    fallbackClauses.push(
      sql`${knowledgeItems.metadata} ->> 'sourceUri' ilike ${`${fileUriPrefix}/%`}`,
    );
    fallbackClauses.push(
      sql`${knowledgeItems.metadata} ->> 'sourceDocumentUri' ilike ${`${fileUriPrefix}/%`}`,
    );
  }

  const clauses = [...primaryClauses, ...fallbackClauses];
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

function fallbackSourceRefsFromMetadata(metadata: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const sourceDocumentUri =
    typeof metadata.sourceDocumentUri === "string" ? metadata.sourceDocumentUri : undefined;
  const sourceUri = typeof metadata.sourceUri === "string" ? metadata.sourceUri : undefined;
  const locator =
    typeof metadata.sourceFragmentLocator === "string" && metadata.sourceFragmentLocator.trim()
      ? metadata.sourceFragmentLocator.trim()
      : "full";

  const source = sourceDocumentUri ?? sourceUri;
  if (source) refs.add(`${source}#${locator}`);
  return [...refs];
}

async function listKnowledgeSourceRefs(knowledgeIds: string[]): Promise<Map<string, string[]>> {
  if (knowledgeIds.length === 0) return new Map();
  const rows = await db
    .select({
      knowledgeId: knowledgeSourceLinks.knowledgeId,
      sourceUri: sources.uri,
      locator: sourceFragments.locator,
      confidence: knowledgeSourceLinks.confidence,
    })
    .from(knowledgeSourceLinks)
    .innerJoin(sourceFragments, eq(sourceFragments.id, knowledgeSourceLinks.sourceFragmentId))
    .innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
    .where(inArray(knowledgeSourceLinks.knowledgeId, knowledgeIds))
    .orderBy(desc(knowledgeSourceLinks.confidence), desc(knowledgeSourceLinks.createdAt));

  const refsByKnowledgeId = new Map<string, string[]>();
  for (const row of rows) {
    const current = refsByKnowledgeId.get(row.knowledgeId) ?? [];
    const ref = `${row.sourceUri}#${row.locator}`;
    if (!current.includes(ref)) current.push(ref);
    refsByKnowledgeId.set(row.knowledgeId, current);
  }
  return refsByKnowledgeId;
}

export async function searchKnowledge(
  input: KnowledgeSearchInput,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const conditions: SQL[] = [];

  if (options.types && options.types.length > 0) {
    conditions.push(inArray(knowledgeItems.type, options.types));
  } else if (input.types && input.types.length > 0) {
    conditions.push(inArray(knowledgeItems.type, input.types));
  }

  if (input.statuses && input.statuses.length > 0) {
    conditions.push(inArray(knowledgeItems.status, input.statuses));
  } else {
    conditions.push(eq(knowledgeItems.status, input.status));
  }

  const repoScopedCondition = buildRepoScopedCondition({
    ...options,
    repoPath: options.repoPath ?? input.repoPath,
  });
  if (repoScopedCondition) {
    conditions.push(repoScopedCondition);
  }

  const query = input.query.trim();
  const importanceOrderExpr = normalizedImportanceExpr();
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
  const textSearchCondition =
    or(
      ilike(knowledgeItems.title, `%${query}%`),
      ilike(knowledgeItems.body, `%${query}%`),
      textMatchExpr,
    ) ?? textMatchExpr;
  conditions.push(textSearchCondition);

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
      score: rankExpr,
    })
    .from(knowledgeItems)
    .where(and(...conditions))
    .orderBy(desc(rankExpr), desc(importanceOrderExpr), desc(knowledgeItems.updatedAt))
    .limit(input.limit);

  const sourceRefsByKnowledgeId = await listKnowledgeSourceRefs(rows.map((row) => row.id));

  return rows.map((row) => {
    const metadata = asRecord(row.metadata);
    const sourceRefs =
      sourceRefsByKnowledgeId.get(row.id) ?? fallbackSourceRefsFromMetadata(metadata);
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      scope: row.scope,
      title: row.title,
      body: row.body,
      confidence: normalizeKnowledgeScore(row.confidence, 70),
      importance: normalizeKnowledgeScore(row.importance, 70),
      score: finiteOrZero(row.score),
      metadata,
      sourceRefs,
      hasSourceLinks: sourceRefs.length > 0,
    };
  });
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

  const scoped = buildKnowledgeScopeMetadata(params.sourceUri, params.metadata);
  const metadata = {
    ...scoped.metadata,
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
        confidence: normalizeKnowledgeScore(params.confidence, 70),
        importance: normalizeKnowledgeScore(params.importance, 70),
        appliesTo: scoped.appliesTo,
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
      confidence: normalizeKnowledgeScore(params.confidence, 70),
      importance: normalizeKnowledgeScore(params.importance, 70),
      appliesTo: scoped.appliesTo,
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
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const embeddingStr = JSON.stringify(embedding);
  const importanceOrderExpr = normalizedImportanceExpr();
  const similarity = sql<number>`1 - (${knowledgeItems.embedding} <=> ${embeddingStr}::vector)`;
  const conditions: SQL[] = [
    inArray(knowledgeItems.status, statuses),
    sql`${knowledgeItems.embedding} IS NOT NULL`,
  ];
  if (options.types && options.types.length > 0) {
    conditions.push(inArray(knowledgeItems.type, options.types));
  }
  const repoScopedCondition = buildRepoScopedCondition(options);
  if (repoScopedCondition) {
    conditions.push(repoScopedCondition);
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
      score: similarity,
    })
    .from(knowledgeItems)
    .where(and(...conditions))
    .orderBy(desc(similarity), desc(importanceOrderExpr))
    .limit(limit);

  const sourceRefsByKnowledgeId = await listKnowledgeSourceRefs(rows.map((row) => row.id));
  return rows.map((row) => {
    const metadata = asRecord(row.metadata);
    const sourceRefs =
      sourceRefsByKnowledgeId.get(row.id) ?? fallbackSourceRefsFromMetadata(metadata);
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      scope: row.scope,
      title: row.title,
      body: row.body,
      confidence: normalizeKnowledgeScore(row.confidence, 70),
      importance: normalizeKnowledgeScore(row.importance, 70),
      score: finiteOrZero(row.score),
      metadata,
      sourceRefs,
      hasSourceLinks: sourceRefs.length > 0,
    };
  });
}
