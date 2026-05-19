import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { findCandidateResults } from "../../db/schema.js";

export type FindCandidateResultRow = typeof findCandidateResults.$inferSelect;

export type CandidateRecord = {
  title: string;
  content: string;
};

export type CandidateOrigin = {
  targetStateId: string;
  targetKind: "wiki_file" | "vibe_memory";
  targetKey: string;
  sourceUri: string;
  inputHash: string;
  readRanges: Array<{
    from: number;
    toExclusive: number;
  }>;
};

function normalizeForHash(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function candidateHash(candidate: CandidateRecord): string {
  const normalized = `${normalizeForHash(candidate.title)}\n${normalizeForHash(candidate.content)}`;
  return createHash("sha256").update(normalized).digest("hex");
}

export async function selectFindCandidateResultByHash(params: {
  targetStateId: string;
  inputHash: string;
  hash: string;
}): Promise<FindCandidateResultRow | null> {
  const [row] = await db
    .select()
    .from(findCandidateResults)
    .where(
      and(
        eq(findCandidateResults.targetStateId, params.targetStateId),
        eq(findCandidateResults.inputHash, params.inputHash),
        eq(findCandidateResults.candidateHash, params.hash),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertFindCandidateResult(params: {
  targetStateId: string;
  targetKind: "wiki_file" | "vibe_memory";
  targetKey: string;
  sourceUri: string;
  inputHash: string;
  provider: string;
  model: string;
  candidateIndex: number;
  candidate: CandidateRecord;
  origin: CandidateOrigin;
  rawOutput: string;
}): Promise<FindCandidateResultRow> {
  const hash = candidateHash(params.candidate);
  const [row] = await db
    .insert(findCandidateResults)
    .values({
      targetStateId: params.targetStateId,
      targetKind: params.targetKind,
      targetKey: params.targetKey,
      sourceUri: params.sourceUri,
      inputHash: params.inputHash,
      provider: params.provider,
      model: params.model,
      candidateIndex: params.candidateIndex,
      candidateHash: hash,
      title: params.candidate.title,
      content: params.candidate.content,
      origin: params.origin,
      rawOutput: params.rawOutput,
      status: "selected",
      metadata: {},
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        findCandidateResults.targetStateId,
        findCandidateResults.inputHash,
        findCandidateResults.candidateHash,
      ],
    })
    .returning();

  if (row) return row;
  const existing = await selectFindCandidateResultByHash({
    targetStateId: params.targetStateId,
    inputHash: params.inputHash,
    hash,
  });
  if (!existing) {
    throw new Error("failed to insert or find existing find_candidate_results row");
  }
  return existing;
}
