import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { updateKnowledgeItem } from "../../../api/modules/knowledge/knowledge.repository.js";
import { db } from "../../db/index.js";
import { knowledgeItems, mergeActivationFinalizeQueue } from "../../db/schema.js";
import { asRecord } from "../../shared/utils/normalize.js";
import { appendQueueEvent } from "../queue/core/events.js";

type SnapshotKnowledge = {
  id: string;
  bodyHash: string;
  status: string;
  appliesTo?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type MergeActivationSnapshot = {
  mergeReviewJob?: {
    id?: string;
    proposedCanonicalBody?: string | null;
    proposedSummary?: string | null;
  };
  deadZone?: SnapshotKnowledge;
  canonical?: SnapshotKnowledge;
};

function hashBody(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string"))]
    : [];
}

function unionAppliesTo(
  canonical: Record<string, unknown>,
  deadZone: Record<string, unknown>,
): {
  appliesTo: Record<string, unknown>;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
} {
  const technologies = [
    ...new Set([...stringArray(canonical.technologies), ...stringArray(deadZone.technologies)]),
  ];
  const changeTypes = [
    ...new Set([...stringArray(canonical.changeTypes), ...stringArray(deadZone.changeTypes)]),
  ];
  const domains = [
    ...new Set([...stringArray(canonical.domains), ...stringArray(deadZone.domains)]),
  ];
  const appliesTo: Record<string, unknown> = {
    ...canonical,
    ...(typeof canonical.general === "boolean"
      ? { general: canonical.general }
      : typeof deadZone.general === "boolean"
        ? { general: deadZone.general }
        : {}),
    ...(technologies.length ? { technologies } : {}),
    ...(changeTypes.length ? { changeTypes } : {}),
    ...(domains.length ? { domains } : {}),
  };
  if (typeof canonical.repoPath === "string") appliesTo.repoPath = canonical.repoPath;
  if (typeof canonical.repoKey === "string") appliesTo.repoKey = canonical.repoKey;
  return {
    appliesTo,
    ...(technologies.length ? { technologies } : {}),
    ...(changeTypes.length ? { changeTypes } : {}),
    ...(domains.length ? { domains } : {}),
  };
}

async function markSkipped(params: { id: string; outcome: string; reason: string }) {
  await db
    .update(mergeActivationFinalizeQueue)
    .set({
      status: "skipped",
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: params.reason,
      lastOutcomeKind: params.outcome,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mergeActivationFinalizeQueue.id, params.id));
}

export async function processMergeActivationFinalizeJob(
  jobId: string,
  _signal?: AbortSignal,
): Promise<void> {
  const [job] = await db
    .select()
    .from(mergeActivationFinalizeQueue)
    .where(eq(mergeActivationFinalizeQueue.id, jobId))
    .limit(1);
  if (!job) throw new Error(`merge activation finalize job not found: ${jobId}`);

  await appendQueueEvent({
    queueName: "mergeActivationFinalize",
    queueJobId: job.id,
    eventType: "claimed",
    message: "merge activation finalize claimed",
    metadata: { visibleQueueName: "finalizeDistille" },
  });

  const snapshot = asRecord(job.inputSnapshot) as MergeActivationSnapshot;
  const [deadZone] = await db
    .select()
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, job.deadZoneKnowledgeId))
    .limit(1);
  const [canonical] = await db
    .select()
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, job.canonicalKnowledgeId))
    .limit(1);
  if (!deadZone || !canonical) {
    await markSkipped({ id: job.id, outcome: "stale_input", reason: "knowledge row missing" });
    return;
  }
  if (
    snapshot.deadZone?.bodyHash !== hashBody(deadZone.body) ||
    snapshot.canonical?.bodyHash !== hashBody(canonical.body) ||
    deadZone.status === "deprecated" ||
    canonical.status !== "active"
  ) {
    await markSkipped({
      id: job.id,
      outcome: "stale_input",
      reason: "knowledge body/status changed before finalize",
    });
    return;
  }

  const proposedBody = snapshot.mergeReviewJob?.proposedCanonicalBody?.trim();
  if (!proposedBody) {
    await markSkipped({
      id: job.id,
      outcome: "activation_blocked",
      reason: "merge review did not provide a canonical body",
    });
    return;
  }

  const nowIso = new Date().toISOString();
  const union = unionAppliesTo(asRecord(canonical.appliesTo), asRecord(deadZone.appliesTo));
  const activationMetadata = {
    finalizeJobId: job.id,
    mergeReviewJobId: job.mergeReviewJobId,
    activationOutcome: "scope_refined",
    appliedAt: nowIso,
    mergedDeadZoneKnowledgeId: deadZone.id,
    appliesToSource: "deterministic_union",
    appliesToWarnings: [],
    proposedAppliesTo: null,
  };

  const updatedCanonical = await updateKnowledgeItem(canonical.id, {
    body: proposedBody,
    appliesTo: union.appliesTo,
    technologies: union.technologies,
    changeTypes: union.changeTypes,
    domains: union.domains,
    metadata: {
      deadZoneMergeActivation: activationMetadata,
    },
  });
  if (!updatedCanonical) {
    throw new Error(`canonical knowledge update failed: ${canonical.id}`);
  }

  const updatedDeadZone = await updateKnowledgeItem(deadZone.id, {
    status: "deprecated",
    metadata: {
      deprecation: {
        reason: "merged",
        mergedIntoKnowledgeId: canonical.id,
        mergeReviewJobId: job.mergeReviewJobId,
        finalizeJobId: job.id,
        deprecatedAt: nowIso,
      },
    },
  });
  if (!updatedDeadZone) {
    throw new Error(`dead-zone knowledge deprecation failed: ${deadZone.id}`);
  }

  await db
    .update(mergeActivationFinalizeQueue)
    .set({
      status: "completed",
      attemptCount: job.attemptCount + 1,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: null,
      lastOutcomeKind: "scope_refined",
      activationResult: {
        outcome: "scope_refined",
        confidence: "medium",
        rationale: ["Applied merge review body with deterministic appliesTo union."],
        blockers: [],
        persistedAppliesTo: union.appliesTo,
      },
      knowledgeId: canonical.id,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mergeActivationFinalizeQueue.id, job.id));

  await appendQueueEvent({
    queueName: "mergeActivationFinalize",
    queueJobId: job.id,
    eventType: "completed",
    message: "merge activation finalize completed",
    metadata: {
      visibleQueueName: "finalizeDistille",
      activationOutcome: "scope_refined",
      knowledgeId: canonical.id,
    },
  });
}
