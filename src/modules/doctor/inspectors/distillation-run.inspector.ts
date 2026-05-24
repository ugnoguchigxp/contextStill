import { and, eq, inArray, sql } from "drizzle-orm";
import { readFileLockState } from "../../../cli/file-lock.js";
import { groupedConfig } from "../../../config.js";
import { APP_CONSTANTS } from "../../../constants.js";
import { getDb } from "../../../db/index.js";
import { distillationTargetStates } from "../../../db/schema.js";
import { isManualPauseTarget } from "../../selectDistillationTarget/manual-pause.js";
import { priorityGroupFromRowLike } from "../../selectDistillationTarget/priority-group.js";
import type { DoctorDistillationHealth } from "../../../shared/schemas/doctor.schema.js";
import { isPipelineLockLikelyBlocking } from "../distillation-lock.util.js";
import { minutesSince, normalizeReasonCounts } from "../doctor.utils.js";
import { inspectLaunchAgent } from "../launch-agent.util.js";

export type DistillationRunInspectorOptions = {
  canQueryDb: boolean;
};

type DistillationHealthReport = DoctorDistillationHealth;
type DistillationRuns = DistillationHealthReport["runs"];
type DistillationJobs = DistillationHealthReport["jobs"];
type DistillationQueueHealth = DistillationHealthReport["queueHealth"];

export type DistillationRunInspectorConfig = {
  label: string;
  launchAgentLabel: string;
  setupScript: string;
  runCommand: string;
  logPath: string;
  targetKind: "wiki_file" | "vibe_memory";
};

type DistillationRunsRow =
  | {
      total_runs?: number;
      ok_runs?: number;
      skipped_runs?: number;
      failed_runs?: number;
      last_run_at?: Date | string | null;
      last_ok_run_at?: Date | string | null;
      skipped_run_reasons?: unknown;
      outcome_kind_counts?: unknown;
    }
  | undefined;

type QueueHealthRow =
  | Pick<
      typeof distillationTargetStates.$inferSelect,
      | "status"
      | "targetKind"
      | "createdAt"
      | "lockedAt"
      | "heartbeatAt"
      | "updatedAt"
      | "nextRetryAt"
      | "lastError"
      | "priorityGroup"
      | "metadata"
    >
  | undefined;

type DistillationQueueBlockers = NonNullable<DistillationQueueHealth["blockers"]>;

function emptyRuns(): DistillationRuns {
  return {
    totalRuns: 0,
    okRuns: 0,
    skippedRuns: 0,
    outcomeKindCounts: [],
    skippedRunReasons: [],
    failedRuns: 0,
    lastRunAt: null,
    lastRunAgeMinutes: null,
    lastOkRunAt: null,
    lastOkRunAgeMinutes: null,
  };
}

function emptyJobs(): DistillationJobs {
  return {
    queued: 0,
    running: 0,
    paused: 0,
    failed: 0,
    lastPausedAt: null,
    lastError: null,
  };
}

function emptyQueueHealth(): DistillationQueueHealth {
  return {
    queued: 0,
    running: 0,
    retryablePaused: 0,
    staleRunning: 0,
    blockedByHigherPriority: false,
    blockers: {
      pendingKnowledgeCandidates: 0,
      runningKnowledgeCandidates: 0,
      staleRunningKnowledgeCandidates: 0,
      retryableKnowledgeCandidates: 0,
      manualPausedKnowledgeCandidates: 0,
      pendingWiki: 0,
      runningWiki: 0,
      staleRunningWiki: 0,
      retryableWiki: 0,
      manualPausedWiki: 0,
    },
    oldestQueuedAt: null,
    oldestQueuedAgeMinutes: null,
    oldestRunningAt: null,
    oldestRunningAgeMinutes: null,
    lock: {
      path: groupedConfig.distillation.pipelineLockFile,
      exists: false,
      pid: null,
      createdAt: null,
      ageSeconds: null,
      staleByCreatedAge: false,
    },
  };
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  return value ? new Date(value).toISOString() : null;
}

function timestampMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function minTimestamp(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return Math.min(current, candidate);
}

