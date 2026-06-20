import { and, desc, eq, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
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
  evidence: Record<string, unknown>;
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

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function parseJsonValue(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(0);
}

export async function loadLandscapeTrajectory(params: {
  runId: string;
  includeCandidates: boolean;
  limit: number;
}): Promise<LandscapeTrajectoryLoadResult | null> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const runRow = sqlite.db
      .query(
        `
        select id, goal, retrieval_mode, status, source, created_at, pack_snapshot
        from context_compile_runs
        where id = ?
        limit 1
      `,
      )
      .get(params.runId) as {
      id: string;
      goal: string;
      retrieval_mode: string;
      status: string;
      source: string;
      created_at: string;
      pack_snapshot: string | null;
    } | null;

    if (!runRow) return null;

    const selectedItemRows = sqlite.db
      .query(
        `
        select item_id, item_kind
        from context_pack_items
        where run_id = ?
          and item_kind in ('rule', 'procedure')
        order by score desc, created_at desc
      `,
      )
      .all(params.runId) as Array<{ item_id: string; item_kind: string }>;
    const selectedKnowledgeIds = [
      ...new Set(
        selectedItemRows
          .filter((row) => row.item_kind === "rule" || row.item_kind === "procedure")
          .map((row) => row.item_id),
      ),
    ];

    const stageCountRaw = sqlite.db
      .query(
        `
        select
          count(*) as total_candidates,
          sum(case when text_rank is not null then 1 else 0 end) as text_hit,
          sum(case when vector_rank is not null then 1 else 0 end) as vector_hit,
          sum(case when merged_rank is not null then 1 else 0 end) as merged,
          sum(case when final_rank is not null then 1 else 0 end) as final_ranked,
          sum(case when selected = 1 then 1 else 0 end) as selected,
          sum(case when suppressed = 1 then 1 else 0 end) as suppressed
        from context_compile_candidate_traces
        where run_id = ?
      `,
      )
      .get(params.runId) as Record<string, unknown> | null;
    const stageCounts: LandscapeTrajectoryStageCountRow = {
      totalCandidates: asCount(stageCountRaw?.total_candidates),
      textHit: asCount(stageCountRaw?.text_hit),
      vectorHit: asCount(stageCountRaw?.vector_hit),
      merged: asCount(stageCountRaw?.merged),
      finalRanked: asCount(stageCountRaw?.final_ranked),
      selected: asCount(stageCountRaw?.selected),
      suppressed: asCount(stageCountRaw?.suppressed),
    };

    const communityRowsRaw = sqlite.db
      .query(
        `
        select
          community_key,
          count(*) as candidate_count,
          sum(case when selected = 1 then 1 else 0 end) as selected_count,
          sum(case when suppressed = 1 then 1 else 0 end) as suppressed_count
        from context_compile_candidate_traces
        where run_id = ?
          and community_key is not null
        group by community_key
        order by selected_count desc, candidate_count desc, community_key asc
      `,
      )
      .all(params.runId) as Array<Record<string, unknown>>;
    const communitySummary: LandscapeTrajectoryCommunitySummaryRow[] = communityRowsRaw
      .filter((row) => typeof row.community_key === "string")
      .map((row) => ({
        communityKey: String(row.community_key),
        candidateCount: asCount(row.candidate_count),
        selectedCount: asCount(row.selected_count),
        suppressedCount: asCount(row.suppressed_count),
      }));

    let candidates: LandscapeTrajectoryCandidateRow[] = [];
    if (params.includeCandidates) {
      const candidateRows = sqlite.db
        .query(
          `
          select
            item_kind, item_id, text_rank, text_score, vector_rank, vector_score,
            merged_rank, merged_score, final_rank, final_score, selected, suppressed,
            suppression_reason, agentic_decision, ranking_reason, community_key, evidence
          from context_compile_candidate_traces
          where run_id = ?
          order by selected desc,
            case when final_rank is null then 1 else 0 end,
            final_rank asc,
            case when merged_rank is null then 1 else 0 end,
            merged_rank asc,
            created_at asc
          limit ?
        `,
        )
        .all(params.runId, params.limit) as Array<Record<string, unknown>>;
      candidates = candidateRows
        .filter(
          (row) =>
            (row.item_kind === "rule" || row.item_kind === "procedure") &&
            (row.agentic_decision === "not_evaluated" ||
              row.agentic_decision === "accepted" ||
              row.agentic_decision === "rejected" ||
              row.agentic_decision === "skipped"),
        )
        .map((row) => ({
          itemKind: row.item_kind as "rule" | "procedure",
          itemId: String(row.item_id),
          textRank: row.text_rank === null ? null : Number(row.text_rank),
          textScore: row.text_score === null ? null : Number(row.text_score),
          vectorRank: row.vector_rank === null ? null : Number(row.vector_rank),
          vectorScore: row.vector_score === null ? null : Number(row.vector_score),
          mergedRank: row.merged_rank === null ? null : Number(row.merged_rank),
          mergedScore: row.merged_score === null ? null : Number(row.merged_score),
          finalRank: row.final_rank === null ? null : Number(row.final_rank),
          finalScore: row.final_score === null ? null : Number(row.final_score),
          selected: Number(row.selected ?? 0) === 1,
          suppressed: Number(row.suppressed ?? 0) === 1,
          suppressionReason: row.suppression_reason ? String(row.suppression_reason) : null,
          agenticDecision:
            row.agentic_decision as LandscapeTrajectoryCandidateRow["agenticDecision"],
          rankingReason: row.ranking_reason ? String(row.ranking_reason) : null,
          communityKey: row.community_key ? String(row.community_key) : null,
          evidence: parseJsonValue(row.evidence, {}) as Record<string, unknown>,
        }));
    }

    return {
      run: {
        id: runRow.id,
        goal: runRow.goal,
        retrievalMode: runRow.retrieval_mode,
        status: runRow.status,
        source: runRow.source,
        createdAt: toDate(runRow.created_at),
        packSnapshot: parseJsonValue(runRow.pack_snapshot, null),
      },
      selectedKnowledgeIds,
      stageCounts,
      candidates,
      communitySummary,
    };
  }

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
        evidence: contextCompileCandidateTraces.evidence,
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
        evidence:
          row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
            ? (row.evidence as Record<string, unknown>)
            : {},
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
