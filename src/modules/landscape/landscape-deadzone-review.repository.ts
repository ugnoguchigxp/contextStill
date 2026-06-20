import { and, eq, inArray, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import {
  knowledgeItems,
  knowledgeOriginLinks,
  knowledgeSourceLinks,
  landscapeReviewItems,
  sourceFragments,
} from "../../db/schema.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

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

export type DeadZoneReviewDecisionRecordInput = {
  reviewItemId?: string | null;
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId?: string | null;
  action: string;
  note?: string | null;
  status: "recorded" | "applied";
  message: string;
};

function asNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function asInt(value: unknown, fallback = 0): number {
  return Math.max(0, Math.trunc(asNumber(value, fallback)));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(", ");
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
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = sqlite.db
      .query<
        {
          id: string;
          title: string;
          body: string;
          type: string;
          status: string;
          scope: string;
          applies_to: string;
          metadata: string;
          confidence: number;
          importance: number;
          dynamic_score: number;
          compile_select_count: number;
          last_compiled_at: string | null;
          last_verified_at: string | null;
          updated_at: string;
          embedded: number;
        },
        string[]
      >(
        `
          select
            k.id,
            k.title,
            k.body,
            k.type,
            k.status,
            k.scope,
            k.applies_to,
            k.metadata,
            k.confidence,
            k.importance,
            k.dynamic_score,
            k.compile_select_count,
            k.last_compiled_at,
            k.last_verified_at,
            k.updated_at,
            case when vf.knowledge_id is null then 0 else 1 end as embedded
          from knowledge_items k
          left join knowledge_items_vec_fallback vf on vf.knowledge_id = k.id
          where k.id in (${placeholders(ids)})
        `,
      )
      .all(...ids);

    return rows.map((row) =>
      mapKnowledgeRow({
        id: row.id,
        title: row.title,
        body: row.body,
        type: row.type,
        status: row.status,
        scope: row.scope,
        appliesTo: row.applies_to,
        metadata: row.metadata,
        confidence: row.confidence,
        importance: row.importance,
        dynamicScore: row.dynamic_score,
        compileSelectCount: row.compile_select_count,
        lastCompiledAt: asDate(row.last_compiled_at),
        lastVerifiedAt: asDate(row.last_verified_at),
        updatedAt: asDate(row.updated_at) ?? new Date(0),
        embedded: row.embedded > 0,
      }),
    );
  }

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
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const sourceRows = sqlite.db
      .query<{ knowledge_id: string; source_ref_count: number }, string[]>(
        `
          select ksl.knowledge_id, count(distinct sf.source_id) as source_ref_count
          from knowledge_source_links ksl
          inner join source_fragments sf on sf.id = ksl.source_fragment_id
          where ksl.knowledge_id in (${placeholders(ids)})
          group by ksl.knowledge_id
        `,
      )
      .all(...ids);
    const originRows = sqlite.db
      .query<{ knowledge_id: string; origin_ref_count: number }, string[]>(
        `
          select knowledge_id, count(*) as origin_ref_count
          from knowledge_origin_links
          where knowledge_id in (${placeholders(ids)})
          group by knowledge_id
        `,
      )
      .all(...ids);

    const byId = new Map<string, DeadZoneKnowledgeEvidenceRow>();
    for (const id of ids) byId.set(id, { knowledgeId: id, sourceRefCount: 0, originRefCount: 0 });
    for (const row of sourceRows) {
      const item = byId.get(row.knowledge_id);
      if (item) item.sourceRefCount = asInt(row.source_ref_count, 0);
    }
    for (const row of originRows) {
      const item = byId.get(row.knowledge_id);
      if (item) item.originRefCount = asInt(row.origin_ref_count, 0);
    }
    return [...byId.values()];
  }

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
  if (isSqliteBackend()) return [];

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
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    return sqlite.db
      .query<{ knowledge_id: string; review_item_id: string }, string[]>(
        `
          select knowledge_id, id as review_item_id
          from landscape_review_items
          where knowledge_id in (${placeholders(ids)})
            and reason in ('dead_zone_reachability_risk', 'dead_zone_stale', 'semantic_merge')
            and status in ('pending', 'reviewing')
            and knowledge_id is not null
        `,
      )
      .all(...ids)
      .map((row) => ({ knowledgeId: row.knowledge_id, reviewItemId: row.review_item_id }));
  }
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

function deadZoneDecisionPayload(input: DeadZoneReviewDecisionRecordInput, decidedAt: Date) {
  return {
    decision: {
      action: input.action,
      note: input.note ?? null,
      status: input.status,
      message: input.message,
      decidedAt: decidedAt.toISOString(),
    },
    deadZoneKnowledgeId: input.deadZoneKnowledgeId,
    canonicalKnowledgeId: input.canonicalKnowledgeId ?? null,
  };
}

function deadZoneDecisionIdempotencyKey(input: DeadZoneReviewDecisionRecordInput): string {
  return [
    "dead-zone-decision",
    input.deadZoneKnowledgeId,
    input.canonicalKnowledgeId ?? "none",
    input.action,
  ].join(":");
}

export async function recordDeadZoneReviewDecision(
  input: DeadZoneReviewDecisionRecordInput,
): Promise<string> {
  if (isSqliteBackend()) {
    return [
      "sqlite-unsupported-dead-zone-review",
      input.deadZoneKnowledgeId,
      input.canonicalKnowledgeId ?? "none",
      input.action,
    ].join(":");
  }

  const now = new Date();
  const payload = deadZoneDecisionPayload(input, now);
  const note = input.note?.trim() ? input.note.trim() : input.message;

  if (input.reviewItemId) {
    const [updated] = await db
      .update(landscapeReviewItems)
      .set({
        status: "resolved",
        note,
        resolvedAt: now,
        updatedAt: now,
        payload: sql`${landscapeReviewItems.payload} || ${JSON.stringify(payload)}::jsonb` as never,
      })
      .where(eq(landscapeReviewItems.id, input.reviewItemId))
      .returning({ id: landscapeReviewItems.id });
    if (updated) return updated.id;
  }

  const [row] = await db
    .insert(landscapeReviewItems)
    .values({
      source: "landscape_snapshot",
      reason: "dead_zone_reachability_risk",
      status: "resolved",
      proposedAction: "review_only",
      priority: 50,
      confidence: "low",
      idempotencyKey: deadZoneDecisionIdempotencyKey(input),
      knowledgeId: input.deadZoneKnowledgeId,
      suggestedAppliesTo: {},
      evidence: [],
      payload,
      note,
      resolvedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: landscapeReviewItems.idempotencyKey,
      set: {
        status: "resolved",
        note,
        resolvedAt: now,
        updatedAt: now,
        payload: sql`${landscapeReviewItems.payload} || ${JSON.stringify(payload)}::jsonb` as never,
      },
    })
    .returning({ id: landscapeReviewItems.id });

  return row.id;
}