function applyRunRow(runs: DistillationRuns, row: DistillationRunsRow) {
  const lastRunAt = toIsoString(row?.last_run_at);
  const lastOkRunAt = toIsoString(row?.last_ok_run_at);
  runs.totalRuns = Number(row?.total_runs ?? 0);
  runs.okRuns = Number(row?.ok_runs ?? 0);
  runs.skippedRuns = Number(row?.skipped_runs ?? 0);
  runs.outcomeKindCounts = normalizeReasonCounts(row?.outcome_kind_counts);
  runs.skippedRunReasons = normalizeReasonCounts(row?.skipped_run_reasons);
  runs.failedRuns = Number(row?.failed_runs ?? 0);
  runs.lastRunAt = lastRunAt;
  runs.lastRunAgeMinutes = runs.lastRunAt ? minutesSince(runs.lastRunAt) : null;
  runs.lastOkRunAt = lastOkRunAt;
  runs.lastOkRunAgeMinutes = runs.lastOkRunAt ? minutesSince(runs.lastOkRunAt) : null;
}

async function loadDomainDistillationRuns(
  targetKind: "wiki_file" | "vibe_memory",
): Promise<DistillationRunsRow> {
  const db = getDb();
  const result = await db.execute(sql`
    with latest as (
      select
        status,
        last_outcome_kind,
        coalesce(completed_at, updated_at) as ended_at
      from distillation_target_states
      where distillation_version = ${APP_CONSTANTS.distillationTargetVersion}
        and target_kind = ${targetKind}
        and status in ('completed', 'skipped', 'failed')
    ),
    normalized as (
      select
        status,
        case
          when status = 'completed' and coalesce(last_outcome_kind, '') like 'knowledge_finalized%'
            then 'knowledge_created'
          when status = 'completed' then coalesce(last_outcome_kind, 'knowledge_created')
          when status = 'failed' and coalesce(last_outcome_kind, '') = 'finalize_failed'
            then 'processing_error'
          when status = 'failed' then coalesce(last_outcome_kind, 'processing_error')
          when status = 'skipped' and coalesce(last_outcome_kind, '') in ('no_candidate', 'missing_source')
            then 'no_candidate'
          when status = 'skipped' and coalesce(last_outcome_kind, '') = 'all_rejected'
            then 'candidate_rejected'
          when status = 'skipped' then coalesce(last_outcome_kind, 'candidate_rejected')
          else status
        end as reason,
        ended_at
      from latest
    ),
    skipped_reason_counts as (
      select
        reason,
        count(*)::int as run_count
      from normalized
      where status = 'skipped'
      group by reason
    ),
    outcome_kind_counts as (
      select
        reason,
        count(*)::int as run_count
      from normalized
      group by reason
    )
    select
      count(*)::int as total_runs,
      count(*) filter (where status = 'completed')::int as ok_runs,
      count(*) filter (where status = 'skipped')::int as skipped_runs,
      count(*) filter (where status = 'failed')::int as failed_runs,
      max(ended_at) as last_run_at,
      max(ended_at) filter (where status = 'completed') as last_ok_run_at,
      coalesce((
        select jsonb_agg(
          jsonb_build_object('reason', reason, 'count', run_count)
          order by reason
        )
        from skipped_reason_counts
      ), '[]'::jsonb) as skipped_run_reasons,
      coalesce((
        select jsonb_agg(
          jsonb_build_object('reason', reason, 'count', run_count)
          order by reason
        )
        from outcome_kind_counts
      ), '[]'::jsonb) as outcome_kind_counts
    from normalized
  `);
  return result.rows[0] as DistillationRunsRow;
}

async function loadDomainDistillationJobs(
  targetKind: "wiki_file" | "vibe_memory",
): Promise<DistillationJobs> {
  const db = getDb();
  const result = await db.execute(sql`
    select
      count(*) filter (where status = 'pending')::int as queued,
      count(*) filter (where status = 'running')::int as running,
      count(*) filter (where status = 'paused')::int as paused,
      count(*) filter (where status = 'failed')::int as failed,
      max(updated_at) filter (where status = 'paused') as last_paused_at,
      (array_agg(last_error order by updated_at desc) filter (where last_error is not null))[1] as last_error
    from distillation_target_states
    where distillation_version = ${APP_CONSTANTS.distillationTargetVersion}
      and target_kind = ${targetKind}
  `);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    queued: Number(row.queued ?? 0),
    running: Number(row.running ?? 0),
    paused: Number(row.paused ?? 0),
    failed: Number(row.failed ?? 0),
    lastPausedAt: toIsoString(row.last_paused_at as Date | string | null | undefined),
    lastError: typeof row.last_error === "string" ? row.last_error : null,
  };
}

