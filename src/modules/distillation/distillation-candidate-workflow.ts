import { groupedConfig } from "../../config.js";
import {
  type DistillationCandidateValidationResult,
  type DistilledKnowledgeCandidate,
  validateDistillationCandidates,
} from "./distillation-candidates.js";
import {
  type DistillationCandidateSourceRef,
  type DistillationCandidateRow,
  claimDistillationCandidateForEvaluation,
  distillationCandidateRowToCandidate,
  listPromotionReadyDistillationCandidates,
  listUnevaluatedDistillationCandidates,
  updateDistillationCandidateEvaluation,
  upsertExtractedDistillationCandidates,
} from "./distillation-candidate.repository.js";
import {
  distillationEvidenceToolNames,
  type DistillationToolResult,
} from "./distillation-tools.service.js";
import {
  distillationReaderAuditContextKey,
  type DistillationReaderContext,
  type DistillationReadableSegment,
} from "./distillation-reader.service.js";
import {
  distillationToolEventsFromError,
  errorWithDistillationToolEvents,
  type DistillationMessage,
} from "./distillation-runtime.service.js";
import {
  type DistillationSessionModelClient,
  evidenceTextFromMessages,
  runDistillationExtractionSession,
  runDistillationVerificationSession,
} from "./distillation-sessions.js";

const VERIFICATION_TOOL_NAMES = new Set<string>(distillationEvidenceToolNames);

function metadataReadLocators(row: DistillationCandidateRow | undefined): string[] {
  const metadata = row?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const readLocators = (metadata as Record<string, unknown>).readLocators;
  if (!Array.isArray(readLocators)) return [];
  return readLocators.filter(
    (value): value is string => typeof value === "string" && Boolean(value),
  );
}

