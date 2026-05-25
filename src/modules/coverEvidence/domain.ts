import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import type { DistillationDomainSmokeResult } from "../distillation-domain.types.js";
import {
  type DistillationChatClient,
  type DistillationProviderSetting,
  type DistillationToolExecutor,
  resolveDistillationModel,
} from "../distillation/distillation-runtime.service.js";
import type { DistillationProviderName } from "../distillation/llm-resolver.js";
import { getFindCandidateResultById } from "../findCandidate/repository.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveCoverEvidenceRoutes,
} from "../settings/settings.service.js";
import { dedupeCoverEvidenceCandidate } from "./dedupe.service.js";
import {
  baseCandidate,
  candidateOriginHintsFromOrigin,
  isRetryableCoverEvidenceStatus,
  makeResult,
  mergeReferences,
  normalizeProcedureBodyQuality,
  referencesFromDuplicateRefs,
  requiresExternalEvidence,
  sourceContextForPrompts,
} from "./helpers.js";
import {
  appendOptionalMcpEvidence,
  runExternalEvidence,
  runValueAssessment,
} from "./llm-runner.js";
import { parseCoverEvidenceResult } from "./parser.js";
import {
  coverEvidenceResultFromRow,
  saveCoverEvidenceResult,
  selectCoverEvidenceResultById,
} from "./repository.js";
import {
  evaluateSourceSupport,
  readSourceEvidenceForCandidate,
  type SourceSupportResult,
} from "./source-support.service.js";
import type { CoverEvidenceInput, CoverEvidenceResult, CoverEvidenceToolEvent } from "./types.js";

export type CoverEvidenceRunInput = CoverEvidenceInput & {
  chatClient?: DistillationChatClient;
  toolExecutor?: DistillationToolExecutor;
};

export type CoverEvidenceRunResult = {
  id: string;
  result: CoverEvidenceResult;
};

async function recordProcedureDemotionAudit(params: {
  id: string;
  result: CoverEvidenceResult;
  saved: boolean;
  cached?: boolean;
}): Promise<void> {
  const events = params.result.toolEvents.filter(
    (event) => event.name === "procedure_demoted_to_rule" && event.ok,
  );
  for (const event of events) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceProcedureDemotedToRule,
      actor: "system",
      payload: {
        id: params.id,
        stage: params.result.stage,
        saved: params.saved,
        cached: Boolean(params.cached),
        metadata: event.metadata ?? {},
      },
    });
  }
}

function shouldVerifySourceSupportWithLlm(
  support: SourceSupportResult,
  sourceContent: string,
): boolean {
  if (support.ok || support.reason === "not_actionable") return false;
  return sourceContent.trim().length > 0;
}

function sourceSupportDiagnosticEvent(support: SourceSupportResult): CoverEvidenceToolEvent | null {
  if (support.ok) return null;
  return {
    name: "source_support",
    ok: false,
    metadata: {
      reason: support.reason,
      confidence: support.confidence,
      overlapRatio: support.overlapRatio,
      matchedTokenCount: support.matchedTokenCount,
      checkedTokenCount: support.checkedTokenCount,
      mode: "llm_verification",
    },
  };
}

function prependToolEvents(
  result: CoverEvidenceResult,
  toolEvents: CoverEvidenceToolEvent[],
): CoverEvidenceResult {
  return toolEvents.length > 0
    ? {
        ...result,
        toolEvents: [...toolEvents, ...result.toolEvents],
      }
    : result;
}

