import crypto from "node:crypto";
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
  runDistillationCompletion,
  resolveDistillationModel,
} from "../distillation/distillation-runtime.service.js";
import {
  type DistillationAcceptedCandidateEntry,
  runDistillationCandidateWorkflow,
} from "../distillation/distillation-candidate-workflow.js";
import {
  attachDistillationCandidateRun,
  updateDistillationCandidateEvaluation,
} from "../distillation/distillation-candidate.repository.js";
import type { DistillationSessionModelClient } from "../distillation/distillation-sessions.js";
import { embedOne } from "../embedding/embedding.service.js";
import { upsertKnowledgeFromSource } from "../knowledge/knowledge.repository.js";
import {
  type SourceDistillationStatus,
  type SourceFragmentForDistillation,
  linkKnowledgeToSourceFragment,
  listSourceFragmentsForDistillation,
  recordSourceDistillationEvidence,
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
};

type DistilledSourceResult = {
  sourceFragmentId: string;
  sourceUri: string;
  locator: string;
  status: SourceDistillationStatus | "dry_run";
  inputHash: string;
  candidateCount: number;
  knowledgeIds: string[];
  candidates: DistilledKnowledgeCandidate[];
  error?: string;
  skipReason?: string;
  jsonRepaired?: boolean;
  rawCandidateCount?: number;
  rejectedLowScoreCount?: number;
  rejectedInvalidEvidenceCount?: number;
  toolEventCount?: number;
  responseChars?: number;
  failureKind?: "llm_call" | "parse_or_repair" | "processing";
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

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
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
}): DistillationMessage[] {
  const maxInputChars = params.maxInputChars ?? groupedConfig.sourceDistillation.maxInputChars;
  const input = truncate(
    [
      `sourceKind: ${params.fragment.sourceKind}`,
      `sourceId: ${params.fragment.sourceId}`,
      `sourceUri: ${params.fragment.sourceUri}`,
      `sourceTitle: ${params.fragment.sourceTitle ?? "(none)"}`,
      `sourceContentHash: ${params.fragment.sourceContentHash}`,
      `fragmentId: ${params.fragment.id}`,
      `fragmentLocator: ${params.fragment.locator}`,
      `fragmentHeading: ${params.fragment.heading ?? "(none)"}`,
      "",
      "SOURCE_FRAGMENT_CONTENT",
      params.fragment.content.trim(),
    ].join("\n"),
    maxInputChars,
  );

  return [
    {
      role: "system",
      content: buildDistillationExtractionSystemPrompt("wiki", [
        "出力形式は次のいずれかでよい:",
        '1) 推奨: 最小 JSON {"candidates":[{"type":"rule|procedure","title":"...","body":"..."}]}',
        "2) 自然言語: TYPE / TITLE / BODY / SCORE(任意) のラベル付きテキスト",
        "候補がない場合は空配列または『候補なし』と返してよい。",
      ]),
    },
    {
      role: "user",
      content: input,
    },
  ];
}

export function buildSourceDistillationInputHash(fragment: SourceFragmentForDistillation): string {
  return sha256(
    JSON.stringify({
      sourceId: fragment.sourceId,
      sourceKind: fragment.sourceKind,
      sourceUri: fragment.sourceUri,
      sourceContentHash: fragment.sourceContentHash,
      fragmentId: fragment.id,
      locator: fragment.locator,
      heading: fragment.heading,
      content: fragment.content,
    }),
  );
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

function knowledgeContentHash(params: {
  promptVersion: string;
  inputHash: string;
  candidate: DistilledKnowledgeCandidate;
}): string {
  return sha256(
    [
      params.promptVersion,
      params.inputHash,
      params.candidate.type,
      params.candidate.title,
      params.candidate.body,
    ].join("\0"),
  );
}

async function recordRun(params: {
  apply: boolean;
  fragment: SourceFragmentForDistillation;
  status: SourceDistillationStatus;
  candidateCount: number;
  knowledgeIds: string[];
  error?: string;
  inputHash: string;
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
    inputHash: params.inputHash,
    promptVersion: groupedConfig.sourceDistillation.promptVersion,
    model: params.model,
    toolEvents: params.toolEvents ?? [],
    metadata: {
      sourceId: params.fragment.sourceId,
      sourceKind: params.fragment.sourceKind,
      sourceUri: params.fragment.sourceUri,
      sourceContentHash: params.fragment.sourceContentHash,
      fragmentLocator: params.fragment.locator,
      fragmentHeading: params.fragment.heading,
      ...(params.metadata ?? {}),
    },
  });
  await recordSourceDistillationEvidence({
    runId: run.id,
    toolEvents: params.toolEvents ?? [],
  });
  await attachDistillationCandidateRun({
    source: {
      sourceKind: "source_fragment",
      sourceFragmentId: params.fragment.id,
    },
    inputHash: params.inputHash,
    promptVersion: groupedConfig.sourceDistillation.promptVersion,
    sourceRunId: run.id,
  });
  return run;
}

