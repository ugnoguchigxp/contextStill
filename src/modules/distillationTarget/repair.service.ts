import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { readFileLockState } from "../../cli/file-lock.js";
import { groupedConfig } from "../../config.js";
import { APP_CONSTANTS } from "../../constants.js";
import { getDb } from "../../db/index.js";
import { distillationTargetStates } from "../../db/schema.js";
import type { DistillationTargetKind } from "./domain.js";
import { isManualPauseTarget } from "./manual-pause.js";
import { priorityGroupFromRowLike } from "./priority-group.js";
import {
  DEFAULT_DISTILLATION_TARGET_VERSION,
  recoverStaleDistillationTargets,
  releaseRetryablePausedDistillationTargets,
} from "./repository.js";

export type DistillationRepairKind = "auto" | "wiki" | "vibe" | "candidate" | "web";
export type DistillationRepairMode = "dry-run" | "apply";
export type DistillationRepairActionType =
  | "remove_stale_file_lock"
  | "inspect_live_worker"
  | "running_target_holds_lock"
  | "release_stale_running"
  | "release_retryable_paused"
  | "manual_paused"
  | "queue_stopped"
  | "blocked_by_higher_priority"
  | "running_recent";

export type DistillationRepairAction = {
  type: DistillationRepairActionType;
  kind: DistillationTargetKind | "all";
  safeToApply: boolean;
  requiresManualReview: boolean;
  reason: string;
  evidence: Record<string, unknown>;
};

export type DistillationRepairInput = {
  kind?: DistillationRepairKind;
  apply?: boolean;
  staleSeconds?: number;
  maxAttempts?: number;
  limit?: number;
  distillationVersion?: string;
};

export type DistillationRepairReport = {
  mode: DistillationRepairMode;
  kind: DistillationRepairKind;
  distillationVersion: string;
  staleSeconds: number;
  maxAttempts: number;
  limit: number;
  actions: DistillationRepairAction[];
  applied: {
    removedLocks: number;
    releasedStaleRunning: number;
    skippedStaleRunning: number;
    releasedRetryablePaused: number;
  };
  skipped: {
    manualPaused: number;
    liveLock: number;
    recentRunning: number;
    queueStopped: number;
    blockedByHigherPriority: number;
  };
  warnings: string[];
};

type ScopedStateRow = Pick<
  typeof distillationTargetStates.$inferSelect,
  | "id"
  | "targetKind"
  | "status"
  | "createdAt"
  | "lockedAt"
  | "heartbeatAt"
  | "updatedAt"
  | "nextRetryAt"
  | "lastError"
  | "priorityGroup"
  | "metadata"
  | "completedAt"
>;

type QueueStats = {
  queued: number;
  running: number;
  staleRunning: number;
  runningRecent: number;
  retryablePaused: number;
  manualPaused: number;
  oldestQueuedAgeMinutes: number | null;
  lastProgressAgeMinutes: number | null;
};

type HigherPriorityBlockers = {
  pendingKnowledgeCandidates: number;
  runningKnowledgeCandidates: number;
  retryableKnowledgeCandidates: number;
  manualPausedKnowledgeCandidates: number;
  pendingWebIngest: number;
  runningWebIngest: number;
  retryableWebIngest: number;
  manualPausedWebIngest: number;
  pendingWiki: number;
  runningWiki: number;
  retryableWiki: number;
  manualPausedWiki: number;
};

function resolveTargetKind(kind: DistillationRepairKind): DistillationTargetKind | undefined {
  if (kind === "wiki") return "wiki_file";
  if (kind === "vibe") return "vibe_memory";
  if (kind === "web") return "web_ingest";
  if (kind === "candidate") return "knowledge_candidate";
  return undefined;
}

