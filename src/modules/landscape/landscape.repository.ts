import { and, inArray, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import {
  contextPackItems,
  knowledgeItems,
  knowledgeSourceLinks,
  knowledgeUsageEvents,
  sourceFragments,
} from "../../db/schema.js";

export type LandscapeKnowledgeRow = {
  id: string;
  status: string;
  type: string;
  scope: string;
  importance: number;
  confidence: number;
  dynamicScore: number;
  compileSelectCount: number;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
  embedded: boolean;
  metadata: Record<string, unknown>;
};

export type LandscapeSelectionAggregate = {
  knowledgeId: string;
  selectedItemCountWindow: number;
  selectedRunCountWindow: number;
};

export type LandscapeSelectionPair = {
  knowledgeId: string;
  runId: string;
};

export type LandscapeFeedbackAggregate = {
  knowledgeId: string;
  usedCountWindow: number;
  notUsedCountWindow: number;
  offTopicCountWindow: number;
  wrongCountWindow: number;
};

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asInt(value: unknown, fallback = 0): number {
  return Math.max(0, Math.trunc(asNumber(value, fallback)));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return asRecord(parsed);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asDate(value: unknown): Date {
  if (value === null || value === undefined) return new Date(0);
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(0);
}

function asNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sourceDocIdFromRef(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const [source] = raw.split("#", 1);
  const normalized = source?.trim();
  if (!normalized) return undefined;
  if (normalized.startsWith("cover-evidence-result://")) return undefined;
  if (normalized.startsWith("agent://")) return undefined;
  return normalized;
}

function sourceDocIdsFromMetadata(metadata: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  for (const value of [
    metadata.sourceDocumentUri,
    metadata.sourceUri,
    ...(Array.isArray(metadata.sourceRefs) ? metadata.sourceRefs : []),
    ...(Array.isArray(metadata.candidateSourceRefs) ? metadata.candidateSourceRefs : []),
  ]) {
    const sourceDocId = sourceDocIdFromRef(value);
    if (sourceDocId) refs.add(sourceDocId);
  }

  const references = Array.isArray(metadata.references) ? metadata.references : [];
  for (const reference of references) {
    const row = asRecord(reference);
    const sourceDocId = sourceDocIdFromRef(row.uri);
    if (sourceDocId) refs.add(sourceDocId);
  }

  return [...refs];
}

export async function loadLandscapeKnowledgeRows(
  knowledgeIds: string[],
): Promise<LandscapeKnowledgeRow[]> {
  if (knowledgeIds.length === 0) return [];
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = sqlite.db
      .query<
        {
          id: string;
          status: string;
          type: string;
          scope: string;
          importance: number;
          confidence: number;
          dynamic_score: number;
          compile_select_count: number;
          last_verified_at: string | null;
          updated_at: string;
          metadata: string;
          embedded: number;
        },
        unknown[]
      >(
        `
          select
            k.id,
            k.status,
            k.type,
            k.scope,
            k.importance,
            k.confidence,
            k.dynamic_score,
            k.compile_select_count,
            k.last_verified_at,
            k.updated_at,
            k.metadata,
            case
              when exists (
                select 1
                from knowledge_items_vec_fallback vf
                where vf.knowledge_id = k.id
              )
              then 1
              else 0
            end as embedded
          from knowledge_items k
          where k.id in (${placeholders(knowledgeIds)})
        `,
      )
      .all(...knowledgeIds);

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      type: row.type,
      scope: row.scope,
      importance: asNumber(row.importance, 0),
      confidence: asNumber(row.confidence, 0),
      dynamicScore: asNumber(row.dynamic_score, 0),
      compileSelectCount: asInt(row.compile_select_count, 0),
      lastVerifiedAt: asNullableDate(row.last_verified_at),
      updatedAt: asDate(row.updated_at),
      embedded: Boolean(row.embedded),
      metadata: asRecord(row.metadata),
    }));
  }

  const rows = await db
    .select({
      id: knowledgeItems.id,
      status: knowledgeItems.status,
      type: knowledgeItems.type,
      scope: knowledgeItems.scope,
      importance: knowledgeItems.importance,
      confidence: knowledgeItems.confidence,
      dynamicScore: knowledgeItems.dynamicScore,
      compileSelectCount: knowledgeItems.compileSelectCount,
      lastVerifiedAt: knowledgeItems.lastVerifiedAt,
      updatedAt: knowledgeItems.updatedAt,
      metadata: knowledgeItems.metadata,
      embedded: sql<boolean>`${knowledgeItems.embedding} is not null`,
    })
    .from(knowledgeItems)
    .where(inArray(knowledgeItems.id, knowledgeIds));

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    type: row.type,
    scope: row.scope,
    importance: asNumber(row.importance, 0),
    confidence: asNumber(row.confidence, 0),
    dynamicScore: asNumber(row.dynamicScore, 0),
    compileSelectCount: asInt(row.compileSelectCount, 0),
    lastVerifiedAt: row.lastVerifiedAt,
    updatedAt: row.updatedAt,
    embedded: Boolean(row.embedded),
    metadata: asRecord(row.metadata),
  }));
}

