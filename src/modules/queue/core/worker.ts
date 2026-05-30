import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { groupedConfig } from "../../../config.js";
import { APP_CONSTANTS } from "../../../constants.js";
import { db } from "../../../db/index.js";
import {
  coveringEvidenceQueue,
  evidenceCoverageResults,
  finalizeDistilleQueue,
  findingCandidateQueue,
  foundCandidates,
  premiumCoveringEvidenceQueue,
} from "../../../db/schema.js";
import { asRecord } from "../../../shared/utils/normalize.js";
import { runCoverEvidence } from "../../coverEvidence/domain.js";
import type { CoverEvidenceResult } from "../../coverEvidence/types.js";
import { runFinalizeDistille } from "../../finalizeDistille/domain.js";
import { type FindCandidateResult, runFindCandidate } from "../../findCandidate/domain.js";
import { researchWebSourceToMarkdown } from "../../sources/web/source-research.service.js";
import { claimNextQueueJob } from "./claim.js";
import { isQueuePaused } from "./control.js";
import { appendQueueEvent } from "./events.js";
import { pauseQueueJob } from "./state.js";
import { type DistillationQueueName, queueTableNameByQueue } from "./types.js";

type QueueRunResult = {
  ok: boolean;
  queue: DistillationQueueName;
  worker: string;
  idle: boolean;
  claimedJobId: string | null;
  message: string;
  completedJobId?: string;
};

type FindingSourceKind = "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest";

type ProvidedCandidatePayload = {
  title: string;
  body: string;
  type?: "rule" | "procedure";
  sourceSummary?: string;
  origin?: Record<string, unknown>;
};

const retryableCoverStatuses = new Set<CoverEvidenceResult["status"]>([
  "reprocess_requested",
  "tool_failed",
  "provider_failed",
  "parse_failed",
]);

function mappedEvidenceStatus(
  status: CoverEvidenceResult["status"],
):
  | "knowledge_ready"
  | "duplicate"
  | "near_duplicate"
  | "insufficient"
  | "parse_failed"
  | "tool_failed"
  | "provider_failed" {
  return status === "reprocess_requested" ? "provider_failed" : status;
}

function appliesToFromCoverCandidate(
  candidate: CoverEvidenceResult["candidate"],
): Record<string, unknown> {
  if (!candidate) return {};
  return {
    ...(candidate.applicabilityGeneral !== undefined
      ? { general: candidate.applicabilityGeneral }
      : {}),
    ...(candidate.technologies?.length ? { technologies: candidate.technologies } : {}),
    ...(candidate.changeTypes?.length ? { changeTypes: candidate.changeTypes } : {}),
    ...(candidate.domains?.length ? { domains: candidate.domains } : {}),
    ...(candidate.repoPath ? { repoPath: candidate.repoPath } : {}),
    ...(candidate.repoKey ? { repoKey: candidate.repoKey } : {}),
  };
}

function priorityForSourceKind(sourceKind: FindingSourceKind): number {
  switch (sourceKind) {
    case "knowledge_candidate":
      return 90;
    case "web_ingest":
      return 80;
    case "wiki_file":
      return 70;
    default:
      return 50;
  }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isMissingSourceError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("enoent") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("vibe memory not found")
  );
}

function parseProvidedCandidatePayload(value: unknown): ProvidedCandidatePayload | null {
  const record = asRecord(value);
  const title = asNonEmptyString(record.title);
  const body = asNonEmptyString(record.body);
  if (!title || !body) return null;
  const typeRaw = asNonEmptyString(record.type);
  const sourceSummary = asNonEmptyString(record.sourceSummary) ?? undefined;
  const origin = asRecord(record.origin);
  return {
    title,
    body,
    type: typeRaw === "procedure" ? "procedure" : typeRaw === "rule" ? "rule" : undefined,
    sourceSummary,
    origin,
  };
}

async function markFindingCompleted(params: {
  jobId: string;
  status: "completed" | "skipped";
  outcome: string;
}): Promise<void> {
  await db
    .update(findingCandidateQueue)
    .set({
      status: params.status,
      completedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: null,
      lastOutcomeKind: params.outcome,
      updatedAt: new Date(),
    })
    .where(eq(findingCandidateQueue.id, params.jobId));
}

