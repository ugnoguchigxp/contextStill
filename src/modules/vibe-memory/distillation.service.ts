import crypto from "node:crypto";
import { groupedConfig } from "../../config.js";
import { normalizeRepoKey, normalizeRepoPath } from "../context-compiler/query-context.js";
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
  buildVibeReaderContext,
  readerCatalog,
  type DistillationReaderContext,
} from "../distillation/distillation-reader.service.js";
import {
  beginDistillationJob,
  checkDistillationCircuitBreaker,
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
import type { DistillationSessionModelClient } from "../distillation/distillation-sessions.js";
import { embedOne } from "../embedding/embedding.service.js";
import { upsertKnowledgeFromSource } from "../knowledge/knowledge.repository.js";
import { checkKnowledgeDuplicate } from "../../lib/knowledge-dedup.js";
import {
  type AgentDiffEntryForDistillation,
  type VibeMemoryDistillationStatus,
  type VibeMemoryForDistillation,
  listAgentDiffEntriesForVibeMemories,
  listVibeMemoriesForDistillation,
  recordVibeMemoryDistillationState,
  upsertVibeMemoryDistillationRun,
} from "./distillation.repository.js";

export {
  validateDistillationCandidates,
  parseDistillationCandidates,
} from "../distillation/distillation-candidates.js";

type DistillationModelClient = DistillationSessionModelClient;

type DistillationEmbedder = (text: string) => Promise<number[]>;

export type DistillVibeMemoriesOptions = {
  limit?: number;
  sessionId?: string;
  vibeMemoryIds?: string[];
  apply?: boolean;
  includeProcessed?: boolean;
  modelClient?: DistillationModelClient;
  embedder?: DistillationEmbedder;
  agenticReader?: boolean;
};

type DistilledVibeMemoryResult = {
  vibeMemoryId: string;
  sessionId: string;
  status: VibeMemoryDistillationStatus | "dry_run";
  inputHash: string;
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

export type DistillVibeMemoriesSummary = {
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
  results: DistilledVibeMemoryResult[];
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueAsString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveRepoScopeForMemory(params: {
  memory: VibeMemoryForDistillation;
  fallbackRepoPath?: string;
  fallbackRepoKey?: string;
}): { repoPath?: string; repoKey?: string } {
  const metadata = asRecord(params.memory.metadata);
  const metadataRepoPath = valueAsString(metadata.projectRoot) ?? valueAsString(metadata.repoPath);
  const metadataRepoKey = valueAsString(metadata.repoKey)?.toLowerCase();
  const repoPath = normalizeRepoPath(metadataRepoPath) ?? params.fallbackRepoPath;
  const repoKey =
    normalizeRepoKey(metadataRepoPath) ??
    metadataRepoKey ??
    (repoPath ? normalizeRepoKey(repoPath) : undefined) ??
    params.fallbackRepoKey;

  return { repoPath, repoKey };
}

function vibeMemoryInputContainsUrl(
  memory: VibeMemoryForDistillation,
  diffEntries: AgentDiffEntryForDistillation[],
): boolean {
  if (textContainsUrl(memory.content)) return true;
  if (textContainsUrl(JSON.stringify(memory.metadata ?? {}))) return true;
  return diffEntries.some(
    (entry) =>
      textContainsUrl(entry.filePath) ||
      textContainsUrl(entry.diffHunk) ||
      textContainsUrl(JSON.stringify(entry.metadata ?? {})),
  );
}

function formatAgentDiff(entry: AgentDiffEntryForDistillation, maxDiffChars: number): string {
  const details = [
    `file: ${entry.filePath}`,
    entry.changeType ? `changeType: ${entry.changeType}` : null,
    entry.language ? `language: ${entry.language}` : null,
    entry.symbolName ? `symbol: ${entry.symbolName}` : null,
    entry.symbolKind ? `symbolKind: ${entry.symbolKind}` : null,
    entry.signature ? `signature: ${entry.signature}` : null,
    entry.startLine || entry.endLine
      ? `lines: ${entry.startLine ?? "?"}-${entry.endLine ?? "?"}`
      : null,
  ].filter((line): line is string => Boolean(line));

  return `${details.join("\n")}\ndiff:\n${truncate(entry.diffHunk.trim(), maxDiffChars)}`;
}

export function buildVibeMemoryDistillationMessages(params: {
  memory: VibeMemoryForDistillation;
  diffEntries: AgentDiffEntryForDistillation[];
  maxInputChars?: number;
  readerContext?: DistillationReaderContext;
}): DistillationMessage[] {
  const maxInputChars = params.maxInputChars ?? groupedConfig.vibeDistillation.maxInputChars;
  const readerEnabled = Boolean(params.readerContext?.enabled);
  const diffBudget = Math.max(
    600,
    Math.floor(maxInputChars / Math.max(1, params.diffEntries.length + 2)),
  );
  const diffText =
    params.diffEntries.length > 0
      ? params.diffEntries.map((entry) => formatAgentDiff(entry, diffBudget)).join("\n\n---\n\n")
      : "(none)";
  const input = truncate(
    [
      `sessionId: ${params.memory.sessionId}`,
      `memoryType: ${params.memory.memoryType}`,
      `createdAt: ${params.memory.createdAt.toISOString()}`,
      "",
      readerEnabled
        ? [
            "READABLE_VIBE_SEGMENTS",
            readerCatalog(params.readerContext as DistillationReaderContext),
            "",
            "必要な locator だけ read_vibe_segment で読んでから候補を出してください。",
          ].join("\n")
        : [
            "VIBE_MEMORY_CONTENT",
            params.memory.content.trim(),
            "",
            "AGENT_DIFF_ENTRIES",
            diffText,
          ].join("\n"),
    ].join("\n"),
    maxInputChars,
  );

  return [
    {
      role: "system",
      content: buildDistillationExtractionSystemPrompt("vibe_memory", [
        "出力形式は次のいずれかでよい:",
        '1) 推奨: 最小 JSON {"candidates":[{"type":"rule|procedure","title":"...","body":"...","confidence":70,"importance":80}]}',
        "2) 自然言語: TYPE: rule、TITLE: ...、BODY: ...、CONFIDENCE: ...、IMPORTANCE: ... のラベル付きテキスト",
        "TYPE / TITLE / BODY のような見出し行だけを出さない。",
        "候補がない場合は空配列または『候補なし』と返してよい。",
        ...(readerEnabled
          ? [
              "入力には本文の全量ではなく locator catalog がある。必要に応じて read_vibe_segment を使う。",
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

export function buildVibeMemoryInputHash(params: {
  memory: VibeMemoryForDistillation;
  diffEntries: AgentDiffEntryForDistillation[];
}): string {
  return sha256(
    JSON.stringify({
      memory: {
        id: params.memory.id,
        sessionId: params.memory.sessionId,
        content: params.memory.content,
        memoryType: params.memory.memoryType,
        createdAt: params.memory.createdAt.toISOString(),
      },
      diffEntries: params.diffEntries.map((entry) => ({
        filePath: entry.filePath,
        diffHunk: entry.diffHunk,
        changeType: entry.changeType,
        language: entry.language,
        symbolName: entry.symbolName,
        symbolKind: entry.symbolKind,
        signature: entry.signature,
        startLine: entry.startLine,
        endLine: entry.endLine,
      })),
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

function recordRunEnabled(apply: boolean): boolean {
  return apply;
}

async function recordDistillationRun(params: {
  apply: boolean;
  vibeMemoryId: string;
  status: VibeMemoryDistillationStatus;
  candidateCount: number;
  knowledgeIds: string[];
  error?: string;
  inputHash: string;
  model: string;
  toolEvents?: DistillationCompletionResult["toolEvents"];
  metadata?: Record<string, unknown>;
}) {
  if (!recordRunEnabled(params.apply)) return;
  const run = await upsertVibeMemoryDistillationRun({
    vibeMemoryId: params.vibeMemoryId,
    status: params.status,
    candidateCount: params.candidateCount,
    knowledgeIds: params.knowledgeIds,
    error: params.error,
    inputHash: params.inputHash,
    promptVersion: groupedConfig.vibeDistillation.promptVersion,
    model: params.model,
    toolEvents: params.toolEvents ?? [],
    metadata: params.metadata,
  });
  await attachDistillationCandidateRun({
    source: {
      sourceKind: "vibe_memory",
      vibeMemoryId: params.vibeMemoryId,
    },
    inputHash: params.inputHash,
    promptVersion: groupedConfig.vibeDistillation.promptVersion,
    vibeMemoryRunId: run.id,
  });
}

export async function distillVibeMemories(
  options: DistillVibeMemoriesOptions = {},
): Promise<DistillVibeMemoriesSummary> {
  const apply = Boolean(options.apply);
  const distillationModel = resolveDistillationModel();
  const modelClient = options.modelClient ?? runDistillationCompletion;
  const embedder = options.embedder ?? defaultEmbedder;
  const agenticReaderEnabled = Boolean(
    options.agenticReader && groupedConfig.distillation.vibeAgenticReaderManualEnabled,
  );
  const circuitBreaker = apply
    ? await checkDistillationCircuitBreaker().catch((error) => ({
        allowed: false as const,
        reason: error instanceof Error ? error.message : String(error),
      }))
    : ({ allowed: true as const } satisfies Awaited<
        ReturnType<typeof checkDistillationCircuitBreaker>
      >);
  const workspaceRepoPath = normalizeRepoPath(process.cwd());
  const workspaceRepoKey = normalizeRepoKey(process.cwd());
  await recordAuditLogSafe({
    eventType: auditEventTypes.vibeDistillationRunStarted,
    actor: "system",
    payload: {
      apply,
      model: distillationModel,
      promptVersion: groupedConfig.vibeDistillation.promptVersion,
      limit: options.limit ?? groupedConfig.vibeDistillation.batchSize,
      includeProcessed: Boolean(options.includeProcessed),
      agenticReader: agenticReaderEnabled,
      sessionId: options.sessionId ?? null,
      vibeMemoryIdCount: options.vibeMemoryIds?.length ?? 0,
    },
  });

  const results: DistilledVibeMemoryResult[] = [];
  try {
    const memories = await listVibeMemoriesForDistillation({
      limit: options.limit ?? groupedConfig.vibeDistillation.batchSize,
      sessionId: options.sessionId,
      vibeMemoryIds: options.vibeMemoryIds,
      promptVersion: groupedConfig.vibeDistillation.promptVersion,
      includeProcessed: options.includeProcessed,
    });
    const diffEntries = await listAgentDiffEntriesForVibeMemories(
      memories.map((memory) => memory.id),
    );
    const diffsByMemoryId = new Map<string, AgentDiffEntryForDistillation[]>();
    for (const entry of diffEntries) {
      const current = diffsByMemoryId.get(entry.vibeMemoryId) ?? [];
      current.push(entry);
      diffsByMemoryId.set(entry.vibeMemoryId, current);
    }

    for (const memory of memories) {
      const memoryRepoScope = resolveRepoScopeForMemory({
        memory,
        fallbackRepoPath: workspaceRepoPath,
        fallbackRepoKey: workspaceRepoKey,
      });
      const memoryDiffs = diffsByMemoryId.get(memory.id) ?? [];
      const inputHash = buildVibeMemoryInputHash({ memory, diffEntries: memoryDiffs });
      const sourceRef = {
        sourceKind: "vibe_memory" as const,
        vibeMemoryId: memory.id,
      };
      let job: DistillationJobRow | null = null;
      let jobError: unknown;
      try {
        job = await beginDistillationJob({
          apply,
          source: sourceRef,
          inputHash,
          promptVersion: groupedConfig.vibeDistillation.promptVersion,
          metadata: {
            source: "vibe_memory_distillation",
            sourceKind: "vibe_memory",
            sourceSessionId: memory.sessionId,
            agenticReader: agenticReaderEnabled,
          },
        });
      } catch (error) {
        jobError = error;
        job = null;
      }
      const readerContext = agenticReaderEnabled
        ? buildVibeReaderContext({ memory, diffEntries: memoryDiffs, apply, jobId: job?.id })
        : undefined;
      const messages = buildVibeMemoryDistillationMessages({
        memory,
        diffEntries: memoryDiffs,
        readerContext,
      });
      let responseChars: number | undefined;
      try {
        if (jobError) {
          throw jobError;
        }
        if (apply && !job) {
          const outcomeKind: DistillationOutcomeKind = "job_already_running";
          await recordDistillationRun({
            apply,
            vibeMemoryId: memory.id,
            status: "skipped",
            candidateCount: 0,
            knowledgeIds: [],
            inputHash,
            model: distillationModel,
            metadata: {
              reason: "distillation_job_already_running",
              outcomeKind,
              sourceSessionId: memory.sessionId,
            },
          });
          results.push({
            vibeMemoryId: memory.id,
            sessionId: memory.sessionId,
            status: "skipped",
            inputHash,
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
          await recordDistillationRun({
            apply,
            vibeMemoryId: memory.id,
            status: "skipped",
            candidateCount: 0,
            knowledgeIds: [],
            inputHash,
            model: distillationModel,
            metadata: {
              reason: "distillation_circuit_breaker_paused",
              outcomeKind,
              sourceSessionId: memory.sessionId,
              error: circuitBreaker.reason,
            },
          });
          results.push({
            vibeMemoryId: memory.id,
            sessionId: memory.sessionId,
            status: "skipped",
            inputHash,
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
          distillationSourceKind: "vibe_memory",
          messages,
          modelClient,
          model: distillationModel,
          maxTokens: groupedConfig.vibeDistillation.maxOutputTokens,
          inputHash,
          promptVersion: groupedConfig.vibeDistillation.promptVersion,
          requireFetchEvidenceForUrlInput: vibeMemoryInputContainsUrl(memory, memoryDiffs),
          jobId: job?.id,
          readerContext,
          extractionMetadata: {
            inputHash,
            source: "vibe_memory_distillation",
            sourceKind: "vibe_memory",
            vibeMemoryId: memory.id,
            sourceSessionId: memory.sessionId,
            sourceMemoryType: memory.memoryType,
            diffEntryCount: memoryDiffs.length,
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
          await recordDistillationRun({
            apply,
            vibeMemoryId: memory.id,
            status: "skipped",
            candidateCount: 0,
            knowledgeIds: [],
            inputHash,
            model: distillationModel,
            toolEvents: session.toolEvents,
            metadata: {
              reason: skipReason,
              outcomeKind,
              sourceSessionId: memory.sessionId,
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
            vibeMemoryId: memory.id,
            sessionId: memory.sessionId,
            status: apply ? "skipped" : "dry_run",
            inputHash,
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
          await recordDistillationRun({
            apply,
            vibeMemoryId: memory.id,
            status: "skipped",
            candidateCount: acceptedCandidates.length,
            knowledgeIds: [],
            inputHash,
            model: distillationModel,
            toolEvents: session.toolEvents,
            metadata: {
              reason: skipReason,
              outcomeKind,
              sourceSessionId: memory.sessionId,
              acceptedCandidateCount: acceptedCandidates.length,
              draftCount: promotionGate.draftCount,
              backlogThresholdCount: promotionGate.threshold,
              jsonRepaired: session.jsonRepaired,
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
              acceptedCandidateCount: acceptedCandidates.length,
              draftCount: promotionGate.draftCount,
              backlogThresholdCount: promotionGate.threshold,
            },
          });
          results.push({
            vibeMemoryId: memory.id,
            sessionId: memory.sessionId,
            status: "skipped",
            inputHash,
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
            // 蒸留前に重複チェック（閾値は MCP より少し緩め: 0.92）
            const embedding = embeddings[index];
            const dedupResult = await checkKnowledgeDuplicate(candidate.title, candidate.body, {
              bodySimilarityThreshold: 0.92,
              topK: 5,
              embedding,
            });
            if (dedupResult.isDuplicate) {
              // 重複の場合は既存 ID を採用し、新規挿入はスキップ
              knowledgeIds.push(dedupResult.existingId);
              if (entry.candidateRowId) {
                await updateDistillationCandidateEvaluation({
                  id: entry.candidateRowId,
                  status: "promoted",
                  candidate,
                  knowledgeId: dedupResult.existingId,
                  toolEvents: entry.toolEvents,
                  metadata: {
                    source: "vibe_memory_distillation",
                    promptVersion: groupedConfig.vibeDistillation.promptVersion,
                    inputHash,
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
              sourceUri: `vibe-memory://${memory.id}`,
              contentHash: knowledgeContentHash({
                promptVersion: groupedConfig.vibeDistillation.promptVersion,
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
                source: "vibe_memory_distillation",
                sourceKind: "vibe_memory",
                sourceVibeMemoryIds: [memory.id],
                sourceSessionId: memory.sessionId,
                sourceMemoryType: memory.memoryType,
                sourceCreatedAt: memory.createdAt.toISOString(),
                sourceContentHash: sha256(memory.content),
                repoPath: memoryRepoScope.repoPath,
                repoKey: memoryRepoScope.repoKey,
                inputHash,
                distillationModel,
                promptVersion: groupedConfig.vibeDistillation.promptVersion,
                candidateIndex: entry.candidateIndex,
                rationale: candidate.rationale,
                candidateSourceRefs: candidate.sourceRefs,
                candidateEvidenceRefs: candidate.evidenceRefs,
                toolEventCount: entry.toolEvents.length,
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
                  source: "vibe_memory_distillation",
                  sourceKind: "vibe_memory",
                  sourceVibeMemoryIds: [memory.id],
                  sourceSessionId: memory.sessionId,
                  sourceMemoryType: memory.memoryType,
                  repoPath: memoryRepoScope.repoPath,
                  repoKey: memoryRepoScope.repoKey,
                  promptVersion: groupedConfig.vibeDistillation.promptVersion,
                  inputHash,
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
        await recordDistillationRun({
          apply,
          vibeMemoryId: memory.id,
          status: "ok",
          candidateCount: acceptedCandidates.length,
          knowledgeIds,
          inputHash,
          model: distillationModel,
          toolEvents: session.toolEvents,
          metadata: {
            outcomeKind,
            sourceSessionId: memory.sessionId,
            diffEntryCount: memoryDiffs.length,
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
          vibeMemoryId: memory.id,
          sessionId: memory.sessionId,
          status: apply ? "ok" : "dry_run",
          inputHash,
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
        await recordDistillationRun({
          apply,
          vibeMemoryId: memory.id,
          status: "failed",
          candidateCount: 0,
          knowledgeIds: [],
          error: message,
          inputHash,
          model: distillationModel,
          toolEvents,
          metadata: {
            sourceSessionId: memory.sessionId,
            diffEntryCount: memoryDiffs.length,
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
          vibeMemoryId: memory.id,
          sessionId: memory.sessionId,
          status: "failed",
          inputHash,
          candidateCount: 0,
          knowledgeIds: [],
          candidates: [],
          error: message,
          outcomeKind,
          failureKind,
          toolEventCount: toolEvents.length,
          responseChars,
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

    const summary: DistillVibeMemoriesSummary = {
      ok: failed === 0,
      apply,
      model: distillationModel,
      promptVersion: groupedConfig.vibeDistillation.promptVersion,
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
      eventType: auditEventTypes.vibeDistillationRunFinished,
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
        failedMemories: summary.results
          .filter((result) => result.status === "failed")
          .slice(0, 20)
          .map((result) => ({
            vibeMemoryId: result.vibeMemoryId,
            sessionId: result.sessionId,
            error: result.error ?? null,
            outcomeKind: result.outcomeKind ?? null,
            failureKind: result.failureKind ?? null,
            toolEventCount: result.toolEventCount ?? null,
            responseChars: result.responseChars ?? null,
          })),
        skippedMemories: summary.results
          .filter((result) => result.status === "skipped")
          .slice(0, 20)
          .map((result) => ({
            vibeMemoryId: result.vibeMemoryId,
            sessionId: result.sessionId,
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
      await recordVibeMemoryDistillationState({
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
      eventType: auditEventTypes.vibeDistillationRunFinished,
      actor: "system",
      payload: {
        ok: false,
        apply,
        model: distillationModel,
        promptVersion: groupedConfig.vibeDistillation.promptVersion,
        processed: results.length,
        error: message,
      },
    });
    throw error;
  }
}
