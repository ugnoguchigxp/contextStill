import { eq, sql } from "drizzle-orm";
import { groupedConfig } from "../../../config.js";
import { getDb } from "../../../db/index.js";
import { syncStates } from "../../../db/schema.js";
import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import { minutesSince } from "../doctor.utils.js";
import { inspectLaunchAgent } from "../launch-agent.util.js";

type VibeDistillationInspectorOptions = {
  canQueryDb: boolean;
  distillationTableAvailable: boolean;
};

export async function inspectVibeDistillation({
  canQueryDb,
  distillationTableAvailable,
}: VibeDistillationInspectorOptions): Promise<DoctorReport["vibeDistillation"]> {
  const launchAgent = await inspectLaunchAgent("com.memory-router.vibe-distillation");
  const runs: DoctorReport["vibeDistillation"]["runs"] = {
    totalRuns: 0,
    okRuns: 0,
    skippedRuns: 0,
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
        .where(eq(syncStates.id, "vibe_distillation"))
        .limit(1);
      const result = await db.execute(sql`
        with latest as (
          select distinct on (vibe_memory_id)
            status,
            updated_at
          from vibe_memory_distillation_runs
          where prompt_version = ${groupedConfig.vibeDistillation.promptVersion}
          order by vibe_memory_id, updated_at desc, id desc
        )
        select
          count(*)::int as total_runs,
          count(*) filter (where status = 'ok')::int as ok_runs,
          count(*) filter (where status = 'skipped')::int as skipped_runs,
          count(*) filter (where status = 'failed')::int as failed_runs,
          max(updated_at) as last_run_at,
          max(updated_at) filter (where status = 'ok') as last_ok_run_at
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
      "./scripts/setup-distillation-automation.sh install で LaunchAgent を配置する",
    );
  } else if (!launchAgent.loaded) {
    nextActions.push("./scripts/setup-distillation-automation.sh load で LaunchAgent を読み込む");
  }
  if (!runs.lastRunAt) {
    nextActions.push("bun run distill:vibe-memory -- --apply を一度実行して処理経路を確認する");
  }
  if (runs.totalRuns > 0 && !runs.lastOkRunAt) {
    nextActions.push("vibe distillation の成功 run がありません。失敗原因を調査して再実行する");
  }

  return { launchAgent, runs, nextActions };
}
