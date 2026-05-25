import { type SQL, and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { knowledgeItems, knowledgeSourceLinks, sourceFragments, sources } from "../../db/schema.js";
import { normalizeKnowledgeScore } from "../../lib/score-scale.js";
import type {
  KnowledgeItem,
  KnowledgeSearchInput,
  KnowledgeStatus,
} from "../../shared/schemas/knowledge.schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import { linkKnowledgeFromMetadata } from "./source-linking.service.js";
import { computeDecayFactor } from "./knowledge-value.service.js";
import {
  asRecord,
  buildApplicabilityQuery,
  type ApplicabilityQuery,
  buildKnowledgeScopeMetadata,
  buildRepoScopedCondition,
  computeApplicability,
  fallbackSourceRefsFromMetadata,
  finiteOrZero,
  hasApplicabilityQuery,
  resolveKnowledgeActor,
  type KnowledgeSearchOptions,
  type KnowledgeSearchQueryInput,
  type KnowledgeSearchResult,
  type UpsertKnowledgeFromSourceParams,
} from "./knowledge.repository.shared.js";

export type { KnowledgeSearchOptions, KnowledgeSearchResult, UpsertKnowledgeFromSourceParams };

function normalizedImportanceExpr() {
  return sql<number>`
    CASE
      WHEN ${knowledgeItems.importance} >= 0 AND ${knowledgeItems.importance} <= 1
        THEN ${knowledgeItems.importance} * 100
      ELSE ${knowledgeItems.importance}
    END
  `;
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

type KnowledgeSearchRow = {
  id: string;
  type: string;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo: unknown;
  metadata: unknown;
  dynamicScore: number;
  compileSelectCount: number;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  lastCompiledAt: Date | null;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
  score: number;
};

function mapKnowledgeRowsToResults(
  rows: KnowledgeSearchRow[],
  sourceRefsByKnowledgeId: Map<string, string[]>,
  applicabilityQuery: ApplicabilityQuery,
): KnowledgeSearchResult[] {
  return rows.map((row) => {
    const appliesTo = asRecord(row.appliesTo);
    const metadata = asRecord(row.metadata);
    const sourceRefs =
      sourceRefsByKnowledgeId.get(row.id) ?? fallbackSourceRefsFromMetadata(metadata);
    const normalizedType = row.type === "procedure" ? "procedure" : "rule";
    const normalizedScope = row.scope === "global" ? "global" : "repo";
    const dynamicScore = Math.max(0, finiteOrZero(row.dynamicScore));
    const compileSelectCount = Math.max(0, Math.floor(finiteOrZero(row.compileSelectCount)));
    const agenticAcceptCount = Math.max(0, Math.floor(finiteOrZero(row.agenticAcceptCount)));
    const explicitUpvoteCount = Math.max(0, Math.floor(finiteOrZero(row.explicitUpvoteCount)));
    const explicitDownvoteCount = Math.max(0, Math.floor(finiteOrZero(row.explicitDownvoteCount)));
    const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
    const decayFactor = computeDecayFactor({
      type: normalizedType,
      scope: normalizedScope,
      lastVerifiedAt: row.lastVerifiedAt,
      updatedAt,
    });
    const applicability = computeApplicability(appliesTo, applicabilityQuery);
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      scope: row.scope,
      title: row.title,
      body: row.body,
      confidence: normalizeKnowledgeScore(row.confidence, 70),
      importance: normalizeKnowledgeScore(row.importance, 70),
      score: finiteOrZero(row.score) + applicability.score,
      appliesTo,
      metadata,
      sourceRefs,
      hasSourceLinks: sourceRefs.length > 0,
      dynamicScore,
      compileSelectCount,
      agenticAcceptCount,
      explicitUpvoteCount,
      explicitDownvoteCount,
      lastCompiledAt: row.lastCompiledAt,
      lastVerifiedAt: row.lastVerifiedAt,
      updatedAt,
      decayFactor,
      applicabilityScore: applicability.score,
      applicabilityMatches: applicability.matches,
    };
  });
}

function buildJsonbArrayAnyMatch(key: string, values: string[]): SQL | undefined {
  if (values.length === 0) return undefined;
  const quotedKey = sql.raw(`'${key}'`);
  return sql`(coalesce(${knowledgeItems.appliesTo} -> ${quotedKey}, '[]'::jsonb) ?| array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`,`,
  )}])`;
}

function buildApplicabilityFilterCondition(query: ApplicabilityQuery): SQL | undefined {
  const clauses: SQL[] = [];
  const technologies = buildJsonbArrayAnyMatch("technologies", query.technologies);
  if (technologies) clauses.push(technologies);
  const changeTypes = buildJsonbArrayAnyMatch("changeTypes", query.changeTypes);
  if (changeTypes) clauses.push(changeTypes);
  const domains = buildJsonbArrayAnyMatch("domains", query.domains);
  if (domains) clauses.push(domains);
  if (query.includeGeneral) {
    clauses.push(sql`coalesce((${knowledgeItems.appliesTo} ->> 'general')::boolean, false) = true`);
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

export async function searchKnowledge(
  input: KnowledgeSearchQueryInput,
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
  const applicabilityQuery = buildApplicabilityQuery(input, options);
  const facetRequested = hasApplicabilityQuery(applicabilityQuery);
  const searchLimit = facetRequested ? Math.max(input.limit * 3, 30) : input.limit;

  const selectFields = {
    id: knowledgeItems.id,
    type: knowledgeItems.type,
    status: knowledgeItems.status,
    scope: knowledgeItems.scope,
    title: knowledgeItems.title,
    body: knowledgeItems.body,
    confidence: knowledgeItems.confidence,
    importance: knowledgeItems.importance,
    appliesTo: knowledgeItems.appliesTo,
    metadata: knowledgeItems.metadata,
    dynamicScore: knowledgeItems.dynamicScore,
    compileSelectCount: knowledgeItems.compileSelectCount,
    agenticAcceptCount: knowledgeItems.agenticAcceptCount,
    explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
    explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
    lastCompiledAt: knowledgeItems.lastCompiledAt,
    lastVerifiedAt: knowledgeItems.lastVerifiedAt,
    updatedAt: knowledgeItems.updatedAt,
    score: rankExpr,
  } as const;

  const rankedRows = (await db
    .select(selectFields)
    .from(knowledgeItems)
    .where(and(...conditions, textSearchCondition))
    .orderBy(desc(rankExpr), desc(importanceOrderExpr), desc(knowledgeItems.updatedAt))
    .limit(searchLimit)) as KnowledgeSearchRow[];

  let rows: KnowledgeSearchRow[] = [...rankedRows];
  if (rows.length === 0 && facetRequested) {
    const applicabilityCondition = buildApplicabilityFilterCondition(applicabilityQuery);
    if (applicabilityCondition) {
      const fallbackRows = (await db
        .select({
          ...selectFields,
          score: sql<number>`0`,
        })
        .from(knowledgeItems)
        .where(and(...conditions, applicabilityCondition))
        .orderBy(desc(importanceOrderExpr), desc(knowledgeItems.updatedAt))
        .limit(searchLimit)) as KnowledgeSearchRow[];
      rows = fallbackRows;
    }
  }

  const sourceRefsByKnowledgeId = await listKnowledgeSourceRefs(rows.map((row) => row.id));
  return mapKnowledgeRowsToResults(rows, sourceRefsByKnowledgeId, applicabilityQuery)
    .sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, input.limit);
}

export async function upsertKnowledgeFromSource(
  params: UpsertKnowledgeFromSourceParams,
): Promise<string> {
  const existing = await db.query.knowledgeItems.findFirst({
    where: sql`${knowledgeItems.metadata} ->> 'sourceUri' = ${params.sourceUri}`,
  });

  const scoped = buildKnowledgeScopeMetadata(params.sourceUri, params.metadata, params.appliesTo);
  const metadata = scoped.metadata;

  if (existing) {
    const now = new Date();
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
        updatedAt: now,
        lastVerifiedAt: now,
      })
      .where(eq(knowledgeItems.id, existing.id));
    const actor = resolveKnowledgeActor(params.sourceUri);
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeUpdated,
      actor,
      payload: {
        knowledgeId: existing.id,
        sourceUri: params.sourceUri,
        type: params.type,
        status: params.status,
        scope: params.scope,
        title: params.title,
        previousStatus: existing.status,
      },
    });
    if (existing.status !== params.status) {
      await recordAuditLogSafe({
        eventType: auditEventTypes.knowledgeStatusChanged,
        actor,
        payload: {
          knowledgeId: existing.id,
          sourceUri: params.sourceUri,
          fromStatus: existing.status,
          toStatus: params.status,
        },
      });
    }
    await linkKnowledgeFromMetadata({
      knowledgeId: existing.id,
      metadata,
      confidence: params.confidence,
      linkMetadataSource: "upsertKnowledgeFromSource",
    });
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
      lastVerifiedAt: new Date(),
    })
    .returning({ id: knowledgeItems.id });

  await recordAuditLogSafe({
    eventType: auditEventTypes.knowledgeCreated,
    actor: resolveKnowledgeActor(params.sourceUri),
    payload: {
      knowledgeId: inserted.id,
      sourceUri: params.sourceUri,
      type: params.type,
      status: params.status,
      scope: params.scope,
      title: params.title,
    },
  });
  await linkKnowledgeFromMetadata({
    knowledgeId: inserted.id,
    metadata,
    confidence: params.confidence,
    linkMetadataSource: "upsertKnowledgeFromSource",
  });

  return inserted.id;
}

