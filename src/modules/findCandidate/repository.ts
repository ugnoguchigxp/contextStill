import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { distillationTargetStates, findCandidateResults } from "../../db/schema.js";

type FindCandidateBaseRow = typeof findCandidateResults.$inferSelect;

export type FindCandidateResultRow = FindCandidateBaseRow & {
  targetKind: "wiki_file" | "vibe_memory";
  targetKey: string;
  sourceUri: string;
};

export type CandidateKnowledgeType = "rule" | "procedure";

export type CandidateRecord = {
  type?: CandidateKnowledgeType;
  title: string;
  content: string;
};

export type CandidateOrigin = {
  candidateType?: CandidateKnowledgeType;
  readRanges: Array<{
    from: number;
    toExclusive: number;
  }>;
};

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
    targetKind: row.targetKind as "wiki_file" | "vibe_memory",
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
    targetKind: row.targetKind as "wiki_file" | "vibe_memory",
  }));
}

export async function insertFindCandidateResult(params: {
  targetStateId: string;
  candidateIndex: number;
  candidate: CandidateRecord;
  origin: CandidateOrigin;
}): Promise<FindCandidateBaseRow> {
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
