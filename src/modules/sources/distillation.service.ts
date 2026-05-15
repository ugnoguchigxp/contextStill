import crypto from "node:crypto";
import { config } from "../../config.js";
import { toUnitKnowledgeScore } from "../../lib/score-scale.js";
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
} from "../distillation/distillation-runtime.service.js";
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

type SourceDistillationModelClient = (
  request: DistillationModelRequest,
) => Promise<string | DistillationCompletionResult>;

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
  results: DistilledSourceResult[];
};

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24))}\n...[truncated]`;
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

export function buildSourceDistillationMessages(params: {
  fragment: SourceFragmentForDistillation;
  maxInputChars?: number;
}): DistillationMessage[] {
  const maxInputChars = params.maxInputChars ?? config.sourceDistillationMaxInputChars;
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
      content: buildDistillationSystemPrompt("wiki", [
        "次の形式の厳密な JSON のみを返すこと:",
        '{"candidates":[{"type":"rule|procedure","title":"短い日本語タイトル","body":"再利用可能で実行可能な日本語 knowledge","confidence":70,"importance":70,"score":0.0,"rationale":"任意の短い理由","sourceRefs":["source fragment refs"],"evidenceRefs":["fetched URLs when tools are used"]}]}',
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

async function parseDistillationCandidatesWithRepair(params: {
  rawResponse: string;
  messages: DistillationMessage[];
  modelClient: SourceDistillationModelClient;
  maxTokens: number;
}): Promise<{ candidates: DistilledKnowledgeCandidate[]; repaired: boolean }> {
  try {
    return {
      candidates: parseDistillationCandidateList(params.rawResponse),
      repaired: false,
    };
  } catch (initialError) {
    const repairResponse = await params.modelClient({
      model: config.localLlmModel,
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
        `source distillation response invalid after JSON repair: ${repairMessage}; initial error: ${initialMessage}`,
      );
    }
  }
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
    promptVersion: config.sourceDistillationPromptVersion,
    model: config.localLlmModel,
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
  return run;
}

export async function distillSources(
  options: DistillSourcesOptions = {},
): Promise<DistillSourcesSummary> {
  const apply = Boolean(options.apply);
  const modelClient = options.modelClient ?? callLocalLlmCompletionForDistillation;
  const embedder = options.embedder ?? defaultEmbedder;
  const fragments = await listSourceFragmentsForDistillation({
    limit: options.limit ?? config.sourceDistillationBatchSize,
    promptVersion: config.sourceDistillationPromptVersion,
    includeProcessed: options.includeProcessed,
    sourceKind: options.sourceKind,
    uri: options.uri,
  });
  const results: DistilledSourceResult[] = [];

  for (const fragment of fragments) {
    const inputHash = buildSourceDistillationInputHash(fragment);
    const messages = buildSourceDistillationMessages({ fragment });
    try {
      const completion = normalizeDistillationModelResult(
        await modelClient({
          model: config.localLlmModel,
          messages,
          maxTokens: config.sourceDistillationMaxOutputTokens,
        }),
      );
      const { candidates, repaired } = await parseDistillationCandidatesWithRepair({
        rawResponse: completion.content,
        messages,
        modelClient,
        maxTokens: config.sourceDistillationMaxOutputTokens,
      });
      const scoreGate = filterDistillationCandidatesByScore(candidates, {
        toolEvents: completion.toolEvents,
      });
      const acceptedCandidates = scoreGate.accepted;

      if (acceptedCandidates.length === 0) {
        await recordRun({
          apply,
          fragment,
          status: "skipped",
          candidateCount: 0,
          knowledgeIds: [],
          inputHash,
          toolEvents: completion.toolEvents,
          metadata: {
            reason:
              candidates.length === 0
                ? "no_rule_or_procedure_candidates"
                : "all_candidates_rejected",
            jsonRepaired: repaired,
            rawCandidateCount: candidates.length,
            scoreThreshold: scoreGate.threshold,
            rejectedLowScoreCount: scoreGate.rejectedLowScore.length,
            rejectedLowScoreCandidates: summarizeRejectedCandidates(scoreGate.rejectedLowScore),
            rejectedInvalidEvidenceCount: scoreGate.rejectedInvalidEvidence.length,
            rejectedInvalidEvidenceCandidates: summarizeRejectedCandidates(
              scoreGate.rejectedInvalidEvidence,
            ),
            toolEventCount: completion.toolEvents.length,
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

      if (apply) {
        for (const [index, candidate] of acceptedCandidates.entries()) {
          const knowledgeId = await upsertKnowledgeFromSource({
            sourceUri: `source-fragment://${fragment.id}`,
            contentHash: knowledgeContentHash({
              promptVersion: config.sourceDistillationPromptVersion,
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
              distillationModel: config.localLlmModel,
              promptVersion: config.sourceDistillationPromptVersion,
              candidateIndex: index,
              distillationScore: candidate.score,
              distillationScoreThreshold: scoreGate.threshold,
              rationale: candidate.rationale,
              candidateSourceRefs: candidate.sourceRefs,
              candidateEvidenceRefs: candidate.evidenceRefs,
              toolEventCount: completion.toolEvents.length,
            },
          });
          await linkKnowledgeToSourceFragment({
            knowledgeId,
            sourceFragmentId: fragment.id,
            confidence: toUnitKnowledgeScore(candidate.confidence, 70),
            metadata: {
              source: "source_distillation",
              promptVersion: config.sourceDistillationPromptVersion,
              inputHash,
            },
          });
          knowledgeIds.push(knowledgeId);
        }
      }

      await recordRun({
        apply,
        fragment,
        status: "ok",
        candidateCount: acceptedCandidates.length,
        knowledgeIds,
        inputHash,
        toolEvents: completion.toolEvents,
        metadata: {
          jsonRepaired: repaired,
          rawCandidateCount: candidates.length,
          acceptedCandidateCount: acceptedCandidates.length,
          scoreThreshold: scoreGate.threshold,
          rejectedLowScoreCount: scoreGate.rejectedLowScore.length,
          rejectedLowScoreCandidates: summarizeRejectedCandidates(scoreGate.rejectedLowScore),
          rejectedInvalidEvidenceCount: scoreGate.rejectedInvalidEvidence.length,
          rejectedInvalidEvidenceCandidates: summarizeRejectedCandidates(
            scoreGate.rejectedInvalidEvidence,
          ),
          toolEventCount: completion.toolEvents.length,
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordRun({
        apply,
        fragment,
        status: "failed",
        candidateCount: 0,
        knowledgeIds: [],
        error: message,
        inputHash,
        metadata: {
          error: message,
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
      });
    }
  }

  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const knowledgeCount = results.reduce((total, result) => total + result.knowledgeIds.length, 0);
  const summary: DistillSourcesSummary = {
    ok: failed === 0,
    apply,
    model: config.localLlmModel,
    promptVersion: config.sourceDistillationPromptVersion,
    processed: results.length,
    skipped,
    failed,
    knowledgeCount,
    results,
  };

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
}