function runningTimestampMs(
  row: Pick<ScopedStateRow, "heartbeatAt" | "lockedAt" | "updatedAt">,
): number {
  return (row.heartbeatAt ?? row.lockedAt ?? row.updatedAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
}

function oldestAgeMinutes(timestampMs: number | null, nowMs: number): number | null {
  if (timestampMs === null) return null;
  return Math.max(0, (nowMs - timestampMs) / 60000);
}

function queueStatsFromRows(rows: ScopedStateRow[], nowMs: number, staleAtMs: number): QueueStats {
  let queued = 0;
  let running = 0;
  let staleRunning = 0;
  let runningRecent = 0;
  let retryablePaused = 0;
  let manualPaused = 0;
  let oldestQueuedMs: number | null = null;
  let newestProgressMs: number | null = null;

  for (const row of rows) {
    if (row.status === "pending") {
      queued += 1;
      const createdMs = row.createdAt.getTime();
      oldestQueuedMs = oldestQueuedMs === null ? createdMs : Math.min(oldestQueuedMs, createdMs);
      continue;
    }
    if (row.status === "running") {
      running += 1;
      const currentMs = runningTimestampMs(row);
      if (currentMs <= staleAtMs) staleRunning += 1;
      else runningRecent += 1;
      continue;
    }
    if (row.status !== "paused") continue;
    const manualPausedTarget = isManualPauseTarget(row);
    if (manualPausedTarget) {
      manualPaused += 1;
      continue;
    }
    const retryAtMs = row.nextRetryAt?.getTime() ?? null;
    if (retryAtMs === null || retryAtMs <= nowMs) {
      retryablePaused += 1;
      const createdMs = row.createdAt.getTime();
      oldestQueuedMs = oldestQueuedMs === null ? createdMs : Math.min(oldestQueuedMs, createdMs);
    }
  }

  for (const row of rows) {
    if (row.status !== "completed" && row.status !== "skipped" && row.status !== "failed") {
      continue;
    }
    const progressMs = (row.completedAt ?? row.updatedAt)?.getTime() ?? null;
    if (progressMs === null) continue;
    newestProgressMs =
      newestProgressMs === null ? progressMs : Math.max(newestProgressMs, progressMs);
  }

  return {
    queued,
    running,
    staleRunning,
    runningRecent,
    retryablePaused,
    manualPaused,
    oldestQueuedAgeMinutes: oldestAgeMinutes(oldestQueuedMs, nowMs),
    lastProgressAgeMinutes:
      newestProgressMs === null ? null : oldestAgeMinutes(newestProgressMs, nowMs),
  };
}

function emptyHigherPriorityBlockers(): HigherPriorityBlockers {
  return {
    pendingKnowledgeCandidates: 0,
    runningKnowledgeCandidates: 0,
    retryableKnowledgeCandidates: 0,
    manualPausedKnowledgeCandidates: 0,
    pendingWebIngest: 0,
    runningWebIngest: 0,
    retryableWebIngest: 0,
    manualPausedWebIngest: 0,
    pendingWiki: 0,
    runningWiki: 0,
    retryableWiki: 0,
    manualPausedWiki: 0,
  };
}

function accumulateHigherPriorityBlocker(
  blockers: HigherPriorityBlockers,
  row: ScopedStateRow,
  nowMs: number,
): void {
  const blockerGroup = priorityGroupFromRowLike(row);
  if (
    blockerGroup !== "knowledge_candidate" &&
    blockerGroup !== "web_ingest" &&
    blockerGroup !== "wiki"
  ) {
    return;
  }
  const isKnowledge = blockerGroup === "knowledge_candidate";
  const isWebIngest = blockerGroup === "web_ingest";
  const manualPaused = row.status === "paused" && isManualPauseTarget(row);
  const retryablePaused =
    row.status === "paused" &&
    !manualPaused &&
    ((row.nextRetryAt?.getTime() ?? null) === null || (row.nextRetryAt?.getTime() ?? 0) <= nowMs);

  if (row.status === "pending") {
    if (isKnowledge) blockers.pendingKnowledgeCandidates += 1;
    else if (isWebIngest) blockers.pendingWebIngest += 1;
    else blockers.pendingWiki += 1;
    return;
  }
  if (row.status === "running") {
    if (isKnowledge) blockers.runningKnowledgeCandidates += 1;
    else if (isWebIngest) blockers.runningWebIngest += 1;
    else blockers.runningWiki += 1;
    return;
  }
  if (retryablePaused) {
    if (isKnowledge) blockers.retryableKnowledgeCandidates += 1;
    else if (isWebIngest) blockers.retryableWebIngest += 1;
    else blockers.retryableWiki += 1;
    return;
  }
  if (manualPaused) {
    if (isKnowledge) blockers.manualPausedKnowledgeCandidates += 1;
    else if (isWebIngest) blockers.manualPausedWebIngest += 1;
    else blockers.manualPausedWiki += 1;
  }
}

function hasBlockingHigherPriority(blockers: HigherPriorityBlockers): boolean {
  return (
    blockers.pendingKnowledgeCandidates +
      blockers.runningKnowledgeCandidates +
      blockers.retryableKnowledgeCandidates +
      blockers.pendingWebIngest +
      blockers.runningWebIngest +
      blockers.retryableWebIngest +
      blockers.pendingWiki +
      blockers.runningWiki +
      blockers.retryableWiki >
    0
  );
}

async function loadScopedRows(
  distillationVersion: string,
  targetKind?: DistillationTargetKind,
): Promise<ScopedStateRow[]> {
  const db = getDb();
  const conditions = [eq(distillationTargetStates.distillationVersion, distillationVersion)];
  if (targetKind) {
    conditions.push(eq(distillationTargetStates.targetKind, targetKind));
  }
  return db
    .select({
      id: distillationTargetStates.id,
      targetKind: distillationTargetStates.targetKind,
      priorityGroup: distillationTargetStates.priorityGroup,
      status: distillationTargetStates.status,
      createdAt: distillationTargetStates.createdAt,
      lockedAt: distillationTargetStates.lockedAt,
      heartbeatAt: distillationTargetStates.heartbeatAt,
      updatedAt: distillationTargetStates.updatedAt,
      nextRetryAt: distillationTargetStates.nextRetryAt,
      lastError: distillationTargetStates.lastError,
      metadata: distillationTargetStates.metadata,
      completedAt: distillationTargetStates.completedAt,
    })
    .from(distillationTargetStates)
    .where(and(...conditions));
}

async function loadHigherPriorityRows(
  distillationVersion: string,
  targetKind?: DistillationTargetKind,
): Promise<ScopedStateRow[]> {
  if (!targetKind || targetKind === "knowledge_candidate") return [];
  const groups =
    targetKind === "vibe_memory"
      ? (["knowledge_candidate", "web_ingest", "wiki"] as const)
      : targetKind === "wiki_file"
        ? (["knowledge_candidate", "web_ingest"] as const)
        : targetKind === "web_ingest"
          ? (["knowledge_candidate"] as const)
          : (["knowledge_candidate"] as const);
  const db = getDb();
  return db
    .select({
      id: distillationTargetStates.id,
      targetKind: distillationTargetStates.targetKind,
      priorityGroup: distillationTargetStates.priorityGroup,
      status: distillationTargetStates.status,
      createdAt: distillationTargetStates.createdAt,
      lockedAt: distillationTargetStates.lockedAt,
      heartbeatAt: distillationTargetStates.heartbeatAt,
      updatedAt: distillationTargetStates.updatedAt,
      nextRetryAt: distillationTargetStates.nextRetryAt,
      lastError: distillationTargetStates.lastError,
      metadata: distillationTargetStates.metadata,
      completedAt: distillationTargetStates.completedAt,
    })
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, distillationVersion),
        inArray(distillationTargetStates.priorityGroup, [...groups]),
      ),
    );
}

