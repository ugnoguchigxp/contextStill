import { groupedConfig } from "../../config.js";
import {
  type DistilledKnowledgeCandidate,
  parseDistillationCandidateListWithMetadata,
} from "./distillation-candidates.js";
import { buildDistillationVerificationSystemPrompt } from "./distillation-prompts.js";
import type {
  DistillationCompletionResult,
  DistillationMessage,
  DistillationModelRequest,
  DistillationRuntimeOptions,
} from "./distillation-runtime.service.js";

export type DistillationSessionModelClient = (
  request: DistillationModelRequest,
  options?: DistillationRuntimeOptions,
) => Promise<string | DistillationCompletionResult>;

export type DistillationSessionResult = {
  candidates: DistilledKnowledgeCandidate[];
  rawCandidateCount: number;
  extractionCandidateCount: number;
  toolEvents: DistillationCompletionResult["toolEvents"];
  responseChars: number;
  extractionResponseChars: number;
  verificationResponseChars: number;
  verificationSessionCount: number;
  jsonRepaired: boolean;
};

export type DistillationExtractionSessionResult = {
  candidates: DistilledKnowledgeCandidate[];
  rawCandidateCount: number;
  toolEvents: DistillationCompletionResult["toolEvents"];
  responseChars: number;
  jsonRepaired: boolean;
};

export type DistillationVerificationSessionResult = {
  candidates: DistilledKnowledgeCandidate[];
  rawCandidateCount: number;
  toolEvents: DistillationCompletionResult["toolEvents"];
  responseChars: number;
  jsonRepaired: boolean;
};

export function normalizeDistillationModelResult(
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

export function evidenceTextFromMessages(messages: DistillationMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function buildDistillationVerificationMessages(params: {
  sourceKind: "vibe_memory" | "wiki";
  sourceEvidence: string;
  candidate: DistilledKnowledgeCandidate;
}): DistillationMessage[] {
  const candidateLines = [
    `TYPE: ${params.candidate.type}`,
    `TITLE: ${params.candidate.title}`,
    "BODY:",
    params.candidate.body,
  ];
  if (Number.isFinite(params.candidate.score)) {
    candidateLines.push(`SCORE: ${params.candidate.score}`);
  }
  return [
    {
      role: "system",
      content: buildDistillationVerificationSystemPrompt(params.candidate.type, [
        `sourceKind: ${params.sourceKind}`,
      ]),
    },
    {
      role: "user",
      content: [
        "SOURCE_EVIDENCE",
        params.sourceEvidence,
        "",
        "CANDIDATE_TO_VERIFY",
        candidateLines.join("\n"),
      ].join("\n"),
    },
  ];
}

export async function runDistillationExtractionSession(params: {
  sourceKind: "vibe_memory" | "wiki";
  messages: DistillationMessage[];
  modelClient: DistillationSessionModelClient;
  model: string;
  maxTokens: number;
}): Promise<DistillationExtractionSessionResult> {
  const extractionCompletion = normalizeDistillationModelResult(
    await params.modelClient(
      {
        model: params.model,
        messages: params.messages,
        maxTokens: params.maxTokens,
      },
      { enableTools: false },
    ),
  );
  const extractionParse = parseDistillationCandidateListWithMetadata(extractionCompletion.content);
  const extractionCandidates = extractionParse.candidates.slice(
    0,
    groupedConfig.distillationTools.maxCandidates,
  );

  return {
    candidates: extractionCandidates,
    rawCandidateCount: extractionParse.candidates.length,
    toolEvents: extractionCompletion.toolEvents,
    responseChars: extractionCompletion.content.length,
    jsonRepaired: extractionParse.jsonRepaired,
  };
}

export async function runDistillationVerificationSession(params: {
  sourceKind: "vibe_memory" | "wiki";
  sourceEvidence: string;
  candidate: DistilledKnowledgeCandidate;
  modelClient: DistillationSessionModelClient;
  model: string;
  maxTokens: number;
  auditContext?: Record<string, unknown>;
}): Promise<DistillationVerificationSessionResult> {
  const verificationCompletion = normalizeDistillationModelResult(
    await params.modelClient(
      {
        model: params.model,
        messages: buildDistillationVerificationMessages({
          sourceKind: params.sourceKind,
          sourceEvidence: params.sourceEvidence,
          candidate: params.candidate,
        }),
        maxTokens: params.maxTokens,
      },
      { enableTools: true, auditContext: params.auditContext, requireToolCall: true },
    ),
  );
  const verificationParse = parseDistillationCandidateListWithMetadata(
    verificationCompletion.content,
  );

  return {
    candidates: verificationParse.candidates,
    rawCandidateCount: verificationParse.candidates.length,
    toolEvents: verificationCompletion.toolEvents,
    responseChars: verificationCompletion.content.length,
    jsonRepaired: verificationParse.jsonRepaired,
  };
}

export async function runDistillationCandidateSessions(params: {
  sourceKind: "vibe_memory" | "wiki";
  messages: DistillationMessage[];
  modelClient: DistillationSessionModelClient;
  model: string;
  maxTokens: number;
}): Promise<DistillationSessionResult> {
  const extraction = await runDistillationExtractionSession(params);
  const toolEvents = [...extraction.toolEvents];
  let verificationResponseChars = 0;
  const verifiedCandidates: DistilledKnowledgeCandidate[] = [];
  let rawCandidateCount = 0;
  let jsonRepaired = extraction.jsonRepaired;

  for (const candidate of extraction.candidates) {
    const verification = await runDistillationVerificationSession({
      sourceKind: params.sourceKind,
      sourceEvidence: evidenceTextFromMessages(params.messages),
      candidate,
      modelClient: params.modelClient,
      model: params.model,
      maxTokens: params.maxTokens,
    });
    verificationResponseChars += verification.responseChars;
    toolEvents.push(...verification.toolEvents);
    rawCandidateCount += verification.rawCandidateCount;
    jsonRepaired = jsonRepaired || verification.jsonRepaired;
    verifiedCandidates.push(...verification.candidates);
  }

  return {
    candidates: verifiedCandidates,
    rawCandidateCount,
    extractionCandidateCount: extraction.candidates.length,
    toolEvents,
    responseChars: extraction.responseChars + verificationResponseChars,
    extractionResponseChars: extraction.responseChars,
    verificationResponseChars,
    verificationSessionCount: extraction.candidates.length,
    jsonRepaired,
  };
}
