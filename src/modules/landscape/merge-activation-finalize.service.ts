import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  deadZoneMergeReviewQueue,
  knowledgeItems,
  mergeActivationFinalizeQueue,
} from "../../db/schema.js";
import { deadZoneMergeReviewResultSchema } from "../../shared/schemas/landscape-deadzone-review.schema.js";
import { appendQueueEvent } from "../queue/core/events.js";
import {
  ensureRuntimeSettingsLoaded,
  getRuntimeSettingsSnapshot,
} from "../settings/settings.service.js";
import { DeadZoneMergeReviewQueueError } from "./deadzone-merge-review-queue.service.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hashBody(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type MergeActivationFinalizeJobCreateResult = {
  id: string;
  status: string;
  jobType: "merge_activation_finalize";
  mergeReviewJobId: string;
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId: string;
  reviewItemId: string | null;
};

export async function createMergeActivationFinalizeJob(
  mergeReviewJobId: string,
): Promise<MergeActivationFinalizeJobCreateResult> {
  const [reviewJob] = await db
    .select()
    .from(deadZoneMergeReviewQueue)
    .where(eq(deadZoneMergeReviewQueue.id, mergeReviewJobId))
    .limit(1);
  if (!reviewJob) throw new DeadZoneMergeReviewQueueError("merge review job not found", 404);
  if (reviewJob.status !== "completed") {
    throw new DeadZoneMergeReviewQueueError("merge review job is not completed");
  }
  if (!reviewJob.canonicalKnowledgeId) {
    throw new DeadZoneMergeReviewQueueError("merge review job has no canonical knowledge", 409);
  }

  const parsedResult = deadZoneMergeReviewResultSchema.safeParse(reviewJob.result);
  if (!parsedResult.success || parsedResult.data.decision !== "merge_recommended") {
    throw new DeadZoneMergeReviewQueueError("merge review did not recommend finalization");
  }

  const rows = await db
    .select({
      id: knowledgeItems.id,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      status: knowledgeItems.status,
      appliesTo: knowledgeItems.appliesTo,
      metadata: knowledgeItems.metadata,
    })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, reviewJob.deadZoneKnowledgeId));
  const [deadZone] = rows;
  const [canonical] = await db
    .select({
      id: knowledgeItems.id,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      status: knowledgeItems.status,
      appliesTo: knowledgeItems.appliesTo,
      metadata: knowledgeItems.metadata,
    })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, reviewJob.canonicalKnowledgeId))
    .limit(1);

  if (!deadZone || !canonical) {
    throw new DeadZoneMergeReviewQueueError("knowledge row missing", 404);
  }
  if (deadZone.id === canonical.id) {
    throw new DeadZoneMergeReviewQueueError("dead-zone and canonical knowledge must differ");
  }

  await ensureRuntimeSettingsLoaded();
  const route = getRuntimeSettingsSnapshot().taskRouting.finalizeDistille;
  const resultHash = createHash("sha256").update(JSON.stringify(parsedResult.data)).digest("hex");
  const nowIso = new Date().toISOString();
  const inputSnapshot = {
    mergeReviewJob: {
      id: reviewJob.id,
      decision: parsedResult.data.decision,
      proposedCanonicalBody: parsedResult.data.proposedCanonicalBody,
      proposedSummary: parsedResult.data.proposedSummary,
      resultHash,
    },
    deadZone: {
      id: deadZone.id,
      title: deadZone.title,
      body: deadZone.body,
      status: deadZone.status,
      appliesTo: asRecord(deadZone.appliesTo),
      metadata: asRecord(deadZone.metadata),
      bodyHash: hashBody(deadZone.body),
    },
    canonical: {
      id: canonical.id,
      title: canonical.title,
      body: canonical.body,
      status: canonical.status,
      appliesTo: asRecord(canonical.appliesTo),
      metadata: asRecord(canonical.metadata),
      bodyHash: hashBody(canonical.body),
    },
    landscape: {},
    replay: {
      selectedCount: 0,
      offTopicCount: 0,
      usefulRuns: [],
      appliesToRefineCandidates: [],
    },
  };

  const [job] = await db
    .insert(mergeActivationFinalizeQueue)
    .values({
      mergeReviewJobId: reviewJob.id,
      deadZoneKnowledgeId: deadZone.id,
      canonicalKnowledgeId: canonical.id,
      reviewItemId: reviewJob.reviewItemId,
      idempotencyKey: `merge-activation-finalize:${reviewJob.id}`,
      status: "pending",
      priority: reviewJob.priority,
      provider: route.provider === "auto" ? "local-llm" : route.provider,
      model: route.model ?? null,
      inputSnapshot,
      payload: {
        sourceQueue: "deadZoneMergeReview",
        sourceQueueJobId: reviewJob.id,
        requestedAt: nowIso,
      },
      metadata: {
        queueVersion: "v1",
        visibleQueueName: "finalizeDistille",
        jobType: "merge_activation_finalize",
      },
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: mergeActivationFinalizeQueue.idempotencyKey,
      set: {
        payload: {
          sourceQueue: "deadZoneMergeReview",
          sourceQueueJobId: reviewJob.id,
          requestedAt: nowIso,
        },
        updatedAt: new Date(),
      },
    })
    .returning({
      id: mergeActivationFinalizeQueue.id,
      status: mergeActivationFinalizeQueue.status,
      mergeReviewJobId: mergeActivationFinalizeQueue.mergeReviewJobId,
      deadZoneKnowledgeId: mergeActivationFinalizeQueue.deadZoneKnowledgeId,
      canonicalKnowledgeId: mergeActivationFinalizeQueue.canonicalKnowledgeId,
      reviewItemId: mergeActivationFinalizeQueue.reviewItemId,
    });

  if (!job) throw new DeadZoneMergeReviewQueueError("failed to enqueue finalize job", 500);

  await appendQueueEvent({
    queueName: "mergeActivationFinalize",
    queueJobId: job.id,
    eventType: "enqueued",
    message: "merge activation finalize enqueued",
    metadata: {
      visibleQueueName: "finalizeDistille",
      mergeReviewJobId: reviewJob.id,
    },
  });

  return {
    ...job,
    jobType: "merge_activation_finalize",
  };
}
