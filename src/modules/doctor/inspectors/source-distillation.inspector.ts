import { eq, sql } from "drizzle-orm";
import { groupedConfig } from "../../../config.js";
import { getDb } from "../../../db/index.js";
import { syncStates } from "../../../db/schema.js";
import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import { minutesSince, normalizeReasonCounts } from "../doctor.utils.js";
import { inspectLaunchAgent } from "../launch-agent.util.js";

type SourceDistillationInspectorOptions = {
  canQueryDb: boolean;
  distillationTableAvailable: boolean;
};

export async function inspectSourceDistillation({
  canQueryDb,
  distillationTableAvailable,
}: SourceDistillationInspectorOptions): Promise<DoctorReport["sourceDistillation"]> {
  const launchAgent = await inspectLaunchAgent("com.memory-router.source-distillation");
  const runs: DoctorReport["sourceDistillation"]["runs"] = {
    totalRuns: 0,
    okRuns: 0,
    skippedRuns: 0,
    skippedRunReasons: [],
    failedRuns: 0,
    lastRunAt: null,
    lastRunAgeMinutes: null,
    lastOkRunAt: null,
    lastOkRunAgeMinutes: null,
  };

  if (canQueryDb && distillationTableAvailable) {
    try {
      const db = getDb();
      const [state] = await db
        .select()
        .from(syncStates)
        .where(eq(syncStates.id, "source_distillation"))
        .limit(1);
      const result = await db.execute(sql`
        with latest as (
          select distinct on (source_fragment_id)
            status,
            metadata,
            updated_at
          from source_distillation_runs
          where prompt_version = ${groupedConfig.sourceDistillation.promptVersion}
          order by source_fragment_id, updated_at desc, id desc
        ),
        skipped_reason_counts as (
          select
            coalesce(metadata->>'reason', 'unknown') as reason,
            count(*)::int as run_count
          from latest
          where status = 'skipped'
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
          ), '[]'::jsonb) as skipped_run_reasons
        from latest
      `);
      const row = result.rows[0] as
        | {
            total_runs?: number;
            ok_runs?: number;
            skipped_runs?: number;
            failed_runs?: number;
            last_run_at?: Date | string | null;
            last_ok_run_at?: Date | string | null;
            skipped_run_reasons?: unknown;
          }
        | undefined;
      const lastRunAt =
        row?.last_run_at instanceof Date
          ? row.last_run_at.toISOString()
          : row?.last_run_at
            ? new Date(row.last_run_at).toISOString()
            : null;
      const lastOkRunAt =
        row?.last_ok_run_at instanceof Date
          ? row.last_ok_run_at.toISOString()
          : row?.last_ok_run_at
            ? new Date(row.last_ok_run_at).toISOString()
            : null;
      runs.totalRuns = Number(row?.total_runs ?? 0);
      runs.okRuns = Number(row?.ok_runs ?? 0);
      runs.skippedRuns = Number(row?.skipped_runs ?? 0);
      runs.skippedRunReasons = normalizeReasonCounts(row?.skipped_run_reasons);
      runs.failedRuns = Number(row?.failed_runs ?? 0);
      runs.lastRunAt = state?.lastSyncedAt?.toISOString() ?? lastRunAt;
      runs.lastRunAgeMinutes = runs.lastRunAt ? minutesSince(runs.lastRunAt) : null;
      runs.lastOkRunAt = lastOkRunAt;
      runs.lastOkRunAgeMinutes = runs.lastOkRunAt ? minutesSince(runs.lastOkRunAt) : null;
    } catch {
      // Keep doctor resilient. Table/query failures are surfaced by the caller.
    }
  }

  const nextActions: string[] = [];
  if (!launchAgent.installed) {
    nextActions.push(
      "./scripts/setup-source-distillation-automation.sh install で LaunchAgent を配置する",
    );
  } else if (!launchAgent.loaded) {
    nextActions.push(
      "./scripts/setup-source-distillation-automation.sh load で LaunchAgent を読み込む",
    );
  }
  if (!runs.lastRunAt) {
    nextActions.push("bun run distill:sources -- --apply を一度実行して処理経路を確認する");
  }
  if (runs.totalRuns > 0 && !runs.lastOkRunAt) {
    nextActions.push("source distillation の成功 run がありません。失敗原因を調査して再実行する");
  }
  if (
    runs.lastOkRunAgeMinutes !== null &&
    runs.lastOkRunAgeMinutes > groupedConfig.doctor.freshnessThresholdMinutes
  ) {
    nextActions.push(
      "source distillation の最新成功 run が古いです。直近の skipped/failed 理由を確認する",
    );
  }
  if (
    runs.failedRuns > 0 &&
    runs.lastRunAt &&
    runs.lastOkRunAt &&
    new Date(runs.lastRunAt).getTime() > new Date(runs.lastOkRunAt).getTime()
  ) {
    nextActions.push(
      "source distillation の直近 run に失敗があります。logs/source-distillation.log を確認する",
    );
  }

  return { launchAgent, runs, nextActions };
}