export async function distillSources(
  options: DistillSourcesOptions = {},
): Promise<DistillSourcesSummary> {
  const apply = Boolean(options.apply);
  const distillationModel = resolveDistillationModel();
  const modelClient = options.modelClient ?? runDistillationCompletion;
  const embedder = options.embedder ?? defaultEmbedder;
  await recordAuditLogSafe({
    eventType: auditEventTypes.sourceDistillationRunStarted,
    actor: "system",
    payload: {
      apply,
      model: distillationModel,
      promptVersion: groupedConfig.sourceDistillation.promptVersion,
      limit: options.limit ?? groupedConfig.sourceDistillation.batchSize,
      includeProcessed: Boolean(options.includeProcessed),
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
      const inputHash = buildSourceDistillationInputHash(fragment);
      const messages = buildSourceDistillationMessages({ fragment });
      let responseChars: number | undefined;
      try {
        const session = await runDistillationCandidateWorkflow({
          apply,
          source: {
            sourceKind: "source_fragment",
            sourceFragmentId: fragment.id,
          },
          distillationSourceKind: "wiki",
          messages,
          modelClient,
          model: distillationModel,
          maxTokens: groupedConfig.sourceDistillation.maxOutputTokens,
          inputHash,
          promptVersion: groupedConfig.sourceDistillation.promptVersion,
          requireFetchEvidenceForUrlInput: sourceFragmentContainsUrl(fragment),
          extractionMetadata: {
            inputHash,
            source: "source_distillation",
            sourceId: fragment.sourceId,
            sourceKind: fragment.sourceKind,
            sourceUri: fragment.sourceUri,
            sourceContentHash: fragment.sourceContentHash,
            fragmentId: fragment.id,
            fragmentLocator: fragment.locator,
          },
        });
        responseChars = session.responseChars;
        const scoreGate = session.scoreGate;
        const acceptedEntries: DistillationAcceptedCandidateEntry[] = session.acceptedEntries;
        const acceptedCandidates = acceptedEntries.map((entry) => entry.candidate);

        if (acceptedCandidates.length === 0) {
          const skipReason =
            session.extractionCandidateCount === 0
              ? "no_rule_or_procedure_candidates"
              : scoreGate.rejectedInvalidEvidence.length > 0 &&
                  scoreGate.rejectedLowScore.length === 0
                ? "all_candidates_missing_external_evidence"
                : scoreGate.rejectedLowScore.length > 0 &&
                    scoreGate.rejectedInvalidEvidence.length === 0
                  ? "all_candidates_below_min_score"
                  : "all_candidates_rejected";
          await recordRun({
            apply,
            fragment,
            status: "skipped",
            candidateCount: 0,
            knowledgeIds: [],
            inputHash,
            model: distillationModel,
            toolEvents: session.toolEvents,
            metadata: {
              reason: skipReason,
              jsonRepaired: session.jsonRepaired,
              rawCandidateCount: session.rawCandidateCount,
              extractionCandidateCount: session.extractionCandidateCount,
              extractionRawCandidateCount: session.extractionRawCandidateCount,
              verificationSessionCount: session.verificationSessionCount,
              extractionResponseChars: session.extractionResponseChars,
              verificationResponseChars: session.verificationResponseChars,
              usedStoredCandidates: session.usedStoredCandidates,
              failedCandidateCount: session.failedCandidateCount,
              concurrentClaimMissCount: session.concurrentClaimMissCount,
              scoreThreshold: scoreGate.threshold,
              rejectedLowScoreCount: scoreGate.rejectedLowScore.length,
              rejectedLowScoreCandidates: summarizeRejectedCandidates(scoreGate.rejectedLowScore),
              rejectedInvalidEvidenceCount: scoreGate.rejectedInvalidEvidence.length,
              rejectedInvalidEvidenceCandidates: summarizeRejectedCandidates(
                scoreGate.rejectedInvalidEvidence,
              ),
              toolEventCount: session.toolEvents.length,
              responseChars,
            },
          });
          results.push({
            sourceFragmentId: fragment.id,
            sourceUri: fragment.sourceUri,
            locator: fragment.locator,
            status: apply ? "skipped" : "dry_run",
            inputHash,
            candidateCount: 0,
            knowledgeIds: [],
            candidates: [],
            skipReason,
            jsonRepaired: session.jsonRepaired,
            rawCandidateCount: session.rawCandidateCount,
            rejectedLowScoreCount: scoreGate.rejectedLowScore.length,
            rejectedInvalidEvidenceCount: scoreGate.rejectedInvalidEvidence.length,
            toolEventCount: session.toolEvents.length,
            responseChars,
          });
          continue;
        }

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
                  inputHash,
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
                    inputHash,
                    dedupMerged: true,
                    dedupReason: dedupResult.reason,
                    distillationScoreThreshold: scoreGate.threshold,
                    toolEventCount: entry.toolEvents.length,
                  },
                });
              }
              dedupSkippedCount++;
              continue;
            }
            const knowledgeId = await upsertKnowledgeFromSource({
              sourceUri: `source-fragment://${fragment.id}`,
              contentHash: knowledgeContentHash({
                promptVersion: groupedConfig.sourceDistillation.promptVersion,
                inputHash,
                candidate,
              }),
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
                sourceContentHash: fragment.sourceContentHash,
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
                inputHash,
                distillationModel,
                promptVersion: groupedConfig.sourceDistillation.promptVersion,
                candidateIndex: entry.candidateIndex,
                distillationScore: candidate.score,
                distillationScoreThreshold: scoreGate.threshold,
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
                inputHash,
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
                  inputHash,
                  distillationScoreThreshold: scoreGate.threshold,
                  toolEventCount: entry.toolEvents.length,
                },
              });
            }
          }
        }

        await recordRun({
          apply,
          fragment,
          status: "ok",
          candidateCount: acceptedCandidates.length,
          knowledgeIds,
          inputHash,
          model: distillationModel,
          toolEvents: session.toolEvents,
          metadata: {
            jsonRepaired: session.jsonRepaired,
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
            scoreThreshold: scoreGate.threshold,
            rejectedLowScoreCount: scoreGate.rejectedLowScore.length,
            rejectedLowScoreCandidates: summarizeRejectedCandidates(scoreGate.rejectedLowScore),
            rejectedInvalidEvidenceCount: scoreGate.rejectedInvalidEvidence.length,
            rejectedInvalidEvidenceCandidates: summarizeRejectedCandidates(
              scoreGate.rejectedInvalidEvidence,
            ),
            toolEventCount: session.toolEvents.length,
            responseChars,
          },
        });
        results.push({
          sourceFragmentId: fragment.id,
          sourceUri: fragment.sourceUri,
          locator: fragment.locator,
          status: apply ? "ok" : "dry_run",
          inputHash,
          candidateCount: acceptedCandidates.length,
          knowledgeIds,
          candidates: acceptedCandidates,
          jsonRepaired: session.jsonRepaired,
          rawCandidateCount: session.rawCandidateCount,
          rejectedLowScoreCount: scoreGate.rejectedLowScore.length,
          rejectedInvalidEvidenceCount: scoreGate.rejectedInvalidEvidence.length,
          toolEventCount: session.toolEvents.length,
          responseChars,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failureKind = classifyFailureKind(message, responseChars);
        await recordRun({
          apply,
          fragment,
          status: "failed",
          candidateCount: 0,
          knowledgeIds: [],
          error: message,
          inputHash,
          model: distillationModel,
          metadata: {
            error: message,
            failureKind,
            responseChars,
          },
        });
        results.push({
          sourceFragmentId: fragment.id,
          sourceUri: fragment.sourceUri,
          locator: fragment.locator,
          status: "failed",
          inputHash,
          candidateCount: 0,
          knowledgeIds: [],
          candidates: [],
          error: message,
          responseChars,
          failureKind,
        });
      }
    }

    const failed = results.filter((result) => result.status === "failed").length;
    const skipped = results.filter((result) => result.status === "skipped").length;
    const knowledgeCount = results.reduce((total, result) => total + result.knowledgeIds.length, 0);
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
            failureKind: result.failureKind ?? null,
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
            jsonRepaired: result.jsonRepaired ?? null,
            rawCandidateCount: result.rawCandidateCount ?? null,
            rejectedLowScoreCount: result.rejectedLowScoreCount ?? null,
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
