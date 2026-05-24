import { and, inArray, sql } from "drizzle-orm";
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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