function emptyQueueBlockers(): DistillationQueueBlockers {
  return {
    pendingKnowledgeCandidates: 0,
    runningKnowledgeCandidates: 0,
    staleRunningKnowledgeCandidates: 0,
    retryableKnowledgeCandidates: 0,
    manualPausedKnowledgeCandidates: 0,
    pendingWiki: 0,
    runningWiki: 0,
    staleRunningWiki: 0,
    retryableWiki: 0,
    manualPausedWiki: 0,
  };
}

function accumulateBlocker(
  blockers: DistillationQueueBlockers,
  blockerGroup: "knowledge_candidate" | "wiki",
  status: string,
  row: QueueHealthRow,
  nowMs: number,
  staleAtMs: number,
): void {
  if (!row) return;
  const isKnowledge = blockerGroup === "knowledge_candidate";
  const runningMs =
    timestampMs(row.heartbeatAt) ?? timestampMs(row.lockedAt) ?? timestampMs(row.updatedAt);
  const staleRunning = (runningMs ?? Number.NEGATIVE_INFINITY) <= staleAtMs;
  const manualPaused = status === "paused" && isManualPauseTarget(row);
  const nextRetryMs = timestampMs(row.nextRetryAt);
  const retryablePaused =
    status === "paused" && !manualPaused && (nextRetryMs === null || nextRetryMs <= nowMs);

  if (status === "pending") {
    if (isKnowledge) blockers.pendingKnowledgeCandidates += 1;
    else blockers.pendingWiki += 1;
  } else if (status === "running") {
    if (isKnowledge) {
      blockers.runningKnowledgeCandidates += 1;
      if (staleRunning) blockers.staleRunningKnowledgeCandidates += 1;
    } else {
      blockers.runningWiki += 1;
      if (staleRunning) blockers.staleRunningWiki += 1;
    }
  } else if (retryablePaused) {
    if (isKnowledge) blockers.retryableKnowledgeCandidates += 1;
    else blockers.retryableWiki += 1;
  } else if (manualPaused) {
    if (isKnowledge) blockers.manualPausedKnowledgeCandidates += 1;
    else blockers.manualPausedWiki += 1;
  }
}

