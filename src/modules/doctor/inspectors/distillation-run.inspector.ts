import { eq, sql } from "drizzle-orm";
import { groupedConfig } from "../../../config.js";
import { getDb } from "../../../db/index.js";
import { syncStates } from "../../../db/schema.js";
import type { DoctorDistillationHealth } from "../../../shared/schemas/doctor.schema.js";
import { minutesSince, normalizeReasonCounts } from "../doctor.utils.js";
import { inspectLaunchAgent } from "../launch-agent.util.js";

export type DistillationRunInspectorOptions = {
  canQueryDb: boolean;
  distillationTableAvailable: boolean;
};

type DistillationHealthReport = DoctorDistillationHealth;
type DistillationRuns = DistillationHealthReport["runs"];

export type DistillationRunInspectorConfig = {
  label: string;
  launchAgentLabel: string;
  syncStateId: string;
  runTableName: string;
  subjectColumnName: string;
  promptVersion: string;
  setupScript: string;
  runCommand: string;
  logPath: string;
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

function toIsoString(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  return value ? new Date(value).toISOString() : null;
}

function applyRunRow(runs: DistillationRuns, row: DistillationRunsRow, stateLastSyncedAt?: Date) {
  const lastRunAt = toIsoString(row?.last_run_at);
  const lastOkRunAt = toIsoString(row?.last_ok_run_at);
  runs.totalRuns = Number(row?.total_runs ?? 0);
  runs.okRuns = Number(row?.ok_runs ?? 0);
  runs.skippedRuns = Number(row?.skipped_runs ?? 0);
  runs.outcomeKindCounts = normalizeReasonCounts(row?.outcome_kind_counts);
  runs.skippedRunReasons = normalizeReasonCounts(row?.skipped_run_reasons);
  runs.failedRuns = Number(row?.failed_runs ?? 0);
  runs.lastRunAt = stateLastSyncedAt?.toISOString() ?? lastRunAt;
  runs.lastRunAgeMinutes = runs.lastRunAt ? minutesSince(runs.lastRunAt) : null;
  runs.lastOkRunAt = lastOkRunAt;
  runs.lastOkRunAgeMinutes = runs.lastOkRunAt ? minutesSince(runs.lastOkRunAt) : null;
}

async function loadDistillationRuns(config: DistillationRunInspectorConfig): Promise<{
  row: DistillationRunsRow;
  stateLastSyncedAt?: Date;
}> {
  const db = getDb();
  const [state] = await db
    .select()
    .from(syncStates)
    .where(eq(syncStates.id, config.syncStateId))
    .limit(1);
  const result = await db.execute(sql`
    with latest as (
      select distinct on (${sql.raw(config.subjectColumnName)})
        status,
        metadata,
        updated_at
      from ${sql.raw(config.runTableName)}
      where prompt_version = ${config.promptVersion}
      order by ${sql.raw(config.subjectColumnName)}, updated_at desc, id desc
    ),
    skipped_reason_counts as (
      select
        coalesce(metadata->>'reason', 'unknown') as reason,
        count(*)::int as run_count
      from latest
      where status = 'skipped'
      group by reason
    ),
    outcome_kind_counts as (
      select
        coalesce(
          metadata->>'outcomeKind',
          case
            when status = 'ok'
              and coalesce((metadata->>'acceptedCandidateCount')::int, 0) > 0
              and coalesce((metadata->>'dedupSkippedCount')::int, 0) >= coalesce((metadata->>'acceptedCandidateCount')::int, 0)
              then 'knowledge_deduped'
            when status = 'ok' then 'knowledge_created'
            when status = 'failed' and metadata->>'failureKind' = 'parse_or_repair'
              then 'llm_unparseable'
            when status = 'failed' and metadata->>'failureKind' = 'llm_call'
              then 'llm_provider_error'
            when status = 'failed' then 'processing_error'
            when status = 'skipped'
              and coalesce((metadata->>'extractionCandidateCount')::int, 0) = 0
              then 'no_candidate'
            when status = 'skipped'
              and coalesce((metadata->>'rawCandidateCount')::int, 0) = 0
              then 'verification_no_candidate'
            when status = 'skipped'
              and coalesce((metadata->>'failedCandidateCount')::int, 0) > 0
              and coalesce((metadata->>'rejectedInvalidEvidenceCount')::int, 0) > 0
              and coalesce((metadata->>'rejectedLowScoreCount')::int, 0) = 0
              and coalesce((metadata->>'rejectedLowQualityCount')::int, 0) = 0
              then 'missing_verification_tool_evidence'
            when status = 'skipped'
              and coalesce((metadata->>'rejectedInvalidEvidenceCount')::int, 0) > 0
              and coalesce((metadata->>'rejectedLowScoreCount')::int, 0) = 0
              and coalesce((metadata->>'rejectedLowQualityCount')::int, 0) = 0
              then 'missing_external_evidence'
            when status = 'skipped'
              and coalesce((metadata->>'rejectedLowQualityCount')::int, 0) > 0
              and coalesce((metadata->>'rejectedLowScoreCount')::int, 0) = 0
              and coalesce((metadata->>'rejectedInvalidEvidenceCount')::int, 0) = 0
              then 'invalid_candidate'
            when status = 'skipped'
              and coalesce((metadata->>'rejectedLowScoreCount')::int, 0) > 0
              and coalesce((metadata->>'rejectedLowQualityCount')::int, 0) = 0
              and coalesce((metadata->>'rejectedInvalidEvidenceCount')::int, 0) = 0
              then 'below_quality_threshold'
            when status = 'skipped'
              and (
                coalesce((metadata->>'rejectedLowScoreCount')::int, 0) > 0
                or coalesce((metadata->>'rejectedLowQualityCount')::int, 0) > 0
                or coalesce((metadata->>'rejectedInvalidEvidenceCount')::int, 0) > 0
                or coalesce((metadata->>'failedCandidateCount')::int, 0) > 0
              )
              then 'mixed_candidate_rejections'
            when status = 'skipped' then 'candidate_rejected'
            else status
          end
        ) as reason,
        count(*)::int as run_count
      from latest
      group by reason
    )
    select
      count(*)::int as total_runs,
      count(*) filter (where status = 'ok')::int as ok_runs,
      count(*) filter (where status = 'skipped')::int as skipped_runs,
      count(*) filter (where status = 'failed')::int as failed_runs,
      max(updated_at) as last_run_at,
      max(updated_at) filter (where status = 'ok') as last_ok_run_at,
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
    from latest
  `);

  return {
    row: result.rows[0] as DistillationRunsRow,
    stateLastSyncedAt: state?.lastSyncedAt ?? undefined,
  };
}

function nextActionsForDistillation(
  config: DistillationRunInspectorConfig,
  launchAgent: DistillationHealthReport["launchAgent"],
  runs: DistillationRuns,
): string[] {
  const nextActions: string[] = [];
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
  return nextActions;
}

export async function inspectDistillationRunHealth(
  options: DistillationRunInspectorOptions,
  config: DistillationRunInspectorConfig,
): Promise<DistillationHealthReport> {
  const launchAgent = await inspectLaunchAgent(config.launchAgentLabel);
  const runs = emptyRuns();

  if (options.canQueryDb && options.distillationTableAvailable) {
    try {
      const { row, stateLastSyncedAt } = await loadDistillationRuns(config);
      applyRunRow(runs, row, stateLastSyncedAt);
    } catch {
      // Keep doctor resilient. Table/query failures are surfaced by the caller.
    }
  }

  return {
    launchAgent,
    runs,
    nextActions: nextActionsForDistillation(config, launchAgent, runs),
  };
}