export async function runDistillationRepair(
  input: DistillationRepairInput = {},
): Promise<DistillationRepairReport> {
  const kind = input.kind ?? "auto";
  const targetKind = resolveTargetKind(kind);
  const distillationVersion = input.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const staleSeconds = Math.max(
    1,
    input.staleSeconds ?? APP_CONSTANTS.distillationTargetStaleSeconds,
  );
  const maxAttempts = Math.max(1, input.maxAttempts ?? APP_CONSTANTS.distillationTargetMaxAttempts);
  const limit = Math.min(500, Math.max(1, input.limit ?? 50));
  const mode: DistillationRepairMode = input.apply ? "apply" : "dry-run";
  const now = new Date();
  const nowMs = now.getTime();
  const staleAtMs = nowMs - staleSeconds * 1000;
  const warnings: string[] = [];
  const actions: DistillationRepairAction[] = [];

  const lockState = await readFileLockState(
    groupedConfig.distillation.pipelineLockFile,
    groupedConfig.distillation.pipelineLockStaleSeconds,
  );
  const allRunningRows = await loadScopedRows(distillationVersion, undefined);
  const recentRunningTargets = allRunningRows.filter(
    (row) => row.status === "running" && runningTimestampMs(row) > staleAtMs,
  ).length;
  const scopedRows = targetKind
    ? allRunningRows.filter((row) => row.targetKind === targetKind)
    : allRunningRows;
  const queueStats = queueStatsFromRows(scopedRows, nowMs, staleAtMs);

  const higherPriorityRows = await loadHigherPriorityRows(distillationVersion, targetKind);
  const blockers = emptyHigherPriorityBlockers();
  for (const row of higherPriorityRows) {
    accumulateHigherPriorityBlocker(blockers, row, nowMs);
  }
  const blockedByHigherPriority = hasBlockingHigherPriority(blockers);

  if (lockState.exists && lockState.staleByCreatedAge) {
    if (lockState.processAlive === true) {
      actions.push({
        type: "inspect_live_worker",
        kind: "all",
        safeToApply: false,
        requiresManualReview: true,
        reason: "stale age だが lock owner pid が生存しているため自動削除しません",
        evidence: {
          path: lockState.path,
          pid: lockState.pid,
          ageSeconds: lockState.ageSeconds,
        },
      });
    } else if (recentRunningTargets > 0) {
      actions.push({
        type: "running_target_holds_lock",
        kind: "all",
        safeToApply: false,
        requiresManualReview: true,
        reason: "recent running target が存在するため lock を自動削除しません",
        evidence: {
          path: lockState.path,
          recentRunningTargets,
        },
      });
    } else {
      actions.push({
        type: "remove_stale_file_lock",
        kind: "all",
        safeToApply: true,
        requiresManualReview: false,
        reason: "stale lock かつ pid dead/recent running なしのため削除可能です",
        evidence: {
          path: lockState.path,
          pid: lockState.pid,
          ageSeconds: lockState.ageSeconds,
        },
      });
    }
  }

  if (queueStats.staleRunning > 0) {
    actions.push({
      type: "release_stale_running",
      kind: targetKind ?? "all",
      safeToApply: true,
      requiresManualReview: false,
      reason: "stale running target を pending/skipped へ回復できます",
      evidence: {
        count: queueStats.staleRunning,
        staleSeconds,
        maxAttempts,
        limit,
      },
    });
  }

  if (queueStats.retryablePaused > 0) {
    actions.push({
      type: "release_retryable_paused",
      kind: targetKind ?? "all",
      safeToApply: true,
      requiresManualReview: false,
      reason: "retryable paused target を pending に戻せます",
      evidence: {
        count: queueStats.retryablePaused,
        limit,
      },
    });
  }

  if (queueStats.manualPaused > 0) {
    actions.push({
      type: "manual_paused",
      kind: targetKind ?? "all",
      safeToApply: false,
      requiresManualReview: true,
      reason: "manual paused target は自動変更しません",
      evidence: {
        count: queueStats.manualPaused,
      },
    });
  }

  const runnableQueued = queueStats.queued + queueStats.retryablePaused;
  const queueStoppedThresholdMinutes = groupedConfig.distillation.pipelineLockStaleSeconds / 60;
  const noRecentProgress =
    queueStats.lastProgressAgeMinutes === null ||
    queueStats.lastProgressAgeMinutes > queueStoppedThresholdMinutes;
  const queueStopped =
    runnableQueued > 0 &&
    queueStats.running === 0 &&
    !blockedByHigherPriority &&
    queueStats.oldestQueuedAgeMinutes !== null &&
    queueStats.oldestQueuedAgeMinutes > queueStoppedThresholdMinutes &&
    noRecentProgress;
  if (queueStopped) {
    actions.push({
      type: "queue_stopped",
      kind: targetKind ?? "all",
      safeToApply: false,
      requiresManualReview: true,
      reason: "queue に実行可能 target があるのに worker が処理していません",
      evidence: {
        queued: queueStats.queued,
        retryablePaused: queueStats.retryablePaused,
        oldestQueuedAgeMinutes: queueStats.oldestQueuedAgeMinutes,
        lastProgressAgeMinutes: queueStats.lastProgressAgeMinutes,
      },
    });
  }

  if (blockedByHigherPriority) {
    actions.push({
      type: "blocked_by_higher_priority",
      kind: targetKind ?? "all",
      safeToApply: false,
      requiresManualReview: true,
      reason: "上位 priority queue が残っているため現在の kind は待機状態です",
      evidence: blockers,
    });
  }

  if (queueStats.runningRecent > 0) {
    actions.push({
      type: "running_recent",
      kind: targetKind ?? "all",
      safeToApply: false,
      requiresManualReview: true,
      reason: "recent running target があるため回復処理は保留が妥当です",
      evidence: {
        count: queueStats.runningRecent,
      },
    });
  }

  const report: DistillationRepairReport = {
    mode,
    kind,
    distillationVersion,
    staleSeconds,
    maxAttempts,
    limit,
    actions,
    applied: {
      removedLocks: 0,
      releasedStaleRunning: 0,
      skippedStaleRunning: 0,
      releasedRetryablePaused: 0,
    },
    skipped: {
      manualPaused: queueStats.manualPaused,
      liveLock: actions.some((action) => action.type === "inspect_live_worker") ? 1 : 0,
      recentRunning:
        actions.some((action) => action.type === "running_target_holds_lock") ||
        queueStats.runningRecent > 0
          ? 1
          : 0,
      queueStopped: queueStopped ? 1 : 0,
      blockedByHigherPriority: blockedByHigherPriority ? 1 : 0,
    },
    warnings,
  };

  if (mode !== "apply") return report;

  for (const action of actions) {
    if (!action.safeToApply) continue;
    if (action.type === "remove_stale_file_lock") {
      try {
        await fs.unlink(groupedConfig.distillation.pipelineLockFile);
        report.applied.removedLocks += 1;
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    if (action.type === "release_stale_running") {
      const result = await recoverStaleDistillationTargets({
        distillationVersion,
        staleSeconds,
        maxAttempts,
        targetKind,
        limit,
      });
      report.applied.releasedStaleRunning += result.recoveredToPending;
      report.applied.skippedStaleRunning += result.skipped;
      continue;
    }
    if (action.type === "release_retryable_paused") {
      const released = await releaseRetryablePausedDistillationTargets({
        distillationVersion,
        targetKind,
        limit,
        excludeManualPauseReasons: true,
      });
      report.applied.releasedRetryablePaused += released;
    }
  }

  return report;
}