async function loadDomainQueueHealth(
  targetKind: "wiki_file" | "vibe_memory",
): Promise<Omit<DistillationQueueHealth, "lock">> {
  const db = getDb();
  const nowMs = Date.now();
  const staleAtMs = nowMs - APP_CONSTANTS.distillationTargetStaleSeconds * 1000;
  const rows = await db
    .select({
      status: distillationTargetStates.status,
      targetKind: distillationTargetStates.targetKind,
      priorityGroup: distillationTargetStates.priorityGroup,
      createdAt: distillationTargetStates.createdAt,
      lockedAt: distillationTargetStates.lockedAt,
      heartbeatAt: distillationTargetStates.heartbeatAt,
      updatedAt: distillationTargetStates.updatedAt,
      nextRetryAt: distillationTargetStates.nextRetryAt,
      lastError: distillationTargetStates.lastError,
      metadata: distillationTargetStates.metadata,
    })
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, APP_CONSTANTS.distillationTargetVersion),
        eq(distillationTargetStates.targetKind, targetKind),
      ),
    );
  let queued = 0;
  let running = 0;
  let retryablePaused = 0;
  let staleRunning = 0;
  let blockedByHigherPriority = false;
  let blockers = emptyQueueBlockers();
  let oldestQueuedMs: number | null = null;
  let oldestRunningMs: number | null = null;

  for (const row of rows) {
    if (!row) continue;
    const status = typeof row.status === "string" ? row.status : "";
    const createdMs = timestampMs(row.createdAt);
    const nextRetryMs = timestampMs(row.nextRetryAt);
    const manualPaused = status === "paused" && isManualPauseTarget(row);
    if (status === "pending") {
      queued += 1;
      oldestQueuedMs = minTimestamp(oldestQueuedMs, createdMs);
    } else if (
      status === "paused" &&
      !manualPaused &&
      (nextRetryMs === null || nextRetryMs <= nowMs)
    ) {
      retryablePaused += 1;
      oldestQueuedMs = minTimestamp(oldestQueuedMs, createdMs);
    } else if (status === "running") {
      running += 1;
      const runningMs =
        timestampMs(row.heartbeatAt) ?? timestampMs(row.lockedAt) ?? timestampMs(row.updatedAt);
      oldestRunningMs = minTimestamp(oldestRunningMs, runningMs);
      if ((runningMs ?? Number.NEGATIVE_INFINITY) <= staleAtMs) {
        staleRunning += 1;
      }
    }
  }

  const higherPriorityKinds =
    targetKind === "vibe_memory"
      ? (["knowledge_candidate", "web_ingest", "wiki"] as const)
      : targetKind === "wiki_file"
        ? (["knowledge_candidate", "web_ingest"] as const)
        : ([] as const);

  if (higherPriorityKinds.length > 0) {
    const extraBlockers = await db
      .select({
        status: distillationTargetStates.status,
        targetKind: distillationTargetStates.targetKind,
        priorityGroup: distillationTargetStates.priorityGroup,
        createdAt: distillationTargetStates.createdAt,
        heartbeatAt: distillationTargetStates.heartbeatAt,
        lockedAt: distillationTargetStates.lockedAt,
        updatedAt: distillationTargetStates.updatedAt,
        nextRetryAt: distillationTargetStates.nextRetryAt,
        lastError: distillationTargetStates.lastError,
        metadata: distillationTargetStates.metadata,
      })
      .from(distillationTargetStates)
      .where(
        and(
          eq(distillationTargetStates.distillationVersion, APP_CONSTANTS.distillationTargetVersion),
          inArray(distillationTargetStates.priorityGroup, [...higherPriorityKinds]),
        ),
      );

    blockers = emptyQueueBlockers();
    for (const row of extraBlockers) {
      if (!row) continue;
      const blockerGroup = priorityGroupFromRowLike(row);
      const normalizedBlockerGroup = blockerGroup === "web_ingest" ? "wiki" : blockerGroup;
      if (normalizedBlockerGroup !== "knowledge_candidate" && normalizedBlockerGroup !== "wiki") {
        continue;
      }
      accumulateBlocker(blockers, normalizedBlockerGroup, row.status ?? "", row, nowMs, staleAtMs);
    }
    blockedByHigherPriority =
      blockers.pendingKnowledgeCandidates +
        blockers.runningKnowledgeCandidates +
        blockers.retryableKnowledgeCandidates +
        blockers.pendingWiki +
        blockers.runningWiki +
        blockers.retryableWiki >
      0;
  }

  const oldestQueuedAt = oldestQueuedMs === null ? null : new Date(oldestQueuedMs).toISOString();
  const oldestRunningAt = oldestRunningMs === null ? null : new Date(oldestRunningMs).toISOString();
  return {
    queued,
    running,
    retryablePaused,
    staleRunning,
    blockedByHigherPriority,
    blockers,
    oldestQueuedAt,
    oldestQueuedAgeMinutes: oldestQueuedAt ? minutesSince(oldestQueuedAt) : null,
    oldestRunningAt,
    oldestRunningAgeMinutes: oldestRunningAt ? minutesSince(oldestRunningAt) : null,
  };
}

async function inspectPipelineLock(): Promise<DistillationQueueHealth["lock"]> {
  const lockState = await readFileLockState(
    groupedConfig.distillation.pipelineLockFile,
    groupedConfig.distillation.pipelineLockStaleSeconds,
  );
  return {
    path: lockState.path,
    exists: lockState.exists,
    pid: lockState.pid,
    createdAt: lockState.createdAt,
    ageSeconds: lockState.ageSeconds,
    staleByCreatedAge: lockState.staleByCreatedAge,
  };
}

