import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { coverEvidenceResults, findCandidateResults } from "../../db/schema.js";
import {
  applicabilityFromCoverCandidate,
  applicabilityToCoverCandidateFields,
  normalizeApplicability,
} from "../knowledge/applicability.js";
import type { CoverEvidenceResult } from "./types.js";

export type CoverEvidenceResultRow = typeof coverEvidenceResults.$inferSelect;

export type SaveCoverEvidenceResultInput = {
  id: string;
  result: CoverEvidenceResult;
};

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
    appliesTo: applicabilityFromCoverCandidate(result.candidate),
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
  const appliesTo = normalizeApplicability(row.appliesTo);
  const candidate =
    row.type && row.title && row.body && row.importance !== null && row.confidence !== null
      ? {
          type,
          title: row.title,
          body: row.body,
          importance: Math.round(row.importance),
          confidence: Math.round(row.confidence),
          ...applicabilityToCoverCandidateFields(appliesTo),
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
