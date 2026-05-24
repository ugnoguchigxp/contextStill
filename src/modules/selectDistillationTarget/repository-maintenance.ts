import { and, asc, count, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { APP_CONSTANTS } from "../../constants.js";
import { db } from "../../db/index.js";
import { distillationTargetStates } from "../../db/schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import type { DistillationTargetKind, DistillationTargetStatus } from "./domain.js";
import { isManualPauseTarget } from "./manual-pause.js";
import {
  DEFAULT_DISTILLATION_TARGET_VERSION,
  type DistillationTargetStateRow,
  rowHeartbeatMs,
  staleThresholdMs,
  targetIdentity,
} from "./repository-helpers.js";

export type DistillationTargetSummary = {
  version: string;
  mode: "candidate_first" | "web_first" | "wiki_first" | "vibe_memory_fallback" | "idle";
  queued: number;
  pendingKnowledgeCandidates: number;
  pendingWebIngest: number;
  pendingWiki: number;
  pendingVibeMemory: number;
  running: number;
  paused: number;
  staleRunning: number;
  failed: number;
  skipped: number;
  completed: number;
  lastCompleted: DistillationTargetStateRow | null;
  lastSkipped: DistillationTargetStateRow | null;
  lastFailed: DistillationTargetStateRow | null;
};

export type RecoveryResult = {
  recoveredToPending: number;
  failed: number;
  skipped: number;
};

export async function releaseRetryablePausedDistillationTargets(
  params: {
    distillationVersion?: string;
    now?: Date;
    targetKind?: DistillationTargetKind;
    limit?: number;
    excludeManualPauseReasons?: boolean;
  } = {},
): Promise<number> {
  const now = params.now ?? new Date();
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const baseConditions = [
    eq(distillationTargetStates.distillationVersion, distillationVersion),
    eq(distillationTargetStates.status, "paused"),
    or(
      isNull(distillationTargetStates.nextRetryAt),
      lte(distillationTargetStates.nextRetryAt, now),
    ),
  ];
  if (params.targetKind) {
    baseConditions.push(eq(distillationTargetStates.targetKind, params.targetKind));
  }
  const limit = typeof params.limit === "number" ? Math.max(1, params.limit) : null;

  // Fast path: keep the original one-shot SQL update when additional filtering is not required.
  if (!params.excludeManualPauseReasons && limit === null) {
    const rows = await db
      .update(distillationTargetStates)
      .set({
        status: "pending",
        nextRetryAt: null,
        updatedAt: now,
      })
      .where(and(...baseConditions))
      .returning({ id: distillationTargetStates.id });
    return rows.length;
  }

  const query = db
    .select({
      id: distillationTargetStates.id,
      lastError: distillationTargetStates.lastError,
      metadata: distillationTargetStates.metadata,
    })
    .from(distillationTargetStates)
    .where(and(...baseConditions))
    .orderBy(asc(distillationTargetStates.updatedAt));

  const pausedRows = limit === null ? await query : await query.limit(limit);
  const eligibleIds = pausedRows
    .filter((row) => (params.excludeManualPauseReasons ? !isManualPauseTarget(row) : true))
    .map((row) => row.id);
  if (eligibleIds.length < 1) return 0;

  const rows = await db
    .update(distillationTargetStates)
    .set({
      status: "pending",
      nextRetryAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, distillationVersion),
        inArray(distillationTargetStates.id, eligibleIds),
      ),
    )
    .returning({ id: distillationTargetStates.id });

  return rows.length;
}