async function markFindingFailed(params: { jobId: string; error: string }): Promise<void> {
  const [current] = await db
    .select({ attemptCount: findingCandidateQueue.attemptCount })
    .from(findingCandidateQueue)
    .where(eq(findingCandidateQueue.id, params.jobId))
    .limit(1);
  await db
    .update(findingCandidateQueue)
    .set({
      status: "failed",
      attemptCount: (current?.attemptCount ?? 0) + 1,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: params.error.slice(0, 2000),
      lastOutcomeKind: "failed",
      updatedAt: new Date(),
    })
    .where(eq(findingCandidateQueue.id, params.jobId));
}

async function enqueueCoveringJob(params: {
  foundCandidateId: string;
  distillationVersion: string;
  providerPolicy?: "default" | "cloud_api";
  priority?: number;
}): Promise<void> {
  await db
    .insert(coveringEvidenceQueue)
    .values({
      foundCandidateId: params.foundCandidateId,
      distillationVersion: params.distillationVersion,
      status: "pending",
      priority: params.priority ?? 50,
      providerPolicy: params.providerPolicy ?? "default",
      payload: {},
      metadata: {},
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: coveringEvidenceQueue.foundCandidateId });
}

async function upsertFoundCandidateRow(params: {
  findingJobId: string;
  candidateIndex: number;
  title: string;
  content: string;
  type?: "rule" | "procedure";
  sourceSummary?: string;
  origin?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const [row] = await db
    .insert(foundCandidates)
    .values({
      findingJobId: params.findingJobId,
      candidateIndex: params.candidateIndex,
      type: params.type ?? null,
      title: params.title,
      content: params.content,
      sourceSummary: params.sourceSummary ?? null,
      origin: params.origin ?? {},
      metadata: params.metadata ?? {},
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [foundCandidates.findingJobId, foundCandidates.candidateIndex],
      set: {
        type: params.type ?? null,
        title: params.title,
        content: params.content,
        sourceSummary: params.sourceSummary ?? null,
        origin: params.origin ?? {},
        metadata: params.metadata ?? {},
        updatedAt: new Date(),
      },
    })
    .returning({ id: foundCandidates.id });
  if (!row) throw new Error("failed to upsert found_candidates row");
  return row.id;
}

async function runSourceTargetFindCandidate(params: {
  findingJob: typeof findingCandidateQueue.$inferSelect;
  signal?: AbortSignal;
}): Promise<FindCandidateResult> {
  const sourceKind = params.findingJob.sourceKind as FindingSourceKind;
  let targetKey = params.findingJob.sourceKey;
  let sourceUri = params.findingJob.sourceUri;

  if (sourceKind === "web_ingest") {
    const sourceUrl =
      sourceUri.startsWith("http://") || sourceUri.startsWith("https://") ? sourceUri : targetKey;
    const research = await researchWebSourceToMarkdown({
      url: sourceUrl,
      normalizedUrl: targetKey,
    });
    targetKey = research.savedWikiTargetKey;
    sourceUri = research.savedWikiTargetKey;
  }
  if (sourceKind === "knowledge_candidate") {
    throw new Error("knowledge_candidate source_target is not supported");
  }

  return runFindCandidate({
    sourceInput: {
      targetKind: sourceKind,
      targetKey,
      sourceUri,
    },
    callerMode: "cli_text",
    signal: params.signal,
  });
}

async function processFindingCandidate(jobId: string, signal?: AbortSignal): Promise<void> {
  const [job] = await db
    .select()
    .from(findingCandidateQueue)
    .where(eq(findingCandidateQueue.id, jobId))
    .limit(1);
  if (!job) throw new Error(`finding queue job not found: ${jobId}`);

  await appendQueueEvent({
    queueName: "findingCandidate",
    queueJobId: job.id,
    eventType: "claimed",
    message: "finding candidate claimed",
  });

  if (job.inputKind === "provided_candidate") {
    const payload = parseProvidedCandidatePayload(job.payload);
    if (!payload) {
      throw new Error("provided_candidate payload is invalid");
    }
    const foundCandidateId = await upsertFoundCandidateRow({
      findingJobId: job.id,
      candidateIndex: 0,
      title: payload.title,
      content: payload.body,
      type: payload.type,
      sourceSummary: payload.sourceSummary,
      origin: {
        ...(payload.origin ?? {}),
        queueVersion: "v2",
        providedCandidate: true,
      },
      metadata: {
        sourceKind: job.sourceKind,
        sourceKey: job.sourceKey,
        sourceUri: job.sourceUri,
      },
    });
    await enqueueCoveringJob({
      foundCandidateId,
      distillationVersion: job.distillationVersion,
      providerPolicy: "default",
      priority: job.priority,
    });
    await markFindingCompleted({
      jobId: job.id,
      status: "completed",
      outcome: "provided_candidate_registered",
    });
    await appendQueueEvent({
      queueName: "findingCandidate",
      queueJobId: job.id,
      eventType: "completed",
      message: "provided candidate moved to covering queue",
      metadata: { foundCandidateId },
    });
    return;
  }

  const findResult = await runSourceTargetFindCandidate({ findingJob: job, signal });
  const candidates = findResult.candidates;
  const foundCandidateIds: string[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const foundCandidateId = await upsertFoundCandidateRow({
      findingJobId: job.id,
      candidateIndex: index,
      type: candidate.type,
      title: candidate.title,
      content: candidate.content,
      sourceSummary: candidate.sourceSummary,
      origin: {
        queueVersion: "v2",
        sourceKind: job.sourceKind,
        sourceKey: job.sourceKey,
        sourceUri: job.sourceUri,
      },
      metadata: {
        sourceKind: job.sourceKind,
        sourceKey: job.sourceKey,
        sourceUri: job.sourceUri,
        readRanges: findResult.readRanges,
      },
    });
    foundCandidateIds.push(foundCandidateId);
    await enqueueCoveringJob({
      foundCandidateId,
      distillationVersion: job.distillationVersion,
      providerPolicy: "default",
      priority: job.priority,
    });
  }

  if (foundCandidateIds.length === 0) {
    await markFindingCompleted({
      jobId: job.id,
      status: "skipped",
      outcome: "no_candidate",
    });
    await appendQueueEvent({
      queueName: "findingCandidate",
      queueJobId: job.id,
      eventType: "completed",
      message: "no candidate found",
    });
    return;
  }

  await markFindingCompleted({
    jobId: job.id,
    status: "completed",
    outcome: "candidates_found",
  });
  await appendQueueEvent({
    queueName: "findingCandidate",
    queueJobId: job.id,
    eventType: "completed",
    message: "finding candidate completed",
    metadata: {
      candidateCount: foundCandidateIds.length,
      foundCandidateIds,
    },
  });
}

async function markCoveringCompleted(params: {
  queue: "coveringEvidence" | "premiumCoveringEvidence";
  jobId: string;
  status: "completed" | "failed" | "paused" | "skipped";
  attemptCount?: number;
  nextRunAt?: Date | null;
  outcome: string;
  lastError?: string | null;
}): Promise<void> {
  const table =
    params.queue === "coveringEvidence" ? coveringEvidenceQueue : premiumCoveringEvidenceQueue;
  await db
    .update(table)
    .set({
      status: params.status,
      attemptCount: params.attemptCount ?? table.attemptCount,
      nextRunAt: params.nextRunAt ?? null,
      completedAt: params.status === "completed" || params.status === "skipped" ? new Date() : null,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: params.lastError ?? null,
      lastOutcomeKind: params.outcome,
      updatedAt: new Date(),
    })
    .where(eq(table.id, params.jobId));
}

async function processCoveringJob(
  queue: "coveringEvidence" | "premiumCoveringEvidence",
  jobId: string,
  signal?: AbortSignal,
): Promise<void> {
  const table = queue === "coveringEvidence" ? coveringEvidenceQueue : premiumCoveringEvidenceQueue;
  const [job] = await db.select().from(table).where(eq(table.id, jobId)).limit(1);
  if (!job) throw new Error(`${queue} job not found: ${jobId}`);

  const [candidate] = await db
    .select()
    .from(foundCandidates)
    .where(eq(foundCandidates.id, job.foundCandidateId))
    .limit(1);
  if (!candidate) throw new Error(`found candidate not found: ${job.foundCandidateId}`);

  await appendQueueEvent({
    queueName: queue,
    queueJobId: job.id,
    eventType: "claimed",
    message: "covering evidence claimed",
  });

  const origin = asRecord(candidate.origin);
  const [findingJob] = await db
    .select()
    .from(findingCandidateQueue)
    .where(eq(findingCandidateQueue.id, candidate.findingJobId))
    .limit(1);
  if (!findingJob) throw new Error(`finding job not found: ${candidate.findingJobId}`);

  const sourceKind =
    findingJob.sourceKind === "web_ingest" ||
    findingJob.sourceKind === "wiki_file" ||
    findingJob.sourceKind === "vibe_memory" ||
    findingJob.sourceKind === "knowledge_candidate"
      ? findingJob.sourceKind
      : "vibe_memory";
  const queuePayload = asRecord(job.payload);
  const forceRefreshEvidence = queuePayload.forceRefreshEvidence === true;
  const cover = await runCoverEvidence({
    id: candidate.id,
    candidate: {
      id: candidate.id,
      status: "selected",
      title: candidate.title,
      content: candidate.content,
      origin: candidate.origin,
      targetStateId: null,
      targetKind: sourceKind,
      targetKey: findingJob.sourceKey,
      sourceUri: findingJob.sourceUri,
    },
    providerPolicy: (job.providerPolicy as "default" | "cloud_api") ?? "default",
    write: false,
    forceRefreshEvidence,
    signal,
  });

  const mappedStatus = mappedEvidenceStatus(cover.result.status);

  let evidenceResultId: string | null = null;
  if (mappedStatus) {
    const [saved] = await db
      .insert(evidenceCoverageResults)
      .values({
        foundCandidateId: candidate.id,
        producerQueue: queue,
        producerJobId: job.id,
        distillationVersion: job.distillationVersion,
        status: mappedStatus,
        stage: cover.result.stage,
        type: cover.result.candidate?.type ?? candidate.type ?? null,
        title: cover.result.candidate?.title ?? candidate.title,
        body: cover.result.candidate?.body ?? candidate.content,
        importance: cover.result.candidate?.importance ?? null,
        confidence: cover.result.candidate?.confidence ?? null,
        appliesTo: appliesToFromCoverCandidate(cover.result.candidate),
        references: cover.result.references,
        duplicateRefs: cover.result.duplicateRefs,
        toolEvents: cover.result.toolEvents,
        reason: cover.result.reason,
        metadata: {
          queueVersion: "v2",
        },
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [evidenceCoverageResults.foundCandidateId, evidenceCoverageResults.producerQueue],
        set: {
          status: mappedStatus,
          stage: cover.result.stage,
          type: cover.result.candidate?.type ?? candidate.type ?? null,
          title: cover.result.candidate?.title ?? candidate.title,
          body: cover.result.candidate?.body ?? candidate.content,
          importance: cover.result.candidate?.importance ?? null,
          confidence: cover.result.candidate?.confidence ?? null,
          appliesTo: appliesToFromCoverCandidate(cover.result.candidate),
          references: cover.result.references,
          duplicateRefs: cover.result.duplicateRefs,
          toolEvents: cover.result.toolEvents,
          reason: cover.result.reason,
          metadata: {
            queueVersion: "v2",
          },
          updatedAt: new Date(),
        },
      })
      .returning({ id: evidenceCoverageResults.id });
    evidenceResultId = saved?.id ?? null;
  }

  const nextAttemptCount = job.attemptCount + 1;
  const exhausted = nextAttemptCount >= job.maxAttempts;

  if (cover.result.status === "knowledge_ready" && evidenceResultId) {
    await db
      .insert(finalizeDistilleQueue)
      .values({
        evidenceResultId,
        distillationVersion: job.distillationVersion,
        status: "pending",
        priority: priorityForSourceKind(
          (candidate.metadata as Record<string, unknown> | null)?.sourceKind === "web_ingest"
            ? "web_ingest"
            : (candidate.metadata as Record<string, unknown> | null)?.sourceKind === "wiki_file"
              ? "wiki_file"
              : (candidate.metadata as Record<string, unknown> | null)?.sourceKind ===
                  "knowledge_candidate"
                ? "knowledge_candidate"
                : "vibe_memory",
        ),
        providerPolicy: job.providerPolicy,
        metadata: {
          queueVersion: "v2",
          sourceQueue: queue,
          sourceQueueJobId: job.id,
        },
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: finalizeDistilleQueue.evidenceResultId });
  }

  if (retryableCoverStatuses.has(cover.result.status)) {
    if (exhausted) {
      await markCoveringCompleted({
        queue,
        jobId: job.id,
        status: "failed",
        attemptCount: nextAttemptCount,
        outcome: cover.result.status,
        lastError: cover.result.reason ?? cover.result.status,
      });
      return;
    }
    await markCoveringCompleted({
      queue,
      jobId: job.id,
      status: "paused",
      attemptCount: nextAttemptCount,
      nextRunAt: new Date(Date.now()),
      outcome: cover.result.status,
      lastError: cover.result.reason ?? cover.result.status,
    });
    return;
  }

  await markCoveringCompleted({
    queue,
    jobId: job.id,
    status:
      cover.result.status === "knowledge_ready" ||
      cover.result.status === "duplicate" ||
      cover.result.status === "near_duplicate" ||
      cover.result.status === "insufficient"
        ? "completed"
        : "failed",
    attemptCount: nextAttemptCount,
    outcome: cover.result.status,
    lastError: cover.result.reason ?? null,
  });
}

function queueTargetKindFromSourceKind(
  sourceKind: string,
): "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest" {
  if (sourceKind === "wiki_file") return "wiki_file";
  if (sourceKind === "web_ingest") return "web_ingest";
  if (sourceKind === "knowledge_candidate") return "knowledge_candidate";
  return "vibe_memory";
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function processFinalizeJob(jobId: string, signal?: AbortSignal): Promise<void> {
  const [job] = await db
    .select()
    .from(finalizeDistilleQueue)
    .where(eq(finalizeDistilleQueue.id, jobId))
    .limit(1);
  if (!job) throw new Error(`finalize job not found: ${jobId}`);

  const [evidence] = await db
    .select()
    .from(evidenceCoverageResults)
    .where(eq(evidenceCoverageResults.id, job.evidenceResultId))
    .limit(1);
  if (!evidence) throw new Error(`evidence result not found: ${job.evidenceResultId}`);
  const [candidate] = await db
    .select()
    .from(foundCandidates)
    .where(eq(foundCandidates.id, evidence.foundCandidateId))
    .limit(1);
  if (!candidate) throw new Error(`found candidate not found: ${evidence.foundCandidateId}`);
  const [findingJob] = await db
    .select()
    .from(findingCandidateQueue)
    .where(eq(findingCandidateQueue.id, candidate.findingJobId))
    .limit(1);
  if (!findingJob) throw new Error(`finding job not found: ${candidate.findingJobId}`);

  await appendQueueEvent({
    queueName: "finalizeDistille",
    queueJobId: job.id,
    eventType: "claimed",
    message: "finalize claimed",
  });

  const appliesTo = asRecord(evidence.appliesTo);
  const candidateTypeRaw =
    evidence.type === "rule" || evidence.type === "procedure"
      ? evidence.type
      : candidate.type === "rule" || candidate.type === "procedure"
        ? candidate.type
        : null;
  const technologies = Array.isArray(appliesTo.technologies)
    ? appliesTo.technologies.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const changeTypes = Array.isArray(appliesTo.changeTypes)
    ? appliesTo.changeTypes.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const domains = Array.isArray(appliesTo.domains)
    ? appliesTo.domains.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const queueCoverResult: CoverEvidenceResult = {
    schemaVersion: 1,
    status:
      evidence.status === "knowledge_ready" ||
      evidence.status === "duplicate" ||
      evidence.status === "near_duplicate" ||
      evidence.status === "insufficient" ||
      evidence.status === "parse_failed" ||
      evidence.status === "tool_failed" ||
      evidence.status === "provider_failed"
        ? evidence.status
        : "parse_failed",
    stage:
      evidence.stage === "load" ||
      evidence.stage === "source_support" ||
      evidence.stage === "dedupe" ||
      evidence.stage === "evidence_need" ||
      evidence.stage === "web" ||
      evidence.stage === "mcp" ||
      evidence.stage === "final"
        ? evidence.stage
        : "final",
    candidate:
      candidateTypeRaw && evidence.title && evidence.body
        ? {
            type: candidateTypeRaw,
            title: evidence.title,
            body: evidence.body,
            importance: Number(evidence.importance ?? 70),
            confidence: Number(evidence.confidence ?? 70),
            ...(typeof appliesTo.general === "boolean"
              ? { applicabilityGeneral: appliesTo.general }
              : {}),
            ...(technologies?.length ? { technologies } : {}),
            ...(changeTypes?.length ? { changeTypes } : {}),
            ...(domains?.length ? { domains } : {}),
            ...(typeof appliesTo.repoPath === "string" ? { repoPath: appliesTo.repoPath } : {}),
            ...(typeof appliesTo.repoKey === "string" ? { repoKey: appliesTo.repoKey } : {}),
          }
        : null,
    references: asArray<CoverEvidenceResult["references"][number]>(evidence.references),
    duplicateRefs: asArray<CoverEvidenceResult["duplicateRefs"][number]>(evidence.duplicateRefs),
    toolEvents: asArray<CoverEvidenceResult["toolEvents"][number]>(evidence.toolEvents),
    reason: typeof evidence.reason === "string" ? evidence.reason : null,
  };
  const finalized = await runFinalizeDistille({
    coverEvidenceResultId: evidence.id,
    resultOverride: queueCoverResult,
    candidateContext: {
      foundCandidateId: candidate.id,
      targetStateId: null,
      findCandidateResultId: null,
      targetKind: queueTargetKindFromSourceKind(findingJob.sourceKind),
      targetKey: findingJob.sourceKey,
      sourceUri: findingJob.sourceUri,
    },
    write: true,
    signal,
  });

  const status =
    finalized.status === "stored"
      ? "completed"
      : finalized.status === "rejected"
        ? "skipped"
        : "failed";
  await db
    .update(finalizeDistilleQueue)
    .set({
      status,
      attemptCount: job.attemptCount + 1,
      knowledgeId: finalized.knowledgeId,
      completedAt: status === "completed" || status === "skipped" ? new Date() : null,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: finalized.reason,
      lastOutcomeKind: finalized.status,
      updatedAt: new Date(),
    })
    .where(eq(finalizeDistilleQueue.id, job.id));

  await appendQueueEvent({
    queueName: "finalizeDistille",
    queueJobId: job.id,
    eventType: "completed",
    message: "finalize completed",
    metadata: {
      finalizeStatus: finalized.status,
      knowledgeId: finalized.knowledgeId,
    },
  });
}

async function runWithHeartbeat<T>(params: {
  queueName: DistillationQueueName;
  jobId: string;
  run: () => Promise<T>;
}): Promise<T> {
  const tableName = queueTableNameByQueue[params.queueName];
  const heartbeatMs = 30_000;
  const timer = setInterval(() => {
    void db.execute(sql`
      update ${sql.raw(tableName)}
      set
        heartbeat_at = now(),
        updated_at = now()
      where id = ${params.jobId}
        and status = 'running'
    `);
  }, heartbeatMs);
  try {
    return await params.run();
  } finally {
    clearInterval(timer);
  }
}

async function runWithTimeout<T>(params: {
  timeoutMs: number;
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const timeoutMs = Math.max(1_000, Math.floor(params.timeoutMs));
  const timeoutController = new AbortController();
  const mergedController = new AbortController();
  const abortMerged = (reason: unknown) => {
    if (!mergedController.signal.aborted) {
      mergedController.abort(reason);
    }
  };

  timeoutController.signal.addEventListener(
    "abort",
    () => {
      abortMerged(timeoutController.signal.reason ?? "queue_job_timeout");
    },
    { once: true },
  );
  if (params.signal) {
    if (params.signal.aborted) {
      abortMerged(params.signal.reason ?? "queue_control_aborted");
    } else {
      params.signal.addEventListener(
        "abort",
        () => {
          abortMerged(params.signal?.reason ?? "queue_control_aborted");
        },
        { once: true },
      );
    }
  }

  const timer = setTimeout(() => {
    timeoutController.abort("queue_job_timeout");
  }, timeoutMs);
  try {
    return await params.run(mergedController.signal);
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "name" in error) {
    return (error as { name?: string }).name === "AbortError";
  }
  return false;
}

export async function runQueueWorkerOnce(params: {
  queueName: DistillationQueueName;
  workerId: string;
}): Promise<QueueRunResult> {
  if (await isQueuePaused(params.queueName)) {
    return {
      ok: true,
      queue: params.queueName,
      worker: params.workerId,
      idle: true,
      claimedJobId: null,
      message: "queue paused by lane control",
    };
  }

  const claimed = await claimNextQueueJob({
    queueName: params.queueName,
    workerId: params.workerId,
  });
  if (!claimed) {
    return {
      ok: true,
      queue: params.queueName,
      worker: params.workerId,
      idle: true,
      claimedJobId: null,
      message: "no runnable job",
    };
  }

  try {
    const pauseController = new AbortController();
    const pausePollTimer = setInterval(() => {
      void (async () => {
        const paused = await isQueuePaused(params.queueName);
        if (paused && !pauseController.signal.aborted) {
          pauseController.abort("queue_lane_paused");
        }
      })().catch(() => {
        // Ignore transient control-plane read errors and continue worker cycle.
      });
    }, 2_000);
    if (await isQueuePaused(params.queueName)) {
      pauseController.abort("queue_lane_paused");
    }

    try {
      await runWithHeartbeat({
        queueName: params.queueName,
        jobId: claimed.id,
        run: async () => {
          if (params.queueName === "findingCandidate") {
            await runWithTimeout({
              timeoutMs: groupedConfig.distillation.findCandidateTimeoutMs,
              signal: pauseController.signal,
              run: (signal) => processFindingCandidate(claimed.id, signal),
            });
          } else if (params.queueName === "coveringEvidence") {
            await runWithTimeout({
              timeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
              signal: pauseController.signal,
              run: (signal) => processCoveringJob("coveringEvidence", claimed.id, signal),
            });
          } else if (params.queueName === "premiumCoveringEvidence") {
            await runWithTimeout({
              timeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
              signal: pauseController.signal,
              run: (signal) => processCoveringJob("premiumCoveringEvidence", claimed.id, signal),
            });
          } else {
            await runWithTimeout({
              timeoutMs: groupedConfig.distillation.timeoutMs,
              signal: pauseController.signal,
              run: (signal) => processFinalizeJob(claimed.id, signal),
            });
          }
        },
      });
    } finally {
      clearInterval(pausePollTimer);
    }

    return {
      ok: true,
      queue: params.queueName,
      worker: params.workerId,
      idle: false,
      claimedJobId: claimed.id,
      completedJobId: claimed.id,
      message: "processed job",
    };
  } catch (error) {
    const pausedByLaneControl =
      (typeof error === "string" && error.includes("queue_lane_paused")) ||
      (error instanceof Error && error.message.includes("queue_lane_paused")) ||
      isAbortError(error);
    const message = error instanceof Error ? error.message : String(error);
    if (pausedByLaneControl && (await isQueuePaused(params.queueName))) {
      await pauseQueueJob({
        queueName: params.queueName,
        id: claimed.id,
        reason: "paused by queue lane control",
      });
      await appendQueueEvent({
        queueName: params.queueName,
        queueJobId: claimed.id,
        eventType: "paused",
        message: "paused by queue lane control",
      });
      return {
        ok: true,
        queue: params.queueName,
        worker: params.workerId,
        idle: false,
        claimedJobId: claimed.id,
        message: "paused by queue lane control",
      };
    }

    if (params.queueName === "findingCandidate") {
      if (isMissingSourceError(message)) {
        await markFindingCompleted({
          jobId: claimed.id,
          status: "skipped",
          outcome: "source_missing",
        });
        await appendQueueEvent({
          queueName: params.queueName,
          queueJobId: claimed.id,
          eventType: "completed",
          message: "source missing skipped",
          metadata: {
            reason: message,
          },
        });
        return {
          ok: true,
          queue: params.queueName,
          worker: params.workerId,
          idle: false,
          claimedJobId: claimed.id,
          completedJobId: claimed.id,
          message: "source missing skipped",
        };
      }
      await markFindingFailed({
        jobId: claimed.id,
        error: message,
      });
    } else if (
      params.queueName === "coveringEvidence" ||
      params.queueName === "premiumCoveringEvidence"
    ) {
      const table =
        params.queueName === "coveringEvidence"
          ? coveringEvidenceQueue
          : premiumCoveringEvidenceQueue;
      const [current] = await db.select().from(table).where(eq(table.id, claimed.id)).limit(1);
      const currentAttempt = current?.attemptCount ?? 0;
      await markCoveringCompleted({
        queue: params.queueName,
        jobId: claimed.id,
        status: "failed",
        attemptCount: currentAttempt + 1,
        outcome: "failed",
        lastError: message,
      });
    } else {
      const [current] = await db
        .select()
        .from(finalizeDistilleQueue)
        .where(eq(finalizeDistilleQueue.id, claimed.id))
        .limit(1);
      const currentAttempt = current?.attemptCount ?? 0;
      await db
        .update(finalizeDistilleQueue)
        .set({
          status: "failed",
          attemptCount: currentAttempt + 1,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          lastError: message,
          lastOutcomeKind: "failed",
          updatedAt: new Date(),
        })
        .where(eq(finalizeDistilleQueue.id, claimed.id));
    }
    await appendQueueEvent({
      queueName: params.queueName,
      queueJobId: claimed.id,
      eventType: "paused",
      message: "worker failed",
      metadata: {
        error: message,
      },
    });
    return {
      ok: params.queueName === "findingCandidate" && isMissingSourceError(message),
      queue: params.queueName,
      worker: params.workerId,
      idle: false,
      claimedJobId: claimed.id,
      message,
    };
  }
}

export async function enqueueFindingJob(params: {
  inputKind: "source_target" | "provided_candidate";
  sourceKind: FindingSourceKind;
  sourceKey: string;
  sourceUri: string;
  distillationVersion?: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  priority?: number;
}): Promise<typeof findingCandidateQueue.$inferSelect> {
  const distillationVersion = params.distillationVersion ?? APP_CONSTANTS.distillationTargetVersion;
  const priority = params.priority ?? priorityForSourceKind(params.sourceKind);
  const [row] = await db
    .insert(findingCandidateQueue)
    .values({
      inputKind: params.inputKind,
      sourceKind: params.sourceKind,
      sourceKey: params.sourceKey,
      sourceUri: params.sourceUri,
      distillationVersion,
      payload: params.payload ?? {},
      metadata: params.metadata ?? {},
      priority,
      status: "pending",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        findingCandidateQueue.inputKind,
        findingCandidateQueue.sourceKind,
        findingCandidateQueue.sourceKey,
        findingCandidateQueue.distillationVersion,
      ],
      set: {
        sourceUri: params.sourceUri,
        payload: params.payload ?? {},
        metadata: params.metadata ?? {},
        priority,
        nextRunAt: null,
        completedAt: null,
        status: "pending",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("failed to enqueue finding candidate job");
  await appendQueueEvent({
    queueName: "findingCandidate",
    queueJobId: row.id,
    eventType: "enqueued",
    message: "finding candidate enqueued",
    metadata: {
      sourceKind: row.sourceKind,
      sourceKey: row.sourceKey,
      inputKind: row.inputKind,
    },
  });
  return row;
}

export async function findFindingJob(params: {
  inputKind: "source_target" | "provided_candidate";
  sourceKind: FindingSourceKind;
  sourceKey: string;
  distillationVersion?: string;
}): Promise<typeof findingCandidateQueue.$inferSelect | null> {
  const distillationVersion = params.distillationVersion ?? APP_CONSTANTS.distillationTargetVersion;
  const [row] = await db
    .select()
    .from(findingCandidateQueue)
    .where(
      and(
        eq(findingCandidateQueue.inputKind, params.inputKind),
        eq(findingCandidateQueue.sourceKind, params.sourceKind),
        eq(findingCandidateQueue.sourceKey, params.sourceKey),
        eq(findingCandidateQueue.distillationVersion, distillationVersion),
      ),
    )
    .limit(1);
  return row ?? null;
}
