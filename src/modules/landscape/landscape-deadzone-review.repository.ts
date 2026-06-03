import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  knowledgeItems,
  knowledgeOriginLinks,
  knowledgeSourceLinks,
  landscapeReviewItems,
  sourceFragments,
} from "../../db/schema.js";

export type DeadZoneKnowledgeRow = {
  id: string;
  title: string;
  body: string;
  type: "rule" | "procedure";
  status: "draft" | "active" | "deprecated";
  scope: string;
  appliesTo: Record<string, unknown>;
  metadata: Record<string, unknown>;
  confidence: number;
  importance: number;
  dynamicScore: number;
  compileSelectCount: number;
  lastCompiledAt: Date | null;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
  embedded: boolean;
};

export type DeadZoneKnowledgeEvidenceRow = {
  knowledgeId: string;
  sourceRefCount: number;
  originRefCount: number;
};

export type DeadZoneSimilarKnowledgeRow = DeadZoneKnowledgeRow & {
  sourceKnowledgeId: string;
  similarity: number;
};

export type DeadZoneReviewItemLinkRow = {
  knowledgeId: string;
  reviewItemId: string;
};

function asNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function asInt(value: unknown, fallback = 0): number {
  return Math.max(0, Math.trunc(asNumber(value, fallback)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeType(value: string): "rule" | "procedure" {
  return value === "procedure" ? "procedure" : "rule";
}

function normalizeStatus(value: string): "draft" | "active" | "deprecated" {
  if (value === "active" || value === "deprecated") return value;
  return "draft";
}

function mapKnowledgeRow(row: {
  id: string;
  title: string;
  body: string;
  type: string;
  status: string;
  scope: string;
  appliesTo: unknown;
  metadata: unknown;
  confidence: unknown;
  importance: unknown;
  dynamicScore: unknown;
  compileSelectCount: unknown;
  lastCompiledAt: Date | null;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
  embedded: unknown;
}): DeadZoneKnowledgeRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    type: normalizeType(row.type),
    status: normalizeStatus(row.status),
    scope: row.scope,
    appliesTo: asRecord(row.appliesTo),
    metadata: asRecord(row.metadata),
    confidence: asNumber(row.confidence, 70),
    importance: asNumber(row.importance, 70),
    dynamicScore: asNumber(row.dynamicScore, 0),
    compileSelectCount: asInt(row.compileSelectCount, 0),
    lastCompiledAt: row.lastCompiledAt,
    lastVerifiedAt: row.lastVerifiedAt,
    updatedAt: row.updatedAt,
    embedded: Boolean(row.embedded),
  };
}

export async function listDeadZoneKnowledgeRows(
  knowledgeIds: string[],
): Promise<DeadZoneKnowledgeRow[]> {
  const ids = [...new Set(knowledgeIds)].filter(Boolean);
  if (ids.length === 0) return [];

  const rows = await db
    .select({
      id: knowledgeItems.id,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      type: knowledgeItems.type,
      status: knowledgeItems.status,
      scope: knowledgeItems.scope,
      appliesTo: knowledgeItems.appliesTo,
      metadata: knowledgeItems.metadata,
      confidence: knowledgeItems.confidence,
      importance: knowledgeItems.importance,
      dynamicScore: knowledgeItems.dynamicScore,
      compileSelectCount: knowledgeItems.compileSelectCount,
      lastCompiledAt: knowledgeItems.lastCompiledAt,
      lastVerifiedAt: knowledgeItems.lastVerifiedAt,
      updatedAt: knowledgeItems.updatedAt,
      embedded: sql<boolean>`${knowledgeItems.embedding} is not null`,
    })
    .from(knowledgeItems)
    .where(inArray(knowledgeItems.id, ids));

  return rows.map(mapKnowledgeRow);
}

export async function listDeadZoneKnowledgeEvidenceRows(
  knowledgeIds: string[],
): Promise<DeadZoneKnowledgeEvidenceRow[]> {
  const ids = [...new Set(knowledgeIds)].filter(Boolean);
  if (ids.length === 0) return [];

  const [sourceRows, originRows] = await Promise.all([
    db
      .select({
        knowledgeId: knowledgeSourceLinks.knowledgeId,
        sourceRefCount: sql<number>`count(distinct ${sourceFragments.sourceId})::int`,
      })
      .from(knowledgeSourceLinks)
      .innerJoin(sourceFragments, eq(sourceFragments.id, knowledgeSourceLinks.sourceFragmentId))
      .where(inArray(knowledgeSourceLinks.knowledgeId, ids))
      .groupBy(knowledgeSourceLinks.knowledgeId),
    db
      .select({
        knowledgeId: knowledgeOriginLinks.knowledgeId,
        originRefCount: sql<number>`count(*)::int`,
      })
      .from(knowledgeOriginLinks)
      .where(inArray(knowledgeOriginLinks.knowledgeId, ids))
      .groupBy(knowledgeOriginLinks.knowledgeId),
  ]);

  const byId = new Map<string, DeadZoneKnowledgeEvidenceRow>();
  for (const id of ids) {
    byId.set(id, { knowledgeId: id, sourceRefCount: 0, originRefCount: 0 });
  }
  for (const row of sourceRows) {
    const item = byId.get(row.knowledgeId);
    if (item) item.sourceRefCount = asInt(row.sourceRefCount, 0);
  }
  for (const row of originRows) {
    const item = byId.get(row.knowledgeId);
    if (item) item.originRefCount = asInt(row.originRefCount, 0);
  }
  return [...byId.values()];
}

export async function listSimilarKnowledgeRows(params: {
  knowledgeIds: string[];
  minSimilarity: number;
  topK: number;
  status: "current" | "active" | "draft" | "deprecated" | "all";
}): Promise<DeadZoneSimilarKnowledgeRow[]> {
  const ids = [...new Set(params.knowledgeIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const idsSql = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const statusFilter =
    params.status === "all"
      ? sql`true`
      : params.status === "current"
        ? sql`candidate.status in ('active', 'draft')`
        : sql`candidate.status = ${params.status}`;

  const result = await db.execute(sql`
    with base_rows as (
      select
        base.id,
        base.embedding
      from ${knowledgeItems} base
      where base.id in (${idsSql})
        and base.embedding is not null
    ),
    nearest as (
      select
        base_rows.id::text as source_knowledge_id,
        nearest_candidate.id::text as id,
        nearest_candidate.title,
        nearest_candidate.body,
        nearest_candidate.type,
        nearest_candidate.status,
        nearest_candidate.scope,
        nearest_candidate.applies_to,
        nearest_candidate.metadata,
        nearest_candidate.confidence,
        nearest_candidate.importance,
        nearest_candidate.dynamic_score,
        nearest_candidate.compile_select_count,
        nearest_candidate.last_compiled_at,
        nearest_candidate.last_verified_at,
        nearest_candidate.updated_at,
        nearest_candidate.embedded,
        nearest_candidate.similarity
      from base_rows
      join lateral (
        select
          candidate.id,
          candidate.title,
          candidate.body,
          candidate.type,
          candidate.status,
          candidate.scope,
          candidate.applies_to,
          candidate.metadata,
          candidate.confidence,
          candidate.importance,
          candidate.dynamic_score,
          candidate.compile_select_count,
          candidate.last_compiled_at,
          candidate.last_verified_at,
          candidate.updated_at,
          (candidate.embedding is not null)::boolean as embedded,
          (1 - (base_rows.embedding <=> candidate.embedding))::real as similarity
        from ${knowledgeItems} candidate
        where candidate.id <> base_rows.id
          and candidate.embedding is not null
          and ${statusFilter}
        order by base_rows.embedding <=> candidate.embedding, candidate.updated_at desc
        limit ${params.topK}
      ) nearest_candidate on true
    )
    select
      source_knowledge_id,
      id,
      title,
      body,
      type,
      status,
      scope,
      applies_to,
      metadata,
      confidence,
      importance,
      dynamic_score,
      compile_select_count,
      last_compiled_at,
      last_verified_at,
      updated_at,
      embedded,
      similarity
    from nearest
    where similarity >= ${params.minSimilarity}
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    ...mapKnowledgeRow({
      id: String(row.id),
      title: String(row.title ?? ""),
      body: String(row.body ?? ""),
      type: String(row.type ?? "rule"),
      status: String(row.status ?? "draft"),
      scope: String(row.scope ?? "repo"),
      appliesTo: row.applies_to,
      metadata: row.metadata,
      confidence: row.confidence,
      importance: row.importance,
      dynamicScore: row.dynamic_score,
      compileSelectCount: row.compile_select_count,
      lastCompiledAt: (row.last_compiled_at as Date | null) ?? null,
      lastVerifiedAt: (row.last_verified_at as Date | null) ?? null,
      updatedAt: row.updated_at as Date,
      embedded: row.embedded,
    }),
    sourceKnowledgeId: String(row.source_knowledge_id),
    similarity: Math.max(0, Math.min(1, asNumber(row.similarity, 0))),
  }));
}

export async function listDeadZoneReviewItemLinks(
  knowledgeIds: string[],
): Promise<DeadZoneReviewItemLinkRow[]> {
  const ids = [...new Set(knowledgeIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      knowledgeId: landscapeReviewItems.knowledgeId,
      reviewItemId: landscapeReviewItems.id,
    })
    .from(landscapeReviewItems)
    .where(
      and(
        inArray(landscapeReviewItems.knowledgeId, ids),
        inArray(landscapeReviewItems.reason, [
          "dead_zone_reachability_risk",
          "dead_zone_stale",
          "semantic_merge",
        ]),
        inArray(landscapeReviewItems.status, ["pending", "reviewing"]),
      ),
    );
  return rows
    .filter((row): row is typeof row & { knowledgeId: string } => Boolean(row.knowledgeId))
    .map((row) => ({ knowledgeId: row.knowledgeId, reviewItemId: row.reviewItemId }));
}
