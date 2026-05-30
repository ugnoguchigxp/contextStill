import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  coverEvidenceResults,
  distillationTargetStates,
  findCandidateResults,
  knowledgeItems,
} from "../../db/schema.js";
import { parseCoverEvidenceReprocessRequest } from "../../shared/schemas/distillation-target-metadata.schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveCoverEvidenceRoutes,
} from "../settings/settings.service.js";
import {
  CoverEvidenceProviderPolicyError,
  ensureCloudApiCoverEvidenceRoutesAvailable,
} from "./provider-policy.js";

export type CoverEvidenceReprocessMode = "cloud_api";
export type CoverEvidenceReprocessActor = "user" | "system";

export type RequestCoverEvidenceReprocessInput = {
  findCandidateResultId: string;
  mode?: CoverEvidenceReprocessMode;
  actor?: CoverEvidenceReprocessActor;
  forceRefreshEvidence?: boolean;
};

export type RequestCoverEvidenceReprocessResult = {
  findCandidateResultId: string;
  coverEvidenceResultId: string;
  targetStateId: string;
  status: "queued" | "already_queued";
  mode: CoverEvidenceReprocessMode;
  previousStatus: string;
  previousReason: string | null;
};

export type CoverEvidenceReprocessErrorReason =
  | "candidate_not_found"
  | "cover_evidence_result_missing"
  | "knowledge_already_exists"
  | "target_running"
  | "cover_evidence_status_not_reprocessable"
  | "cloud_api_provider_unavailable";

export class CoverEvidenceReprocessError extends Error {
  readonly statusCode: 404 | 409;
  readonly reason: CoverEvidenceReprocessErrorReason;