export async function loadLandscapeSelectionAggregates(params: {
  knowledgeIds: string[];
  windowDays: number;
}): Promise<LandscapeSelectionAggregate[]> {
  if (params.knowledgeIds.length === 0) return [];
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = sqlite.db
      .query<
        {
          knowledge_id: string;
          selected_item_count_window: number;
          selected_run_count_window: number;
        },
        unknown[]
      >(
        `
          select
            item_id as knowledge_id,
            count(*) as selected_item_count_window,
            count(distinct run_id) as selected_run_count_window
          from context_pack_items
          where item_id in (${placeholders(params.knowledgeIds)})
            and item_kind in ('rule', 'procedure')
            and datetime(created_at) >= datetime('now', ?)
          group by item_id
        `,
      )
      .all(...params.knowledgeIds, `-${params.windowDays} days`);

    return rows.map((row) => ({
      knowledgeId: row.knowledge_id,
      selectedItemCountWindow: asInt(row.selected_item_count_window, 0),
      selectedRunCountWindow: asInt(row.selected_run_count_window, 0),
    }));
  }

  const rows = await db
    .select({
      knowledgeId: contextPackItems.itemId,
      selectedItemCountWindow: sql<number>`count(*)::int`,
      selectedRunCountWindow: sql<number>`count(distinct ${contextPackItems.runId})::int`,
    })
    .from(contextPackItems)
    .where(
      and(
        inArray(contextPackItems.itemId, params.knowledgeIds),
        inArray(contextPackItems.itemKind, ["rule", "procedure"]),
        sql`${contextPackItems.createdAt} >= now() - (${params.windowDays} * interval '1 day')`,
      ),
    )
    .groupBy(contextPackItems.itemId);

  return rows.map((row) => ({
    knowledgeId: row.knowledgeId,
    selectedItemCountWindow: asInt(row.selectedItemCountWindow, 0),
    selectedRunCountWindow: asInt(row.selectedRunCountWindow, 0),
  }));
}

export async function loadLandscapeSelectionPairs(params: {
  knowledgeIds: string[];
  windowDays: number;
}): Promise<LandscapeSelectionPair[]> {
  if (params.knowledgeIds.length === 0) return [];
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = sqlite.db
      .query<{ knowledge_id: string; run_id: string }, unknown[]>(
        `
          select item_id as knowledge_id, run_id
          from context_pack_items
          where item_id in (${placeholders(params.knowledgeIds)})
            and item_kind in ('rule', 'procedure')
            and datetime(created_at) >= datetime('now', ?)
        `,
      )
      .all(...params.knowledgeIds, `-${params.windowDays} days`);

    return rows.map((row) => ({
      knowledgeId: row.knowledge_id,
      runId: row.run_id,
    }));
  }

  const rows = await db
    .select({
      knowledgeId: contextPackItems.itemId,
      runId: contextPackItems.runId,
    })
    .from(contextPackItems)
    .where(
      and(
        inArray(contextPackItems.itemId, params.knowledgeIds),
        inArray(contextPackItems.itemKind, ["rule", "procedure"]),
        sql`${contextPackItems.createdAt} >= now() - (${params.windowDays} * interval '1 day')`,
      ),
    );

  return rows.map((row) => ({
    knowledgeId: row.knowledgeId,
    runId: row.runId,
  }));
}