function nextActionsForDistillation(
  config: DistillationRunInspectorConfig,
  launchAgent: DistillationHealthReport["launchAgent"],
  runs: DistillationRuns,
  jobs: DistillationJobs,
  queueHealth: DistillationQueueHealth,
): string[] {
  const nextActions: string[] = [];
  const kindArg = config.targetKind === "vibe_memory" ? "vibe" : "wiki";
  const repairDryRunCommand = `bun run distill:repair -- --kind ${kindArg} --json`;
  const repairApplyCommand = `bun run distill:repair -- --kind ${kindArg} --apply --limit 50 --json`;
  const lockLikelyBlocking = isPipelineLockLikelyBlocking({
    staleByCreatedAge: queueHealth.lock.staleByCreatedAge,
    launchAgentLoaded: launchAgent.loaded,
    staleRunning: queueHealth.staleRunning,
    running: queueHealth.running,
    runnableQueued: queueHealth.queued + queueHealth.retryablePaused,
    blockedByHigherPriority: queueHealth.blockedByHigherPriority,
  });
  if (!launchAgent.installed) {
    nextActions.push(`${config.setupScript} install で LaunchAgent を配置する`);
  } else if (!launchAgent.loaded) {
    nextActions.push(`${config.setupScript} load で LaunchAgent を読み込む`);
  }
  if (!runs.lastRunAt) {
    nextActions.push(`${config.runCommand} を一度実行して処理経路を確認する`);
  }
  if (runs.totalRuns > 0 && !runs.lastOkRunAt) {
    nextActions.push(`${config.label} の成功 run がありません。失敗原因を調査して再実行する`);
  }
  if (
    runs.lastOkRunAgeMinutes !== null &&
    runs.lastOkRunAgeMinutes > groupedConfig.doctor.freshnessThresholdMinutes
  ) {
    nextActions.push(
      `${config.label} の最新成功 run が古いです。直近の skipped/failed 理由を確認する`,
    );
  }
  if (
    runs.failedRuns > 0 &&
    runs.lastRunAt &&
    runs.lastOkRunAt &&
    new Date(runs.lastRunAt).getTime() > new Date(runs.lastOkRunAt).getTime()
  ) {
    nextActions.push(`${config.label} の直近 run に失敗があります。${config.logPath} を確認する`);
  }
  if (jobs.paused > 0) {
    nextActions.push(
      `${config.label} は paused job があります。LLM provider と draft backlog を確認する`,
    );
  }
  if (jobs.running > 0) {
    nextActions.push(
      `${config.label} は running job があります。完了しない場合は lock と worker log を確認する`,
    );
  }
  if (queueHealth.staleRunning > 0) {
    nextActions.push(
      `${config.label} は stale running job があります。${repairDryRunCommand} で対象を確認し、必要なら ${repairApplyCommand} を実行する`,
    );
  }
  if (lockLikelyBlocking) {
    nextActions.push(
      `${config.label} の pipeline lock が古いです。${repairDryRunCommand} で lock 判定を確認する`,
    );
  }
  if (
    queueHealth.queued > 0 &&
    queueHealth.running === 0 &&
    !queueHealth.blockedByHigherPriority &&
    queueHealth.oldestQueuedAgeMinutes !== null &&
    queueHealth.oldestQueuedAgeMinutes > groupedConfig.distillation.pipelineLockStaleSeconds / 60
  ) {
    nextActions.push(
      `${config.label} のqueueが進んでいません。${repairDryRunCommand} で queue 状態を確認し、LaunchAgent と ${config.logPath} を確認する`,
    );
  }
  if (queueHealth.blockedByHigherPriority && queueHealth.blockers) {
    const blockerSummary = `candidate pending=${queueHealth.blockers.pendingKnowledgeCandidates}, running=${queueHealth.blockers.runningKnowledgeCandidates}, retryable=${queueHealth.blockers.retryableKnowledgeCandidates}; wiki pending=${queueHealth.blockers.pendingWiki}, running=${queueHealth.blockers.runningWiki}, retryable=${queueHealth.blockers.retryableWiki}`;
    nextActions.push(
      `${config.label} は上位priorityにより待機中です（${blockerSummary}）。${repairDryRunCommand} で再確認する`,
    );
  }
  return nextActions;
}

export async function inspectDistillationRunHealth(
  options: DistillationRunInspectorOptions,
  config: DistillationRunInspectorConfig,
): Promise<DistillationHealthReport> {
  const launchAgent = await inspectLaunchAgent(config.launchAgentLabel);
  const runs = emptyRuns();
  let jobs = emptyJobs();
  let queueHealth = emptyQueueHealth();

  if (options.canQueryDb) {
    try {
      const row = await loadDomainDistillationRuns(config.targetKind);
      applyRunRow(runs, row);
    } catch {
      // Keep doctor resilient. Query failures are surfaced by caller-level DB checks.
    }
    try {
      jobs = await loadDomainDistillationJobs(config.targetKind);
    } catch {
      jobs = emptyJobs();
    }
    try {
      queueHealth = {
        ...(await loadDomainQueueHealth(config.targetKind)),
        lock: await inspectPipelineLock(),
      };
    } catch {
      queueHealth = emptyQueueHealth();
    }
  } else {
    queueHealth = {
      ...queueHealth,
      lock: await inspectPipelineLock(),
    };
  }

  return {
    launchAgent,
    runs,
    jobs,
    queueHealth,
    nextActions: nextActionsForDistillation(config, launchAgent, runs, jobs, queueHealth),
  };
}