  constructor(statusCode: 404 | 409, reason: CoverEvidenceReprocessErrorReason) {
    super(reason);
    this.name = "CoverEvidenceReprocessError";
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

const reprocessableStatuses = new Set([
  "insufficient",
  "provider_failed",
  "tool_failed",
  "parse_failed",
  "reprocess_requested",
]);

function normalizeReprocessReason(reason: string | null): string {
  const normalized = reason?.trim() || "unspecified";
  const withoutPrefix = normalized.startsWith("reprocess_requested:")
    ? normalized.slice("reprocess_requested:".length)
    : normalized;
  const cloudScoped = withoutPrefix.startsWith("cloud_api:")
    ? withoutPrefix
    : `cloud_api:${withoutPrefix}`;
  return `reprocess_requested:${cloudScoped}`.slice(0, 160);
}

function isCloudApiReprocessReason(reason: string | null): boolean {
  const normalized = reason?.trim() ?? "";
  return (
    normalized === "reprocess_requested:cloud_api" ||
    normalized.startsWith("reprocess_requested:cloud_api:")
  );
}

function mergeRequestedIds(params: {
  existingRequest: ReturnType<typeof parseCoverEvidenceReprocessRequest>;
  findCandidateResultId: string;
}): string[] {
  const merged = new Set<string>();
  const existingRequest =
    params.existingRequest?.mode === "cloud_api" && params.existingRequest.status === "requested"
      ? params.existingRequest
      : null;
  for (const id of existingRequest?.findCandidateResultIds ?? []) {
    const normalized = id.trim();
    if (!normalized) continue;
    merged.add(normalized);
  }
  merged.add(params.findCandidateResultId);
  return [...merged];
}

function assertCloudApiRoutesAvailable(): void {
  ensureCloudApiCoverEvidenceRoutesAvailable(resolveCoverEvidenceRoutes());
}

export async function requestCoverEvidenceReprocess(
  input: RequestCoverEvidenceReprocessInput,
): Promise<RequestCoverEvidenceReprocessResult> {
  const findCandidateResultId = input.findCandidateResultId.trim();
  if (!findCandidateResultId) {
    throw new CoverEvidenceReprocessError(404, "candidate_not_found");
  }
  const mode: CoverEvidenceReprocessMode = input.mode ?? "cloud_api";
  const actor: CoverEvidenceReprocessActor = input.actor ?? "user";
  const requestedAt = new Date();

  if (mode === "cloud_api") {
    await ensureRuntimeSettingsLoaded();
    try {
      assertCloudApiRoutesAvailable();
    } catch (error) {
      if (error instanceof CoverEvidenceProviderPolicyError) {
        throw new CoverEvidenceReprocessError(409, "cloud_api_provider_unavailable");
      }
      throw error;
    }
  }

  const [row] = await db
    .select({
      findCandidateResultId: findCandidateResults.id,
      targetStateId: findCandidateResults.targetStateId,
      targetStatus: distillationTargetStates.status,
      targetMetadata: distillationTargetStates.metadata,
      coverStatus: coverEvidenceResults.status,
      coverStage: coverEvidenceResults.stage,
      coverReason: coverEvidenceResults.reason,
      knowledgeId: knowledgeItems.id,
    })
    .from(findCandidateResults)
    .innerJoin(
      distillationTargetStates,
      eq(distillationTargetStates.id, findCandidateResults.targetStateId),
    )
    .leftJoin(coverEvidenceResults, eq(coverEvidenceResults.id, findCandidateResults.id))
    .leftJoin(
      knowledgeItems,
      sql`(${knowledgeItems.metadata}->>'coverEvidenceResultId' = ${findCandidateResults.id}::text
        or ${knowledgeItems.metadata}->>'sourceUri' = concat('cover-evidence-result://', ${findCandidateResults.id}::text))`,
    )
    .where(eq(findCandidateResults.id, findCandidateResultId))
    .limit(1);

  if (!row) {
    throw new CoverEvidenceReprocessError(404, "candidate_not_found");
  }
  if (!row.coverStatus) {
    throw new CoverEvidenceReprocessError(409, "cover_evidence_result_missing");
  }
  const coverStatus = row.coverStatus;
  const coverStage = row.coverStage;
  const coverReason = row.coverReason;
  if (row.knowledgeId) {
    throw new CoverEvidenceReprocessError(409, "knowledge_already_exists");
  }

  const existingRequest = parseCoverEvidenceReprocessRequest(row.targetMetadata);
  const alreadyQueued =
    coverStatus === "reprocess_requested" &&
    isCloudApiReprocessReason(coverReason) &&
    (existingRequest?.mode === "cloud_api" || existingRequest === null);
  if (alreadyQueued) {
    return {
      findCandidateResultId,
      coverEvidenceResultId: findCandidateResultId,
      targetStateId: row.targetStateId,
      status: "already_queued",
      mode,
      previousStatus: coverStatus,
      previousReason: coverReason,
    };
  }

  if (row.targetStatus === "running") {
    throw new CoverEvidenceReprocessError(409, "target_running");
  }
  if (!reprocessableStatuses.has(coverStatus)) {
    throw new CoverEvidenceReprocessError(409, "cover_evidence_status_not_reprocessable");
  }

  const nextReason = normalizeReprocessReason(coverReason);
  const mergedFindCandidateResultIds = mergeRequestedIds({
    existingRequest,
    findCandidateResultId,
  });
  const requestMetadata = {
    coverEvidenceReprocessRequest: {
      mode,
      requestedAt: requestedAt.toISOString(),
      requestedBy: actor,
      findCandidateResultIds: mergedFindCandidateResultIds,
      coverEvidenceResultIds: mergedFindCandidateResultIds,
      forceRefreshEvidence: input.forceRefreshEvidence ?? true,
      providerPolicy: "cloud_api",
      providerFallbackMode: "fallback",
      status: "requested",
    },
  };

  const result = await db.transaction(async (tx) => {
    const updatedCoverRows = await tx
      .update(coverEvidenceResults)
      .set({
        status: "reprocess_requested",
        reason: nextReason,
        toolEvents: sql`${coverEvidenceResults.toolEvents} || ${JSON.stringify([
          {
            name: "cloud_api_cover_evidence_reprocess_requested",
            ok: true,
            metadata: {
              previousStatus: coverStatus,
              previousStage: coverStage,
              previousReason: coverReason,
              requestedAt: requestedAt.toISOString(),
              mode,
            },
          },
        ])}::jsonb` as never,
        updatedAt: requestedAt,
      })
      .where(
        and(
          eq(coverEvidenceResults.id, findCandidateResultId),
          sql`${coverEvidenceResults.status} in ('insufficient', 'provider_failed', 'tool_failed', 'parse_failed', 'reprocess_requested')`,
        ),
      )
      .returning({
        id: coverEvidenceResults.id,
      });
    if (updatedCoverRows.length === 0) {
      throw new CoverEvidenceReprocessError(409, "cover_evidence_status_not_reprocessable");
    }

    const updatedTargetRows = await tx
      .update(distillationTargetStates)
      .set({
        status: "pending",
        phase: "selected",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        nextRetryAt: null,
        attemptCount: 0,
        completedAt: null,
        lastOutcomeKind: "manual_cloud_api_cover_evidence_reprocess",
        lastError: nextReason.slice(0, 500),
        metadata:
          sql`${distillationTargetStates.metadata} || ${JSON.stringify(requestMetadata)}::jsonb` as never,
        updatedAt: requestedAt,
      })
      .where(
        and(
          eq(distillationTargetStates.id, row.targetStateId),
          sql`${distillationTargetStates.status} <> 'running'`,
        ),
      )
      .returning({
        id: distillationTargetStates.id,
      });
    if (updatedTargetRows.length === 0) {
      throw new CoverEvidenceReprocessError(409, "target_running");
    }

    return {
      findCandidateResultId,
      coverEvidenceResultId: findCandidateResultId,
      targetStateId: row.targetStateId,
      status: "queued" as const,
      mode,
      previousStatus: coverStatus,
      previousReason: coverReason,
    };
  });

  await recordAuditLogSafe({
    eventType: auditEventTypes.coverEvidenceReprocessRequested,
    actor,
    payload: {
      targetStateId: row.targetStateId,
      coverEvidenceResultId: findCandidateResultId,
      findCandidateResultId,
      oldStatus: coverStatus,
      oldStage: coverStage,
      oldReason: coverReason,
      mode,
      requestedAt: requestedAt.toISOString(),
    },
  });

  return result;
}
