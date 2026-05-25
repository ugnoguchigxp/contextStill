import {
  type CompileInput,
  type RetrievalMode,
  deriveRetrievalModeFromChangeTypes,
  retrievalModeSchema,
} from "../../shared/schemas/compile.schema.js";
import {
  extractLandscapeTaskFacets,
  type LandscapeReplayCompileRunInput,
} from "./landscape-facets.js";
import type {
  LandscapeReplayComparisonKind,
  LandscapeReplayComparisonRun,
  LandscapeUsageVerdict,
  LandscapeVerdictMix,
} from "./landscape-replay.types.js";

export type PackItemForComparison = {
  itemId: string;
  score: number;
  createdAt: Date;
};

export type UsageEventForComparison = {
  runId: string;
  knowledgeId: string;
  verdict: LandscapeUsageVerdict;
};

export function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function orderPackItems(items: PackItemForComparison[]): PackItemForComparison[] {
  return [...items].sort(
    (a, b) =>
      b.score - a.score ||
      b.createdAt.getTime() - a.createdAt.getTime() ||
      a.itemId.localeCompare(b.itemId),
  );
}

export function groupByRunId<T extends { runId: string }>(rows: T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const current = result.get(row.runId) ?? [];
    current.push(row);
    result.set(row.runId, current);
  }
  return result;
}

export function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function classifyReplayComparison(params: {
  baselineCount: number;
  currentCount: number;
  retainedCount: number;
  overlapRate: number;
}): LandscapeReplayComparisonKind {
  if (params.baselineCount === 0 && params.currentCount > 0) return "new_only";
  if (params.currentCount === 0) return "no_current_match";
  if (params.baselineCount > 0 && params.retainedCount === 0) return "lost_baseline";
  if (params.overlapRate >= 0.6) return "stable";
  return "drifted";
}

export function normalizeRetrievalMode(value: string, fallbackChangeTypes: string[]): RetrievalMode {
  const parsed = retrievalModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return deriveRetrievalModeFromChangeTypes(fallbackChangeTypes);
}

export function compileInputFromRun(input: LandscapeReplayCompileRunInput): CompileInput {
  const facets = extractLandscapeTaskFacets({
    runInput: input.runInput,
    repoPath: input.repoPath,
    retrievalMode: input.retrievalMode,
    source: input.source,
    runStatus: input.runStatus,
    degradedReasons: input.degradedReasons,
  });
  return {
    goal: input.goal,
    ...(facets.changeTypes.length > 0 ? { changeTypes: facets.changeTypes } : {}),
    ...(facets.technologies.length > 0 ? { technologies: facets.technologies } : {}),
    ...(facets.domains.length > 0 ? { domains: facets.domains } : {}),
  };
}

export function emptyComparisonCounts(): Record<LandscapeReplayComparisonKind, number> {
  return {
    stable: 0,
    drifted: 0,
    lost_baseline: 0,
    new_only: 0,
    no_current_match: 0,
  };
}

export function emptyVerdictMix(): LandscapeVerdictMix {
  return {
    used: 0,
    notUsed: 0,
    offTopic: 0,
    wrong: 0,
  };
}

export function buildVerdictMix(events: UsageEventForComparison[]): LandscapeVerdictMix {
  const mix = emptyVerdictMix();
  for (const event of events) {
    if (event.verdict === "used") mix.used += 1;
    if (event.verdict === "not_used") mix.notUsed += 1;
    if (event.verdict === "off_topic") mix.offTopic += 1;
    if (event.verdict === "wrong") mix.wrong += 1;
  }
  return mix;
}

export function averageRunRate(
  runs: LandscapeReplayComparisonRun[],
  compute: (run: LandscapeReplayComparisonRun) => number,
): number {
  return rate(
    runs.reduce((sum, run) => sum + compute(run), 0),
    runs.length,
  );
}