export async function loadLandscapeFeedbackAggregates(params: {
  knowledgeIds: string[];
  windowDays: number;
}): Promise<LandscapeFeedbackAggregate[]> {
  if (params.knowledgeIds.length === 0) return [];
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = sqlite.db
      .query<
        {
          knowledge_id: string;
          used_count_window: number;
          not_used_count_window: number;
          off_topic_count_window: number;
          wrong_count_window: number;
        },
        unknown[]
      >(
        `
          select
            knowledge_id,
            sum(case when verdict = 'used' then 1 else 0 end) as used_count_window,
            sum(case when verdict = 'not_used' then 1 else 0 end) as not_used_count_window,
            sum(case when verdict = 'off_topic' then 1 else 0 end) as off_topic_count_window,
            sum(case when verdict = 'wrong' then 1 else 0 end) as wrong_count_window
          from knowledge_usage_events
          where knowledge_id in (${placeholders(params.knowledgeIds)})
            and datetime(created_at) >= datetime('now', ?)
          group by knowledge_id
        `,
      )
      .all(...params.knowledgeIds, `-${params.windowDays} days`);

    return rows.map((row) => ({
      knowledgeId: row.knowledge_id,
      usedCountWindow: asInt(row.used_count_window, 0),
      notUsedCountWindow: asInt(row.not_used_count_window, 0),
      offTopicCountWindow: asInt(row.off_topic_count_window, 0),
      wrongCountWindow: asInt(row.wrong_count_window, 0),
    }));
  }

  const rows = await db
    .select({
      knowledgeId: knowledgeUsageEvents.knowledgeId,
      usedCountWindow: sql<number>`count(*) filter (where ${knowledgeUsageEvents.verdict} = 'used')::int`,
      notUsedCountWindow: sql<number>`count(*) filter (where ${knowledgeUsageEvents.verdict} = 'not_used')::int`,
      offTopicCountWindow: sql<number>`count(*) filter (where ${knowledgeUsageEvents.verdict} = 'off_topic')::int`,
      wrongCountWindow: sql<number>`count(*) filter (where ${knowledgeUsageEvents.verdict} = 'wrong')::int`,
    })
    .from(knowledgeUsageEvents)
    .where(
      and(
        inArray(knowledgeUsageEvents.knowledgeId, params.knowledgeIds),
        sql`${knowledgeUsageEvents.createdAt} >= now() - (${params.windowDays} * interval '1 day')`,
      ),
    )
    .groupBy(knowledgeUsageEvents.knowledgeId);

  return rows.map((row) => ({
    knowledgeId: row.knowledgeId,
    usedCountWindow: asInt(row.usedCountWindow, 0),
    notUsedCountWindow: asInt(row.notUsedCountWindow, 0),
    offTopicCountWindow: asInt(row.offTopicCountWindow, 0),
    wrongCountWindow: asInt(row.wrongCountWindow, 0),
  }));
}

export async function loadLandscapeSourceRefCountMap(
  knowledgeRows: LandscapeKnowledgeRow[],
): Promise<Map<string, number>> {
  if (knowledgeRows.length === 0) return new Map();
  const knowledgeIds = knowledgeRows.map((row) => row.id);
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const linkRows = sqlite.db
      .query<{ knowledge_id: string; source_id: string }, unknown[]>(
        `
          select ksl.knowledge_id, sf.source_id
          from knowledge_source_links ksl
          inner join source_fragments sf on sf.id = ksl.source_fragment_id
          where ksl.knowledge_id in (${placeholders(knowledgeIds)})
        `,
      )
      .all(...knowledgeIds);

    const linkedSourceByKnowledge = new Map<string, Set<string>>();
    for (const row of linkRows) {
      const current = linkedSourceByKnowledge.get(row.knowledge_id) ?? new Set<string>();
      current.add(row.source_id);
      linkedSourceByKnowledge.set(row.knowledge_id, current);
    }

    const sourceRefCountMap = new Map<string, number>();
    for (const row of knowledgeRows) {
      const refs = new Set<string>(linkedSourceByKnowledge.get(row.id) ?? new Set<string>());
      for (const sourceDocId of sourceDocIdsFromMetadata(row.metadata)) {
        refs.add(sourceDocId);
      }
      sourceRefCountMap.set(row.id, refs.size);
    }
    return sourceRefCountMap;
  }

  const linkRows = await db
    .select({
      knowledgeId: knowledgeSourceLinks.knowledgeId,
      sourceId: sourceFragments.sourceId,
    })
    .from(knowledgeSourceLinks)
    .innerJoin(
      sourceFragments,
      sql`${sourceFragments.id} = ${knowledgeSourceLinks.sourceFragmentId}`,
    )
    .where(inArray(knowledgeSourceLinks.knowledgeId, knowledgeIds));

  const linkedSourceByKnowledge = new Map<string, Set<string>>();
  for (const row of linkRows) {
    const current = linkedSourceByKnowledge.get(row.knowledgeId) ?? new Set<string>();
    current.add(row.sourceId);
    linkedSourceByKnowledge.set(row.knowledgeId, current);
  }

  const sourceRefCountMap = new Map<string, number>();
  for (const row of knowledgeRows) {
    const refs = new Set<string>(linkedSourceByKnowledge.get(row.id) ?? new Set<string>());
    for (const sourceDocId of sourceDocIdsFromMetadata(row.metadata)) {
      refs.add(sourceDocId);
    }
    sourceRefCountMap.set(row.id, refs.size);
  }
  return sourceRefCountMap;
}
