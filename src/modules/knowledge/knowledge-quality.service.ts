import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  knowledgeItems,
  knowledgeQualityAdjustments,
  knowledgeUsageEvents,
} from "../../db/schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";

const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_COOLDOWN_DAYS = 14;
const DEFAULT_MIN_OFF_TOPIC_RUNS = 5;
const DEFAULT_MIN_OFF_TOPIC_RATE = 0.6;
const DEFAULT_DECREMENT = 2;

type ActiveKnowledgeRow = {
  id: string;
  importance: number;
  confidence: number;
};

type UsageAggregateRow = {
  knowledgeId: string;
  offTopicRunCount: number;
  usedRunCount: number;
};

type AdjustmentCooldownRow = {
  knowledgeId: string;
  lastAdjustedAt: Date | null;
};

export type QualityAdjustmentCandidate = {
  knowledgeId: string;
  usedRunCount: number;
  offTopicRunCount: number;
  offTopicRate: number;
  cooldownBlocked: boolean;
};

export type ApplyKnowledgeQualityAdjustmentsInput = {
  apply: boolean;
  limit?: number;
  windowDays?: number;
  cooldownDays?: number;
  minOffTopicRuns?: number;
  minOffTopicRate?: number;
  decrement?: number;
};

export type ApplyKnowledgeQualityAdjustmentsResult = {
  ok: true;
  dryRun: boolean;
  scannedCount: number;
  candidateCount: number;
  adjustedCount: number;
  skippedByCooldownCount: number;
  candidatePreview: QualityAdjustmentCandidate[];
};

function toFiniteNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const normalized = Math.floor(toFiniteNumber(value, fallback));
  return normalized > 0 ? normalized : fallback;
}

function normalizeRate(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const normalized = toFiniteNumber(value, fallback);
  if (!Number.isFinite(normalized)) return fallback;
  return Math.min(1, Math.max(0, normalized));
}

async function loadActiveKnowledgeRows(limit?: number): Promise<ActiveKnowledgeRow[]> {
  const query = db
    .select({
      id: knowledgeItems.id,
      importance: knowledgeItems.importance,
      confidence: knowledgeItems.confidence,
    })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.status, "active"))
    .orderBy(desc(knowledgeItems.updatedAt));

  const rows = limit && limit > 0 ? await query.limit(limit) : await query;
  return rows.map((row) => ({
    id: row.id,
    importance: toFiniteNumber(row.importance, 0),
    confidence: toFiniteNumber(row.confidence, 0),
  }));
}

async function loadUsageAggregates(
  knowledgeIds: string[],
  windowDays: number,
): Promise<Map<string, UsageAggregateRow>> {
  if (knowledgeIds.length === 0) return new Map();
  const rows = await db
    .select({
      knowledgeId: knowledgeUsageEvents.knowledgeId,
      offTopicRunCount: sql<number>`count(distinct ${knowledgeUsageEvents.runId}) filter (where ${knowledgeUsageEvents.verdict} = 'off_topic')::int`,
      usedRunCount: sql<number>`count(distinct ${knowledgeUsageEvents.runId}) filter (where ${knowledgeUsageEvents.verdict} = 'used')::int`,
    })
    .from(knowledgeUsageEvents)
    .where(
      and(
        sql`${knowledgeUsageEvents.createdAt} >= now() - (${windowDays} * interval '1 day')`,
        inArray(knowledgeUsageEvents.knowledgeId, knowledgeIds),
      ),
    )
    .groupBy(knowledgeUsageEvents.knowledgeId);

  const map = new Map<string, UsageAggregateRow>();
  for (const row of rows) {
    map.set(row.knowledgeId, {
      knowledgeId: row.knowledgeId,
      offTopicRunCount: Math.max(0, Math.floor(toFiniteNumber(row.offTopicRunCount, 0))),
      usedRunCount: Math.max(0, Math.floor(toFiniteNumber(row.usedRunCount, 0))),
    });
  }
  return map;
}

async function loadCooldownRows(knowledgeIds: string[]): Promise<Map<string, Date>> {
  if (knowledgeIds.length === 0) return new Map();
  const rows = await db
    .select({
      knowledgeId: knowledgeQualityAdjustments.knowledgeId,
      lastAdjustedAt: sql<Date | null>`max(${knowledgeQualityAdjustments.createdAt})`,
    })
    .from(knowledgeQualityAdjustments)
    .where(
      and(
        eq(knowledgeQualityAdjustments.adjustmentKind, "off_topic_quality_decrement"),
        inArray(knowledgeQualityAdjustments.knowledgeId, knowledgeIds),
      ),
    )
    .groupBy(knowledgeQualityAdjustments.knowledgeId);

  const map = new Map<string, Date>();
  for (const row of rows as AdjustmentCooldownRow[]) {
    if (row.lastAdjustedAt instanceof Date) {
      map.set(row.knowledgeId, row.lastAdjustedAt);
    }
  }
  return map;
}

