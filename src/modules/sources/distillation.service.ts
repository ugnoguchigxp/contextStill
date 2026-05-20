import { groupedConfig } from "../../config.js";
import { toUnitKnowledgeScore } from "../../lib/score-scale.js";
import { checkKnowledgeDuplicate } from "../../lib/knowledge-dedup.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  type DistilledKnowledgeCandidate,
  summarizeRejectedCandidates,
} from "../distillation/distillation-candidates.js";
import { buildDistillationExtractionSystemPrompt } from "../distillation/distillation-prompts.js";
import {
  type DistillationCompletionResult,
  type DistillationMessage,
  distillationToolEventsFromError,
  runDistillationCompletion,
  resolveDistillationModel,
} from "../distillation/distillation-runtime.service.js";
import {
  buildSourceReaderContext,
  readerCatalog,
  type DistillationReaderContext,
} from "../distillation/distillation-reader.service.js";
import {
  beginDistillationJob,
  checkDistillationCircuitBreaker,
  pauseJobForBackpressure,
  pauseJobForCircuitBreaker,
  shouldPauseDistillationPromotion,
} from "../distillation/distillation-job.service.js";
import {
  finishDistillationJob,
  updateDistillationJobPhase,
  type DistillationJobRow,
} from "../distillation/distillation-job.repository.js";
import {
  type DistillationAcceptedCandidateEntry,
  runDistillationCandidateWorkflow,
} from "../distillation/distillation-candidate-workflow.js";
import {
  type DistillationOutcomeKind,
  classifyFailedDistillationOutcome,
  classifySkippedDistillationOutcome,
  classifySuccessfulDistillationOutcome,
} from "../distillation/distillation-outcomes.js";
import {
  attachDistillationCandidateRun,
  updateDistillationCandidateEvaluation,
} from "../distillation/distillation-candidate.repository.js";
import { assertLegacyDistillationEnabled } from "../distillation/legacy-distillation-guard.js";
import type { DistillationSessionModelClient } from "../distillation/distillation-sessions.js";
import { embedOne } from "../embedding/embedding.service.js";
import { upsertKnowledgeFromSource } from "../knowledge/knowledge.repository.js";
import {
  type SourceDistillationStatus,
  type SourceFragmentForDistillation,
  linkKnowledgeToSourceFragment,
  listSourceFragmentsForDistillation,
  recordSourceDistillationState,
  upsertSourceDistillationRun,
} from "./distillation.repository.js";

type SourceDistillationModelClient = DistillationSessionModelClient;

type SourceDistillationEmbedder = (text: string) => Promise<number[]>;

export type DistillSourcesOptions = {
  limit?: number;
  sourceKind?: "wiki";
  uri?: string;
  apply?: boolean;
  includeProcessed?: boolean;
  modelClient?: SourceDistillationModelClient;
  embedder?: SourceDistillationEmbedder;
  agenticReader?: boolean;
};

type DistilledSourceResult = {
  sourceFragmentId: string;
  sourceUri: string;
  locator: string;
  status: SourceDistillationStatus | "dry_run";
  candidateCount: number;
  knowledgeIds: string[];
  candidates: DistilledKnowledgeCandidate[];
  error?: string;
  outcomeKind?: DistillationOutcomeKind;
  skipReason?: string;
  jsonRepaired?: boolean;
  verificationCandidateCount?: number;
  verificationAttemptCount?: number;
  /** @deprecated Use verificationCandidateCount. */
  rawCandidateCount?: number;
  rejectedLowQualityCount?: number;
  rejectedInvalidEvidenceCount?: number;
  toolEventCount?: number;
  responseChars?: number;
  failureKind?: "llm_call" | "parse_or_repair" | "processing";
  jobId?: string;
};

export type DistillSourcesSummary = {
  ok: boolean;
  apply: boolean;
  model: string;
  promptVersion: string;
  processed: number;
  skipped: number;
  failed: number;
  knowledgeCount: number;
  outcomeKindCounts: Record<string, number>;
  skipReasonCounts: Record<string, number>;
  failureKindCounts: Record<string, number>;
  results: DistilledSourceResult[];
};

