import {
  type LandscapeTrajectoryResult,
  landscapeTrajectoryResultSchema,
} from "../../shared/schemas/landscape-trajectory.schema.js";
import { loadLandscapeTrajectory } from "./landscape-trajectory.repository.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNullableInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.trunc(parsed));
}

function asNullableBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeRunStatus(value: string): "ok" | "degraded" | "failed" {
  if (value === "ok" || value === "degraded" || value === "failed") return value;
  return "failed";
}

export async function buildLandscapeTrajectory(params: {
  runId: string;
  includeCandidates: boolean;
  limit: number;
}): Promise<LandscapeTrajectoryResult | null> {
  const loaded = await loadLandscapeTrajectory(params);
  if (!loaded) return null;

  const runSnapshot = asRecord(loaded.run.packSnapshot);
  const diagnostics = asRecord(runSnapshot.diagnostics);
  const retrievalStats = asRecord(diagnostics.retrievalStats);

  const traceDiagnostics = {
    candidateTraceSavedCount: asNullableInt(retrievalStats.candidateTraceSavedCount),
    candidateTraceTruncated: asNullableBoolean(retrievalStats.candidateTraceTruncated),
    candidateTraceLimit: asNullableInt(retrievalStats.candidateTraceLimit),
    candidateTraceSkippedReason: asNullableString(retrievalStats.candidateTraceSkippedReason),
  };

  const traceAvailable = loaded.stageCounts.totalCandidates > 0;
  const warnings: string[] = [];
  if (!traceAvailable) {
    warnings.push("trace unavailable");
  }
  if (traceDiagnostics.candidateTraceTruncated) {
    warnings.push("candidate trace was truncated at compile time");
  }
  if (
    params.includeCandidates &&
    loaded.stageCounts.totalCandidates > 0 &&
    loaded.candidates.length < loaded.stageCounts.totalCandidates
  ) {
    warnings.push("candidate list truncated by query limit");
  }

  return landscapeTrajectoryResultSchema.parse({
    run: {
      id: loaded.run.id,
      goal: loaded.run.goal,
      retrievalMode: loaded.run.retrievalMode,
      status: normalizeRunStatus(loaded.run.status),
      source: loaded.run.source,
      createdAt: loaded.run.createdAt.toISOString(),
    },
    traceAvailable,
    warnings,
    stageCounts: loaded.stageCounts,
    selectedKnowledgeIds: loaded.selectedKnowledgeIds,
    diagnostics: traceDiagnostics,
    candidates: loaded.candidates,
    communitySummary: loaded.communitySummary,
  });
}
