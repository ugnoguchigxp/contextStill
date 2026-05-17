import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import { db } from "../../db/client.js";
import { distillationCandidates } from "../../db/schema.js";
import type { DistilledKnowledgeCandidate } from "./distillation-candidates.js";
import type { DistillationToolResult } from "./distillation-tools.service.js";

export type DistillationCandidateStatus =
  | "extracted"
  | "evaluating"
  | "verified"
  | "promoted"
  | "rejected"
  | "failed";

export type DistillationCandidateRow = typeof distillationCandidates.$inferSelect;

export type DistillationCandidateSourceRef =
  | {
      sourceKind: "vibe_memory";
      vibeMemoryId: string;
    }
  | {
      sourceKind: "source_fragment";
      sourceFragmentId: string;
    };

type CandidateInsertSource =
  | {
      sourceKind: "vibe_memory";
      vibeMemoryId: string;
      sourceFragmentId?: null;
    }
  | {
      sourceKind: "source_fragment";
      sourceFragmentId: string;
      vibeMemoryId?: null;
    };

function sourceInsertValues(source: DistillationCandidateSourceRef): CandidateInsertSource {
  if (source.sourceKind === "vibe_memory") {
    return {
      sourceKind: source.sourceKind,
      vibeMemoryId: source.vibeMemoryId,
      sourceFragmentId: null,
    };
  }
  return {
    sourceKind: source.sourceKind,
    sourceFragmentId: source.sourceFragmentId,
    vibeMemoryId: null,
  };
}

function sourceFilters(source: DistillationCandidateSourceRef) {
  if (source.sourceKind === "vibe_memory") {
    return [
      eq(distillationCandidates.sourceKind, source.sourceKind),
      eq(distillationCandidates.vibeMemoryId, source.vibeMemoryId),
    ];
  }
  return [
    eq(distillationCandidates.sourceKind, source.sourceKind),
    eq(distillationCandidates.sourceFragmentId, source.sourceFragmentId),
  ];
}

function conflictTarget(source: DistillationCandidateSourceRef) {
  if (source.sourceKind === "vibe_memory") {
    return [
      distillationCandidates.vibeMemoryId,
      distillationCandidates.promptVersion,
      distillationCandidates.inputHash,
      distillationCandidates.candidateIndex,
    ];
  }
  return [
    distillationCandidates.sourceFragmentId,
    distillationCandidates.promptVersion,
    distillationCandidates.inputHash,
    distillationCandidates.candidateIndex,
  ];
}

function conflictWhere(source: DistillationCandidateSourceRef) {
  return source.sourceKind === "vibe_memory"
    ? distillationCandidates.vibeMemoryId
    : distillationCandidates.sourceFragmentId;
}

export function distillationCandidateRowToCandidate(
  row: DistillationCandidateRow,
): DistilledKnowledgeCandidate {
  return {
    type: row.type as DistilledKnowledgeCandidate["type"],
    title: row.title,
    body: row.body,
    confidence: row.confidence ?? 65,
    importance: row.importance ?? 55,
  };
}

export async function upsertExtractedDistillationCandidates(params: {
  source: DistillationCandidateSourceRef;
  inputHash: string;
  promptVersion: string;
  model: string;
  candidates: DistilledKnowledgeCandidate[];
  metadata?: Record<string, unknown>;
}): Promise<DistillationCandidateRow[]> {
  if (params.candidates.length === 0) return [];

  const sourceValues = sourceInsertValues(params.source);
  await db
    .insert(distillationCandidates)
    .values(
      params.candidates.map((candidate, candidateIndex) => ({
        ...sourceValues,
        inputHash: params.inputHash,
        promptVersion: params.promptVersion,
        model: params.model,
        candidateIndex,
        type: candidate.type,
        title: candidate.title,
        body: candidate.body,
        confidence: candidate.confidence,
        importance: candidate.importance,
        status: "extracted",
        metadata: {
          ...(params.metadata ?? {}),
          extractionCandidateIndex: candidateIndex,
        },
        updatedAt: new Date(),
      })),
    )
    .onConflictDoNothing({
      target: conflictTarget(params.source),
      where: isNotNull(conflictWhere(params.source)),
    });

  return listUnevaluatedDistillationCandidates({
    source: params.source,
    inputHash: params.inputHash,
    promptVersion: params.promptVersion,
  });
}

export async function listDistillationCandidatesForInput(params: {
  source: DistillationCandidateSourceRef;
  inputHash: string;
  promptVersion: string;
  statuses?: DistillationCandidateStatus[];
  limit?: number;
}): Promise<DistillationCandidateRow[]> {
  const filters = [
    ...sourceFilters(params.source),
    eq(distillationCandidates.inputHash, params.inputHash),
    eq(distillationCandidates.promptVersion, params.promptVersion),
  ];
  if (params.statuses && params.statuses.length > 0) {
    filters.push(inArray(distillationCandidates.status, params.statuses));
  }

  const query = db
    .select()
    .from(distillationCandidates)
    .where(and(...filters))
    .orderBy(asc(distillationCandidates.candidateIndex));

  return params.limit ? query.limit(params.limit) : query;
}