function truncateReaderEvidence(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24))}\n...[truncated]`;
}

function readerSegmentEvidence(segment: DistillationReadableSegment, maxChars: number): string {
  return [
    `locator: ${segment.locator}`,
    `label: ${segment.label}`,
    "content:",
    truncateReaderEvidence(segment.content, maxChars),
  ].join("\n");
}

function storedReaderEvidence(params: {
  readerContext?: DistillationReaderContext;
  row?: DistillationCandidateRow;
}): string | null {
  if (!params.readerContext?.enabled) return null;
  const locators = [...new Set(metadataReadLocators(params.row))];
  if (locators.length === 0) return null;
  const segments = locators
    .map((locator) => params.readerContext?.segments.find((segment) => segment.locator === locator))
    .filter((segment): segment is DistillationReadableSegment => Boolean(segment));
  if (segments.length === 0) return null;
  return [
    "READ_SEGMENT_EVIDENCE",
    ...segments.map((segment) =>
      readerSegmentEvidence(segment, params.readerContext?.maxCharsPerRead ?? 4000),
    ),
  ].join("\n\n---\n\n");
}

export type DistillationAcceptedCandidateEntry = {
  candidate: DistilledKnowledgeCandidate;
  candidateRowId?: string;
  candidateIndex: number;
  toolEvents: DistillationToolResult[];
};

export type DistillationCandidateWorkflowResult = {
  candidates: DistilledKnowledgeCandidate[];
  acceptedEntries: DistillationAcceptedCandidateEntry[];
  verificationCandidateCount: number;
  verificationAttemptCount: number;
  /** @deprecated Use verificationCandidateCount. */
  rawCandidateCount: number;
  extractionCandidateCount: number;
  extractionRawCandidateCount: number;
  toolEvents: DistillationToolResult[];
  responseChars: number;
  extractionResponseChars: number;
  verificationResponseChars: number;
  /** @deprecated Use verificationAttemptCount. */
  verificationSessionCount: number;
  jsonRepaired: boolean;
  usedStoredCandidates: boolean;
  failedCandidateCount: number;
  concurrentClaimMissCount: number;
  candidateGate: DistillationCandidateValidationResult;
};

function emptyGate(): DistillationCandidateValidationResult {
  return {
    accepted: [],
    rejectedLowQuality: [],
    rejectedInvalidEvidence: [],
  };
}

function rowByCandidateIndex(
  rows: DistillationCandidateRow[],
): Map<number, DistillationCandidateRow> {
  return new Map(rows.map((row) => [row.candidateIndex, row]));
}

function toolEventsFromRow(row: DistillationCandidateRow): DistillationToolResult[] {
  return Array.isArray(row.toolEvents) ? (row.toolEvents as DistillationToolResult[]) : [];
}

function metadataFromRow(row: DistillationCandidateRow): Record<string, unknown> {
  return row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : {};
}

function hasSuccessfulVerificationToolEvidence(toolEvents: DistillationToolResult[]): boolean {
  return toolEvents.some((event) => event.ok && VERIFICATION_TOOL_NAMES.has(event.name));
}

function rejectionReason(params: {
  verifiedCandidateCount: number;
  rejectedLowQualityCount: number;
  rejectedInvalidEvidenceCount: number;
  acceptedLimitReached: boolean;
}): string {
  if (params.acceptedLimitReached) return "candidate_limit_reached";
  if (params.verifiedCandidateCount === 0) return "verification_returned_no_candidates";
  if (params.rejectedInvalidEvidenceCount > 0) return "invalid_or_missing_external_evidence";
  if (params.rejectedLowQualityCount > 0) return "invalid_candidate";
  return "candidate_rejected";
}

export async function runDistillationCandidateWorkflow(params: {
  apply: boolean;
  source: DistillationCandidateSourceRef;
  distillationSourceKind: "vibe_memory" | "wiki";
  messages: DistillationMessage[];
  modelClient: DistillationSessionModelClient;
  model: string;
  maxTokens: number;
  promptVersion: string;
  requireFetchEvidenceForUrlInput?: boolean;
  requireVerificationToolEvidence?: boolean;
  jobId?: string;
  readerContext?: DistillationReaderContext;
  extractionMetadata?: Record<string, unknown>;
}): Promise<DistillationCandidateWorkflowResult> {
  const toolEvents: DistillationToolResult[] = [];
  const acceptedEntries: DistillationAcceptedCandidateEntry[] = [];
  const validationGate = emptyGate();
  let verificationCandidateCount = 0;
  let verificationAttemptCount = 0;
  let extractionRawCandidateCount = 0;
  let extractionResponseChars = 0;
  let verificationResponseChars = 0;
  let jsonRepaired = false;
  let usedStoredCandidates = false;
  let failedCandidateCount = 0;
  let concurrentClaimMissCount = 0;
  let extractionReadEvidence: string | null = null;
  const baseSourceEvidence = evidenceTextFromMessages(params.messages);
  const maxCandidates = groupedConfig.distillationTools.maxCandidates;
  const verificationToolEvidenceRequired = params.requireVerificationToolEvidence ?? params.apply;

  let rows: DistillationCandidateRow[] = [];
  let promotionReadyRows: DistillationCandidateRow[] = [];
  let extractionCandidates: DistilledKnowledgeCandidate[] = [];

  if (params.apply) {
    const promotionRows = await listPromotionReadyDistillationCandidates({
      source: params.source,
      promptVersion: params.promptVersion,
      limit: maxCandidates,
    });
    if (promotionRows.length > 0) {
      promotionReadyRows = verificationToolEvidenceRequired
        ? promotionRows.filter((row) =>
            hasSuccessfulVerificationToolEvidence(toolEventsFromRow(row)),
          )
        : promotionRows;
      const missingEvidenceRows = verificationToolEvidenceRequired
        ? promotionRows.filter(
            (row) => !hasSuccessfulVerificationToolEvidence(toolEventsFromRow(row)),
          )
        : [];
      for (const row of missingEvidenceRows) {
        await updateDistillationCandidateEvaluation({
          id: row.id,
          status: "failed",
          rejectionReason: "verification_tool_evidence_missing",
          toolEvents: toolEventsFromRow(row),
          metadata: {
            ...metadataFromRow(row),
            missingVerificationToolEvidence: true,
            failureKind: "verification_tool_evidence",
            previousStatus: "verified",
          },
        });
      }
      if (promotionReadyRows.length === 0) {
        rows = await listUnevaluatedDistillationCandidates({
          source: params.source,
          promptVersion: params.promptVersion,
          limit: maxCandidates,
        });
      }
    }
    if (promotionReadyRows.length > 0 && rows.length === 0) {
      usedStoredCandidates = true;
      const storedToolEvents = promotionReadyRows.flatMap((row) => toolEventsFromRow(row));
      for (const row of promotionReadyRows) {
        const candidate = distillationCandidateRowToCandidate(row);
        acceptedEntries.push({
          candidate,
          candidateRowId: row.id,
          candidateIndex: row.candidateIndex,
          toolEvents: toolEventsFromRow(row),
        });
        validationGate.accepted.push(candidate);
      }
      return {
        candidates: validationGate.accepted,
        acceptedEntries,
        verificationCandidateCount: promotionReadyRows.length,
        verificationAttemptCount: 0,
        rawCandidateCount: promotionReadyRows.length,
        extractionCandidateCount: promotionReadyRows.length,
        extractionRawCandidateCount: promotionReadyRows.length,
        toolEvents: storedToolEvents,
        responseChars: 0,
        extractionResponseChars: 0,
        verificationResponseChars: 0,
        verificationSessionCount: 0,
        jsonRepaired,
        usedStoredCandidates,
        failedCandidateCount,
        concurrentClaimMissCount,
        candidateGate: validationGate,
      };
    }

    if (rows.length === 0) {
      rows = await listUnevaluatedDistillationCandidates({
        source: params.source,
        promptVersion: params.promptVersion,
        limit: maxCandidates,
      });
    }
    if (rows.length > 0) {
      usedStoredCandidates = true;
      extractionCandidates = rows.map(distillationCandidateRowToCandidate);
      extractionRawCandidateCount = rows.length;
    }
  }

  if (extractionCandidates.length === 0 && !usedStoredCandidates) {
    const extraction = await runDistillationExtractionSession({
      sourceKind: params.distillationSourceKind,
      messages: params.messages,
      modelClient: params.modelClient,
      model: params.model,
      maxTokens: params.maxTokens,
      readerContext: params.readerContext,
      auditContext: {
        ...(params.extractionMetadata ?? {}),
        jobId: params.jobId,
        [distillationReaderAuditContextKey]: params.readerContext,
      },
    });
    extractionCandidates = extraction.candidates;
    extractionRawCandidateCount = extraction.rawCandidateCount;
    extractionResponseChars = extraction.responseChars;
    jsonRepaired = extraction.jsonRepaired;
    toolEvents.push(...extraction.toolEvents);
    extractionReadEvidence = evidenceTextFromMessages(extraction.messages);

    if (params.apply) {
      rows = await upsertExtractedDistillationCandidates({
        source: params.source,
        promptVersion: params.promptVersion,
        model: params.model,
        candidates: extractionCandidates,
        metadata: params.extractionMetadata,
      });
    }
  }

  const rowsByIndex = rowByCandidateIndex(rows);
  const entries = params.apply
    ? rows.map((row) => ({
        candidate: distillationCandidateRowToCandidate(row),
        row,
        candidateIndex: row.candidateIndex,
      }))
    : extractionCandidates.map((candidate, candidateIndex) => ({
        candidate,
        row: rowsByIndex.get(candidateIndex),
        candidateIndex,
      }));

  for (const entry of entries.slice(0, maxCandidates)) {
    if (entry.row) {
      const claimed = await claimDistillationCandidateForEvaluation(entry.row.id);
      if (!claimed) {
        concurrentClaimMissCount++;
        continue;
      }
    }

    try {
      verificationAttemptCount++;
      const sourceEvidence =
        extractionReadEvidence ||
        storedReaderEvidence({ readerContext: params.readerContext, row: entry.row }) ||
        baseSourceEvidence;
      const verification = await runDistillationVerificationSession({
        sourceKind: params.distillationSourceKind,
        sourceEvidence,
        candidate: entry.candidate,
        modelClient: params.modelClient,
        model: params.model,
        maxTokens: params.maxTokens,
        auditContext: {
          sourceKind: params.source.sourceKind,
          sourceId:
            params.source.sourceKind === "vibe_memory"
              ? params.source.vibeMemoryId
              : params.source.sourceFragmentId,
          promptVersion: params.promptVersion,
          candidateRowId: entry.row?.id,
          candidateIndex: entry.candidateIndex,
          candidateType: entry.candidate.type,
          candidateTitle: entry.candidate.title,
          jobId: params.jobId,
        },
      });
      verificationResponseChars += verification.responseChars;
      verificationCandidateCount += verification.rawCandidateCount;
      jsonRepaired = jsonRepaired || verification.jsonRepaired;
      toolEvents.push(...verification.toolEvents);

      if (
        verificationToolEvidenceRequired &&
        !hasSuccessfulVerificationToolEvidence(verification.toolEvents)
      ) {
        failedCandidateCount++;
        validationGate.rejectedInvalidEvidence.push(...verification.candidates);
        if (entry.row) {
          await updateDistillationCandidateEvaluation({
            id: entry.row.id,
            status: "failed",
            rejectionReason: "verification_tool_evidence_missing",
            toolEvents: verification.toolEvents,
            metadata: {
              ...(params.extractionMetadata ?? {}),
              missingVerificationToolEvidence: true,
              failureKind: "verification_tool_evidence",
              verifiedCandidateCount: verification.candidates.length,
              jsonRepaired: verification.jsonRepaired,
              responseChars: verification.responseChars,
            },
          });
        }
        continue;
      }

      const currentValidation = validateDistillationCandidates(verification.candidates, {
        toolEvents: verification.toolEvents,
        requireFetchEvidenceForUrlInput: params.requireFetchEvidenceForUrlInput,
      });
      validationGate.rejectedLowQuality.push(...currentValidation.rejectedLowQuality);
      validationGate.rejectedInvalidEvidence.push(...currentValidation.rejectedInvalidEvidence);

      const acceptedLimitReached = acceptedEntries.length >= maxCandidates;
      const acceptedCandidate = acceptedLimitReached ? undefined : currentValidation.accepted[0];
      if (acceptedCandidate) {
        validationGate.accepted.push(acceptedCandidate);
        acceptedEntries.push({
          candidate: acceptedCandidate,
          candidateRowId: entry.row?.id,
          candidateIndex: entry.candidateIndex,
          toolEvents: verification.toolEvents,
        });
        if (entry.row) {
          await updateDistillationCandidateEvaluation({
            id: entry.row.id,
            status: "verified",
            candidate: acceptedCandidate,
            toolEvents: verification.toolEvents,
            metadata: {
              ...(params.extractionMetadata ?? {}),
              verifiedCandidateCount: verification.candidates.length,
              acceptedCandidateCount: 1,
              jsonRepaired: verification.jsonRepaired,
              responseChars: verification.responseChars,
            },
          });
        }
        continue;
      }

      if (entry.row) {
        await updateDistillationCandidateEvaluation({
          id: entry.row.id,
          status: "rejected",
          rejectionReason: rejectionReason({
            verifiedCandidateCount: verification.candidates.length,
            rejectedLowQualityCount: currentValidation.rejectedLowQuality.length,
            rejectedInvalidEvidenceCount: currentValidation.rejectedInvalidEvidence.length,
            acceptedLimitReached,
          }),
          toolEvents: verification.toolEvents,
          metadata: {
            ...(params.extractionMetadata ?? {}),
            verifiedCandidateCount: verification.candidates.length,
            rejectedLowQualityCount: currentValidation.rejectedLowQuality.length,
            rejectedInvalidEvidenceCount: currentValidation.rejectedInvalidEvidence.length,
            jsonRepaired: verification.jsonRepaired,
            responseChars: verification.responseChars,
          },
        });
      }
    } catch (error) {
      failedCandidateCount++;
      const errorToolEvents = distillationToolEventsFromError(error);
      if (errorToolEvents.length > 0) {
        toolEvents.push(...errorToolEvents);
      }
      if (entry.row) {
        await updateDistillationCandidateEvaluation({
          id: entry.row.id,
          status: "failed",
          rejectionReason: error instanceof Error ? error.message : String(error),
          toolEvents: errorToolEvents.length > 0 ? errorToolEvents : undefined,
          metadata: {
            ...(params.extractionMetadata ?? {}),
            failureKind: "verification",
            toolEventCount: errorToolEvents.length,
          },
        });
      }
      throw errorWithDistillationToolEvents(error, toolEvents);
    }
  }

  if (entries.length > 0 && concurrentClaimMissCount === entries.length) {
    throw new Error("distillation candidates are already claimed by another worker");
  }

  return {
    candidates: validationGate.accepted,
    acceptedEntries,
    verificationCandidateCount,
    verificationAttemptCount,
    rawCandidateCount: verificationCandidateCount,
    extractionCandidateCount: entries.length,
    extractionRawCandidateCount,
    toolEvents,
    responseChars: extractionResponseChars + verificationResponseChars,
    extractionResponseChars,
    verificationResponseChars,
    verificationSessionCount: verificationAttemptCount,
    jsonRepaired,
    usedStoredCandidates,
    failedCandidateCount,
    concurrentClaimMissCount,
    candidateGate: validationGate,
  };
}
