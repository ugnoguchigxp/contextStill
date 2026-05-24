import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contextCompileCandidateTraces,
  contextCompileRuns,
  contextPackItems,
} from "../../db/schema.js";

type LandscapeTrajectoryRunRow = {
  id: string;
  goal: string;
  retrievalMode: string;
  status: string;
  source: string;
  createdAt: Date;
  packSnapshot: unknown;
};

type LandscapeTrajectoryStageCountRow = {
  totalCandidates: number;
  textHit: number;
  vectorHit: number;
  merged: number;
  finalRanked: number;
  selected: number;
  suppressed: number;
};

type LandscapeTrajectoryCandidateRow = {
  itemKind: "rule" | "procedure";
  itemId: string;
  textRank: number | null;
  textScore: number | null;
  vectorRank: number | null;
  vectorScore: number | null;
  mergedRank: number | null;
  mergedScore: number | null;
  finalRank: number | null;
  finalScore: number | null;
  selected: boolean;
  suppressed: boolean;
  suppressionReason: string | null;
  agenticDecision: "not_evaluated" | "accepted" | "rejected" | "skipped";
  rankingReason: string | null;
  communityKey: string | null;
};

type LandscapeTrajectoryCommunitySummaryRow = {
  communityKey: string;
  candidateCount: number;
  selectedCount: number;
  suppressedCount: number;
};

export type LandscapeTrajectoryLoadResult = {
  run: LandscapeTrajectoryRunRow;
  selectedKnowledgeIds: string[];
  stageCounts: LandscapeTrajectoryStageCountRow;
  candidates: LandscapeTrajectoryCandidateRow[];
  communitySummary: LandscapeTrajectoryCommunitySummaryRow[];
};

function asCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