export function listUnevaluatedDistillationCandidates(params: {
  source: DistillationCandidateSourceRef;
  inputHash: string;
  promptVersion: string;
  limit?: number;
}): Promise<DistillationCandidateRow[]> {
  return listUnevaluatedDistillationCandidatesAfterStaleReset(params);
}

async function listUnevaluatedDistillationCandidatesAfterStaleReset(params: {
  source: DistillationCandidateSourceRef;
  inputHash: string;
  promptVersion: string;
  limit?: number;
}): Promise<DistillationCandidateRow[]> {
  await resetStaleEvaluatingDistillationCandidates(params);
  return listDistillationCandidatesForInput({
    source: params.source,
    inputHash: params.inputHash,
    promptVersion: params.promptVersion,
    statuses: ["extracted", "failed"],
    limit: params.limit,
  });
}

async function resetStaleEvaluatingDistillationCandidates(params: {
  source: DistillationCandidateSourceRef;
  inputHash: string;
  promptVersion: string;
}): Promise<void> {
  const staleAfterMs = Math.max(60_000, groupedConfig.distillation.timeoutMs * 2);
  const staleBefore = new Date(Date.now() - staleAfterMs);
  const now = new Date();
  await db
    .update(distillationCandidates)
    .set({
      status: "failed",
      rejectionReason: "stale_evaluating_candidate_reclaimed",
      evaluatedAt: now,
      updatedAt: now,
      metadata: sql`${distillationCandidates.metadata} || ${JSON.stringify({
        failureKind: "stale_evaluating",
        reclaimedAt: now.toISOString(),
      })}::jsonb` as never,
    })
    .where(
      and(
        ...sourceFilters(params.source),
        eq(distillationCandidates.inputHash, params.inputHash),
        eq(distillationCandidates.promptVersion, params.promptVersion),
        eq(distillationCandidates.status, "evaluating"),
        lt(distillationCandidates.updatedAt, staleBefore),
      ),
    );
}

export function listPromotionReadyDistillationCandidates(params: {
  source: DistillationCandidateSourceRef;
  inputHash: string;
  promptVersion: string;
  limit?: number;
}): Promise<DistillationCandidateRow[]> {
  return listDistillationCandidatesForInput({
    source: params.source,
    inputHash: params.inputHash,
    promptVersion: params.promptVersion,
    statuses: ["verified"],
    limit: params.limit,
  });
}

export async function claimDistillationCandidateForEvaluation(
  id: string,
): Promise<DistillationCandidateRow | null> {
  const [row] = await db
    .update(distillationCandidates)
    .set({
      status: "evaluating",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(distillationCandidates.id, id),
        inArray(distillationCandidates.status, ["extracted", "failed"]),
      ),
    )
    .returning();
  return row ?? null;
}

export async function markDistillationCandidateEvaluating(id: string): Promise<void> {
  await claimDistillationCandidateForEvaluation(id);
}

export async function updateDistillationCandidateEvaluation(params: {
  id: string;
  status: Exclude<DistillationCandidateStatus, "extracted" | "evaluating">;
  candidate?: DistilledKnowledgeCandidate;
  rejectionReason?: string | null;
  knowledgeId?: string | null;
  toolEvents?: DistillationToolResult[];
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const set: Partial<typeof distillationCandidates.$inferInsert> = {
    status: params.status,
    rejectionReason: params.rejectionReason ?? null,
    knowledgeId: params.knowledgeId ?? null,
    evaluatedAt: new Date(),
    updatedAt: new Date(),
  };

  if (params.candidate) {
    set.type = params.candidate.type;
    set.title = params.candidate.title;
    set.body = params.candidate.body;
    set.confidence = params.candidate.confidence;
    set.importance = params.candidate.importance;
  }
  if (params.toolEvents) {
    set.toolEvents = params.toolEvents;
  }
  if (params.metadata) {
    set.metadata = params.metadata;
  }

  await db.update(distillationCandidates).set(set).where(eq(distillationCandidates.id, params.id));
}

export async function attachDistillationCandidateRun(params: {
  source: DistillationCandidateSourceRef;
  inputHash: string;
  promptVersion: string;
  vibeMemoryRunId?: string | null;
  sourceRunId?: string | null;
}): Promise<void> {
  const set: Partial<typeof distillationCandidates.$inferInsert> = {};
  if (params.vibeMemoryRunId !== undefined) {
    set.vibeMemoryRunId = params.vibeMemoryRunId;
  }
  if (params.sourceRunId !== undefined) {
    set.sourceRunId = params.sourceRunId;
  }
  if (Object.keys(set).length === 0) return;

  await db
    .update(distillationCandidates)
    .set(set)
    .where(
      and(
        ...sourceFilters(params.source),
        eq(distillationCandidates.inputHash, params.inputHash),
        eq(distillationCandidates.promptVersion, params.promptVersion),
      ),
    );
}
