import crypto from "node:crypto";
import { groupedConfig } from "../../config.js";
import { normalizeRepoKey, normalizeRepoPath } from "../context-compiler/query-context.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  type DistilledKnowledgeCandidate,
  filterDistillationCandidatesByScore,
  parseDistillationCandidateList,
  summarizeRejectedCandidates,
} from "../distillation/distillation-candidates.js";
import { buildDistillationSystemPrompt } from "../distillation/distillation-prompts.js";
import {
  type DistillationCompletionResult,
  type DistillationMessage,
  type DistillationModelRequest,
  callLocalLlmCompletionForDistillation,
  resolveDistillationModel,
} from "../distillation/distillation-runtime.service.js";
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
  filterDistillationCandidatesByScore,
  parseDistillationCandidates,
} from "../distillation/distillation-candidates.js";

type DistillationModelClient = (
  request: DistillationModelRequest,
) => Promise<string | DistillationCompletionResult>;

type DistillationEmbedder = (text: string) => Promise<number[]>;

export type DistillVibeMemoriesOptions = {
  limit?: number;
  sessionId?: string;
  vibeMemoryIds?: string[];
  apply?: boolean;
  includeProcessed?: boolean;
  modelClient?: DistillationModelClient;
  embedder?: DistillationEmbedder;
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
  results: DistilledVibeMemoryResult[];
};

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24))}\n...[truncated]`;
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
}): DistillationMessage[] {
  const maxInputChars = params.maxInputChars ?? groupedConfig.vibeDistillation.maxInputChars;
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
      "VIBE_MEMORY_CONTENT",
      params.memory.content.trim(),
      "",
      "AGENT_DIFF_ENTRIES",
      diffText,
    ].join("\n"),
    maxInputChars,
  );

  return [
    {
      role: "system",
      content: buildDistillationSystemPrompt("vibe_memory", [
        "次の形式の厳密な JSON のみを返すこと:",
        '{"candidates":[{"type":"rule|procedure","title":"短い日本語タイトル","body":"再利用可能で実行可能な日本語 knowledge","confidence":70,"importance":70,"score":0.0,"rationale":"任意の短い理由","sourceRefs":["local evidence refs"],"evidenceRefs":["fetched URLs when tools are used"]}]}',
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

async function parseDistillationCandidatesWithRepair(params: {
  rawResponse: string;
  messages: DistillationMessage[];
  modelClient: DistillationModelClient;
  maxTokens: number;
  model: string;
}): Promise<{ candidates: DistilledKnowledgeCandidate[]; repaired: boolean }> {
  try {
    return {
      candidates: parseDistillationCandidateList(params.rawResponse),
      repaired: false,
    };
  } catch (initialError) {
    const repairResponse = await params.modelClient({
      model: params.model,
      messages: [
        ...params.messages,
        {
          role: "assistant",
          content: params.rawResponse,
        },
        {
          role: "user",
          content:
            '前回の応答は不正または不完全な JSON でした。同じ schema で、最大 2 件、score と sourceRefs を含む完全な厳密 JSON のみを返してください。不確実な場合は {"candidates":[]} を返してください。',
        },
      ],
      maxTokens: params.maxTokens,
    });
    const repairedContent = normalizeDistillationModelResult(repairResponse).content;

    try {
      return {
        candidates: parseDistillationCandidateList(repairedContent),
        repaired: true,
      };
    } catch (repairError) {
      const initialMessage =
        initialError instanceof Error ? initialError.message : String(initialError);
      const repairMessage =
        repairError instanceof Error ? repairError.message : String(repairError);
      throw new Error(
        `distillation response invalid after JSON repair: ${repairMessage}; initial error: ${initialMessage}`,
      );
    }
  }
}

function normalizeDistillationModelResult(
  result: string | DistillationCompletionResult,
): DistillationCompletionResult {
  if (typeof result === "string") {
    return {
      content: result,
      toolEvents: [],
      messages: [],
    };
  }
  return result;
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
  metadata?: Record<string, unknown>;
}) {
  if (!recordRunEnabled(params.apply)) return;
  await upsertVibeMemoryDistillationRun({
    vibeMemoryId: params.vibeMemoryId,
    status: params.status,
    candidateCount: params.candidateCount,
    knowledgeIds: params.knowledgeIds,
    error: params.error,
    inputHash: params.inputHash,
    promptVersion: groupedConfig.vibeDistillation.promptVersion,
    model: params.model,
    metadata: params.metadata,
  });
}

export async function distillVibeMemories(
  options: DistillVibeMemoriesOptions = {},
): Promise<DistillVibeMemoriesSummary> {
  const apply = Boolean(options.apply);
  const distillationModel = resolveDistillationModel();
  const modelClient = options.modelClient ?? callLocalLlmCompletionForDistillation;
  const embedder = options.embedder ?? defaultEmbedder;
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
      const messages = buildVibeMemoryDistillationMessages({ memory, diffEntries: memoryDiffs });
      try {
        const completion = normalizeDistillationModelResult(
          await modelClient({
            model: distillationModel,
            messages,
            maxTokens: groupedConfig.vibeDistillation.maxOutputTokens,
          }),
        );
        const rawResponse = completion.content;
        const { candidates, repaired } = await parseDistillationCandidatesWithRepair({
          rawResponse,
          messages,
          modelClient,
          maxTokens: groupedConfig.vibeDistillation.maxOutputTokens,
          model: distillationModel,
        });
        const scoreGate = filterDistillationCandidatesByScore(candidates, {
          toolEvents: completion.toolEvents,
        });
        const acceptedCandidates = scoreGate.accepted;
        const rejectedLowScoreCandidates = scoreGate.rejectedLowScore;

        if (acceptedCandidates.length === 0) {
          await recordDistillationRun({
            apply,
            vibeMemoryId: memory.id,
            status: "skipped",
            candidateCount: 0,
            knowledgeIds: [],
            inputHash,
            model: distillationModel,
            metadata: {
              reason:
                candidates.length === 0
                  ? "no_rule_or_procedure_candidates"
                  : "all_candidates_below_min_score",
              sourceSessionId: memory.sessionId,
              jsonRepaired: repaired,
              rawCandidateCount: candidates.length,
              scoreThreshold: scoreGate.threshold,
              rejectedLowScoreCount: rejectedLowScoreCandidates.length,
              rejectedLowScoreCandidates: summarizeRejectedCandidates(rejectedLowScoreCandidates),
              rejectedInvalidEvidenceCount: scoreGate.rejectedInvalidEvidence.length,
              rejectedInvalidEvidenceCandidates: summarizeRejectedCandidates(
                scoreGate.rejectedInvalidEvidence,
              ),
              toolEventCount: completion.toolEvents.length,
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
          for (const [index, candidate] of acceptedCandidates.entries()) {
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
                candidateIndex: index,
                distillationScore: candidate.score,
                distillationScoreThreshold: scoreGate.threshold,
                rationale: candidate.rationale,
                candidateSourceRefs: candidate.sourceRefs,
                candidateEvidenceRefs: candidate.evidenceRefs,
                toolEventCount: completion.toolEvents.length,
              },
            });
            knowledgeIds.push(knowledgeId);
          }
        }

        await recordDistillationRun({
          apply,
          vibeMemoryId: memory.id,
          status: "ok",
          candidateCount: acceptedCandidates.length,
          knowledgeIds,
          inputHash,
          model: distillationModel,
          metadata: {
            sourceSessionId: memory.sessionId,
            diffEntryCount: memoryDiffs.length,
            jsonRepaired: repaired,
            rawCandidateCount: candidates.length,
            acceptedCandidateCount: acceptedCandidates.length,
            dedupSkippedCount,
            scoreThreshold: scoreGate.threshold,
            rejectedLowScoreCount: rejectedLowScoreCandidates.length,
            rejectedLowScoreCandidates: summarizeRejectedCandidates(rejectedLowScoreCandidates),
            rejectedInvalidEvidenceCount: scoreGate.rejectedInvalidEvidence.length,
            rejectedInvalidEvidenceCandidates: summarizeRejectedCandidates(
              scoreGate.rejectedInvalidEvidence,
            ),
            toolEventCount: completion.toolEvents.length,
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
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordDistillationRun({
          apply,
          vibeMemoryId: memory.id,
          status: "failed",
          candidateCount: 0,
          knowledgeIds: [],
          error: message,
          inputHash,
          model: distillationModel,
          metadata: {
            sourceSessionId: memory.sessionId,
            diffEntryCount: memoryDiffs.length,
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
        });
      }
    }

    const failed = results.filter((result) => result.status === "failed").length;
    const skipped = results.filter((result) => result.status === "skipped").length;
    const knowledgeCount = results.reduce((total, result) => total + result.knowledgeIds.length, 0);

    const summary = {
      ok: failed === 0,
      apply,
      model: distillationModel,
      promptVersion: groupedConfig.vibeDistillation.promptVersion,
      processed: results.length,
      skipped,
      failed,
      knowledgeCount,
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
        failedMemories: summary.results
          .filter((result) => result.status === "failed")
          .slice(0, 20)
          .map((result) => ({
            vibeMemoryId: result.vibeMemoryId,
            sessionId: result.sessionId,
            error: result.error ?? null,
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