export async function runCoverEvidence(
  input: CoverEvidenceRunInput,
): Promise<CoverEvidenceRunResult> {
  const id = input.id.trim();
  if (!id) {
    throw new Error("id is required");
  }
  await ensureRuntimeSettingsLoaded();
  const routes = resolveCoverEvidenceRoutes();

  const sourceSupportProvider =
    input.provider ?? (routes.sourceSupport.provider as DistillationProviderSetting);
  const sourceSupportFallbackOrder = input.provider
    ? []
    : ([...routes.sourceSupport.fallback] as DistillationProviderName[]);
  const sourceSupportModel = resolveDistillationModel(sourceSupportProvider);
  const externalEvidenceProvider =
    input.provider ?? (routes.externalEvidence.provider as DistillationProviderSetting);
  const externalEvidenceFallbackOrder = input.provider
    ? []
    : ([...routes.externalEvidence.fallback] as DistillationProviderName[]);
  const externalEvidenceModel = resolveDistillationModel(externalEvidenceProvider);
  const mcpEvidenceProvider =
    input.provider ?? (routes.mcpEvidence.provider as DistillationProviderSetting);
  const mcpEvidenceFallbackOrder = input.provider
    ? []
    : ([...routes.mcpEvidence.fallback] as DistillationProviderName[]);
  const mcpEvidenceModel = resolveDistillationModel(mcpEvidenceProvider);

  if (input.write) {
    const existing = await selectCoverEvidenceResultById(id);
    if (existing) {
      const existingResult = coverEvidenceResultFromRow(existing);
      const normalizedExistingResult = normalizeProcedureBodyQuality(existingResult);
      if (input.forceRefreshEvidence || isRetryableCoverEvidenceStatus(existingResult.status)) {
        // Retryable rows are checkpoints, not terminal cache hits.
      } else {
        if (normalizedExistingResult !== existingResult) {
          await saveCoverEvidenceResult({
            id: existing.id,
            result: normalizedExistingResult,
          });
          await recordProcedureDemotionAudit({
            id: existing.id,
            result: normalizedExistingResult,
            saved: true,
            cached: true,
          });
        }
        return {
          id: existing.id,
          result: normalizedExistingResult,
        };
      }
    }
  }

  const row = await getFindCandidateResultById(id);
  if (!row) {
    throw new Error(`find candidate result not found: ${id}`);
  }
  await recordAuditLogSafe({
    eventType: auditEventTypes.coverEvidenceStarted,
    actor: "system",
    payload: {
      id,
      targetKind: row.targetKind,
      targetKey: row.targetKey,
      provider: sourceSupportProvider,
    },
  });

  let result: CoverEvidenceResult | undefined;

  try {
    if (row.status !== "selected") {
      result = makeResult({
        status: "parse_failed",
        stage: "load",
        candidate: null,
        reason: "find_candidate_not_selected",
      });
    } else {
      let sourceRead: Awaited<ReturnType<typeof readSourceEvidenceForCandidate>>;
      try {
        sourceRead = await readSourceEvidenceForCandidate(row);
      } catch (error) {
        result = makeResult({
          status: "tool_failed",
          stage: "source_support",
          candidate: null,
          reason: "source_read_failed",
        });
        sourceRead = {
          content: "",
          references: [],
          readRanges: [],
        };
      }

      if (result === undefined) {
        const support = evaluateSourceSupport({
          title: row.title,
          body: row.content,
          sourceContent: sourceRead.content,
        });
        const sourceSupportDiagnostics: CoverEvidenceToolEvent[] = [];
        if (!support.ok && !shouldVerifySourceSupportWithLlm(support, sourceRead.content)) {
          result = makeResult({
            status: "insufficient",
            stage: "source_support",
            candidate: null,
            references: sourceRead.references,
            reason: support.reason,
          });
        } else {
          const diagnosticEvent = sourceSupportDiagnosticEvent(support);
          if (diagnosticEvent) {
            sourceSupportDiagnostics.push(diagnosticEvent);
          }
          const sourceContext = sourceContextForPrompts({
            row,
            readRanges: sourceRead.readRanges,
          });
          const originHints = candidateOriginHintsFromOrigin(row.origin);
          const candidate = baseCandidate({
            title: row.title,
            body: row.content,
            confidence: support.confidence,
            hints: originHints,
          });
          const dedupe = await dedupeCoverEvidenceCandidate(candidate);
          if (dedupe.status !== "unique") {
            result = makeResult({
              status: dedupe.status,
              stage: "dedupe",
              candidate: null,
              references: mergeReferences(
                sourceRead.references,
                referencesFromDuplicateRefs(dedupe.duplicateRefs),
              ),
              duplicateRefs: dedupe.duplicateRefs,
              reason: dedupe.status,
            });
          } else if (requiresExternalEvidence(candidate)) {
            result = await runExternalEvidence({
              id,
              candidate,
              sourceReferences: sourceRead.references,
              sourceContext,
              candidateTypeHint: originHints.type,
              provider: externalEvidenceProvider,
              model: externalEvidenceModel,
              fallbackOrder: externalEvidenceFallbackOrder,
              forceRefreshEvidence: input.forceRefreshEvidence,
              chatClient: input.chatClient,
              toolExecutor: input.toolExecutor,
              signal: input.signal,
            });
            result = await appendOptionalMcpEvidence({
              id,
              result,
              provider: mcpEvidenceProvider,
              model: mcpEvidenceModel,
              fallbackOrder: mcpEvidenceFallbackOrder,
              chatClient: input.chatClient,
              toolExecutor: input.toolExecutor,
              signal: input.signal,
            });
          } else {
            result = await runValueAssessment({
              id,
              candidate,
              sourceReferences: sourceRead.references,
              sourceContentExcerpt: sourceRead.content,
              sourceContext,
              candidateTypeHint: originHints.type,
              provider: sourceSupportProvider,
              model: sourceSupportModel,
              fallbackOrder: sourceSupportFallbackOrder,
              chatClient: input.chatClient,
              signal: input.signal,
            });
          }
          if (result) {
            result = prependToolEvents(result, sourceSupportDiagnostics);
          }
        }
      }
    }

    if (!result) {
      throw new Error("coverEvidence did not produce a result");
    }

    if (input.write) {
      await saveCoverEvidenceResult({
        id,
        result,
      });
      await recordProcedureDemotionAudit({
        id,
        result,
        saved: true,
      });
    }

    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceCompleted,
      actor: "system",
      payload: {
        id,
        status: result.status,
        stage: result.stage,
        saved: Boolean(input.write),
      },
    });

    return { id, result };
  } catch (error) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceFailed,
      actor: "system",
      payload: {
        id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function runCoverEvidenceSmoke(
  input: Record<string, unknown>,
): Promise<DistillationDomainSmokeResult> {
  const parsed = parseCoverEvidenceResult(
    JSON.stringify({
      schemaVersion: 1,
      status: "knowledge_ready",
      stage: "final",
      candidate: {
        type: "rule",
        title: "coverEvidence smoke keeps evidence refs",
        body: "coverEvidence must preserve source references before finalizeDistille creates drafts.",
        importance: 70,
        confidence: 80,
      },
      references: [
        {
          kind: "source",
          uri: "smoke://cover-evidence",
          note: "smoke source reference",
          evidenceRole: "supports_candidate",
        },
      ],
      duplicateRefs: [],
      toolEvents: [],
      reason: null,
    }),
  );
  return {
    domain: "coverEvidence",
    implemented: true,
    status: "ok",
    checkedAt: new Date().toISOString(),
    message: "coverEvidence parser and runtime are available.",
    receivedInput: input,
    nextContracts: [
      "coverEvidence preserves source references",
      "coverEvidence write=true stores cover_evidence_results",
      "finalizeDistille consumes knowledge_ready cover evidence results",
    ],
  };
}
