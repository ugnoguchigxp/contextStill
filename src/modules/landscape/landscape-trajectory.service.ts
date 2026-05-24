import {
  type LandscapeTrajectoryResult,
  landscapeTrajectoryResultSchema,
} from "../../shared/schemas/landscape-trajectory.schema.js";
import {
  findContextCompileTaskTraceByRunId,
  listRecentContextCompileTaskTraces,
  type ContextCompileTaskTrace,
} from "../context-compiler/context-compile-task-trace.repository.js";
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

function normalizeCandidateEvidence(value: unknown): {
  textMatched: boolean;
  vectorMatched: boolean;
  vectorScore: number | null;
  facetMatched: boolean;
} | null {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return null;

  const textMatched = Boolean(record.textMatched);
  const vectorMatched = Boolean(record.vectorMatched);
  const facetMatched = Boolean(record.facetMatched);
  const vectorScoreRaw = Number(record.vectorScore);
  const vectorScore = Number.isFinite(vectorScoreRaw) ? vectorScoreRaw : null;

  if (!textMatched && !vectorMatched && !facetMatched && vectorScore === null) return null;
  return {
    textMatched,
    vectorMatched,
    vectorScore,
    facetMatched,
  };
}

function normalizeTrajectoryEvidence(value: unknown): {
  status: string | null;
  candidateEvidence: {
    textMatched: boolean;
    vectorMatched: boolean;
    vectorScore: number | null;
    facetMatched: boolean;
  } | null;
} {
  const record = asRecord(value);
  return {
    status: asNullableString(record.status),
    candidateEvidence: normalizeCandidateEvidence(record.candidateEvidence),
  };
}

function asSimilarityScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return Number(value.toFixed(4));
}

function jaccardScore(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 ? intersection / union : 0;
}

function cosineSimilarity(left: number[] | null, right: number[] | null): number | null {
  if (!left || !right) return null;
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined || r === undefined) return null;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return null;
  const score = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  if (!Number.isFinite(score)) return null;
  return Math.max(0, Math.min(1, score));
}

function facetSimilarity(base: ContextCompileTaskTrace, candidate: ContextCompileTaskTrace): number {
  const repoPathMatch =
    Boolean(base.repoPath) && Boolean(candidate.repoPath) && base.repoPath === candidate.repoPath
      ? 1
      : 0;
  const repoKeyMatch =
    Boolean(base.repoKey) && Boolean(candidate.repoKey) && base.repoKey === candidate.repoKey
      ? 1
      : 0;
  const retrievalModeMatch = base.retrievalMode === candidate.retrievalMode ? 1 : 0;

  const technologies = jaccardScore(base.technologies, candidate.technologies);
  const changeTypes = jaccardScore(base.changeTypes, candidate.changeTypes);
  const domains = jaccardScore(base.domains, candidate.domains);

  return asSimilarityScore(
    repoPathMatch * 0.25 +
      repoKeyMatch * 0.2 +
      retrievalModeMatch * 0.15 +
      technologies * 0.15 +
      changeTypes * 0.15 +
      domains * 0.1,
  );
}

function buildTaskSimilarity(base: ContextCompileTaskTrace, recent: ContextCompileTaskTrace[]) {
  return recent
    .map((candidate) => {
      const cosine = cosineSimilarity(base.embedding, candidate.embedding);
      if (cosine !== null) {
        return {
          runId: candidate.runId,
          similarity: asSimilarityScore(cosine),
          mode: "embedding" as const,
          retrievalMode: candidate.retrievalMode,
          repoPath: candidate.repoPath,
          repoKey: candidate.repoKey,
          goalHash: candidate.goalHash,
          embeddingStatus: candidate.embeddingStatus,
          createdAt: candidate.createdAt.toISOString(),
        };
      }

      return {
        runId: candidate.runId,
        similarity: facetSimilarity(base, candidate),
        mode: "facets" as const,
        retrievalMode: candidate.retrievalMode,
        repoPath: candidate.repoPath,
        repoKey: candidate.repoKey,
        goalHash: candidate.goalHash,
        embeddingStatus: candidate.embeddingStatus,
        createdAt: candidate.createdAt.toISOString(),
      };
    })
    .filter((item) => item.similarity > 0)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 5);
}

export async function buildLandscapeTrajectory(params: {
  runId: string;
  includeCandidates: boolean;
  limit: number;
}): Promise<LandscapeTrajectoryResult | null> {
  const loaded = await loadLandscapeTrajectory(params);
  if (!loaded) return null;

  const taskTrace = await findContextCompileTaskTraceByRunId(params.runId);
  const taskSimilarity = taskTrace
    ? buildTaskSimilarity(
        taskTrace,
        await listRecentContextCompileTaskTraces({
          limit: 120,
          excludeRunId: params.runId,
        }),
      )
    : [];

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
    candidates: loaded.candidates.map((candidate) => ({
      ...candidate,
      evidence: normalizeTrajectoryEvidence(candidate.evidence),
    })),
    communitySummary: loaded.communitySummary,
    taskTrace: taskTrace
      ? {
          runId: taskTrace.runId,
          retrievalMode: taskTrace.retrievalMode,
          repoPath: taskTrace.repoPath,
          repoKey: taskTrace.repoKey,
          technologies: taskTrace.technologies,
          changeTypes: taskTrace.changeTypes,
          domains: taskTrace.domains,
          embeddingStatus: taskTrace.embeddingStatus,
          embeddingProvider: taskTrace.embeddingProvider,
          embeddingModel: taskTrace.embeddingModel,
          embeddingDimensions: taskTrace.embeddingDimensions,
          goalHash: taskTrace.goalHash,
          createdAt: taskTrace.createdAt.toISOString(),
        }
      : null,
    taskSimilarity,
  });
}