export async function vectorSearchKnowledge(
  embedding: number[],
  limit: number,
  statuses: KnowledgeStatus[] = ["active"],
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const applicabilityQuery = buildApplicabilityQuery(
    {
      includeGeneral: options.includeGeneral ?? true,
    },
    options,
  );
  const facetRequested = hasApplicabilityQuery(applicabilityQuery);
  const searchLimit = facetRequested ? Math.max(limit * 3, 30) : limit;
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
      appliesTo: knowledgeItems.appliesTo,
      metadata: knowledgeItems.metadata,
      dynamicScore: knowledgeItems.dynamicScore,
      compileSelectCount: knowledgeItems.compileSelectCount,
      agenticAcceptCount: knowledgeItems.agenticAcceptCount,
      explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
      explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
      lastCompiledAt: knowledgeItems.lastCompiledAt,
      lastVerifiedAt: knowledgeItems.lastVerifiedAt,
      updatedAt: knowledgeItems.updatedAt,
      score: similarity,
    })
    .from(knowledgeItems)
    .where(and(...conditions))
    .orderBy(desc(similarity), desc(importanceOrderExpr))
    .limit(searchLimit);

  const sourceRefsByKnowledgeId = await listKnowledgeSourceRefs(rows.map((row) => row.id));
  return mapKnowledgeRowsToResults(
    rows as KnowledgeSearchRow[],
    sourceRefsByKnowledgeId,
    applicabilityQuery,
  )
    .sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, limit);
}