export async function recoverStaleDistillationTargets(
  params: {
    distillationVersion?: string;
    staleSeconds?: number;
    maxAttempts?: number;
    now?: Date;
    targetKind?: DistillationTargetKind;
    limit?: number;
  } = {},
): Promise<RecoveryResult> {
  const now = params.now ?? new Date();
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const thresholdMs = staleThresholdMs(
    params.staleSeconds ?? APP_CONSTANTS.distillationTargetStaleSeconds,
    now,
  );
  const maxAttempts = params.maxAttempts ?? APP_CONSTANTS.distillationTargetMaxAttempts;
  const runningConditions = [
    eq(distillationTargetStates.distillationVersion, distillationVersion),
    eq(distillationTargetStates.status, "running"),
  ];
  if (params.targetKind) {
    runningConditions.push(eq(distillationTargetStates.targetKind, params.targetKind));
  }
  const runningRows = await db
    .select()
    .from(distillationTargetStates)
    .where(and(...runningConditions));
  const staleRows = runningRows
    .filter((row) => rowHeartbeatMs(row) <= thresholdMs)
    .slice(
      0,
      typeof params.limit === "number" ? Math.max(1, params.limit) : Number.MAX_SAFE_INTEGER,
    );

  let recoveredToPending = 0;
  const failed = 0;
  let skipped = 0;

  for (const stale of staleRows) {
    const nextStatus: DistillationTargetStatus =
      stale.attemptCount >= maxAttempts ? "skipped" : "pending";
    const [row] = await db
      .update(distillationTargetStates)
      .set({
        status: nextStatus,
        phase: nextStatus === "skipped" ? "stored" : "selected",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        nextRetryAt: null,
        lastOutcomeKind: "stale_running_recovered",
        lastError:
          nextStatus === "skipped"
            ? "stale_running_retry_limit_exceeded"
            : "stale_running_recovered",
        metadata: sql`${distillationTargetStates.metadata} || ${JSON.stringify({
          staleRecovered: true,
          staleRecoveredAt: now.toISOString(),
        })}::jsonb` as never,
        completedAt: nextStatus === "skipped" ? now : null,
        updatedAt: now,
      })
      .where(eq(distillationTargetStates.id, stale.id))
      .returning();
    if (!row) continue;
    if (nextStatus === "skipped") skipped += 1;
    else recoveredToPending += 1;
  }

  if (recoveredToPending > 0 || failed > 0 || skipped > 0) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.distillationTargetRecovered,
      actor: "system",
      payload: {
        distillationVersion,
        targetKind: params.targetKind ?? null,
        recoveredToPending,
        failed,
        skipped,
        limit: params.limit ?? null,
        staleSeconds: params.staleSeconds ?? APP_CONSTANTS.distillationTargetStaleSeconds,
      },
    });
  }

  return { recoveredToPending, failed, skipped };
}

export async function markMissingWikiTargetsSkipped(params: {
  currentTargetKeys: Set<string>;
  rootPath: string;
  distillationVersion?: string;
}): Promise<number> {
  const now = new Date();
  const rows = await db
    .select()
    .from(distillationTargetStates)
    .where(
      and(
        eq(
          distillationTargetStates.distillationVersion,
          params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION,
        ),
        eq(distillationTargetStates.targetKind, "wiki_file"),
        inArray(distillationTargetStates.status, ["pending", "running", "paused", "failed"]),
      ),
    );

  let updated = 0;
  for (const row of rows) {
    if (params.currentTargetKeys.has(row.targetKey)) continue;
    const [skipped] = await db
      .update(distillationTargetStates)
      .set({
        status: "skipped",
        phase: "stored",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        nextRetryAt: null,
        lastOutcomeKind: "missing_source",
        lastError: "wiki_file_missing",
        metadata: sql`${distillationTargetStates.metadata} || ${JSON.stringify({
          missing: true,
          missingDetectedAt: now.toISOString(),
          rootPath: params.rootPath,
        })}::jsonb` as never,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(distillationTargetStates.id, row.id))
      .returning();
    if (skipped) updated += 1;
  }
  return updated;
}

export async function markMissingVibeMemoryTargetsSkipped(params: {
  currentTargetKeys: Set<string>;
  distillationVersion?: string;
}): Promise<number> {
  const now = new Date();
  const rows = await db
    .select()
    .from(distillationTargetStates)
    .where(
      and(
        eq(
          distillationTargetStates.distillationVersion,
          params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION,
        ),
        eq(distillationTargetStates.targetKind, "vibe_memory"),
        inArray(distillationTargetStates.status, ["pending", "running", "paused", "failed"]),
      ),
    );

  let updated = 0;
  for (const row of rows) {
    if (params.currentTargetKeys.has(row.targetKey)) continue;
    const [skipped] = await db
      .update(distillationTargetStates)
      .set({
        status: "skipped",
        phase: "stored",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        nextRetryAt: null,
        lastOutcomeKind: "missing_source",
        lastError: "vibe_memory_missing",
        metadata: sql`${distillationTargetStates.metadata} || ${JSON.stringify({
          missing: true,
          missingDetectedAt: now.toISOString(),
        })}::jsonb` as never,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(distillationTargetStates.id, row.id))
      .returning();
    if (skipped) updated += 1;
  }
  return updated;
}

async function countStaleRunning(
  distillationVersion: string,
  staleSeconds: number,
): Promise<number> {
  const thresholdMs = staleThresholdMs(staleSeconds);
  const rows = await db
    .select({
      heartbeatAt: distillationTargetStates.heartbeatAt,
      lockedAt: distillationTargetStates.lockedAt,
    })
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, distillationVersion),
        eq(distillationTargetStates.status, "running"),
      ),
    );
  return rows.filter((row) => rowHeartbeatMs(row) <= thresholdMs).length;
}