export async function applyKnowledgeQualityAdjustments(
  input: ApplyKnowledgeQualityAdjustmentsInput,
): Promise<ApplyKnowledgeQualityAdjustmentsResult> {
  const windowDays = normalizePositiveInteger(input.windowDays, DEFAULT_WINDOW_DAYS);
  const cooldownDays = normalizePositiveInteger(input.cooldownDays, DEFAULT_COOLDOWN_DAYS);
  const minOffTopicRuns = normalizePositiveInteger(
    input.minOffTopicRuns,
    DEFAULT_MIN_OFF_TOPIC_RUNS,
  );
  const minOffTopicRate = normalizeRate(input.minOffTopicRate, DEFAULT_MIN_OFF_TOPIC_RATE);
  const decrement = normalizePositiveInteger(input.decrement, DEFAULT_DECREMENT);
  const activeKnowledge = await loadActiveKnowledgeRows(input.limit);
  const usageByKnowledgeId = await loadUsageAggregates(
    activeKnowledge.map((row) => row.id),
    windowDays,
  );
  const cooldownByKnowledgeId = await loadCooldownRows(activeKnowledge.map((row) => row.id));
  const now = new Date();
  const cooldownThresholdMs = cooldownDays * 24 * 60 * 60 * 1000;

  const candidates: QualityAdjustmentCandidate[] = [];
  const adjustableKnowledgeIds: string[] = [];
  let skippedByCooldownCount = 0;

  for (const item of activeKnowledge) {
    const usage = usageByKnowledgeId.get(item.id);
    const offTopicRunCount = usage?.offTopicRunCount ?? 0;
    const usedRunCount = usage?.usedRunCount ?? 0;
    const denominator = usedRunCount + offTopicRunCount;
    if (denominator <= 0) continue;
    const offTopicRate = offTopicRunCount / denominator;
    if (offTopicRunCount < minOffTopicRuns) continue;
    if (offTopicRate < minOffTopicRate) continue;

    const lastAdjustedAt = cooldownByKnowledgeId.get(item.id);
    const cooldownBlocked =
      lastAdjustedAt !== undefined &&
      now.getTime() - lastAdjustedAt.getTime() < cooldownThresholdMs;

    candidates.push({
      knowledgeId: item.id,
      usedRunCount,
      offTopicRunCount,
      offTopicRate,
      cooldownBlocked,
    });

    if (cooldownBlocked) {
      skippedByCooldownCount += 1;
      continue;
    }
    adjustableKnowledgeIds.push(item.id);
  }

  let adjustedCount = 0;

  if (input.apply) {
    for (const knowledgeId of adjustableKnowledgeIds) {
      const candidate = candidates.find((item) => item.knowledgeId === knowledgeId);
      if (!candidate) continue;
      const windowStartAt = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

      await db
        .update(knowledgeItems)
        .set({
          importance: sql`greatest(0, ${knowledgeItems.importance} - ${decrement})`,
          confidence: sql`greatest(0, ${knowledgeItems.confidence} - ${decrement})`,
          updatedAt: now,
        })
        .where(eq(knowledgeItems.id, knowledgeId));

      await db.insert(knowledgeQualityAdjustments).values({
        knowledgeId,
        adjustmentKind: "off_topic_quality_decrement",
        windowStartAt,
        windowEndAt: now,
        negativeRunCount: candidate.offTopicRunCount,
        offTopicRate: candidate.offTopicRate,
        importanceDelta: -decrement,
        confidenceDelta: -decrement,
        createdAt: now,
      });

      await recordAuditLogSafe({
        eventType: auditEventTypes.knowledgeQualityAdjusted,
        actor: "system",
        payload: {
          knowledgeId,
          adjustmentKind: "off_topic_quality_decrement",
          offTopicRunCount: candidate.offTopicRunCount,
          usedRunCount: candidate.usedRunCount,
          offTopicRate: candidate.offTopicRate,
          importanceDelta: -decrement,
          confidenceDelta: -decrement,
          windowDays,
          cooldownDays,
        },
      });

      adjustedCount += 1;
    }
  }

  return {
    ok: true,
    dryRun: !input.apply,
    scannedCount: activeKnowledge.length,
    candidateCount: candidates.length,
    adjustedCount,
    skippedByCooldownCount,
    candidatePreview: candidates.slice(0, 20),
  };
}