function summarizeCounts(values: Array<string | undefined>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (!value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function classifyFailureKind(
  message: string,
  responseChars: number | undefined,
): "llm_call" | "parse_or_repair" | "processing" {
  if (responseChars === undefined) return "llm_call";
  if (
    message.includes("invalid after JSON repair") ||
    message.includes("did not contain valid JSON") ||
    message.includes("did not include assistant content")
  ) {
    return "parse_or_repair";
  }
  return "processing";
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24))}\n...[truncated]`;
}

function textContainsUrl(value: string): boolean {
  return /https?:\/\//i.test(value);
}

export function buildSourceDistillationMessages(params: {
  fragment: SourceFragmentForDistillation;
  maxInputChars?: number;
  readerContext?: DistillationReaderContext;
}): DistillationMessage[] {
  const maxInputChars = params.maxInputChars ?? groupedConfig.sourceDistillation.maxInputChars;
  const readerEnabled = Boolean(params.readerContext?.enabled);
  const input = truncate(
    [
      `sourceKind: ${params.fragment.sourceKind}`,
      `sourceId: ${params.fragment.sourceId}`,
      `sourceUri: ${params.fragment.sourceUri}`,
      `sourceTitle: ${params.fragment.sourceTitle ?? "(none)"}`,
      `fragmentId: ${params.fragment.id}`,
      `fragmentLocator: ${params.fragment.locator}`,
      `fragmentHeading: ${params.fragment.heading ?? "(none)"}`,
      "",
      readerEnabled
        ? [
            "READABLE_SOURCE_SEGMENTS",
            readerCatalog(params.readerContext as DistillationReaderContext),
            "",
            "必要な locator だけ read_source_segment で読んでから候補を出してください。",
          ].join("\n")
        : ["SOURCE_FRAGMENT_CONTENT", params.fragment.content.trim()].join("\n"),
    ].join("\n"),
    maxInputChars,
  );

  return [
    {
      role: "system",
      content: buildDistillationExtractionSystemPrompt("wiki", [
        "出力形式は次のいずれかでよい:",
        '1) 推奨: 最小 JSON {"candidates":[{"type":"rule|procedure","title":"...","body":"...","confidence":70,"importance":80}]}',
        "2) 自然言語: TYPE: rule、TITLE: ...、BODY: ...、CONFIDENCE: ...、IMPORTANCE: ... のラベル付きテキスト",
        "TYPE / TITLE / BODY のような見出し行だけを出さない。",
        "候補がない場合は空配列または『候補なし』と返してよい。",
        ...(readerEnabled
          ? [
              "入力には本文の全量ではなく locator catalog がある。必要に応じて read_source_segment を使う。",
              "読んだ内容を短く統合し、最終候補だけを返す。圧縮メモは保存対象ではない。",
            ]
          : []),
      ]),
    },
    {
      role: "user",
      content: input,
    },
  ];
}

function sourceFragmentContainsUrl(fragment: SourceFragmentForDistillation): boolean {
  if (textContainsUrl(fragment.sourceUri)) return true;
  if (textContainsUrl(fragment.content)) return true;
  return textContainsUrl(
    JSON.stringify({
      metadata: fragment.metadata,
      sourceMetadata: fragment.sourceMetadata,
    }),
  );
}

async function defaultEmbedder(text: string): Promise<number[]> {
  return embedOne(text, "passage");
}

async function recordRun(params: {
  apply: boolean;
  fragment: SourceFragmentForDistillation;
  status: SourceDistillationStatus;
  candidateCount: number;
  knowledgeIds: string[];
  error?: string;
  model: string;
  toolEvents?: DistillationCompletionResult["toolEvents"];
  metadata?: Record<string, unknown>;
}) {
  if (!params.apply) return null;
  const run = await upsertSourceDistillationRun({
    sourceFragmentId: params.fragment.id,
    status: params.status,
    candidateCount: params.candidateCount,
    knowledgeIds: params.knowledgeIds,
    error: params.error,
    promptVersion: groupedConfig.sourceDistillation.promptVersion,
    model: params.model,
    toolEvents: params.toolEvents ?? [],
    metadata: {
      sourceId: params.fragment.sourceId,
      sourceKind: params.fragment.sourceKind,
      sourceUri: params.fragment.sourceUri,
      fragmentLocator: params.fragment.locator,
      fragmentHeading: params.fragment.heading,
      ...(params.metadata ?? {}),
    },
  });
  await attachDistillationCandidateRun({
    source: {
      sourceKind: "source_fragment",
      sourceFragmentId: params.fragment.id,
    },
    promptVersion: groupedConfig.sourceDistillation.promptVersion,
    sourceRunId: run.id,
  });
  return run;
}

export async function distillSources(
  options: DistillSourcesOptions = {},
): Promise<DistillSourcesSummary> {
  assertLegacyDistillationEnabled("distillSources");
  const apply = Boolean(options.apply);
  const distillationModel = resolveDistillationModel();
  const modelClient = options.modelClient ?? runDistillationCompletion;
  const embedder = options.embedder ?? defaultEmbedder;
  const agenticReaderEnabled = Boolean(
    options.agenticReader && groupedConfig.distillation.sourceAgenticReaderManualEnabled,
  );
  const circuitBreaker = apply
    ? await checkDistillationCircuitBreaker().catch((error) => ({
        allowed: false as const,
        reason: error instanceof Error ? error.message : String(error),
      }))
    : ({ allowed: true as const } satisfies Awaited<
        ReturnType<typeof checkDistillationCircuitBreaker>
      >);
  await recordAuditLogSafe({
    eventType: auditEventTypes.sourceDistillationRunStarted,
    actor: "system",
    payload: {
      apply,
      model: distillationModel,
      promptVersion: groupedConfig.sourceDistillation.promptVersion,
      limit: options.limit ?? groupedConfig.sourceDistillation.batchSize,
      includeProcessed: Boolean(options.includeProcessed),
      agenticReader: agenticReaderEnabled,
      sourceKind: options.sourceKind ?? null,
      uri: options.uri ?? null,
    },
  });

  const results: DistilledSourceResult[] = [];
  try {
    const fragments = await listSourceFragmentsForDistillation({
      limit: options.limit ?? groupedConfig.sourceDistillation.batchSize,
      promptVersion: groupedConfig.sourceDistillation.promptVersion,
      includeProcessed: options.includeProcessed,
      sourceKind: options.sourceKind,
      uri: options.uri,
    });

    for (const fragment of fragments) {
      const sourceRef = {
        sourceKind: "source_fragment" as const,
        sourceFragmentId: fragment.id,
      };
      let job: DistillationJobRow | null = null;
      let jobError: unknown;
      try {
        job = await beginDistillationJob({
          apply,
          source: sourceRef,
          promptVersion: groupedConfig.sourceDistillation.promptVersion,
          metadata: {
            source: "source_distillation",
            sourceKind: fragment.sourceKind,
            sourceUri: fragment.sourceUri,
            agenticReader: agenticReaderEnabled,
          },
        });
      } catch (error) {
        jobError = error;
        job = null;
      }
      const readerContext = agenticReaderEnabled
        ? buildSourceReaderContext({ fragment, apply, jobId: job?.id })
        : undefined;
      const messages = buildSourceDistillationMessages({ fragment, readerContext });
      let responseChars: number | undefined;
      try {
        if (jobError) {
          throw jobError;
        }
        if (apply && !job) {
          const outcomeKind: DistillationOutcomeKind = "job_already_running";
          await recordRun({
            apply,
            fragment,
            status: "skipped",
            candidateCount: 0,
            knowledgeIds: [],
            model: distillationModel,
            metadata: {
              reason: "distillation_job_already_running",
              outcomeKind,
            },
          });
          results.push({
            sourceFragmentId: fragment.id,
            sourceUri: fragment.sourceUri,
            locator: fragment.locator,
            status: "skipped",
            candidateCount: 0,
            knowledgeIds: [],
            candidates: [],
            outcomeKind,
            skipReason: "distillation_job_already_running",
          });
          continue;
        }

        if (!circuitBreaker.allowed) {
          const outcomeKind: DistillationOutcomeKind = "batch_paused_circuit_breaker";
          await pauseJobForCircuitBreaker({
            jobId: job?.id,
            reason: circuitBreaker.reason,
            health:
              "health" in circuitBreaker
                ? (circuitBreaker.health as unknown as Record<string, unknown>)
                : undefined,
          });
          await recordRun({
            apply,
            fragment,
            status: "skipped",
            candidateCount: 0,
            knowledgeIds: [],
            model: distillationModel,
            metadata: {
              reason: "distillation_circuit_breaker_paused",
              outcomeKind,
              error: circuitBreaker.reason,
            },
          });
          results.push({
            sourceFragmentId: fragment.id,
            sourceUri: fragment.sourceUri,
            locator: fragment.locator,
            status: "skipped",
            candidateCount: 0,
            knowledgeIds: [],
            candidates: [],
            outcomeKind,
            skipReason: "distillation_circuit_breaker_paused",
            error: circuitBreaker.reason,
            jobId: job?.id,
          });
          continue;
        }

        await updateDistillationJobPhase(job?.id, agenticReaderEnabled ? "reading" : "extracting");
        const session = await runDistillationCandidateWorkflow({
          apply,
          source: sourceRef,
          distillationSourceKind: "wiki",
          messages,
          modelClient,
          model: distillationModel,
          maxTokens: groupedConfig.sourceDistillation.maxOutputTokens,
          promptVersion: groupedConfig.sourceDistillation.promptVersion,
          requireFetchEvidenceForUrlInput: sourceFragmentContainsUrl(fragment),
          jobId: job?.id,
          readerContext,
          extractionMetadata: {
            source: "source_distillation",
            sourceId: fragment.sourceId,
            sourceKind: fragment.sourceKind,
            sourceUri: fragment.sourceUri,
            fragmentId: fragment.id,
            fragmentLocator: fragment.locator,
            agenticReader: agenticReaderEnabled,
            readLocators: readerContext?.readLocators,
          },
        });
        responseChars = session.responseChars;
        const candidateGate = session.candidateGate;
        const acceptedEntries: DistillationAcceptedCandidateEntry[] = session.acceptedEntries;
        const acceptedCandidates = acceptedEntries.map((entry) => entry.candidate);

        if (acceptedCandidates.length === 0) {
          const skippedOutcome = classifySkippedDistillationOutcome({
            extractionCandidateCount: session.extractionCandidateCount,
            verificationCandidateCount: session.verificationCandidateCount,
            rejectedLowQualityCount: candidateGate.rejectedLowQuality.length,
            rejectedInvalidEvidenceCount: candidateGate.rejectedInvalidEvidence.length,
            failedCandidateCount: session.failedCandidateCount,
          });
          const skipReason = skippedOutcome.legacyReason;
          const outcomeKind = skippedOutcome.outcomeKind;
          await recordRun({
            apply,
            fragment,
            status: "skipped",
            candidateCount: 0,
            knowledgeIds: [],
            model: distillationModel,
            toolEvents: session.toolEvents,
            metadata: {
              reason: skipReason,
              outcomeKind,
              jsonRepaired: session.jsonRepaired,
              verificationCandidateCount: session.verificationCandidateCount,
              verificationAttemptCount: session.verificationAttemptCount,
              rawCandidateCount: session.rawCandidateCount,
              extractionCandidateCount: session.extractionCandidateCount,
              extractionRawCandidateCount: session.extractionRawCandidateCount,
              verificationSessionCount: session.verificationSessionCount,
              extractionResponseChars: session.extractionResponseChars,
              verificationResponseChars: session.verificationResponseChars,
              usedStoredCandidates: session.usedStoredCandidates,
              failedCandidateCount: session.failedCandidateCount,
              concurrentClaimMissCount: session.concurrentClaimMissCount,
              rejectedLowQualityCount: candidateGate.rejectedLowQuality.length,
              rejectedLowQualityCandidates: summarizeRejectedCandidates(
                candidateGate.rejectedLowQuality,
              ),
              rejectedInvalidEvidenceCount: candidateGate.rejectedInvalidEvidence.length,
              rejectedInvalidEvidenceCandidates: summarizeRejectedCandidates(
                candidateGate.rejectedInvalidEvidence,
              ),
              toolEventCount: session.toolEvents.length,
              responseChars,
            },
          });
          await finishDistillationJob({
            id: job?.id,
            status: "skipped",
            outcomeKind,
            metadata: {
              reason: skipReason,
              acceptedCandidateCount: 0,
            },
          });
          results.push({
            sourceFragmentId: fragment.id,
            sourceUri: fragment.sourceUri,
            locator: fragment.locator,
            status: apply ? "skipped" : "dry_run",
            candidateCount: 0,
            knowledgeIds: [],
            candidates: [],
            outcomeKind,
            skipReason,
            jsonRepaired: session.jsonRepaired,
            verificationCandidateCount: session.verificationCandidateCount,
            verificationAttemptCount: session.verificationAttemptCount,
            rawCandidateCount: session.rawCandidateCount,
            rejectedLowQualityCount: candidateGate.rejectedLowQuality.length,
            rejectedInvalidEvidenceCount: candidateGate.rejectedInvalidEvidence.length,
            toolEventCount: session.toolEvents.length,
            responseChars,
            jobId: job?.id,
          });
          continue;
        }

        const promotionGate = apply
          ? await shouldPauseDistillationPromotion()
          : { paused: false, draftCount: 0, threshold: 0 };
        if (promotionGate.paused) {
          const outcomeKind: DistillationOutcomeKind = "promotion_paused_backpressure";
          const skipReason = "hitl_backpressure";
          await pauseJobForBackpressure({
            jobId: job?.id,
            draftCount: promotionGate.draftCount,
            threshold: promotionGate.threshold,
            acceptedCandidateCount: acceptedCandidates.length,
          });
          await recordRun({
            apply,
            fragment,
            status: "skipped",
            candidateCount: acceptedCandidates.length,
            knowledgeIds: [],
            model: distillationModel,
            toolEvents: session.toolEvents,
            metadata: {
              reason: skipReason,
              outcomeKind,
              acceptedCandidateCount: acceptedCandidates.length,
              draftCount: promotionGate.draftCount,
              backlogThresholdCount: promotionGate.threshold,
              jsonRepaired: session.jsonRepaired,
              toolEventCount: session.toolEvents.length,
              responseChars,
            },
          });
          results.push({
            sourceFragmentId: fragment.id,
            sourceUri: fragment.sourceUri,
            locator: fragment.locator,
            status: "skipped",
            candidateCount: acceptedCandidates.length,
            knowledgeIds: [],
            candidates: acceptedCandidates,
            outcomeKind,
            skipReason,
            jsonRepaired: session.jsonRepaired,
            verificationCandidateCount: session.verificationCandidateCount,
            verificationAttemptCount: session.verificationAttemptCount,
            rawCandidateCount: session.rawCandidateCount,
            rejectedLowQualityCount: candidateGate.rejectedLowQuality.length,
            rejectedInvalidEvidenceCount: candidateGate.rejectedInvalidEvidence.length,
            toolEventCount: session.toolEvents.length,
            responseChars,
            jobId: job?.id,
          });
          continue;
        }

        await updateDistillationJobPhase(job?.id, "promoting");
        const embeddings = apply
          ? await Promise.all(
              acceptedCandidates.map((candidate) =>
                embedder(`${candidate.title}\n${candidate.body}`),
              ),
            )
          : [];
        const knowledgeIds: string[] = [];
        let dedupSkippedCount = 0;

        if (apply) {
          for (const [index, entry] of acceptedEntries.entries()) {
            const candidate = entry.candidate;
            const embedding = embeddings[index];
            // 蒸留前に重複チェック（閾値は MCP より少し緩め: 0.92）
            const dedupResult = await checkKnowledgeDuplicate(candidate.title, candidate.body, {
              bodySimilarityThreshold: 0.92,
              topK: 5,
              embedding,
            });
            if (dedupResult.isDuplicate) {
              // 重複時: 既存アイテムにソースリンクのみ追記（新規挿入はスキップ）
              await linkKnowledgeToSourceFragment({
                knowledgeId: dedupResult.existingId,
                sourceFragmentId: fragment.id,
                confidence: toUnitKnowledgeScore(candidate.confidence, 70),
                metadata: {
                  source: "source_distillation",
                  promptVersion: groupedConfig.sourceDistillation.promptVersion,
                  dedupMerged: true,
                  dedupReason: dedupResult.reason,
                },
              });
              knowledgeIds.push(dedupResult.existingId);
              if (entry.candidateRowId) {
                await updateDistillationCandidateEvaluation({
                  id: entry.candidateRowId,
                  status: "promoted",
                  candidate,
                  knowledgeId: dedupResult.existingId,
                  toolEvents: entry.toolEvents,
                  metadata: {
                    source: "source_distillation",
                    promptVersion: groupedConfig.sourceDistillation.promptVersion,
                    dedupMerged: true,
                    dedupReason: dedupResult.reason,
                    toolEventCount: entry.toolEvents.length,
                  },
                });
              }
              dedupSkippedCount++;
              continue;
            }
            const knowledgeId = await upsertKnowledgeFromSource({
              sourceUri: `source-fragment://${fragment.id}`,
              type: candidate.type,
              status: "draft",
              scope: "repo",
              title: candidate.title,
              body: candidate.body,
              confidence: candidate.confidence,
              importance: candidate.importance,
              embedding: embeddings[index],
              metadata: {
                source: "source_distillation",
                sourceKind: fragment.sourceKind,
                sourceId: fragment.sourceId,
                sourceDocumentUri: fragment.sourceUri,
                sourceTitle: fragment.sourceTitle,
                sourceFragmentId: fragment.id,
                sourceFragmentLocator: fragment.locator,
                sourceFragmentHeading: fragment.heading,
                repoPath:
                  typeof fragment.sourceMetadata.repoPath === "string"
                    ? fragment.sourceMetadata.repoPath
                    : undefined,
                repoKey:
                  typeof fragment.sourceMetadata.repoKey === "string"
                    ? fragment.sourceMetadata.repoKey
                    : undefined,
                distillationModel,
                promptVersion: groupedConfig.sourceDistillation.promptVersion,
                candidateIndex: entry.candidateIndex,
                rationale: candidate.rationale,
                candidateSourceRefs: candidate.sourceRefs,
                candidateEvidenceRefs: candidate.evidenceRefs,
                toolEventCount: entry.toolEvents.length,
              },
            });
            await linkKnowledgeToSourceFragment({
              knowledgeId,
              sourceFragmentId: fragment.id,
              confidence: toUnitKnowledgeScore(candidate.confidence, 70),
              metadata: {
                source: "source_distillation",
                promptVersion: groupedConfig.sourceDistillation.promptVersion,
              },
            });
            knowledgeIds.push(knowledgeId);
            if (entry.candidateRowId) {
              await updateDistillationCandidateEvaluation({
                id: entry.candidateRowId,
                status: "promoted",
                candidate,
                knowledgeId,
                toolEvents: entry.toolEvents,
                metadata: {
                  source: "source_distillation",
                  sourceKind: fragment.sourceKind,
                  sourceId: fragment.sourceId,
                  sourceDocumentUri: fragment.sourceUri,
                  sourceFragmentId: fragment.id,
                  sourceFragmentLocator: fragment.locator,
                  promptVersion: groupedConfig.sourceDistillation.promptVersion,
                  toolEventCount: entry.toolEvents.length,
                },
              });
            }
          }
        }

        const outcomeKind = classifySuccessfulDistillationOutcome({
          apply,
          acceptedCandidateCount: acceptedCandidates.length,
          dedupSkippedCount,
        });
        await recordRun({
          apply,
          fragment,
          status: "ok",
          candidateCount: acceptedCandidates.length,
          knowledgeIds,
          model: distillationModel,
          toolEvents: session.toolEvents,
          metadata: {
            outcomeKind,
            jsonRepaired: session.jsonRepaired,
            verificationCandidateCount: session.verificationCandidateCount,
            verificationAttemptCount: session.verificationAttemptCount,
            rawCandidateCount: session.rawCandidateCount,
            extractionCandidateCount: session.extractionCandidateCount,
            extractionRawCandidateCount: session.extractionRawCandidateCount,
            verificationSessionCount: session.verificationSessionCount,
            extractionResponseChars: session.extractionResponseChars,
            verificationResponseChars: session.verificationResponseChars,
            usedStoredCandidates: session.usedStoredCandidates,
            failedCandidateCount: session.failedCandidateCount,
            concurrentClaimMissCount: session.concurrentClaimMissCount,
            acceptedCandidateCount: acceptedCandidates.length,
            dedupSkippedCount,
            rejectedLowQualityCount: candidateGate.rejectedLowQuality.length,
            rejectedLowQualityCandidates: summarizeRejectedCandidates(
              candidateGate.rejectedLowQuality,
            ),
            rejectedInvalidEvidenceCount: candidateGate.rejectedInvalidEvidence.length,
            rejectedInvalidEvidenceCandidates: summarizeRejectedCandidates(
              candidateGate.rejectedInvalidEvidence,
            ),
            toolEventCount: session.toolEvents.length,
            responseChars,
          },
        });
        await finishDistillationJob({
          id: job?.id,
          status: "completed",
          outcomeKind,
          metadata: {
            acceptedCandidateCount: acceptedCandidates.length,
            knowledgeCount: knowledgeIds.length,
            dedupSkippedCount,
          },
        });
        results.push({
          sourceFragmentId: fragment.id,
          sourceUri: fragment.sourceUri,
          locator: fragment.locator,
          status: apply ? "ok" : "dry_run",
          candidateCount: acceptedCandidates.length,
          knowledgeIds,
          candidates: acceptedCandidates,
          outcomeKind,
          jsonRepaired: session.jsonRepaired,
          verificationCandidateCount: session.verificationCandidateCount,
          verificationAttemptCount: session.verificationAttemptCount,
          rawCandidateCount: session.rawCandidateCount,
          rejectedLowQualityCount: candidateGate.rejectedLowQuality.length,
          rejectedInvalidEvidenceCount: candidateGate.rejectedInvalidEvidence.length,
          toolEventCount: session.toolEvents.length,
          responseChars,
          jobId: job?.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const toolEvents = distillationToolEventsFromError(error);
        const failureKind = classifyFailureKind(message, responseChars);
        const outcomeKind = classifyFailedDistillationOutcome({ message, failureKind });
        await recordRun({
          apply,
          fragment,
          status: "failed",
          candidateCount: 0,
          knowledgeIds: [],
          error: message,
          model: distillationModel,
          toolEvents,
          metadata: {
            error: message,
            outcomeKind,
            failureKind,
            toolEventCount: toolEvents.length,
            responseChars,
          },
        });
        await finishDistillationJob({
          id: job?.id,
          status: "failed",
          outcomeKind,
          error: message,
          metadata: {
            failureKind,
            responseChars,
          },
        });
        results.push({
          sourceFragmentId: fragment.id,
          sourceUri: fragment.sourceUri,
          locator: fragment.locator,
          status: "failed",
          candidateCount: 0,
          knowledgeIds: [],
          candidates: [],
          error: message,
          outcomeKind,
          responseChars,
          failureKind,
          toolEventCount: toolEvents.length,
          jobId: job?.id,
        });
      }
    }

    const failed = results.filter((result) => result.status === "failed").length;
    const skipped = results.filter((result) => result.status === "skipped").length;
    const knowledgeCount = results.reduce((total, result) => total + result.knowledgeIds.length, 0);
    const outcomeKindCounts = summarizeCounts(results.map((result) => result.outcomeKind));
    const skipReasonCounts = summarizeCounts(
      results.filter((result) => result.status === "skipped").map((result) => result.skipReason),
    );
    const failureKindCounts = summarizeCounts(
      results.filter((result) => result.status === "failed").map((result) => result.failureKind),
    );
    const summary: DistillSourcesSummary = {
      ok: failed === 0,
      apply,
      model: distillationModel,
      promptVersion: groupedConfig.sourceDistillation.promptVersion,
      processed: results.length,
      skipped,
      failed,
      knowledgeCount,
      outcomeKindCounts,
      skipReasonCounts,
      failureKindCounts,
      results,
    };

    await recordAuditLogSafe({
      eventType: auditEventTypes.sourceDistillationRunFinished,
      actor: "system",
      payload: {
        ok: summary.ok,
        apply: summary.apply,
        model: summary.model,
        promptVersion: summary.promptVersion,
        processed: summary.processed,
        skipped: summary.skipped,
        failed: summary.failed,
        knowledgeCount: summary.knowledgeCount,
        outcomeKindCounts: summary.outcomeKindCounts,
        skipReasonCounts: summary.skipReasonCounts,
        failureKindCounts: summary.failureKindCounts,
        jsonRepairedCount: summary.results.filter((result) => result.jsonRepaired).length,
        failedFragments: summary.results
          .filter((result) => result.status === "failed")
          .slice(0, 20)
          .map((result) => ({
            sourceFragmentId: result.sourceFragmentId,
            sourceUri: result.sourceUri,
            locator: result.locator,
            error: result.error ?? null,
            outcomeKind: result.outcomeKind ?? null,
            failureKind: result.failureKind ?? null,
            toolEventCount: result.toolEventCount ?? null,
            responseChars: result.responseChars ?? null,
          })),
        skippedFragments: summary.results
          .filter((result) => result.status === "skipped")
          .slice(0, 20)
          .map((result) => ({
            sourceFragmentId: result.sourceFragmentId,
            sourceUri: result.sourceUri,
            locator: result.locator,
            reason: result.skipReason ?? null,
            outcomeKind: result.outcomeKind ?? null,
            jsonRepaired: result.jsonRepaired ?? null,
            verificationCandidateCount: result.verificationCandidateCount ?? null,
            verificationAttemptCount: result.verificationAttemptCount ?? null,
            rawCandidateCount: result.rawCandidateCount ?? null,
            rejectedLowQualityCount: result.rejectedLowQualityCount ?? null,
            rejectedInvalidEvidenceCount: result.rejectedInvalidEvidenceCount ?? null,
            toolEventCount: result.toolEventCount ?? null,
            responseChars: result.responseChars ?? null,
          })),
      },
    });

    if (apply) {
      await recordSourceDistillationState({
        ok: summary.ok,
        apply: summary.apply,
        model: summary.model,
        promptVersion: summary.promptVersion,
        processed: summary.processed,
        skipped: summary.skipped,
        failed: summary.failed,
        knowledgeCount: summary.knowledgeCount,
      });
    }

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordAuditLogSafe({
      eventType: auditEventTypes.sourceDistillationRunFinished,
      actor: "system",
      payload: {
        ok: false,
        apply,
        model: distillationModel,
        promptVersion: groupedConfig.sourceDistillation.promptVersion,
        processed: results.length,
        error: message,
      },
    });
    throw error;
  }
}
