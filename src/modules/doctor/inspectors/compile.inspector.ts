import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import { listRecentCompileRuns } from "../../context-compiler/context-compiler.repository.js";
import { minutesSince } from "../doctor.utils.js";

type CompileInspectorOptions = {
  windowSize: number;
  freshnessThresholdMinutes: number;
  degradedRateThreshold: number;
  compileRunsTableAvailable: boolean;
};

export type CompileRunsInspection = {
  runs: DoctorReport["runs"];
  reasons: string[];
};

export async function inspectCompileRuns({
  windowSize,
  freshnessThresholdMinutes,
  degradedRateThreshold,
  compileRunsTableAvailable,
}: CompileInspectorOptions): Promise<CompileRunsInspection> {
  const reasons: string[] = [];
  const runs: DoctorReport["runs"] = {
    windowSize,
    totalRuns: 0,
    degradedRuns: 0,
    degradedRate: 0,
    lastRunAt: null,
    lastRunAgeMinutes: null,
    freshnessThresholdMinutes,
    degradedRateThreshold,
  };

  if (!compileRunsTableAvailable) {
    reasons.push("RUN_HEALTH_SKIPPED_TABLE_MISSING");
    return { runs, reasons };
  }

  try {
    const recentRuns = await listRecentCompileRuns(windowSize);
    runs.totalRuns = recentRuns.length;
    runs.degradedRuns = recentRuns.filter(
      (run) => run.status === "degraded" || run.status === "failed",
    ).length;
    runs.degradedRate = runs.totalRuns > 0 ? runs.degradedRuns / runs.totalRuns : 0;
    runs.lastRunAt = recentRuns[0]?.createdAt ? recentRuns[0].createdAt.toISOString() : null;
    runs.lastRunAgeMinutes = runs.lastRunAt ? minutesSince(runs.lastRunAt) : null;

    if (runs.totalRuns === 0) {
      reasons.push("NO_COMPILE_RUN_HISTORY");
    }
    if (runs.lastRunAgeMinutes !== null && runs.lastRunAgeMinutes > freshnessThresholdMinutes) {
      reasons.push("CONTEXT_COMPILE_STALE");
    }
    if (runs.degradedRate > degradedRateThreshold) {
      reasons.push("DEGRADED_RATE_HIGH");
    }
  } catch {
    reasons.push("RUN_HEALTH_QUERY_FAILED");
  }

  return { runs, reasons };
}