export async function loadLandscapeTrajectory(params: {
  runId: string;
  includeCandidates: boolean;
  limit: number;
}): Promise<LandscapeTrajectoryLoadResult | null> {
  const [runRow] = await db
    .select({
      id: contextCompileRuns.id,
      goal: contextCompileRuns.goal,
      retrievalMode: contextCompileRuns.retrievalMode,
      status: contextCompileRuns.status,
      source: contextCompileRuns.source,
      createdAt: contextCompileRuns.createdAt,
      packSnapshot: contextCompileRuns.packSnapshot,
    })
    .from(contextCompileRuns)
    .where(eq(contextCompileRuns.id, params.runId))
    .limit(1);

  if (!runRow) return null;

  const selectedItemRows = await db
    .select({
      itemId: contextPackItems.itemId,
      itemKind: contextPackItems.itemKind,
    })
    .from(contextPackItems)
    .where(
      and(
        eq(contextPackItems.runId, params.runId),
        sql`${contextPackItems.itemKind} IN ('rule', 'procedure')`,
      ),
    )
    .orderBy(desc(contextPackItems.score), desc(contextPackItems.createdAt));

  const selectedKnowledgeIds = [
    ...new Set(
      selectedItemRows
        .filter((row) => row.itemKind === "rule" || row.itemKind === "procedure")
        .map((row) => row.itemId),
    ),
  ];

  const [stageCountRaw] = await db
    .select({
      totalCandidates: sql<number>`count(*)`,
      textHit: sql<number>`count(*) filter (where ${contextCompileCandidateTraces.textRank} is not null)`,
      vectorHit: sql<number>`count(*) filter (where ${contextCompileCandidateTraces.vectorRank} is not null)`,
      merged: sql<number>`count(*) filter (where ${contextCompileCandidateTraces.mergedRank} is not null)`,
      finalRanked: sql<number>`count(*) filter (where ${contextCompileCandidateTraces.finalRank} is not null)`,
      selected: sql<number>`count(*) filter (where ${contextCompileCandidateTraces.selected} = true)`,
      suppressed: sql<number>`count(*) filter (where ${contextCompileCandidateTraces.suppressed} = true)`,
    })
    .from(contextCompileCandidateTraces)
    .where(eq(contextCompileCandidateTraces.runId, params.runId));

  const stageCounts: LandscapeTrajectoryStageCountRow = {
    totalCandidates: asCount(stageCountRaw?.totalCandidates),
    textHit: asCount(stageCountRaw?.textHit),
    vectorHit: asCount(stageCountRaw?.vectorHit),
    merged: asCount(stageCountRaw?.merged),
    finalRanked: asCount(stageCountRaw?.finalRanked),
    selected: asCount(stageCountRaw?.selected),
    suppressed: asCount(stageCountRaw?.suppressed),
  };

  const communityRowsRaw = await db
    .select({
      communityKey: contextCompileCandidateTraces.communityKey,
      candidateCount: sql<number>`count(*)`,
      selectedCount: sql<number>`count(*) filter (where ${contextCompileCandidateTraces.selected} = true)`,
      suppressedCount: sql<number>`count(*) filter (where ${contextCompileCandidateTraces.suppressed} = true)`,
    })
    .from(contextCompileCandidateTraces)
    .where(
      and(
        eq(contextCompileCandidateTraces.runId, params.runId),
        sql`${contextCompileCandidateTraces.communityKey} IS NOT NULL`,
      ),
    )
    .groupBy(contextCompileCandidateTraces.communityKey)
    .orderBy(
      sql`count(*) filter (where ${contextCompileCandidateTraces.selected} = true) desc`,
      sql`count(*) desc`,
      contextCompileCandidateTraces.communityKey,
    );

  const communitySummary: LandscapeTrajectoryCommunitySummaryRow[] = communityRowsRaw
    .filter(
      (row): row is typeof row & { communityKey: string } => typeof row.communityKey === "string",
    )
    .map((row) => ({
      communityKey: row.communityKey,
      candidateCount: asCount(row.candidateCount),
      selectedCount: asCount(row.selectedCount),
      suppressedCount: asCount(row.suppressedCount),
    }));

  let candidates: LandscapeTrajectoryCandidateRow[] = [];
  if (params.includeCandidates) {
    const candidateRows = await db
      .select({
        itemKind: contextCompileCandidateTraces.itemKind,
        itemId: contextCompileCandidateTraces.itemId,
        textRank: contextCompileCandidateTraces.textRank,
        textScore: contextCompileCandidateTraces.textScore,
        vectorRank: contextCompileCandidateTraces.vectorRank,
        vectorScore: contextCompileCandidateTraces.vectorScore,
        mergedRank: contextCompileCandidateTraces.mergedRank,
        mergedScore: contextCompileCandidateTraces.mergedScore,
        finalRank: contextCompileCandidateTraces.finalRank,
        finalScore: contextCompileCandidateTraces.finalScore,
        selected: contextCompileCandidateTraces.selected,
        suppressed: contextCompileCandidateTraces.suppressed,
        suppressionReason: contextCompileCandidateTraces.suppressionReason,
        agenticDecision: contextCompileCandidateTraces.agenticDecision,
        rankingReason: contextCompileCandidateTraces.rankingReason,
        communityKey: contextCompileCandidateTraces.communityKey,
      })
      .from(contextCompileCandidateTraces)
      .where(eq(contextCompileCandidateTraces.runId, params.runId))
      .orderBy(
        desc(contextCompileCandidateTraces.selected),
        sql`case when ${contextCompileCandidateTraces.finalRank} is null then 1 else 0 end`,
        contextCompileCandidateTraces.finalRank,
        sql`case when ${contextCompileCandidateTraces.mergedRank} is null then 1 else 0 end`,
        contextCompileCandidateTraces.mergedRank,
        contextCompileCandidateTraces.createdAt,
      )
      .limit(params.limit);

    candidates = candidateRows
      .filter(
        (
          row,
        ): row is typeof row & {
          itemKind: "rule" | "procedure";
          agenticDecision: "not_evaluated" | "accepted" | "rejected" | "skipped";
        } =>
          (row.itemKind === "rule" || row.itemKind === "procedure") &&
          (row.agenticDecision === "not_evaluated" ||
            row.agenticDecision === "accepted" ||
            row.agenticDecision === "rejected" ||
            row.agenticDecision === "skipped"),
      )
      .map((row) => ({
        itemKind: row.itemKind,
        itemId: row.itemId,
        textRank: row.textRank,
        textScore: row.textScore,
        vectorRank: row.vectorRank,
        vectorScore: row.vectorScore,
        mergedRank: row.mergedRank,
        mergedScore: row.mergedScore,
        finalRank: row.finalRank,
        finalScore: row.finalScore,
        selected: row.selected,
        suppressed: row.suppressed,
        suppressionReason: row.suppressionReason,
        agenticDecision: row.agenticDecision,
        rankingReason: row.rankingReason,
        communityKey: row.communityKey,
      }));
  }

  return {
    run: {
      id: runRow.id,
      goal: runRow.goal,
      retrievalMode: runRow.retrievalMode,
      status: runRow.status,
      source: runRow.source,
      createdAt: runRow.createdAt,
      packSnapshot: runRow.packSnapshot,
    },
    selectedKnowledgeIds,
    stageCounts,
    candidates,
    communitySummary,
  };
}
