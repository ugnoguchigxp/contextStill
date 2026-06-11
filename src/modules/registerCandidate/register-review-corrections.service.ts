import { randomUUID } from "node:crypto";
import { and, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  coveringEvidenceQueue,
  distillationTargetStates,
  findCandidateResults,
  findingCandidateQueue,
  foundCandidates,
} from "../../db/schema.js";
import type {
  RegisterReviewCorrectionItem,
  RegisterReviewCorrectionsInput,
} from "../../shared/schemas/knowledge.schema.js";
import { resolveKnowledgeCandidatePriorityGroup } from "../distillationTarget/priority-group.js";
import { DEFAULT_DISTILLATION_TARGET_VERSION } from "../distillationTarget/repository.js";
import { appendQueueEvent } from "../queue/core/events.js";

export type RegisterReviewCorrectionsItemResult = {
  index: number;
  status: "success" | "duplicate" | "failed";
  title?: string;
  targetStateId?: string;
  findCandidateResultId?: string;
  sourceUri?: string;
  error?: string;
};

export type RegisterReviewCorrectionsResult = {
  status: "success" | "partial" | "failed";
  registeredCount: number;
  failedCount: number;
  duplicateCount: number;
  items: RegisterReviewCorrectionsItemResult[];
};

function buildCandidateBody(item: RegisterReviewCorrectionItem): string {
  const parts: string[] = [];
  parts.push(`Failure: ${item.finding}`);
  if (item.impact?.trim()) {
    parts.push(`Impact: ${item.impact.trim()}`);
  }
  if (item.trigger?.trim()) {
    parts.push(`Trigger: ${item.trigger.trim()}`);
  }
  if (item.fix?.trim()) {
    parts.push(`Fix: ${item.fix.trim()}`);
  }
  if (item.verification?.trim()) {
    parts.push(`Verification: ${item.verification.trim()}`);
  }
  if (item.decisionSignal?.trim()) {
    parts.push(`Decision signal: ${item.decisionSignal.trim()}`);
  }
  return parts.join("\n");
}

