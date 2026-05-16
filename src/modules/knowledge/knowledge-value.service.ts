import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contextPackItems, knowledgeItems } from "../../db/schema.js";
import { recordAuditLogSafe } from "../audit/audit-log.service.js";

const RECENT_SELECTION_WINDOW_DAYS = 30;

export type KnowledgeValueSignals = {
  compileSelectCount: number;
  recentSelectCount30d: number;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
};

type RecordKnowledgeCompileSelectionInput = {
  runId: string;
  selectedKnowledgeIds: string[];
  agenticAcceptedKnowledgeIds: string[];
};

type KnowledgeCounterRow = {
  id: string;
  compileSelectCount: number;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  lastVerifiedAt: Date | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function asNonNegativeInteger(value: unknown, fallback = 0): number {
  const num = Math.floor(asFiniteNumber(value, fallback));
  return Number.isFinite(num) ? Math.max(0, num) : Math.max(0, Math.floor(fallback));
}

export function computeDynamicScore(signals: KnowledgeValueSignals): number {
  const compileSelectCount = asNonNegativeInteger(signals.compileSelectCount);
  const recentSelectCount30d = asNonNegativeInteger(signals.recentSelectCount30d);
  const agenticAcceptCount = asNonNegativeInteger(signals.agenticAcceptCount);
  const explicitUpvoteCount = asNonNegativeInteger(signals.explicitUpvoteCount);
  const explicitDownvoteCount = asNonNegativeInteger(signals.explicitDownvoteCount);

  const score =
    Math.min(35, Math.log1p(compileSelectCount) * 10) +
    Math.min(25, recentSelectCount30d * 3) +
    Math.min(20, agenticAcceptCount * 4) +
    Math.min(20, explicitUpvoteCount * 10) -
    Math.min(40, explicitDownvoteCount * 15);

  return clamp(score, 0, 100);
}

export function computeDecayFactor(input: {
  type: "rule" | "procedure";
  scope: "repo" | "global";
  lastVerifiedAt: Date | null;
  updatedAt: Date;
  now?: Date;
}): number {
  const now = input.now ?? new Date();
  const referenceDate = input.lastVerifiedAt ?? input.updatedAt;
  const elapsedMs = Math.max(0, now.getTime() - referenceDate.getTime());
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
  const lambda = input.type === "procedure" ? 0.004 : 0.001;
  const scopeFactor = input.scope === "global" ? 0.5 : 1;
  return Math.exp(-lambda * scopeFactor * elapsedDays);
}

async function loadKnowledgeCounterRows(knowledgeIds: string[]): Promise<KnowledgeCounterRow[]> {
  if (knowledgeIds.length === 0) return [];
  const rows = await db
    .select({
      id: knowledgeItems.id,
      compileSelectCount: knowledgeItems.compileSelectCount,
      agenticAcceptCount: knowledgeItems.agenticAcceptCount,
      explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
      explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
      lastVerifiedAt: knowledgeItems.lastVerifiedAt,
    })
    .from(knowledgeItems)
    .where(inArray(knowledgeItems.id, knowledgeIds));

  return rows.map((row) => ({
    id: row.id,
    compileSelectCount: asNonNegativeInteger(row.compileSelectCount),
    agenticAcceptCount: asNonNegativeInteger(row.agenticAcceptCount),
    explicitUpvoteCount: asNonNegativeInteger(row.explicitUpvoteCount),
    explicitDownvoteCount: asNonNegativeInteger(row.explicitDownvoteCount),
    lastVerifiedAt: row.lastVerifiedAt,
  }));
}

async function loadRecentSelectionCountMap(knowledgeIds: string[]): Promise<Map<string, number>> {
  if (knowledgeIds.length === 0) return new Map();
  const rows = await db
    .select({
      itemId: contextPackItems.itemId,
      count: sql<number>`count(*)::int`,
    })
    .from(contextPackItems)
    .where(
      and(
        inArray(contextPackItems.itemId, knowledgeIds),
        inArray(contextPackItems.itemKind, ["rule", "procedure"]),
        sql`${contextPackItems.createdAt} >= now() - (${RECENT_SELECTION_WINDOW_DAYS} * interval '1 day')`,
      ),
    )
    .groupBy(contextPackItems.itemId);

  const countMap = new Map<string, number>();
  for (const row of rows) {
    countMap.set(row.itemId, asNonNegativeInteger(row.count));
  }
  return countMap;
}

export async function recordKnowledgeCompileSelection(
  input: RecordKnowledgeCompileSelectionInput,
): Promise<void> {
  const selectedKnowledgeIds = [
    ...new Set(input.selectedKnowledgeIds.map((id) => id.trim())),
  ].filter(Boolean);
  if (selectedKnowledgeIds.length === 0) return;
  const acceptedSet = new Set(
    input.agenticAcceptedKnowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0),
  );

  const [knowledgeRows, recentSelectionCountMap] = await Promise.all([
    loadKnowledgeCounterRows(selectedKnowledgeIds),
    loadRecentSelectionCountMap(selectedKnowledgeIds),
  ]);

  const now = new Date();
  for (const row of knowledgeRows) {
    const nextCompileSelectCount = row.compileSelectCount + 1;
    const nextAgenticAcceptCount = row.agenticAcceptCount + (acceptedSet.has(row.id) ? 1 : 0);
    const dynamicScore = computeDynamicScore({
      compileSelectCount: nextCompileSelectCount,
      recentSelectCount30d: recentSelectionCountMap.get(row.id) ?? 0,
      agenticAcceptCount: nextAgenticAcceptCount,
      explicitUpvoteCount: row.explicitUpvoteCount,
      explicitDownvoteCount: row.explicitDownvoteCount,
    });

    await db
      .update(knowledgeItems)
      .set({
        compileSelectCount: nextCompileSelectCount,
        agenticAcceptCount: nextAgenticAcceptCount,
        lastCompiledAt: now,
        dynamicScore,
        lastVerifiedAt: row.lastVerifiedAt ?? now,
      })
      .where(eq(knowledgeItems.id, row.id));
  }
}

export async function recordKnowledgeCompileSelectionSafe(
  input: RecordKnowledgeCompileSelectionInput,
): Promise<void> {
  try {
    await recordKnowledgeCompileSelection(input);
  } catch (error) {
    await recordAuditLogSafe({
      eventType: "KNOWLEDGE_VALUE_UPDATE_FAILED",
      actor: "system",
      payload: {
        runId: input.runId,
        selectedKnowledgeIds: input.selectedKnowledgeIds,
        agenticAcceptedKnowledgeIds: input.agenticAcceptedKnowledgeIds,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