async function lastTargetByStatus(
  status: Extract<DistillationTargetStatus, "completed" | "skipped" | "failed">,
  distillationVersion: string,
): Promise<DistillationTargetStateRow | null> {
  const [row] = await db
    .select()
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, distillationVersion),
        eq(distillationTargetStates.status, status),
      ),
    )
    .orderBy(
      desc(
        sql`coalesce(${distillationTargetStates.completedAt}, ${distillationTargetStates.updatedAt})`,
      ),
      desc(distillationTargetStates.id),
    )
    .limit(1);
  return row ?? null;
}

export async function getDistillationTargetSummary(
  params: {
    distillationVersion?: string;
    staleSeconds?: number;
  } = {},
): Promise<DistillationTargetSummary> {
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const rows = await db
    .select({
      targetKind: distillationTargetStates.targetKind,
      status: distillationTargetStates.status,
      value: count(),
    })
    .from(distillationTargetStates)
    .where(eq(distillationTargetStates.distillationVersion, distillationVersion))
    .groupBy(distillationTargetStates.targetKind, distillationTargetStates.status);

  const value = (targetKind: DistillationTargetKind, status: DistillationTargetStatus) =>
    Number(rows.find((row) => row.targetKind === targetKind && row.status === status)?.value ?? 0);
  const statusTotal = (status: DistillationTargetStatus) =>
    Number(
      rows.filter((row) => row.status === status).reduce((sum, row) => sum + Number(row.value), 0),
    );

  const pendingKnowledgeCandidates =
    value("knowledge_candidate", "pending") + value("knowledge_candidate", "paused");
  const pendingWebIngest = value("web_ingest", "pending") + value("web_ingest", "paused");
  const pendingWiki = value("wiki_file", "pending") + value("wiki_file", "paused");
  const pendingVibeMemory = value("vibe_memory", "pending") + value("vibe_memory", "paused");
  const queued = pendingKnowledgeCandidates + pendingWebIngest + pendingWiki + pendingVibeMemory;

  return {
    version: distillationVersion,
    mode:
      pendingKnowledgeCandidates > 0
        ? "candidate_first"
        : pendingWebIngest > 0
          ? "web_first"
          : pendingWiki > 0
            ? "wiki_first"
            : pendingVibeMemory > 0
              ? "vibe_memory_fallback"
              : "idle",
    queued,
    pendingKnowledgeCandidates,
    pendingWebIngest,
    pendingWiki,
    pendingVibeMemory,
    running: statusTotal("running"),
    paused: statusTotal("paused"),
    staleRunning: await countStaleRunning(
      distillationVersion,
      params.staleSeconds ?? APP_CONSTANTS.distillationTargetStaleSeconds,
    ),
    failed: statusTotal("failed"),
    skipped: statusTotal("skipped"),
    completed: statusTotal("completed"),
    lastCompleted: await lastTargetByStatus("completed", distillationVersion),
    lastSkipped: await lastTargetByStatus("skipped", distillationVersion),
    lastFailed: await lastTargetByStatus("failed", distillationVersion),
  };
}
