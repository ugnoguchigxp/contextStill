import { groupedConfig } from "../../config.js";
import {
  type DistillationChatClient,
  type DistillationProviderSetting,
  type DistillationToolExecutor,
  distillationToolEventsFromError,
  runDistillationCompletion,
} from "../distillation/distillation-runtime.service.js";
import {
  type McpEvidenceToolName,
  configuredMcpEvidenceToolNames,
  referencesFromMcpToolEvents,
} from "./mcp-evidence.service.js";
import { parseCoverEvidenceResult } from "./parser.js";
import type {
  CoverEvidenceCandidate,
  CoverEvidenceReference,
  CoverEvidenceResult,
  CoverEvidenceStatus,
  CoverEvidenceToolEvent,
} from "./types.js";
import {
  type CoverEvidenceSourceContext,
  toolEventsForResult,
  normalizeProcedureBodyQuality,
  rejectLowImportance,
  reclassifyResultCandidate,
  mergeReferences,
  isAbortError,
  makeResult,
  referencesFromToolEvents,
} from "./helpers.js";
import {
  valueAssessmentSystemPrompt,
  valueAssessmentUserPrompt,
  applicabilityBlankResponseReminderLines,
  externalEvidenceSystemPrompt,
  externalEvidenceUserPrompt,
  mcpEvidenceSystemPrompt,
  mcpEvidenceUserPrompt,
} from "./prompts.js";

export async function runValueAssessment(params: {
  id: string;
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContentExcerpt: string;
  sourceContext: CoverEvidenceSourceContext;
  provider: DistillationProviderSetting;
  model: string;
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
        chatClient: params.chatClient,
        enableTools: false,
        blankResponseReminder: applicabilityBlankResponseReminderLines(
          "final",
          "knowledge_ready|insufficient",
        ),
        signal: params.signal,
        auditContext: {
          domain: "coverEvidence",
          id: params.id,
          assessment: "value",
        },
      },
    );
    const parsed = parseCoverEvidenceResult(completion.content, {
      candidateDefaults: params.candidate,
    });
    return normalizeProcedureBodyQuality(
      rejectLowImportance({
        ...reclassifyResultCandidate(parsed),
        references: mergeReferences(params.sourceReferences, parsed.references),
        toolEvents: toolEventsForResult(completion.toolEvents),
      }),
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const toolEvents = toolEventsForResult(distillationToolEventsFromError(error));
    const status: CoverEvidenceStatus = toolEvents.length > 0 ? "tool_failed" : "provider_failed";
    return makeResult({
      status,
      stage: "final",
      candidate: null,
      references: params.sourceReferences,
      toolEvents,
      reason: status === "tool_failed" ? "value_tool_failed" : "value_provider_failed",
    });
  }
}

export async function runExternalEvidence(params: {
  id: string;
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContext: CoverEvidenceSourceContext;
  provider: DistillationProviderSetting;
  model: string;
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
        chatClient: params.chatClient,
        toolExecutor: params.toolExecutor,
        enableTools: true,
        maxToolRounds: groupedConfig.distillationTools.maxRounds,
        requireToolCall: true,
        blankResponseReminder: applicabilityBlankResponseReminderLines(
          "web",
          "knowledge_ready|insufficient|duplicate|near_duplicate",
        ),
        toolNames: ["search_web", "fetch_content"],
        auditContext: {
          domain: "coverEvidence",
          id: params.id,
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
        toolEvents,
        reason: "external_parse_failed",
      });
    }
    const toolEvents = toolEventsForResult(completion.toolEvents);
    const references = mergeReferences(
      params.sourceReferences,
      parsed.references,
      referencesFromToolEvents(toolEvents),
    );
    const hasFetchEvidence = toolEvents.some((event) => event.name === "fetch_content" && event.ok);
    if (parsed.status === "knowledge_ready" && !hasFetchEvidence) {
      return makeResult({
        status: "insufficient",
        stage: "web",
        candidate: null,
        references,
        duplicateRefs: parsed.duplicateRefs,
        toolEvents,
        reason: "external_fetch_evidence_missing",
      });
    }

    return normalizeProcedureBodyQuality(
      rejectLowImportance({
        ...reclassifyResultCandidate(parsed),
        references,
        toolEvents,
      }),
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const toolEvents = toolEventsForResult(distillationToolEventsFromError(error));
    const status: CoverEvidenceStatus = toolEvents.length > 0 ? "tool_failed" : "provider_failed";
    return makeResult({
      status,
      stage: "web",
      candidate: null,
      references: params.sourceReferences,
      toolEvents,
      reason: status === "tool_failed" ? "external_tool_failed" : "external_provider_failed",
    });
  }
}

export async function runOptionalMcpEvidence(params: {
  id: string;
  candidate: CoverEvidenceCandidate;
  provider: DistillationProviderSetting;
  model: string;
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
        chatClient: params.chatClient,
        toolExecutor: params.toolExecutor,
        enableTools: true,
        maxToolRounds: 2,
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
