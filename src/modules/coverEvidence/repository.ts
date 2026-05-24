import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { coverEvidenceResults, findCandidateResults } from "../../db/schema.js";
import { asRecord, asStringArray } from "../../shared/utils/normalize.js";
import type { CoverEvidenceResult } from "./types.js";

export type CoverEvidenceResultRow = typeof coverEvidenceResults.$inferSelect;

export type SaveCoverEvidenceResultInput = {
  id: string;
  result: CoverEvidenceResult;
};

function appliesToFromCandidate(
  candidate: CoverEvidenceResult["candidate"],
): Record<string, unknown> {
  if (!candidate) return {};
  return {
    ...(candidate.applicabilityGeneral !== undefined
      ? { general: candidate.applicabilityGeneral }
      : {}),
    ...(candidate.technologies && candidate.technologies.length > 0
      ? { technologies: candidate.technologies }
      : {}),
    ...(candidate.changeTypes && candidate.changeTypes.length > 0
      ? { changeTypes: candidate.changeTypes }
      : {}),
    ...(candidate.domains && candidate.domains.length > 0 ? { domains: candidate.domains } : {}),
    ...(candidate.repoPath ? { repoPath: candidate.repoPath } : {}),
    ...(candidate.repoKey ? { repoKey: candidate.repoKey } : {}),
  };
}

function candidateApplicabilityFromAppliesTo(
  appliesTo: Record<string, unknown>,
): Pick<
  NonNullable<CoverEvidenceResult["candidate"]>,
  "applicabilityGeneral" | "technologies" | "changeTypes" | "domains" | "repoPath" | "repoKey"
> {
  const technologies = asStringArray(appliesTo.technologies);
  const changeTypes = asStringArray(appliesTo.changeTypes);
  const domains = asStringArray(appliesTo.domains);
  return {
    ...(typeof appliesTo.general === "boolean" ? { applicabilityGeneral: appliesTo.general } : {}),
    ...(technologies.length > 0 ? { technologies } : {}),
    ...(changeTypes.length > 0 ? { changeTypes } : {}),
    ...(domains.length > 0 ? { domains } : {}),
    ...(typeof appliesTo.repoPath === "string" && appliesTo.repoPath.trim()
      ? { repoPath: appliesTo.repoPath.trim() }
      : {}),
    ...(typeof appliesTo.repoKey === "string" && appliesTo.repoKey.trim()
      ? { repoKey: appliesTo.repoKey.trim() }
      : {}),
  };
}

export async function selectCoverEvidenceResultById(
  id: string,
): Promise<CoverEvidenceResultRow | null> {
  const [row] = await db
    .select()
    .from(coverEvidenceResults)
    .where(eq(coverEvidenceResults.id, id))
    .limit(1);
  return row ?? null;
}

export async function listCoverEvidenceResultsByTargetStateId(
  targetStateId: string,
): Promise<CoverEvidenceResultRow[]> {
  return db
    .select({
      id: coverEvidenceResults.id,
      status: coverEvidenceResults.status,
      stage: coverEvidenceResults.stage,
      type: coverEvidenceResults.type,
      title: coverEvidenceResults.title,
      body: coverEvidenceResults.body,
      importance: coverEvidenceResults.importance,
      confidence: coverEvidenceResults.confidence,
      appliesTo: coverEvidenceResults.appliesTo,
      references: coverEvidenceResults.references,
      duplicateRefs: coverEvidenceResults.duplicateRefs,
      toolEvents: coverEvidenceResults.toolEvents,
      reason: coverEvidenceResults.reason,
      createdAt: coverEvidenceResults.createdAt,
      updatedAt: coverEvidenceResults.updatedAt,
    })
    .from(coverEvidenceResults)
    .innerJoin(findCandidateResults, eq(findCandidateResults.id, coverEvidenceResults.id))
    .where(eq(findCandidateResults.targetStateId, targetStateId))
    .orderBy(asc(findCandidateResults.candidateIndex), asc(coverEvidenceResults.id));
}

export async function saveCoverEvidenceResult(
  input: SaveCoverEvidenceResultInput,
): Promise<CoverEvidenceResultRow> {
  const { result } = input;
  const now = new Date();
  const values = {
    id: input.id,
    status: result.status,
    stage: result.stage,
    type: result.candidate?.type ?? null,
    title: result.candidate?.title ?? null,
    body: result.candidate?.body ?? null,
    importance: result.candidate?.importance ?? null,
    confidence: result.candidate?.confidence ?? null,
    appliesTo: appliesToFromCandidate(result.candidate),
    references: result.references,
    duplicateRefs: result.duplicateRefs,
    toolEvents: result.toolEvents,
    reason: result.reason,
    updatedAt: now,
  };

  const [row] = await db
    .insert(coverEvidenceResults)
    .values(values)
    .onConflictDoUpdate({
      target: coverEvidenceResults.id,
      set: values,
    })
    .returning();

  if (!row) {
    throw new Error("failed to save cover evidence result");
  }
  return row;
}

export function coverEvidenceResultFromRow(row: CoverEvidenceResultRow): CoverEvidenceResult {
  const type: "rule" | "procedure" = row.type === "procedure" ? "procedure" : "rule";
  const appliesTo = asRecord(row.appliesTo);
  const candidate =
    row.type && row.title && row.body && row.importance !== null && row.confidence !== null
      ? {
          type,
          title: row.title,
          body: row.body,
          importance: Math.round(row.importance),
          confidence: Math.round(row.confidence),
          ...candidateApplicabilityFromAppliesTo(appliesTo),
        }
      : null;

  return {
    schemaVersion: 1,
    status: row.status as CoverEvidenceResult["status"],
    stage: row.stage as CoverEvidenceResult["stage"],
    candidate,
    references: Array.isArray(row.references)
      ? (row.references as CoverEvidenceResult["references"])
      : [],
    duplicateRefs: Array.isArray(row.duplicateRefs)
      ? (row.duplicateRefs as CoverEvidenceResult["duplicateRefs"])
      : [],
    toolEvents: Array.isArray(row.toolEvents)
      ? (row.toolEvents as CoverEvidenceResult["toolEvents"])
      : [],
    reason: row.reason,
  };
}
