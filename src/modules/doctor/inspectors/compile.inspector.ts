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

const maintenanceReasonSet = new Set([
  "KNOWLEDGE_APPLIES_TO_FALLBACK",
  "KNOWLEDGE_REPO_SCOPE_FALLBACK",
  "SOURCE_REPO_SCOPE_FALLBACK",
]);

const warningReasonSet = new Set([
  "QUERY_EMBEDDING_UNAVAILABLE",
  "SOURCE_QUERY_EMBEDDING_UNAVAILABLE",
  "TOKEN_BUDGET_SECTION_LIMIT_REACHED",
]);

const usablePackFallbackReasonSet = new Set([
  "AGENTIC_REFINE_FAILED",
  "CONTEXT_RESPONSE_COMPOSE_FAILED",
]);

function isBlockingReason(reason: string, hasUsablePack: boolean): boolean {
  if (maintenanceReasonSet.has(reason)) return false;
  if (warningReasonSet.has(reason)) return false;
  if (usablePackFallbackReasonSet.has(reason) && hasUsablePack) return false;
  if (reason === "NO_ACTIVE_KNOWLEDGE_MATCH") return true;
  if (reason === "NO_SOURCE_MATCH" && hasUsablePack) return false;
  if (reason === "NO_SOURCE_MATCH") return true;
  if (reason.endsWith("_FAILED") || reason.includes("ERROR")) return true;
  return true;
}

function hasBlockingReason(degradedReasons: string[], hasUsablePack: boolean): boolean {
  return degradedReasons.some((reason) => isBlockingReason(reason, hasUsablePack));
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, quantile));
  const position = (sorted.length - 1) * clamped;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? null;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

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
    blockingRuns: 0,
    blockingRate: 0,
    usableRuns: 0,
    usableRate: 0,
    warningOnlyRuns: 0,
    warningOnlyRate: 0,
    noContentRuns: 0,
    noContentRate: 0,
    durationMsP50: null,
    durationMsP95: null,
    durationMsAvg: null,
    durationSamples: [],
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
    let blockingRuns = 0;
    let usableRuns = 0;
    let warningOnlyRuns = 0;
    let noContentRuns = 0;
    for (const run of recentRuns) {
      const degradedReasons = [...new Set(run.degradedReasons)];
      const selectedItemCount = run.selectedItemCount ?? 0;
      const hasUsablePack = selectedItemCount > 0 && run.outputMarkdownKind !== "no-content";
      const blocking = run.status === "failed" || hasBlockingReason(degradedReasons, hasUsablePack);
      if (blocking) {
        blockingRuns += 1;
      } else {
        usableRuns += 1;
      }
      if (!blocking && degradedReasons.length > 0) {
        warningOnlyRuns += 1;
      }
      if (
        degradedReasons.includes("NO_ACTIVE_KNOWLEDGE_MATCH") &&
        degradedReasons.includes("NO_SOURCE_MATCH")
      ) {
        noContentRuns += 1;
      }
    }
    runs.blockingRuns = blockingRuns;
    runs.blockingRate = runs.totalRuns > 0 ? blockingRuns / runs.totalRuns : 0;
    runs.usableRuns = usableRuns;
    runs.usableRate = runs.totalRuns > 0 ? usableRuns / runs.totalRuns : 0;
    runs.warningOnlyRuns = warningOnlyRuns;
    runs.warningOnlyRate = runs.totalRuns > 0 ? warningOnlyRuns / runs.totalRuns : 0;
    runs.noContentRuns = noContentRuns;
    runs.noContentRate = runs.totalRuns > 0 ? noContentRuns / runs.totalRuns : 0;
    runs.durationSamples = [...recentRuns].reverse().map((run, index) => ({
      runId: run.id,
      label: `#${index + 1}`,
      durationMs: run.durationMs,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
    }));
    const durations = recentRuns
      .map((run) => run.durationMs)
      .filter((duration) => Number.isFinite(duration) && duration >= 0);
    runs.durationMsP50 = percentile(durations, 0.5);
    runs.durationMsP95 = percentile(durations, 0.95);
    runs.durationMsAvg = average(durations);
    runs.lastRunAt = recentRuns[0]?.createdAt ? recentRuns[0].createdAt.toISOString() : null;
    runs.lastRunAgeMinutes = runs.lastRunAt ? minutesSince(runs.lastRunAt) : null;
    if (runs.totalRuns === 0) {
      reasons.push("NO_COMPILE_RUN_HISTORY");
    }
    if (runs.lastRunAgeMinutes !== null && runs.lastRunAgeMinutes > freshnessThresholdMinutes) {
      reasons.push("CONTEXT_COMPILE_STALE");
    }
    if ((runs.blockingRate ?? 0) > degradedRateThreshold) {
      reasons.push("DEGRADED_RATE_HIGH");
    }
    if ((runs.usableRate ?? 0) < 1 - degradedRateThreshold) {
      reasons.push("USABLE_PACK_RATE_LOW");
    }
  } catch {
    reasons.push("RUN_HEALTH_QUERY_FAILED");
  }

  return { runs, reasons };
}
