import { groupedConfig } from "../../config.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  coverEvidenceResultFromRow,
  selectCoverEvidenceResultById,
} from "../coverEvidence/repository.js";
import type { CoverEvidenceReference, CoverEvidenceResult } from "../coverEvidence/types.js";
import type { DistillationDomainSmokeResult } from "../distillation-domain.types.js";
import {
  PROCEDURE_BODY_NOT_ACTIONABLE_REASON,
  assessProcedureQuality,
  hasSkillLikeProcedureBody,
  validateCandidateQualityForStorage,
} from "../distillation/procedure-quality.js";
import { embedOne } from "../embedding/embedding.service.js";
import { getFindCandidateResultById } from "../findCandidate/repository.js";
import { upsertKnowledgeFromSource } from "../knowledge/knowledge.repository.js";
import {
  getLandscapeReviewLinkForFinalize,
  getLandscapeReviewLinkForFinalizeByFoundCandidate,
  markLandscapeReviewLinkFinalizedForCandidate,
  markLandscapeReviewLinkFinalizedForFoundCandidate,
  markLandscapeReviewLinkReviewRequiredForCandidate,
  markLandscapeReviewLinkReviewRequiredForFoundCandidate,
} from "../landscape/landscape-review-candidate.service.js";
import { findSourceFragmentByReference, selectKnowledgeByFinalizeSourceUri } from "./repository.js";
import { linkKnowledgeToSourceFragment } from "./source-link.repository.js";

export type FinalizeDistilleInput = {
  coverEvidenceResultId: string;
  resultOverride?: CoverEvidenceResult;
  candidateContext?: {
    foundCandidateId: string;
    targetStateId?: string | null;
    findCandidateResultId?: string | null;
    targetKind: "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest";
    targetKey: string;
    sourceUri: string;
  };
  write?: boolean;
  signal?: AbortSignal;
};

export type FinalizeDistilleResult = {
  coverEvidenceResultId: string;
  knowledgeId: string | null;
  status: "stored" | "dry_run" | "rejected";
  embeddingStatus: "stored" | "unavailable" | "failed";
  sourceReferenceCount: number;
  sourceLinkCount: number;
  reason: string | null;
};

const FINALIZE_SOURCE_PREFIX = "cover-evidence-result://";

function finalizeSourceUri(coverEvidenceResultId: string): string {
  return `${FINALIZE_SOURCE_PREFIX}${coverEvidenceResultId}`;
}

function embeddingStatusFromError(error: unknown): FinalizeDistilleResult["embeddingStatus"] {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes("disabled") || lowered.includes("no embedding provider available")) {
    return "unavailable";
  }
  return "failed";
}

function unitConfidence(confidence: number | undefined): number {
  const normalized = Number(confidence ?? 70);
  if (!Number.isFinite(normalized)) return 0.7;
  if (normalized <= 1) return Math.max(0, Math.min(1, normalized));
  return Math.max(0, Math.min(1, normalized / 100));
}

function sourceLinkCandidate(reference: CoverEvidenceReference): boolean {
  return reference.kind === "source" && reference.evidenceRole === "supports_candidate";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("operation aborted");
  error.name = "AbortError";
  throw error;
}

async function linkResolvableSourceReferences(params: {
  knowledgeId: string;
  references: CoverEvidenceReference[];
  confidence: number;
  coverEvidenceResultId: string;
}): Promise<number> {
  let linked = 0;
  for (const reference of params.references) {
    if (!sourceLinkCandidate(reference)) continue;
    const fragment = await findSourceFragmentByReference({
      uri: reference.uri,
      locator: reference.locator,
    });
    if (!fragment) continue;
    await linkKnowledgeToSourceFragment({
      knowledgeId: params.knowledgeId,
      sourceFragmentId: fragment.sourceFragmentId,
      confidence: params.confidence,
      metadata: {
        source: "finalizeDistille",
        coverEvidenceResultId: params.coverEvidenceResultId,
        reference,
      },
    });
    linked += 1;
  }
  return linked;
}

