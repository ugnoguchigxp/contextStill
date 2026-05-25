import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { distillationTargetStates, findCandidateResults } from "../../db/schema.js";
import type { DistillationTargetKind } from "../selectDistillationTarget/domain.js";

type FindCandidateBaseRow = typeof findCandidateResults.$inferSelect;

export type FindCandidateResultRow = FindCandidateBaseRow & {
  targetKind: DistillationTargetKind;
  targetKey: string;
  sourceUri: string;
};

export type CandidateKnowledgeType = "rule" | "procedure";

export type CandidateRecord = {
  type?: CandidateKnowledgeType;
  title: string;
  content: string;
  sourceSummary?: string;
};

export type CandidateOrigin = {
  candidateType?: CandidateKnowledgeType;
  sourceSummary?: string;
  readRanges: Array<{
    from: number;
    toExclusive: number;
  }>;
};

const MAX_SOURCE_SUMMARY_CHARS = 1000;

function normalizeSourceSummary(value: string | undefined): string | undefined {
  const summary = value?.replace(/\s+/g, " ").trim();
  return summary ? summary.slice(0, MAX_SOURCE_SUMMARY_CHARS) : undefined;
}

export async function getFindCandidateResultById(
  id: string,
): Promise<FindCandidateResultRow | null> {
  const [row] = await db
    .select({
      id: findCandidateResults.id,
      targetStateId: findCandidateResults.targetStateId,
      candidateIndex: findCandidateResults.candidateIndex,
      title: findCandidateResults.title,
      content: findCandidateResults.content,
      origin: findCandidateResults.origin,
      status: findCandidateResults.status,
      createdAt: findCandidateResults.createdAt,
      updatedAt: findCandidateResults.updatedAt,
      targetKind: distillationTargetStates.targetKind,
      targetKey: distillationTargetStates.targetKey,
      sourceUri: distillationTargetStates.sourceUri,
    })
    .from(findCandidateResults)
    .innerJoin(
      distillationTargetStates,
      eq(distillationTargetStates.id, findCandidateResults.targetStateId),
    )
    .where(eq(findCandidateResults.id, id))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    targetKind: row.targetKind as DistillationTargetKind,
  };
}

export async function listFindCandidateResultsByTargetStateId(
  targetStateId: string,
): Promise<FindCandidateResultRow[]> {
  const rows = await db
    .select({
      id: findCandidateResults.id,
      targetStateId: findCandidateResults.targetStateId,
      candidateIndex: findCandidateResults.candidateIndex,
      title: findCandidateResults.title,
      content: findCandidateResults.content,
      origin: findCandidateResults.origin,
      status: findCandidateResults.status,
      createdAt: findCandidateResults.createdAt,
      updatedAt: findCandidateResults.updatedAt,
      targetKind: distillationTargetStates.targetKind,
      targetKey: distillationTargetStates.targetKey,
      sourceUri: distillationTargetStates.sourceUri,
    })
    .from(findCandidateResults)
    .innerJoin(
      distillationTargetStates,
      eq(distillationTargetStates.id, findCandidateResults.targetStateId),
    )
    .where(eq(findCandidateResults.targetStateId, targetStateId))
    .orderBy(asc(findCandidateResults.candidateIndex), asc(findCandidateResults.id));

  return rows.map((row) => ({
    ...row,
    targetKind: row.targetKind as DistillationTargetKind,
  }));
}

export async function insertFindCandidateResult(params: {
  targetStateId: string;
  candidateIndex: number;
  candidate: CandidateRecord;
  origin: CandidateOrigin;
}): Promise<FindCandidateBaseRow> {
  const sourceSummary = normalizeSourceSummary(params.candidate.sourceSummary);
  const [row] = await db
    .insert(findCandidateResults)
    .values({
      targetStateId: params.targetStateId,
      candidateIndex: params.candidateIndex,
      title: params.candidate.title,
      content: params.candidate.content,
      origin: {
        ...params.origin,
        ...(params.candidate.type ? { candidateType: params.candidate.type } : {}),
        ...(sourceSummary ? { sourceSummary } : {}),
      },
      status: "selected",
      updatedAt: new Date(),
    })
    .returning();

  if (!row) {
    throw new Error("failed to save find_candidate_results row");
  }
  return row;
}
