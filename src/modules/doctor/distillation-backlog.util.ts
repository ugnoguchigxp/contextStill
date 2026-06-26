import type { DoctorReport } from "../../shared/schemas/doctor.schema.js";

const failedBacklogWarningCount = 50;
const failedBacklogCriticalCount = 200;
const failedBacklogWarningRate = 0.05;
const failedBacklogCriticalRate = 0.1;
const failedBacklogWarningLast24h = 5;
const failedBacklogWarningLast7d = 10;
const failedBacklogCriticalLast24h = 20;
const failedBacklogCriticalLast7d = 50;

export type DistillationFailedBacklogLevel = "high" | "critical";

export type DistillationFailedBacklogStats = {
  failed: number;
  totalJobs: number | null;
  failedRate: number | null;
  failedLast24h: number;
  failedLast7d: number;
};

export function getDistillationFailedBacklogStats(
  distillation: DoctorReport["vibeDistillation"],
): DistillationFailedBacklogStats {
  const failed = distillation.jobs.failed;
  const explicitTotal = distillation.jobs.total;
  const inputTotal =
    distillation.inputSources.fragments > 0
      ? distillation.inputSources.fragments
      : distillation.inputSources.sources;
  const totalJobs =
    typeof explicitTotal === "number" && explicitTotal > 0
      ? explicitTotal
      : inputTotal > 0
        ? inputTotal
        : failed > 0 &&
            distillation.jobs.failedLast24h === undefined &&
            distillation.jobs.failedLast7d === undefined
          ? failed
          : null;
  const failedRate = totalJobs && totalJobs > 0 ? failed / totalJobs : null;

  return {
    failed,
    totalJobs,
    failedRate,
    failedLast24h: distillation.jobs.failedLast24h ?? 0,
    failedLast7d: distillation.jobs.failedLast7d ?? 0,
  };
}

export function getDistillationFailedBacklogLevel(
  distillation: DoctorReport["vibeDistillation"],
): DistillationFailedBacklogLevel | null {
  const stats = getDistillationFailedBacklogStats(distillation);
  const rate = stats.failedRate ?? 0;

  if (
    stats.failed >= failedBacklogCriticalCount &&
    (rate >= failedBacklogCriticalRate ||
      stats.failedLast24h >= failedBacklogCriticalLast24h ||
      stats.failedLast7d >= failedBacklogCriticalLast7d)
  ) {
    return "critical";
  }

  if (
    stats.failed >= failedBacklogWarningCount &&
    (rate >= failedBacklogWarningRate ||
      stats.failedLast24h >= failedBacklogWarningLast24h ||
      stats.failedLast7d >= failedBacklogWarningLast7d)
  ) {
    return "high";
  }

  return null;
}