function rejectedResult(
  coverEvidenceResultId: string,
  result: CoverEvidenceResult | null,
  reason: string,
): FinalizeDistilleResult {
  return {
    coverEvidenceResultId,
    knowledgeId: null,
    status: "rejected",
    embeddingStatus: "unavailable",
    sourceReferenceCount: result?.references.length ?? 0,
    sourceLinkCount: 0,
    reason,
  };
}

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

async function getLandscapeLinkForContext(params: {
  findCandidateResultId?: string | null;
  foundCandidateId?: string | null;
}): Promise<{
  status: "draft_created" | "review_required" | "approved" | "rejected" | "finalized";
  linkId: string;
} | null> {
  if (params.foundCandidateId) {
    return getLandscapeReviewLinkForFinalizeByFoundCandidate(params.foundCandidateId);
  }
  if (params.findCandidateResultId) {
    return getLandscapeReviewLinkForFinalize(params.findCandidateResultId);
  }
  return null;
}

async function markLandscapeReviewRequired(params: {
  findCandidateResultId?: string | null;
  foundCandidateId?: string | null;
}): Promise<void> {
  if (params.foundCandidateId) {
    await markLandscapeReviewLinkReviewRequiredForFoundCandidate(params.foundCandidateId);
    return;
  }
  if (params.findCandidateResultId) {
    await markLandscapeReviewLinkReviewRequiredForCandidate(params.findCandidateResultId);
  }
}

async function markLandscapeFinalized(params: {
  findCandidateResultId?: string | null;
  foundCandidateId?: string | null;
}): Promise<void> {
  if (params.foundCandidateId) {
    await markLandscapeReviewLinkFinalizedForFoundCandidate(params.foundCandidateId);
    return;
  }
  if (params.findCandidateResultId) {
    await markLandscapeReviewLinkFinalizedForCandidate(params.findCandidateResultId);
  }
}

