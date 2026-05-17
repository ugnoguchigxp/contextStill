import os from "node:os";
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { distillationJobs } from "../../db/schema.js";
import type { DistillationCandidateSourceRef } from "./distillation-candidate.repository.js";
import type { DistillationOutcomeKind } from "./distillation-outcomes.js";

export type DistillationJobRow = typeof distillationJobs.$inferSelect;
export type DistillationJobPhase =
  | "pending"
  | "reading"
  | "extracting"
  | "verifying"
  | "promoting"
  | "completed";
export type DistillationJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "skipped"
  | "failed";

function sourceValues(source: DistillationCandidateSourceRef) {
  return source.sourceKind === "vibe_memory"
    ? {
        sourceKind: source.sourceKind,
        vibeMemoryId: source.vibeMemoryId,
        sourceFragmentId: null,
      }
    : {
        sourceKind: source.sourceKind,
        vibeMemoryId: null,
        sourceFragmentId: source.sourceFragmentId,
      };
}

function sourceFilters(source: DistillationCandidateSourceRef) {
  return source.sourceKind === "vibe_memory"
    ? [
        eq(distillationJobs.sourceKind, source.sourceKind),
        eq(distillationJobs.vibeMemoryId, source.vibeMemoryId),
      ]
    : [
        eq(distillationJobs.sourceKind, source.sourceKind),
        eq(distillationJobs.sourceFragmentId, source.sourceFragmentId),
      ];
}

function conflictTarget(source: DistillationCandidateSourceRef) {
  return source.sourceKind === "vibe_memory"
    ? [distillationJobs.vibeMemoryId, distillationJobs.promptVersion, distillationJobs.inputHash]
    : [
        distillationJobs.sourceFragmentId,
        distillationJobs.promptVersion,
        distillationJobs.inputHash,
      ];
}

function conflictWhere(source: DistillationCandidateSourceRef) {
  return source.sourceKind === "vibe_memory"
    ? distillationJobs.vibeMemoryId
    : distillationJobs.sourceFragmentId;
}

function workerId(): string {
  return `${os.hostname()}:${process.pid}`;
}

export async function upsertDistillationJob(params: {
  source: DistillationCandidateSourceRef;
  inputHash: string;
  promptVersion: string;
  budget?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<DistillationJobRow> {
  const now = new Date();
  const [job] = await db
    .insert(distillationJobs)
    .values({
      ...sourceValues(params.source),
      inputHash: params.inputHash,
      promptVersion: params.promptVersion,
      status: "queued",
      phase: "pending",
      budget: params.budget ?? {},
      metadata: params.metadata ?? {},
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: conflictTarget(params.source),
      targetWhere: isNotNull(conflictWhere(params.source)),
      set: {
        status: sql`
          case
            when ${distillationJobs.status} in ('completed', 'skipped') then 'queued'
            else ${distillationJobs.status}
          end
        ` as never,
        phase: sql`
          case
            when ${distillationJobs.status} in ('completed', 'skipped') then 'pending'
            else ${distillationJobs.phase}
          end
        ` as never,
        budget: params.budget ?? {},
        metadata:
          sql`${distillationJobs.metadata} || ${JSON.stringify(params.metadata ?? {})}::jsonb` as never,
        updatedAt: now,
      },
    })
    .returning();

  if (!job) {
    const [existing] = await db
      .select()
      .from(distillationJobs)
      .where(
        and(
          ...sourceFilters(params.source),
          eq(distillationJobs.inputHash, params.inputHash),
          eq(distillationJobs.promptVersion, params.promptVersion),
        ),
      )
      .limit(1);
    if (existing) return existing;
    throw new Error("failed to upsert distillation job");
  }
  return job;
}

export async function claimDistillationJob(id: string): Promise<DistillationJobRow | null> {
  const now = new Date();
  const [job] = await db
    .update(distillationJobs)
    .set({
      status: "running",
      lockedBy: workerId(),
      lockedAt: now,
      attemptCount: sql`${distillationJobs.attemptCount} + 1` as never,
      updatedAt: now,
    })
    .where(
      and(
        eq(distillationJobs.id, id),
        inArray(distillationJobs.status, ["queued", "paused", "failed"]),
        or(isNull(distillationJobs.nextRetryAt), lte(distillationJobs.nextRetryAt, now)),
      ),
    )
    .returning();
  return job ?? null;
}

export async function updateDistillationJobPhase(
  id: string | undefined,
  phase: DistillationJobPhase,
  budgetUsed?: Record<string, unknown>,
): Promise<void> {
  if (!id) return;
  await db
    .update(distillationJobs)
    .set({
      phase,
      ...(budgetUsed ? { budgetUsed } : {}),
      updatedAt: new Date(),
    })
    .where(eq(distillationJobs.id, id));
}

export async function finishDistillationJob(params: {
  id?: string;
  status: Extract<DistillationJobStatus, "completed" | "skipped" | "failed">;
  phase?: DistillationJobPhase;
  outcomeKind?: DistillationOutcomeKind;
  error?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!params.id) return;
  await db
    .update(distillationJobs)
    .set({
      status: params.status,
      phase: params.phase ?? "completed",
      lastOutcomeKind: params.outcomeKind,
      lastError: params.error ?? null,
      lockedBy: null,
      lockedAt: null,
      metadata: params.metadata
        ? (sql`${distillationJobs.metadata} || ${JSON.stringify(params.metadata)}::jsonb` as never)
        : undefined,
      updatedAt: new Date(),
    })
    .where(eq(distillationJobs.id, params.id));
}

export async function pauseDistillationJob(params: {
  id?: string;
  outcomeKind: DistillationOutcomeKind;
  error: string;
  pauseSeconds: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!params.id) return;
  const now = new Date();
  await db
    .update(distillationJobs)
    .set({
      status: "paused",
      lastOutcomeKind: params.outcomeKind,
      lastError: params.error,
      nextRetryAt: new Date(now.getTime() + params.pauseSeconds * 1000),
      lockedBy: null,
      lockedAt: null,
      metadata: params.metadata
        ? (sql`${distillationJobs.metadata} || ${JSON.stringify(params.metadata)}::jsonb` as never)
        : undefined,
      updatedAt: now,
    })
    .where(eq(distillationJobs.id, params.id));
}
