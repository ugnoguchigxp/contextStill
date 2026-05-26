import { groupedConfig } from "../../config.js";
import {
  type DistillationChatClient,
  type DistillationProviderSetting,
  type DistillationToolExecutor,
  distillationToolEventsFromError,
  runDistillationCompletion,
} from "../distillation/distillation-runtime.service.js";
import type { DistillationProviderName } from "../distillation/llm-resolver.js";
import {
  PROCEDURE_BODY_NOT_ACTIONABLE_REASON,
  PROCEDURE_REPAIR_FAILED_REASON,
  assessProcedureQuality,
  validateCandidateQualityForStorage,
} from "../distillation/procedure-quality.js";
import type { CandidateKnowledgeType } from "../findCandidate/repository.js";
import {
  type CoverEvidenceSourceContext,
  isAbortError,
  makeResult,
  mergeReferences,
  normalizeProcedureBodyQuality,
  reclassifyResultCandidate,
  referencesFromToolEvents,
  rejectLowImportance,
  toolEventsForResult,
} from "./helpers.js";
import {
  coverEvidenceMaxToolRounds,
  coverEvidenceToolLimits,
  parseFailureToolEvent,
  procedureRepairEvidenceFromCompletion,
} from "./llm-runner.helpers.js";
import {
  type McpEvidenceToolName,
  configuredMcpEvidenceToolNames,
  referencesFromMcpToolEvents,
} from "./mcp-evidence.service.js";
import { parseCoverEvidenceResult } from "./parser.js";
import { repairProcedureCandidate } from "./procedure-repair.service.js";
import {
  applicabilityRefinementSystemPrompt,
  applicabilityRefinementUserPrompt,
  applicabilityBlankResponseReminderLines,
  externalEvidenceSystemPrompt,
  externalEvidenceUserPrompt,
  mcpEvidenceSystemPrompt,
  mcpEvidenceUserPrompt,
  valueAssessmentSystemPrompt,
  valueAssessmentUserPrompt,
} from "./prompts.js";
import type {
  CoverEvidenceCandidate,
  CoverEvidenceReference,
  CoverEvidenceResult,
  CoverEvidenceStatus,
  CoverEvidenceToolEvent,
} from "./types.js";

type LlmRuntimeFailureKind = "aborted" | "timeout" | null;

function llmRuntimeFailureKind(error: unknown): LlmRuntimeFailureKind {
  if (!(error instanceof Error)) return null;
  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  if (name === "aborterror" || message.includes("aborted")) return "aborted";
  if (message.includes("timed out") || message.includes("timeout")) return "timeout";
  return null;
}

function coverEvidenceFailureStatus(params: {
  error: unknown;
  toolEvents: CoverEvidenceToolEvent[];
}): CoverEvidenceStatus {
  const hasFailedToolEvent = params.toolEvents.some((event) => !event.ok);
  if (llmRuntimeFailureKind(params.error) && !hasFailedToolEvent) return "provider_failed";
  return params.toolEvents.length > 0 ? "tool_failed" : "provider_failed";
}

function coverEvidenceFailureReason(params: {
  prefix: "external" | "value";
  status: CoverEvidenceStatus;
  error: unknown;
}): string {
  if (params.status === "tool_failed") return `${params.prefix}_tool_failed`;
  const runtimeFailure = llmRuntimeFailureKind(params.error);
  if (runtimeFailure === "aborted") return `${params.prefix}_provider_aborted`;
  if (runtimeFailure === "timeout") return `${params.prefix}_provider_timeout`;
  return `${params.prefix}_provider_failed`;
}

function hasFacet(values: string[] | undefined): boolean {
  if (!values || values.length === 0) return false;
  return values.some((value) => value.trim().length > 0);
}

function missingApplicabilityFacets(candidate: CoverEvidenceCandidate): string[] {
  const missing: string[] = [];
  if (!hasFacet(candidate.technologies)) missing.push("technologies");
  if (!hasFacet(candidate.changeTypes)) missing.push("changeTypes");
  if (!hasFacet(candidate.domains)) missing.push("domains");
  return missing;
}