export async function runFinalizeDistille(
  input: FinalizeDistilleInput,
): Promise<FinalizeDistilleResult> {
  throwIfAborted(input.signal);
  const coverEvidenceResultId = input.coverEvidenceResultId.trim();
  if (!coverEvidenceResultId) {
    throw new Error("coverEvidenceResultId is required");
  }

  let result: CoverEvidenceResult;
  if (input.resultOverride) {
    result = input.resultOverride;
  } else {
    const row = await selectCoverEvidenceResultById(coverEvidenceResultId);
    throwIfAborted(input.signal);
    if (!row) {
      throw new Error(`cover evidence result not found: ${coverEvidenceResultId}`);
    }
    result = coverEvidenceResultFromRow(row);
  }
  const sourceReferenceCount = result.references.length;

  if (result.status !== "knowledge_ready" || !result.candidate) {
    return rejectedResult(
      coverEvidenceResultId,
      result,
      result.reason ?? `cover evidence status is ${result.status}`,
    );
  }

  if (result.candidate.importance <= groupedConfig.distillation.lowImportanceRejectThreshold) {
    return rejectedResult(coverEvidenceResultId, result, "low_importance");
  }

  let candidate = result.candidate;
  let demotionReason: string | null = null;
  if (candidate.type === "rule") {
    const validation = validateCandidateQualityForStorage(candidate);
    if (validation.action === "reject") {
      return rejectedResult(coverEvidenceResultId, result, validation.reason);
    }
  } else if (candidate.type === "procedure" && !hasSkillLikeProcedureBody(candidate.body)) {
    const decision = assessProcedureQuality({ title: candidate.title, body: candidate.body });
    if (decision.action === "demote_to_rule") {
      candidate = {
        ...candidate,
        type: "rule",
      };
      demotionReason = decision.reason;
    } else {
      return rejectedResult(
        coverEvidenceResultId,
        result,
        decision.action === "reject_insufficient"
          ? decision.reason
          : PROCEDURE_BODY_NOT_ACTIONABLE_REASON,
      );
    }
  }

  let candidateContext = input.candidateContext;
  if (!candidateContext) {
    const candidateRow = await getFindCandidateResultById(coverEvidenceResultId);
    if (!candidateRow) {
      throw new Error(`find candidate result not found: ${coverEvidenceResultId}`);
    }
    candidateContext = {
      foundCandidateId: "",
      targetStateId: candidateRow.targetStateId,
      findCandidateResultId: coverEvidenceResultId,
      targetKind: candidateRow.targetKind,
      targetKey: candidateRow.targetKey,
      sourceUri: candidateRow.sourceUri,
    };
  }

  const landscapeLink = await getLandscapeLinkForContext({
    findCandidateResultId: candidateContext.findCandidateResultId,
    foundCandidateId: candidateContext.foundCandidateId || null,
  });
  const requiresLandscapeApproval =
    candidateContext.targetKind === "knowledge_candidate" && Boolean(landscapeLink);
  if (
    requiresLandscapeApproval &&
    landscapeLink &&
    landscapeLink.status !== "approved" &&
    landscapeLink.status !== "finalized"
  ) {
    if (input.write) {
      await markLandscapeReviewRequired({
        findCandidateResultId: candidateContext.findCandidateResultId,
        foundCandidateId: candidateContext.foundCandidateId || null,
      });
    }
    return rejectedResult(coverEvidenceResultId, result, "landscape_manual_approval_required");
  }

  const sourceUri = finalizeSourceUri(coverEvidenceResultId);
  const finalizedAt = new Date().toISOString();
  const metadata = {
    sourceUri,
    coverEvidenceResultId,
    findCandidateResultId: candidateContext.findCandidateResultId ?? null,
    foundCandidateId: candidateContext.foundCandidateId || null,
    targetStateId: candidateContext.targetStateId ?? null,
    targetKind: candidateContext.targetKind,
    targetKey: candidateContext.targetKey,
    sourceDocumentUri: candidateContext.sourceUri,
    references: result.references,
    duplicateRefs: result.duplicateRefs,
    toolEvents: demotionReason
      ? [
          ...result.toolEvents,
          {
            name: "procedure_demoted_to_rule",
            ok: true,
            metadata: {
              reason: demotionReason,
              source: "finalizeDistille",
            },
          },
        ]
      : result.toolEvents,
    finalizedBy: "finalizeDistille",
    finalizedAt,
  };

  if (!input.write) {
    return {
      coverEvidenceResultId,
      knowledgeId: null,
      status: "dry_run",
      embeddingStatus: "unavailable",
      sourceReferenceCount,
      sourceLinkCount: 0,
      reason: null,
    };
  }

  await recordAuditLogSafe({
    eventType: auditEventTypes.finalizeDistilleStarted,
    actor: "system",
    payload: {
      coverEvidenceResultId,
      targetStateId: candidateContext.targetStateId ?? null,
      targetKind: candidateContext.targetKind,
      targetKey: candidateContext.targetKey,
    },
  });
  if (demotionReason) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceProcedureDemotedToRule,
      actor: "system",
      payload: {
        coverEvidenceResultId,
        targetStateId: candidateContext.targetStateId ?? null,
        targetKind: candidateContext.targetKind,
        targetKey: candidateContext.targetKey,
        reason: demotionReason,
        source: "finalizeDistille",
      },
    });
  }

  const existing = await selectKnowledgeByFinalizeSourceUri(sourceUri);
  if (existing) {
    const sourceLinkCount = await linkResolvableSourceReferences({
      knowledgeId: existing.id,
      references: result.references,
      confidence: unitConfidence(candidate.confidence),
      coverEvidenceResultId,
    });
    if (requiresLandscapeApproval && landscapeLink?.status === "approved") {
      await markLandscapeFinalized({
        findCandidateResultId: candidateContext.findCandidateResultId,
        foundCandidateId: candidateContext.foundCandidateId || null,
      });
    }
    await recordAuditLogSafe({
      eventType: auditEventTypes.finalizeDistilleCompleted,
      actor: "system",
      payload: {
        coverEvidenceResultId,
        knowledgeId: existing.id,
        embeddingStatus: "stored",
        sourceReferenceCount,
        sourceLinkCount,
        existing: true,
      },
    });
    return {
      coverEvidenceResultId,
      knowledgeId: existing.id,
      status: "stored",
      embeddingStatus: "stored",
      sourceReferenceCount,
      sourceLinkCount,
      reason: null,
    };
  }

  let embedding: number[] | undefined;
  let embeddingStatus: FinalizeDistilleResult["embeddingStatus"] = "stored";
  try {
    throwIfAborted(input.signal);
    embedding = await embedOne(`${candidate.title}\n${candidate.body}`, "passage");
    throwIfAborted(input.signal);
  } catch (error) {
    embeddingStatus = embeddingStatusFromError(error);
    await recordAuditLogSafe({
      eventType: auditEventTypes.finalizeDistilleEmbeddingFailed,
      actor: "system",
      payload: {
        coverEvidenceResultId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throwIfAborted(input.signal);
  }

  throwIfAborted(input.signal);
  const knowledgeId = await upsertKnowledgeFromSource({
    sourceUri,
    type: candidate.type,
    status: "draft",
    scope: "repo",
    title: candidate.title,
    body: candidate.body,
    confidence: candidate.confidence,
    importance: candidate.importance,
    appliesTo: appliesToFromCandidate(candidate),
    metadata,
    embedding,
  });

  throwIfAborted(input.signal);
  const sourceLinkCount = await linkResolvableSourceReferences({
    knowledgeId,
    references: result.references,
    confidence: unitConfidence(candidate.confidence),
    coverEvidenceResultId,
  });

  await recordAuditLogSafe({
    eventType: auditEventTypes.finalizeDistilleCompleted,
    actor: "system",
    payload: {
      coverEvidenceResultId,
      knowledgeId,
      embeddingStatus,
      sourceReferenceCount,
      sourceLinkCount,
    },
  });

  if (requiresLandscapeApproval && landscapeLink?.status === "approved") {
    await markLandscapeFinalized({
      findCandidateResultId: candidateContext.findCandidateResultId,
      foundCandidateId: candidateContext.foundCandidateId || null,
    });
  }

  return {
    coverEvidenceResultId,
    knowledgeId,
    status: "stored",
    embeddingStatus,
    sourceReferenceCount,
    sourceLinkCount,
    reason: null,
  };
}

export async function runFinalizeDistilleSmoke(
  input: Record<string, unknown>,
): Promise<DistillationDomainSmokeResult> {
  const id = typeof input.coverEvidenceResultId === "string" ? input.coverEvidenceResultId : "";
  if (!id.trim()) {
    return {
      domain: "finalizeDistille",
      implemented: true,
      status: "prepared",
      checkedAt: new Date().toISOString(),
      message: "finalizeDistille runtime is wired. Pass coverEvidenceResultId for dry-run smoke.",
      receivedInput: input,
      nextContracts: [
        "knowledge_ready cover evidence results can be dry-run finalized",
        "write-side finalize is available via finalize-distille CLI",
      ],
    };
  }

  const result = await runFinalizeDistille({
    coverEvidenceResultId: id,
    write: false,
  });

  return {
    domain: "finalizeDistille",
    implemented: true,
    status: result.status === "dry_run" ? "ok" : "prepared",
    checkedAt: new Date().toISOString(),
    message:
      result.status === "dry_run"
        ? "finalizeDistille dry-run completed for a knowledge_ready cover evidence result."
        : "finalizeDistille rejected a non-ready cover evidence result.",
    receivedInput: input,
    nextContracts: [
      "write=true stores draft knowledge through upsertKnowledgeFromSource",
      "source references are preserved in knowledge metadata",
      "resolvable source fragments are linked through knowledge_source_links",
    ],
  };
}