export async function registerReviewCorrections(
  input: RegisterReviewCorrectionsInput,
): Promise<RegisterReviewCorrectionsResult> {
  const items: RegisterReviewCorrectionsItemResult[] = [];
  let registeredCount = 0;
  let failedCount = 0;
  let duplicateCount = 0;

  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index];

    try {
      // 1. Check for duplicates using origin.system and origin.reviewFindingId
      const existing = await db
        .select({ id: distillationTargetStates.id })
        .from(distillationTargetStates)
        .where(
          and(
            sql`${distillationTargetStates.metadata} -> 'origin' ->> 'system' = ${item.origin.system}`,
            sql`${distillationTargetStates.metadata} -> 'origin' ->> 'reviewFindingId' = ${item.origin.reviewFindingId}`,
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        duplicateCount += 1;
        items.push({
          index,
          status: "duplicate",
          error: `Duplicate review correction: ${item.origin.system}:${item.origin.reviewFindingId}`,
        });
        continue;
      }

      // 2. Prepare metadata and content
      const candidateId = randomUUID();
      const sourceUri = `agent://candidate/${candidateId}`;
      const now = new Date();
      const body = buildCandidateBody(item);

      const polarity = "negative";
      const intentTags =
        item.intentTags && item.intentTags.length > 0 ? item.intentTags : ["review_finding"];

      const targetMetadata = {
        source: "mcp_register_review_corrections",
        registeredAt: now.toISOString(),
        polarity,
        intentTags,
        origin: item.origin,
        status: item.status,
        severity: item.severity,
      } as Record<string, unknown>;

      const priorityGroup = resolveKnowledgeCandidatePriorityGroup({
        sourceUri,
        metadata: targetMetadata,
      });

      const origin = {
        source: "mcp_register_review_corrections",
        registeredAt: now.toISOString(),
        candidateType: "rule",
        polarity,
        intentTags,
        confidence: item.confidence,
        importance: item.importance,
        appliesTo: item.appliesTo,
        origin: item.origin,
      };

      const candidateMetadata = {
        sourceKind: "knowledge_candidate",
        sourceKey: candidateId,
        sourceUri,
        polarity,
        intentTags,
      };

      // 3. Perform database operations in transaction
      const result = await db.transaction(async (tx) => {
        const [target] = await tx
          .insert(distillationTargetStates)
          .values({
            targetKind: "knowledge_candidate",
            targetKey: candidateId,
            sourceUri,
            distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
            status: "pending",
            phase: "selected",
            priorityGroup,
            sortKey: now.toISOString(),
            metadata: targetMetadata,
            updatedAt: now,
          })
          .returning();

        if (!target) throw new Error("failed to create candidate target state");

        const [candidate] = await tx
          .insert(findCandidateResults)
          .values({
            targetStateId: target.id,
            candidateIndex: 0,
            title: item.title,
            content: body,
            origin,
            status: "selected",
            updatedAt: now,
          })
          .returning();

        if (!candidate) throw new Error("failed to create candidate result");

        const payload = {
          title: item.title,
          body,
          type: "rule" as const,
          sourceSummary: undefined,
          origin,
          legacyTargetStateId: target.id,
          legacyFindCandidateResultId: candidate.id,
        };

        const findingJobMetadata = {
          source: "mcp_register_review_corrections",
          registeredAt: now.toISOString(),
          legacyTargetStateId: target.id,
          legacyFindCandidateResultId: candidate.id,
        };

        const [findingJob] = await tx
          .insert(findingCandidateQueue)
          .values({
            inputKind: "provided_candidate",
            sourceKind: "knowledge_candidate",
            sourceKey: candidateId,
            sourceUri,
            distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
            payload,
            metadata: findingJobMetadata,
            priority: 90,
            status: "completed",
            completedAt: now,
            lastOutcomeKind: "provided_candidate_registered",
            updatedAt: now,
          })
          .returning();

        if (!findingJob) throw new Error("failed to create V2 finding job");

        const [foundCandidate] = await tx
          .insert(foundCandidates)
          .values({
            findingJobId: findingJob.id,
            candidateIndex: 0,
            type: "rule",
            title: item.title,
            content: body,
            origin,
            metadata: candidateMetadata,
            updatedAt: now,
          })
          .returning();

        if (!foundCandidate) throw new Error("failed to create V2 found candidate");

        const [coveringJob] = await tx
          .insert(coveringEvidenceQueue)
          .values({
            foundCandidateId: foundCandidate.id,
            distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
            status: "pending",
            priority: 90,
            providerPolicy: "default",
            payload: {},
            metadata: {},
            updatedAt: now,
          })
          .returning();

        if (!coveringJob) throw new Error("failed to create V2 covering job");

        return { target, candidate, findingJob, foundCandidate, coveringJob };
      });

      await appendQueueEvent({
        queueName: "findingCandidate",
        queueJobId: result.findingJob.id,
        eventType: "completed",
        message: "review correction candidate registered synchronously",
        metadata: {
          sourceKind: "knowledge_candidate",
          sourceKey: candidateId,
          inputKind: "provided_candidate",
          foundCandidateId: result.foundCandidate.id,
        },
      });

      await appendQueueEvent({
        queueName: "coveringEvidence",
        queueJobId: result.coveringJob.id,
        eventType: "enqueued",
        message: "covering job enqueued from review correction registration",
        metadata: {
          foundCandidateId: result.foundCandidate.id,
          findingJobId: result.findingJob.id,
        },
      });

      registeredCount += 1;
      items.push({
        index,
        status: "success",
        title: item.title,
        targetStateId: result.target.id,
        findCandidateResultId: result.candidate.id,
        sourceUri,
      });
    } catch (error) {
      failedCount += 1;
      items.push({
        index,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const status =
    registeredCount === input.items.length ? "success" : registeredCount > 0 ? "partial" : "failed";

  return {
    status,
    registeredCount,
    failedCount,
    duplicateCount,
    items,
  };
}