async function enrichApplicabilityFacets(params: {
  id: string;
  result: CoverEvidenceResult;
  sourceReferences: CoverEvidenceReference[];
  sourceContentExcerpt: string;
  sourceContext: CoverEvidenceSourceContext;
  provider: DistillationProviderSetting;
  model: string;
  fallbackOrder?: DistillationProviderName[];
  azureDeploymentSlots?: number[];
  chatClient?: DistillationChatClient;
  signal?: AbortSignal;
}): Promise<CoverEvidenceResult> {
  if (params.result.status !== "knowledge_ready" || !params.result.candidate) {
    return params.result;
  }
  const missingBefore = missingApplicabilityFacets(params.result.candidate);
  if (missingBefore.length === 0) {
    return params.result;
  }

  try {
    const completion = await runDistillationCompletion(
      {
        model: params.model,
        maxTokens: Math.max(768, groupedConfig.vibeDistillation.maxOutputTokens),
        messages: [
          { role: "system", content: applicabilityRefinementSystemPrompt() },
          {
            role: "user",
            content: applicabilityRefinementUserPrompt({
              candidate: params.result.candidate,
              sourceReferences: params.sourceReferences,
              sourceContentExcerpt: params.sourceContentExcerpt,
              sourceContext: params.sourceContext,
            }),
          },
        ],
      },
      {
        providerSetting: params.provider,
        fallbackOrder: params.fallbackOrder,
        azureDeploymentSlots: params.azureDeploymentSlots,
        chatClient: params.chatClient,
        usageSource: "cover-evidence:applicability-refinement",
        enableTools: false,
        timeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
        blankResponseReminder: applicabilityBlankResponseReminderLines(
          "final",
          "knowledge_ready|insufficient",
        ),
        signal: params.signal,
        auditContext: {
          domain: "coverEvidence",
          id: params.id,
          stage: "final",
          assessment: "applicability-refinement",
        },
      },
    );

    let refined: CoverEvidenceResult;
    try {
      refined = parseCoverEvidenceResult(completion.content, {
        candidateDefaults: params.result.candidate,
      });
    } catch (error) {
      return {
        ...params.result,
        toolEvents: [
          ...params.result.toolEvents,
          ...toolEventsForResult(completion.toolEvents),
          parseFailureToolEvent({
            reason: "applicability_refinement_parse_failed",
            error,
            completion,
          }),
        ],
      };
    }

    if (refined.status !== "knowledge_ready" || !refined.candidate) {
      return {
        ...params.result,
        toolEvents: [
          ...params.result.toolEvents,
          ...toolEventsForResult(completion.toolEvents),
          {
            name: "applicability_refinement",
            ok: false,
            metadata: { reason: "refinement_not_knowledge_ready" },
          },
        ],
      };
    }

    const mergedCandidate: CoverEvidenceCandidate = {
      ...params.result.candidate,
      ...(hasFacet(refined.candidate.technologies)
        ? { technologies: refined.candidate.technologies }
        : {}),
      ...(hasFacet(refined.candidate.changeTypes)
        ? { changeTypes: refined.candidate.changeTypes }
        : {}),
      ...(hasFacet(refined.candidate.domains) ? { domains: refined.candidate.domains } : {}),
    };
    const missingAfter = missingApplicabilityFacets(mergedCandidate);
    return {
      ...params.result,
      candidate: mergedCandidate,
      toolEvents: [
        ...params.result.toolEvents,
        ...toolEventsForResult(completion.toolEvents),
        {
          name: "applicability_refinement",
          ok: missingAfter.length === 0,
          metadata: {
            missingBefore,
            missingAfter,
          },
        },
      ],
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      ...params.result,
      toolEvents: [
        ...params.result.toolEvents,
        ...toolEventsForResult(distillationToolEventsFromError(error)),
        {
          name: "applicability_refinement",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function repairCandidateForResult(
  result: CoverEvidenceResult,
  fallbackProcedureCandidate?: CoverEvidenceCandidate,
): CoverEvidenceCandidate | null {
  if (result.candidate?.type === "procedure") return result.candidate;
  if (
    result.status === "insufficient" &&
    result.reason === PROCEDURE_BODY_NOT_ACTIONABLE_REASON &&
    fallbackProcedureCandidate?.type === "procedure"
  ) {
    return fallbackProcedureCandidate;
  }
  return null;
}

async function normalizeOrRepairProcedureQuality(params: {
  id: string;
  result: CoverEvidenceResult;
  candidateTypeHint?: CandidateKnowledgeType;
  fallbackProcedureCandidate?: CoverEvidenceCandidate;
  sourceEvidence?: string;
  provider: DistillationProviderSetting;
  model: string;
  fallbackOrder?: DistillationProviderName[];
  azureDeploymentSlots?: number[];
  chatClient?: DistillationChatClient;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CoverEvidenceResult> {
  if (
    params.result.status !== "knowledge_ready" &&
    !(
      params.result.status === "insufficient" &&
      params.result.reason === PROCEDURE_BODY_NOT_ACTIONABLE_REASON
    )
  ) {
    return normalizeProcedureBodyQuality(params.result, { typeHint: params.candidateTypeHint });
  }
  const candidate = repairCandidateForResult(params.result, params.fallbackProcedureCandidate);
  if (!candidate) {
    return normalizeProcedureBodyQuality(params.result, { typeHint: params.candidateTypeHint });
  }
  const decision = assessProcedureQuality({
    title: candidate.title,
    body: candidate.body,
    typeHint: params.candidateTypeHint,
  });
  if (decision.action !== "repair_procedure" || !params.sourceEvidence?.trim()) {
    return normalizeProcedureBodyQuality(params.result, { typeHint: params.candidateTypeHint });
  }

  const repair = await repairProcedureCandidate({
    id: params.id,
    title: candidate.title,
    body: candidate.body,
    sourceEvidence: params.sourceEvidence,
    provider: params.provider,
    model: params.model,
    fallbackOrder: params.fallbackOrder,
    azureDeploymentSlots: params.azureDeploymentSlots,
    chatClient: params.chatClient,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  if (repair.status === "failed") {
    return makeResult({
      status: repair.reason === "repair_tool_failed" ? "tool_failed" : "provider_failed",
      stage: params.result.stage,
      candidate: null,
      references: params.result.references,
      duplicateRefs: params.result.duplicateRefs,
      toolEvents: [...params.result.toolEvents, ...repair.toolEvents],
      reason: repair.reason,
    });
  }
  if (repair.status === "not_repairable") {
    const toolEvents: CoverEvidenceToolEvent[] = [
      ...params.result.toolEvents,
      {
        name: "procedure_repair",
        ok: false,
        metadata: { reason: repair.reason },
      },
    ];
    const demotedRule = {
      ...candidate,
      type: "rule" as const,
    };
    const ruleValidation = validateCandidateQualityForStorage(demotedRule, {
      typeHint: params.candidateTypeHint,
    });
    if (ruleValidation.action === "accept") {
      return makeResult({
        status: "knowledge_ready",
        stage: params.result.stage,
        candidate: demotedRule,
        references: params.result.references,
        duplicateRefs: params.result.duplicateRefs,
        toolEvents: [
          ...toolEvents,
          {
            name: "procedure_demoted_to_rule",
            ok: true,
            metadata: {
              reason: ruleValidation.reason,
              repairReason: repair.reason,
              typeHint: params.candidateTypeHint ?? null,
            },
          },
        ],
        reason: null,
      });
    }
    return makeResult({
      status: "insufficient",
      stage: params.result.stage,
      candidate: null,
      references: params.result.references,
      duplicateRefs: params.result.duplicateRefs,
      toolEvents,
      reason: PROCEDURE_REPAIR_FAILED_REASON,
    });
  }
  return normalizeProcedureBodyQuality(
    {
      ...params.result,
      candidate: {
        ...candidate,
        title: repair.candidate.title,
        body: repair.candidate.body,
        type: "procedure",
      },
      toolEvents: [
        ...params.result.toolEvents,
        ...repair.toolEvents,
        {
          name: "procedure_repair",
          ok: true,
          metadata: { reason: repair.reason },
        },
      ],
    },
    { typeHint: params.candidateTypeHint },
  );
}

export async function runValueAssessment(params: {
  id: string;
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContentExcerpt: string;
  sourceContext: CoverEvidenceSourceContext;
  candidateTypeHint?: CandidateKnowledgeType;
  provider: DistillationProviderSetting;
  model: string;
  fallbackOrder?: DistillationProviderName[];
  azureDeploymentSlots?: number[];
  chatClient?: DistillationChatClient;
  signal?: AbortSignal;
}): Promise<CoverEvidenceResult> {
  try {
    const completion = await runDistillationCompletion(
      {
        model: params.model,
        maxTokens: Math.max(1024, groupedConfig.vibeDistillation.maxOutputTokens),
        messages: [
          { role: "system", content: valueAssessmentSystemPrompt() },
          {
            role: "user",
            content: valueAssessmentUserPrompt({
              candidate: params.candidate,
              sourceReferences: params.sourceReferences,
              sourceContentExcerpt: params.sourceContentExcerpt,
              sourceContext: params.sourceContext,
            }),
          },
        ],
      },
      {
        providerSetting: params.provider,
        fallbackOrder: params.fallbackOrder,
        azureDeploymentSlots: params.azureDeploymentSlots,
        chatClient: params.chatClient,
        usageSource: "cover-evidence:value-assessment",
        enableTools: false,
        timeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
        blankResponseReminder: applicabilityBlankResponseReminderLines(
          "final",
          "knowledge_ready|insufficient",
        ),
        signal: params.signal,
        auditContext: {
          domain: "coverEvidence",
          id: params.id,
          stage: "final",
          assessment: "value",
        },
      },
    );
    let parsed: CoverEvidenceResult;
    try {
      parsed = parseCoverEvidenceResult(completion.content, {
        candidateDefaults: params.candidate,
      });
    } catch (error) {
      const toolEvents = toolEventsForResult(completion.toolEvents);
      return makeResult({
        status: "parse_failed",
        stage: "final",
        candidate: null,
        references: params.sourceReferences,
        toolEvents: [
          ...toolEvents,
          parseFailureToolEvent({
            reason: "value_parse_failed",
            error,
            completion,
          }),
        ],
        reason: "value_parse_failed",
      });
    }
    const baseResult = rejectLowImportance({
      ...reclassifyResultCandidate(parsed),
      references: mergeReferences(params.sourceReferences, parsed.references),
      toolEvents: toolEventsForResult(completion.toolEvents),
    });
    const enrichedResult = await enrichApplicabilityFacets({
      id: params.id,
      result: baseResult,
      sourceReferences: params.sourceReferences,
      sourceContentExcerpt: params.sourceContentExcerpt,
      sourceContext: params.sourceContext,
      provider: params.provider,
      model: params.model,
      fallbackOrder: params.fallbackOrder,
      azureDeploymentSlots: params.azureDeploymentSlots,
      chatClient: params.chatClient,
      signal: params.signal,
    });
    return normalizeOrRepairProcedureQuality({
      id: params.id,
      result: enrichedResult,
      candidateTypeHint: params.candidateTypeHint,
      fallbackProcedureCandidate: params.candidate,
      sourceEvidence: procedureRepairEvidenceFromCompletion({
        sourceEvidence: params.sourceContentExcerpt,
        completion,
      }),
      provider: params.provider,
      model: params.model,
      fallbackOrder: params.fallbackOrder,
      azureDeploymentSlots: params.azureDeploymentSlots,
      chatClient: params.chatClient,
      signal: params.signal,
      timeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const toolEvents = toolEventsForResult(distillationToolEventsFromError(error));
    const status = coverEvidenceFailureStatus({ error, toolEvents });
    return makeResult({
      status,
      stage: "final",
      candidate: null,
      references: params.sourceReferences,
      toolEvents,
      reason: coverEvidenceFailureReason({ prefix: "value", status, error }),
    });
  }
}

export async function runExternalEvidence(params: {
  id: string;
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContentExcerpt: string;
  sourceContext: CoverEvidenceSourceContext;
  candidateTypeHint?: CandidateKnowledgeType;
  provider: DistillationProviderSetting;
  model: string;
  fallbackOrder?: DistillationProviderName[];
  azureDeploymentSlots?: number[];
  forceRefreshEvidence?: boolean;
  chatClient?: DistillationChatClient;
  toolExecutor?: DistillationToolExecutor;
  signal?: AbortSignal;
}): Promise<CoverEvidenceResult> {
  try {
    const completion = await runDistillationCompletion(
      {
        model: params.model,
        maxTokens: Math.max(2048, groupedConfig.vibeDistillation.maxOutputTokens),
        messages: [
          { role: "system", content: externalEvidenceSystemPrompt() },
          {
            role: "user",
            content: externalEvidenceUserPrompt({
              candidate: params.candidate,
              sourceReferences: params.sourceReferences,
              sourceContext: params.sourceContext,
            }),
          },
        ],
      },
      {
        providerSetting: params.provider,
        fallbackOrder: params.fallbackOrder,
        azureDeploymentSlots: params.azureDeploymentSlots,
        chatClient: params.chatClient,
        toolExecutor: params.toolExecutor,
        usageSource: "cover-evidence:external-evidence",
        enableTools: true,
        maxToolRounds: coverEvidenceMaxToolRounds(),
        toolCallLimits: coverEvidenceToolLimits(),
        timeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
        blankResponseReminder: applicabilityBlankResponseReminderLines(
          "web",
          "knowledge_ready|insufficient|duplicate|near_duplicate",
        ),
        toolNames: ["search_web", "fetch_content"],
        auditContext: {
          domain: "coverEvidence",
          id: params.id,
          stage: "web",
          assessment: "external-evidence",
          forceRefreshEvidence: Boolean(params.forceRefreshEvidence),
        },
        signal: params.signal,
      },
    );
    let parsed: CoverEvidenceResult;
    try {
      parsed = parseCoverEvidenceResult(completion.content, {
        candidateDefaults: params.candidate,
      });
    } catch (error) {
      const toolEvents = toolEventsForResult(completion.toolEvents);
      return makeResult({
        status: "parse_failed",
        stage: "web",
        candidate: null,
        references: params.sourceReferences,
        toolEvents: [
          ...toolEvents,
          parseFailureToolEvent({
            reason: "external_parse_failed",
            error,
            completion,
          }),
        ],
        reason: "external_parse_failed",
      });
    }
    const toolEvents = toolEventsForResult(completion.toolEvents);
    const references = mergeReferences(
      params.sourceReferences,
      parsed.references,
      referencesFromToolEvents(toolEvents),
    );

    return normalizeOrRepairProcedureQuality({
      id: params.id,
      result: rejectLowImportance({
        ...reclassifyResultCandidate(parsed),
        references,
        toolEvents,
      }),
      candidateTypeHint: params.candidateTypeHint,
      fallbackProcedureCandidate: params.candidate,
      sourceEvidence: procedureRepairEvidenceFromCompletion({
        sourceEvidence: params.sourceContentExcerpt,
        completion,
      }),
      provider: params.provider,
      model: params.model,
      fallbackOrder: params.fallbackOrder,
      azureDeploymentSlots: params.azureDeploymentSlots,
      chatClient: params.chatClient,
      signal: params.signal,
      timeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const toolEvents = toolEventsForResult(distillationToolEventsFromError(error));
    const status = coverEvidenceFailureStatus({ error, toolEvents });
    return makeResult({
      status,
      stage: "web",
      candidate: null,
      references: params.sourceReferences,
      toolEvents,
      reason: coverEvidenceFailureReason({ prefix: "external", status, error }),
    });
  }
}

export async function runOptionalMcpEvidence(params: {
  id: string;
  candidate: CoverEvidenceCandidate;
  provider: DistillationProviderSetting;
  model: string;
  fallbackOrder?: DistillationProviderName[];
  azureDeploymentSlots?: number[];
  chatClient?: DistillationChatClient;
  toolExecutor?: DistillationToolExecutor;
  signal?: AbortSignal;
}): Promise<{ references: CoverEvidenceReference[]; toolEvents: CoverEvidenceToolEvent[] }> {
  const toolNames = configuredMcpEvidenceToolNames();
  if (toolNames.length === 0) {
    return { references: [], toolEvents: [] };
  }

  try {
    const completion = await runDistillationCompletion(
      {
        model: params.model,
        maxTokens: 1024,
        messages: [
          { role: "system", content: mcpEvidenceSystemPrompt(toolNames) },
          { role: "user", content: mcpEvidenceUserPrompt(params.candidate) },
        ],
      },
      {
        providerSetting: params.provider,
        fallbackOrder: params.fallbackOrder,
        azureDeploymentSlots: params.azureDeploymentSlots,
        chatClient: params.chatClient,
        toolExecutor: params.toolExecutor,
        usageSource: "cover-evidence:mcp-evidence",
        enableTools: true,
        maxToolRounds: 2,
        timeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
        requireToolCall: true,
        toolNames,
        requireToolCallReminder: [
          "直前の応答はまだ採用できません。",
          `補助 MCP evidence が設定されているため、最終 JSON の前に ${toolNames.join(
            " または ",
          )} を 1 回だけ呼び出してください。`,
        ],
        auditContext: {
          domain: "coverEvidence",
          id: params.id,
          stage: "mcp",
          optionalEvidence: "mcp",
        },
        signal: params.signal,
      },
    );
    const toolEvents = toolEventsForResult(completion.toolEvents);
    return {
      references: referencesFromMcpToolEvents(toolEvents),
      toolEvents,
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const toolEvents = toolEventsForResult(distillationToolEventsFromError(error));
    return {
      references: referencesFromMcpToolEvents(toolEvents),
      toolEvents,
    };
  }
}

export async function appendOptionalMcpEvidence(params: {
  id: string;
  result: CoverEvidenceResult;
  provider: DistillationProviderSetting;
  model: string;
  fallbackOrder?: DistillationProviderName[];
  azureDeploymentSlots?: number[];
  chatClient?: DistillationChatClient;
  toolExecutor?: DistillationToolExecutor;
  signal?: AbortSignal;
}): Promise<CoverEvidenceResult> {
  if (params.result.status !== "knowledge_ready" || !params.result.candidate) {
    return params.result;
  }

  const mcpEvidence = await runOptionalMcpEvidence({
    id: params.id,
    candidate: params.result.candidate,
    provider: params.provider,
    model: params.model,
    fallbackOrder: params.fallbackOrder,
    azureDeploymentSlots: params.azureDeploymentSlots,
    chatClient: params.chatClient,
    toolExecutor: params.toolExecutor,
    signal: params.signal,
  });
  if (mcpEvidence.references.length === 0 && mcpEvidence.toolEvents.length === 0) {
    return params.result;
  }

  return {
    ...params.result,
    references: mergeReferences(params.result.references, mcpEvidence.references),
    toolEvents: [...params.result.toolEvents, ...mcpEvidence.toolEvents],
  };
}
